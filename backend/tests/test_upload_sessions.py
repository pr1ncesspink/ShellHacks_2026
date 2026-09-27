"""Offline tests for signed large uploads, session state, job launch, and the job runner."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json

from fastapi.testclient import TestClient
import pytest

from backend.app.api.rate_limit import AGENT_PATH
from backend.app.api.routes.upload_sessions import get_session_service
from backend.app.main import create_app
from backend.documentparsing.snowflake import SnowflakeError
from backend.projectdata import upload_job
from backend.projectdata.gcs import GcsClient, GcsError, PreconditionFailed, sign_put_url
from backend.projectdata.upload_sessions import (
    ConfigError, JobLauncher, SessionError, SessionService, UploadConfig, object_name, session_name,
)

NOW = datetime(2026, 9, 27, 12, 0, 0, tzinfo=timezone.utc)
MAX = 52_428_800
EMAIL = "shellhacks-api-runtime@shellhacks-2026.iam.gserviceaccount.com"
BUCKET = "shellhacks-2026-plan-uploads"
USER = {"X-Authenticated-User": "user_1"}
PDF = b"%PDF-1.7\n" + b"x" * 64


class FakeSigner:
    def __init__(self):
        self.signed = []

    def sign(self, message):
        self.signed.append(message)
        return b"\xab\xcd"


class FakeGcs:
    def __init__(self):
        self.objects: dict[str, tuple[bytes, int]] = {}
        self.calls = []
        self.deleted = []
        self.race_on_write = None
        self._generation = 100

    def _put(self, name, data):
        self._generation += 1
        self.objects[name] = (data, self._generation)
        return self._generation

    def stat(self, name):
        self.calls.append(("stat", name))
        if name not in self.objects:
            return None
        data, generation = self.objects[name]
        return {"size": str(len(data)), "generation": str(generation)}

    def read_range(self, name, start, end):
        self.calls.append(("read_range", name))
        return self.objects[name][0][start:end + 1]

    def download_to(self, name, path, max_bytes):
        data = self.objects[name][0]
        if len(data) > max_bytes:
            raise ValueError("too large")
        path.write_bytes(data)
        return len(data)

    def read_json(self, name):
        self.calls.append(("read_json", name))
        if name not in self.objects:
            return None, None
        data, generation = self.objects[name]
        return json.loads(data), generation

    def write_json(self, name, document, *, if_generation_match):
        self.calls.append(("write_json", name, document.get("status")))
        if self.race_on_write and self.race_on_write(document):
            self.race_on_write = None
            raise PreconditionFailed("race")
        current = self.objects.get(name, (None, 0))[1]
        if current != if_generation_match:
            raise PreconditionFailed("stale")
        return self._put(name, json.dumps(document).encode())

    def delete(self, name):
        self.deleted.append(name)
        self.objects.pop(name, None)

    def doc(self, session_id):
        return json.loads(self.objects[session_name(session_id)][0])


class FakeLauncher:
    def __init__(self, fail=False, fail_cancel=False):
        self.launched = []
        self.cancelled = []
        self.fail = fail
        self.fail_cancel = fail_cancel

    def launch(self, session_id):
        if self.fail:
            raise RuntimeError("boom")
        self.launched.append(session_id)

    def cancel(self, execution):
        self.cancelled.append(execution)
        if self.fail_cancel:
            raise RuntimeError("cancel boom")


class Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now


def make_service(gcs=None, launcher=None, clock=None, **config):
    config = UploadConfig(BUCKET, job_name="shellhacks-upload-job", **config)
    return SessionService(config, gcs or FakeGcs(), signer=FakeSigner(), email=EMAIL,
                          launcher=launcher or FakeLauncher(), clock=clock or Clock())


@pytest.fixture
def api():
    gcs, launcher, clock = FakeGcs(), FakeLauncher(), Clock()
    service = make_service(gcs, launcher, clock)
    app = create_app()
    app.dependency_overrides[get_session_service] = lambda: service
    with TestClient(app) as http:
        yield http, gcs, launcher, clock


def create(http, size=len(PDF), headers=USER):
    return http.post("/projects/upload-sessions", json={"size_bytes": size}, headers=headers)


# -- V4 signing ---------------------------------------------------------------------

def test_v4_signed_put_url_golden():
    signer = FakeSigner()
    name = "uploads/SES_" + "0" * 32 + ".pdf"
    signed = sign_put_url(BUCKET, name, MAX, 900, signer, EMAIL, NOW)
    query = ("X-Goog-Algorithm=GOOG4-RSA-SHA256"
             "&X-Goog-Credential=shellhacks-api-runtime%40shellhacks-2026.iam.gserviceaccount.com"
             "%2F20260927%2Fauto%2Fstorage%2Fgoog4_request"
             "&X-Goog-Date=20260927T120000Z&X-Goog-Expires=900"
             "&X-Goog-SignedHeaders=content-type%3Bhost%3Bx-goog-content-length-range")
    canonical = (
        "PUT\n"
        f"/{BUCKET}/{name}\n"
        f"{query}\n"
        "content-type:application/pdf\n"
        "host:storage.googleapis.com\n"
        "x-goog-content-length-range:1,52428800\n"
        "\n"
        "content-type;host;x-goog-content-length-range\n"
        "UNSIGNED-PAYLOAD"
    )
    assert signed.canonical_request == canonical
    expected_sts = ("GOOG4-RSA-SHA256\n20260927T120000Z\n20260927/auto/storage/goog4_request\n"
                    + hashlib.sha256(canonical.encode()).hexdigest())
    assert signed.string_to_sign == expected_sts
    assert signer.signed == [expected_sts.encode()]
    assert signed.url == f"https://storage.googleapis.com/{BUCKET}/{name}?{query}&X-Goog-Signature=abcd"
    assert signed.headers == {"Content-Type": "application/pdf",
                              "x-goog-content-length-range": "1,52428800"}
    assert signed.expires_at == NOW + timedelta(seconds=900)


@pytest.mark.parametrize("expires", [0, 901, 604800])
def test_signing_rejects_expiry_outside_900_seconds(expires):
    with pytest.raises(ValueError):
        sign_put_url(BUCKET, "uploads/x.pdf", MAX, expires, FakeSigner(), EMAIL, NOW)


# -- configuration --------------------------------------------------------------------

def test_config_defaults_and_missing_env():
    config = UploadConfig.from_env({"UPLOAD_BUCKET": BUCKET, "UPLOAD_JOB_NAME": "shellhacks-upload-job"})
    assert (config.max_bytes, config.job_region, config.job_timeout_s) == (52_428_800, "us-east1", 3600)
    with pytest.raises(ConfigError):
        UploadConfig.from_env({"UPLOAD_JOB_NAME": "j"})
    with pytest.raises(ConfigError):
        UploadConfig.from_env({"UPLOAD_BUCKET": BUCKET})
    assert UploadConfig.from_env({"UPLOAD_BUCKET": BUCKET}, require_job=False).bucket == BUCKET
    with pytest.raises(ConfigError):
        UploadConfig.from_env({"UPLOAD_BUCKET": BUCKET, "UPLOAD_JOB_NAME": "j", "UPLOAD_MAX_BYTES": "x"})


def test_firebase_project_is_refused():
    with pytest.raises(ConfigError):
        UploadConfig.from_env({"UPLOAD_BUCKET": "shellhacks26-c78d4-uploads", "UPLOAD_JOB_NAME": "j"})
    with pytest.raises(ConfigError):
        UploadConfig.from_env({"UPLOAD_BUCKET": BUCKET, "UPLOAD_JOB_NAME": "shellhacks26-c78d4"})
    with pytest.raises(ValueError):
        sign_put_url(BUCKET, "uploads/x.pdf", MAX, 900, FakeSigner(),
                     "sa@shellhacks26-c78d4.iam.gserviceaccount.com", NOW)
    with pytest.raises(ValueError):
        GcsClient("shellhacks26-c78d4.appspot.com", session=object())
    with pytest.raises(ValueError):
        JobLauncher(object(), "shellhacks26-c78d4")


def test_missing_bucket_env_returns_503(monkeypatch):
    for name in ("UPLOAD_BUCKET", "UPLOAD_JOB_NAME"):
        monkeypatch.delenv(name, raising=False)
    with TestClient(create_app()) as http:
        response = create(http)
    assert response.status_code == 503


def test_agent_path_covers_new_posts_only():
    session = "SES_" + "a" * 32
    assert AGENT_PATH.fullmatch("/projects/upload-sessions")
    assert AGENT_PATH.fullmatch(f"/projects/upload-sessions/{session}/process")
    assert not AGENT_PATH.fullmatch(f"/projects/upload-sessions/{session}")
    assert not AGENT_PATH.fullmatch(f"/projects/upload-sessions/{session}/process/x")
    assert not AGENT_PATH.fullmatch(f"/projects/upload-sessions/{session}/cancel")


# -- create -----------------------------------------------------------------------------

def test_create_returns_signed_contract_and_stores_owned_session(api):
    http, gcs, _, _ = api
    response = create(http)
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"session_id", "upload_url", "method", "required_headers", "expires_at"}
    assert body["method"] == "PUT"
    assert body["required_headers"] == {"Content-Type": "application/pdf",
                                        "x-goog-content-length-range": f"1,{MAX}"}
    assert body["expires_at"] == "2026-09-27T12:15:00Z"
    sid = body["session_id"]
    assert body["upload_url"].startswith(f"https://storage.googleapis.com/{BUCKET}/uploads/{sid}.pdf?")
    assert "X-Goog-Expires=900" in body["upload_url"]
    text = json.dumps(body).lower()
    assert "token" not in text and "private_key" not in text and "bearer" not in text
    assert gcs.doc(sid)["owner"] == "user_1" and gcs.doc(sid)["status"] == "created"


@pytest.mark.parametrize("payload", [{"size_bytes": 0}, {"size_bytes": -1}, {"size_bytes": MAX + 1},
                                     {"size_bytes": "10"}, {}, {"size_bytes": 10, "filename": "x.pdf"}])
def test_create_rejects_bad_sizes_without_signing(api, payload):
    http, gcs, _, _ = api
    response = http.post("/projects/upload-sessions", json=payload, headers=USER)
    assert response.status_code == 422
    assert gcs.calls == []


def test_create_accepts_exact_max_and_requires_user(api):
    http, _, _, _ = api
    assert create(http, MAX).status_code == 201
    assert create(http, headers={}).status_code == 401


# -- process ----------------------------------------------------------------------------

def start(http, gcs, data=PDF):
    sid = create(http).json()["session_id"]
    if data is not None:
        gcs._put(object_name(sid), data)
    return sid


def process(http, sid, headers=USER):
    return http.post(f"/projects/upload-sessions/{sid}/process", headers=headers)


def test_process_launches_exactly_once(api):
    http, gcs, launcher, _ = api
    sid = start(http, gcs)
    first = process(http, sid)
    assert (first.status_code, first.json()) == (202, {"status": "queued"})
    second = process(http, sid)
    assert second.status_code == 200
    assert second.json()["status"] == "queued"
    assert launcher.launched == [sid]


def test_process_missing_object_is_409(api):
    http, gcs, launcher, _ = api
    sid = start(http, gcs, data=None)
    assert process(http, sid).status_code == 409
    assert launcher.launched == [] and gcs.doc(sid)["status"] == "created"


@pytest.mark.parametrize("data, code", [(b"<html>not a pdf", "invalid_pdf"),
                                        (b"%PDF-" + b"x" * 100, "too_large")])
def test_process_rejects_and_deletes_bad_objects(data, code):
    gcs, launcher = FakeGcs(), FakeLauncher()
    service = make_service(gcs, launcher, max_bytes=50)
    app = create_app()
    app.dependency_overrides[get_session_service] = lambda: service
    with TestClient(app) as http:
        sid = http.post("/projects/upload-sessions", json={"size_bytes": 10}, headers=USER).json()["session_id"]
        gcs._put(object_name(sid), data)
        assert process(http, sid).status_code == 422
    assert object_name(sid) in gcs.deleted and launcher.launched == []
    assert gcs.doc(sid)["error_code"] == code


def test_generation_race_does_not_launch_twice(api):
    http, gcs, launcher, _ = api
    sid = start(http, gcs)
    gcs.race_on_write = lambda doc: doc["status"] == "queued"
    response = process(http, sid)
    assert response.status_code == 200 and launcher.launched == []


def test_launch_failure_marks_failed_and_deletes(api):
    http, gcs, launcher, _ = api
    launcher.fail = True
    sid = start(http, gcs)
    assert process(http, sid).status_code == 502
    assert gcs.doc(sid)["status"] == "failed" and object_name(sid) in gcs.deleted


class DeleteFailsGcs(FakeGcs):
    def delete(self, name):
        self.deleted.append(name)
        raise GcsError("delete boom")


class DeleteAndWriteFailGcs(DeleteFailsGcs):
    def write_json(self, name, document, *, if_generation_match):
        if document.get("status") == "failed":
            raise GcsError("write boom")
        return super().write_json(name, document, if_generation_match=if_generation_match)


def test_launch_failure_cleanup_errors_still_return_502():
    gcs = DeleteFailsGcs()
    service = make_service(gcs, FakeLauncher(fail=True))
    sid = service.create("user_1", len(PDF))["session_id"]
    gcs._put(object_name(sid), PDF)
    with pytest.raises(SessionError) as raised:
        service.process("user_1", sid)
    assert (raised.value.status_code, raised.value.detail) == (502, "Processing could not be started")
    assert (gcs.doc(sid)["status"], gcs.doc(sid)["error_code"]) == ("failed", "internal")

    gcs = DeleteAndWriteFailGcs()
    service = make_service(gcs, FakeLauncher(fail=True))
    sid = service.create("user_1", len(PDF))["session_id"]
    gcs._put(object_name(sid), PDF)
    with pytest.raises(SessionError) as raised:
        service.process("user_1", sid)
    assert raised.value.status_code == 502 and object_name(sid) in gcs.deleted


# -- status / ownership -----------------------------------------------------------------

def test_status_shape_owner_and_stale_timeout(api):
    http, gcs, _, clock = api
    sid = start(http, gcs)
    status = http.get(f"/projects/upload-sessions/{sid}", headers=USER)
    assert status.json() == {"session_id": sid, "status": "created", "upload_id": None,
                             "error_code": None, "updated_at": "2026-09-27T12:00:00Z"}
    other = {"X-Authenticated-User": "user_2"}
    assert http.get(f"/projects/upload-sessions/{sid}", headers=other).status_code == 404
    assert process(http, sid, other).status_code == 404
    assert process(http, sid).status_code == 202
    clock.now = NOW + timedelta(seconds=3900)
    assert http.get(f"/projects/upload-sessions/{sid}", headers=USER).json()["status"] == "queued"
    clock.now = NOW + timedelta(seconds=3901)
    stale = http.get(f"/projects/upload-sessions/{sid}", headers=USER).json()
    assert (stale["status"], stale["error_code"], stale["upload_id"]) == ("failed", "timeout", None)


@pytest.mark.parametrize("bad", ["SES_123", "SES_" + "A" * 32, "UPL_" + "a" * 32, "SES_" + "a" * 33])
def test_bad_ids_are_422_before_any_gcs_call(api, bad):
    http, gcs, _, _ = api
    assert http.get(f"/projects/upload-sessions/{bad}", headers=USER).status_code == 422
    assert process(http, bad).status_code == 422
    assert gcs.calls == []


# -- job ----------------------------------------------------------------------------------

def queued_session(gcs, data=PDF):
    service = make_service(gcs)
    sid = service.create("user_1", len(data))["session_id"]
    gcs._put(object_name(sid), data)
    assert service.process("user_1", sid) == (202, {"status": "queued"})
    return service, sid


@contextmanager
def fake_store():
    yield object()


@pytest.fixture(autouse=True)
def no_summary(monkeypatch):
    """Job tests never reach the real summary module (stubbed per the W6 handshake)."""
    monkeypatch.setattr(upload_job, "default_summarize",
                        lambda store, upload_id, owner, *, progress=None: "rule_only")


def test_job_success_writes_upload_id_and_deletes_object():
    gcs = FakeGcs()
    service, sid = queued_session(gcs)
    calls = []

    def process_plan(path, store, progress=None):
        calls.append(path.read_bytes())
        return {"upload_id": "UPL_" + "b" * 32}

    status = upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                            process=process_plan, clock=Clock())
    assert status == "succeeded" and calls == [PDF]
    assert service.status("user_1", sid)["upload_id"] == "UPL_" + "b" * 32
    assert object_name(sid) in gcs.deleted
    assert ("write_json", session_name(sid), "processing") in gcs.calls


@pytest.mark.parametrize("error, code", [(SnowflakeError("secret detail"), "snowflake_failed"),
                                         (ValueError("some other value error"), "internal"),
                                         (KeyError("x"), "internal")])
def test_job_failure_is_generic_and_deletes_object(error, code):
    gcs = FakeGcs()
    service, sid = queued_session(gcs)

    def process_plan(path, store, progress=None):
        raise error

    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=process_plan) == "failed"
    view = service.status("user_1", sid)
    assert (view["status"], view["error_code"]) == ("failed", code)
    assert "secret" not in json.dumps(gcs.doc(sid))
    assert object_name(sid) in gcs.deleted


class NoReferenceStore:
    client = "client"

    def reference(self):
        raise ValueError("No reference dataset loaded; run python -m backend.projectdata seed first")


class SnowflakeReferenceStore(NoReferenceStore):
    def reference(self):
        raise SnowflakeError("secret detail")


@pytest.mark.parametrize("store, code", [(NoReferenceStore(), "reference_unavailable"),
                                         (SnowflakeReferenceStore(), "snowflake_failed")])
def test_job_classifies_reference_lookup_errors(store, code):
    gcs = FakeGcs()
    service, sid = queued_session(gcs)
    seen = []

    @contextmanager
    def factory():
        yield store

    def process_plan(path, guarded, progress=None):
        seen.append(guarded.client)
        guarded.reference()

    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=factory,
                          process=process_plan) == "failed"
    assert seen == ["client"] and gcs.doc(sid)["error_code"] == code


def test_job_config_value_error_is_internal():
    gcs = FakeGcs()
    service, sid = queued_session(gcs)

    @contextmanager
    def factory():
        raise ValueError("Missing Snowflake settings: SNOWFLAKE_ACCOUNT")
        yield  # pragma: no cover

    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=factory,
                          process=lambda path, store, progress=None: None) == "failed"
    assert gcs.doc(sid)["error_code"] == "internal"
    assert "SNOWFLAKE" not in json.dumps(gcs.doc(sid))


def test_job_rejects_tampered_object_before_processing():
    gcs = FakeGcs()
    service, sid = queued_session(gcs)
    gcs._put(object_name(sid), b"MZ-not-a-pdf")
    called = []
    status = upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                            process=lambda path, store, progress=None: called.append(path))
    assert status == "failed" and called == []
    assert gcs.doc(sid)["error_code"] == "invalid_pdf" and object_name(sid) in gcs.deleted


def test_job_skips_non_queued_sessions_and_main_exit_codes():
    gcs = FakeGcs()
    service = make_service(gcs)
    sid = service.create("user_1", 10)["session_id"]
    assert upload_job.run(sid, gcs=gcs, config=service.config) is None
    assert gcs.doc(sid)["status"] == "created"
    assert upload_job.main(["--session", "../etc"], gcs=gcs, config=service.config) == 2

    _, queued = queued_session(gcs)

    def process_plan(path, store, progress=None):
        raise SnowflakeError("x")

    assert upload_job.main(["--session", queued], gcs=gcs, config=service.config,
                           store_factory=fake_store, process=process_plan) == 0
    assert gcs.doc(queued)["status"] == "failed"


# -- transport adapters -----------------------------------------------------------------

class FakeResponse:
    def __init__(self, status_code, payload=None, content=b""):
        self.status_code = status_code
        self._payload = payload
        self.content = content

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def _next(self, method, url, **kwargs):
        self.requests.append((method, url, kwargs))
        return self.responses.pop(0)

    def get(self, url, **kwargs):
        return self._next("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self._next("POST", url, **kwargs)

    def delete(self, url, **kwargs):
        return self._next("DELETE", url, **kwargs)


def test_gcs_client_json_api_calls():
    session = FakeSession(FakeResponse(404), FakeResponse(412), FakeResponse(200, {"generation": "7"}),
                          FakeResponse(404))
    client = GcsClient(BUCKET, session)
    assert client.stat("sessions/SES_x.json") is None
    with pytest.raises(PreconditionFailed):
        client.write_json("sessions/SES_x.json", {"a": 1}, if_generation_match=0)
    assert client.write_json("sessions/SES_x.json", {"a": 1}, if_generation_match=3) == 7
    client.delete("uploads/SES_x.pdf")
    method, url, kwargs = session.requests[0]
    assert url == f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/sessions%2FSES_x.json"
    assert session.requests[2][2]["params"]["ifGenerationMatch"] == "3"


def test_job_launcher_posts_run_with_overrides():
    session = FakeSession(FakeResponse(200, {}))
    sid = "SES_" + "c" * 32
    JobLauncher(session, "shellhacks-upload-job").launch(sid)
    method, url, kwargs = session.requests[0]
    assert url == ("https://run.googleapis.com/v2/projects/shellhacks-2026/locations/us-east1"
                   "/jobs/shellhacks-upload-job:run")
    assert kwargs["json"] == {"overrides": {"containerOverrides": [
        {"args": ["-m", "backend.projectdata.upload_job", "--session", sid]}]}}
    with pytest.raises(RuntimeError):
        JobLauncher(FakeSession(FakeResponse(403)), "shellhacks-upload-job").launch(sid)


def test_job_launcher_cancel_posts_execution_cancel_and_rejects_malformed_names():
    session = FakeSession(FakeResponse(200, {}))
    launcher = JobLauncher(session, "shellhacks-upload-job", "us-east1")
    launcher.cancel("shellhacks-upload-job-x7k2p")
    method, url, _ = session.requests[0]
    assert (method, url) == ("POST", "https://run.googleapis.com/v2/projects/shellhacks-2026/"
                             "locations/us-east1/jobs/shellhacks-upload-job/executions/"
                             "shellhacks-upload-job-x7k2p:cancel")
    for bad in ("", "UPPER", "a/b", "../x", "a" * 64, None, 5, "x:cancel"):
        with pytest.raises(ValueError):
            launcher.cancel(bad)
    assert len(session.requests) == 1
    with pytest.raises(RuntimeError):
        JobLauncher(FakeSession(FakeResponse(403)), "shellhacks-upload-job").cancel("exec-1")


# -- cancel ---------------------------------------------------------------------------------

EXECUTION = "shellhacks-upload-job-abc12"


def cancel(http, sid, headers=USER):
    return http.post(f"/projects/upload-sessions/{sid}/cancel", headers=headers)


def set_status(gcs, sid, **changes):
    gcs._put(session_name(sid), json.dumps({**gcs.doc(sid), **changes}).encode())


def cancelled_view(sid, updated_at="2026-09-27T12:00:00Z"):
    return {"session_id": sid, "status": "cancelled", "upload_id": None, "error_code": None,
            "updated_at": updated_at}


@pytest.mark.parametrize("state", ["created", "queued", "processing"])
def test_cancel_from_each_active_status(api, state):
    http, gcs, launcher, clock = api
    sid = start(http, gcs)
    if state != "created":
        assert process(http, sid).status_code == 202
    if state == "processing":
        set_status(gcs, sid, status="processing", job_execution=EXECUTION, stage="extracting",
                   stage_detail={"done": 1, "total": 3}, stage_started_at="2026-09-27T12:00:00Z")
    clock.now = NOW + timedelta(seconds=30)
    response = cancel(http, sid)
    assert response.status_code == 200
    assert response.json() == cancelled_view(sid, "2026-09-27T12:00:30Z")
    doc = gcs.doc(sid)
    assert (doc["status"], doc["cancelled_at"]) == ("cancelled", "2026-09-27T12:00:30Z")
    assert object_name(sid) in gcs.deleted and object_name(sid) not in gcs.objects
    assert launcher.cancelled == ([EXECUTION] if state == "processing" else [])
    status = http.get(f"/projects/upload-sessions/{sid}", headers=USER).json()
    assert status == cancelled_view(sid, "2026-09-27T12:00:30Z")


def test_cancel_is_idempotent_and_never_times_out(api):
    http, gcs, launcher, clock = api
    sid = start(http, gcs)
    first = cancel(http, sid).json()
    clock.now = NOW + timedelta(days=1)
    assert cancel(http, sid).json() == first
    assert http.get(f"/projects/upload-sessions/{sid}", headers=USER).json() == first
    writes = [c for c in gcs.calls if c[0] == "write_json" and c[2] == "cancelled"]
    assert len(writes) == 1 and launcher.cancelled == []


def test_cancel_of_csv_session_deletes_csv_object_and_reports_kind(api):
    http, gcs, _, _ = api
    body = http.post("/projects/upload-sessions", json={"size_bytes": 10, "content_type": "text/csv"},
                     headers=USER).json()
    sid = body["session_id"]
    gcs._put(object_name(sid, "csv"), b"project_id,project_name,utility\n")
    assert cancel(http, sid).json() == {**cancelled_view(sid), "kind": "csv"}
    assert object_name(sid, "csv") in gcs.deleted


@pytest.mark.parametrize("final", [{"status": "succeeded", "upload_id": "UPL_" + "b" * 32},
                                   {"status": "failed", "error_code": "invalid_pdf"}])
def test_cancel_returns_terminal_sessions_unchanged(api, final):
    http, gcs, launcher, _ = api
    sid = start(http, gcs)
    set_status(gcs, sid, job_execution=EXECUTION, **final)
    before = gcs.doc(sid)
    response = cancel(http, sid)
    assert response.status_code == 200
    assert response.json() == http.get(f"/projects/upload-sessions/{sid}", headers=USER).json()
    assert response.json()["status"] == final["status"]
    assert gcs.doc(sid) == before and gcs.deleted == [] and launcher.cancelled == []


def test_cancel_owner_ids_and_auth(api):
    http, gcs, _, _ = api
    sid = start(http, gcs)
    assert cancel(http, sid, {"X-Authenticated-User": "user_2"}).status_code == 404
    assert cancel(http, "SES_" + "0" * 32).status_code == 404
    assert cancel(http, sid, {}).status_code == 401
    assert gcs.doc(sid)["status"] == "created" and gcs.deleted == []
    gcs.calls.clear()
    for bad in ("SES_123", "SES_" + "A" * 32, "UPL_" + "a" * 32):
        assert cancel(http, bad).status_code == 422
    assert gcs.calls == []


def test_cancel_gcs_error_is_502():
    class Unavailable(FakeGcs):
        def read_json(self, name):
            raise GcsError("down")

    service = make_service(Unavailable())
    app = create_app()
    app.dependency_overrides[get_session_service] = lambda: service
    with TestClient(app) as http:
        response = cancel(http, "SES_" + "a" * 32)
    assert response.status_code == 502


def test_cancel_retries_precondition_and_respects_an_intervening_terminal_write():
    gcs = FakeGcs()
    service = make_service(gcs)
    sid = service.create("user_1", len(PDF))["session_id"]

    def race(document):
        if document["status"] == "cancelled":
            set_status(gcs, sid, status="succeeded", upload_id="UPL_" + "c" * 32)
            return True
        return False

    gcs.race_on_write = race
    view = service.cancel("user_1", sid)
    assert (view["status"], view["upload_id"]) == ("succeeded", "UPL_" + "c" * 32)
    assert gcs.doc(sid)["status"] == "succeeded" and gcs.deleted == []

    sid = service.create("user_1", len(PDF))["session_id"]
    gcs.race_on_write = lambda document: document["status"] == "cancelled"
    assert service.cancel("user_1", sid)["status"] == "cancelled"
    assert gcs.doc(sid)["status"] == "cancelled"


def test_cancel_gives_up_after_three_lost_races():
    class AlwaysRaces(FakeGcs):
        def write_json(self, name, document, *, if_generation_match):
            if document.get("status") == "cancelled":
                self.calls.append(("write_json", name, "cancelled"))
                raise PreconditionFailed("race")
            return super().write_json(name, document, if_generation_match=if_generation_match)

    gcs = AlwaysRaces()
    service = make_service(gcs)
    sid = service.create("user_1", len(PDF))["session_id"]
    with pytest.raises(SessionError) as raised:
        service.cancel("user_1", sid)
    assert raised.value.status_code == 502
    assert gcs.calls.count(("write_json", session_name(sid), "cancelled")) == 3


def test_cancel_succeeds_when_execution_cancel_or_delete_fails():
    gcs, launcher = DeleteFailsGcs(), FakeLauncher(fail_cancel=True)
    service = make_service(gcs, launcher)
    sid = service.create("user_1", len(PDF))["session_id"]
    set_status(gcs, sid, status="processing", job_execution=EXECUTION)
    assert service.cancel("user_1", sid)["status"] == "cancelled"
    assert launcher.cancelled == [EXECUTION] and object_name(sid) in gcs.deleted
    assert gcs.doc(sid)["status"] == "cancelled"

    launcher = FakeLauncher()
    service = make_service(FakeGcs(), launcher)
    sid = service.create("user_1", len(PDF))["session_id"]
    set_status(service.gcs, sid, status="processing", job_execution="BAD/NAME")
    assert service.cancel("user_1", sid)["status"] == "cancelled"
    assert launcher.cancelled == []


def test_process_after_cancel_does_not_launch(api):
    http, gcs, launcher, _ = api
    sid = start(http, gcs)
    cancel(http, sid)
    gcs._put(object_name(sid), PDF)
    response = process(http, sid)
    assert response.status_code == 200 and response.json()["status"] == "cancelled"
    assert launcher.launched == []


# -- job cancel -------------------------------------------------------------------------------

def test_job_records_validated_execution_name_from_env():
    gcs = FakeGcs()
    service, sid = queued_session(gcs)
    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=lambda path, store, progress=None: {"upload_id": "UPL_" + "b" * 32},
                          env={"CLOUD_RUN_EXECUTION": EXECUTION}) == "succeeded"
    assert gcs.doc(sid)["job_execution"] == EXECUTION

    for env in ({}, {"CLOUD_RUN_EXECUTION": "Bad/Name"}, {"CLOUD_RUN_EXECUTION": "x" * 64}):
        service, sid = queued_session(gcs)
        seen = []

        def process_plan(path, store, progress=None, sid=sid, seen=seen):
            seen.append(gcs.doc(sid)["job_execution"])
            return {"upload_id": "UPL_" + "b" * 32}

        upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                       process=process_plan, env=env)
        assert seen == [None]


def test_job_skips_a_session_cancelled_while_queued():
    gcs = FakeGcs()
    service, sid = queued_session(gcs)
    service.cancel("user_1", sid)
    assert upload_job.run(sid, gcs=gcs, config=service.config) is None
    assert gcs.doc(sid)["status"] == "cancelled"


def test_job_cancelled_before_download_opens_no_store():
    class CancelOnValidate(FakeGcs):
        hook = None
        downloads = 0

        def read_range(self, name, start, end):
            data = super().read_range(name, start, end)
            if self.hook:
                hook, self.hook = self.hook, None
                hook()
            return data

        def download_to(self, name, path, max_bytes):
            self.downloads += 1
            return super().download_to(name, path, max_bytes)

    gcs = CancelOnValidate()
    service, sid = queued_session(gcs)
    gcs.hook = lambda: service.cancel("user_1", sid)
    opened = []

    @contextmanager
    def factory():
        opened.append(True)
        yield object()

    status = upload_job.run(sid, gcs=gcs, config=service.config, store_factory=factory,
                            process=lambda path, store, progress=None: {"upload_id": "x"})
    assert status == "cancelled" and opened == [] and gcs.downloads == 0
    assert service.status("user_1", sid) == cancelled_view(sid)
    assert gcs.doc(sid)["stage"] == "validating"


def test_job_cancelled_before_processing_never_calls_process():
    class CancelOnDownload(FakeGcs):
        hook = None

        def download_to(self, name, path, max_bytes):
            size = super().download_to(name, path, max_bytes)
            self.hook()
            return size

    gcs = CancelOnDownload()
    service, sid = queued_session(gcs)
    gcs.hook = lambda: service.cancel("user_1", sid)
    called = []
    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=lambda path, store, progress=None: called.append(1)) == "cancelled"
    assert called == [] and gcs.doc(sid)["status"] == "cancelled"


def test_job_cancelled_during_process_skips_summary_and_final_write():
    gcs = FakeGcs()
    service, sid = queued_session(gcs)
    summaries = []

    def process_plan(path, store, progress=None):
        service.cancel("user_1", sid)
        return {"upload_id": "UPL_" + "d" * 32}

    status = upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                            process=process_plan,
                            summarize=lambda *args, **kwargs: summaries.append(args))
    assert status == "cancelled" and summaries == []
    doc = gcs.doc(sid)
    assert (doc["status"], doc["upload_id"]) == ("cancelled", None)
    assert not [c for c in gcs.calls if c[0] == "write_json" and c[2] in ("succeeded", "failed")]
    assert service.status("user_1", sid)["upload_id"] is None


def test_job_failure_after_cancel_never_flips_the_status():
    gcs = FakeGcs()
    service, sid = queued_session(gcs)

    def process_plan(path, store, progress=None):
        service.cancel("user_1", sid)
        raise SnowflakeError("x")

    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=process_plan) == "cancelled"
    assert gcs.doc(sid)["status"] == "cancelled"


def test_write_final_never_overwrites_a_cancelled_session():
    gcs = FakeGcs()
    service, sid = queued_session(gcs)
    key = session_name(sid)
    set_status(gcs, sid, status="processing")
    _, generation = gcs.read_json(key)
    service.cancel("user_1", sid)
    final = {**gcs.doc(sid), "status": "succeeded", "upload_id": "UPL_" + "e" * 32}
    # Direct path: the generation-matched write loses to the cancel.
    assert upload_job._write_final(gcs, key, sid, final, generation) == "cancelled"
    # Retry path (lost-ack recovery) re-reads and refuses a non-processing document.
    gcs.race_on_write = lambda document: document["status"] == "failed"
    _, current = gcs.read_json(key)
    assert upload_job._write_final(gcs, key, sid, {**final, "status": "failed"}, current) \
        == "cancelled"
    assert gcs.doc(sid)["status"] == "cancelled" and gcs.doc(sid)["upload_id"] is None
