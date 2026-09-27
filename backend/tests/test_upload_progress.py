"""Offline tests for pipeline stage progress, the progress reporter, and CSV upload sessions."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import timedelta
import json
import sys

from fastapi.testclient import TestClient
import pytest

from backend.app.api.routes.upload_sessions import get_session_service
from backend.app.main import create_app
from backend.documentparsing.extraction import CHUNK_CHARS, extract_document
from backend.documentparsing.pipeline import run_pipeline
from backend.documentparsing.tests.test_documents import FakeCortex, row
from backend.projectdata import upload_job
from backend.projectdata.gcs import GcsError, PreconditionFailed
from backend.projectdata.pipeline import process_plan
from backend.projectdata.progress import ProgressReporter
from backend.projectdata.upload_sessions import STAGES, UploadConfig, object_name, session_name
from backend.tests.test_projectdata import MemoryStore
from backend.tests.test_upload_sessions import (
    BUCKET, NOW, PDF, USER, Clock, FakeGcs, FakeLauncher, make_service,
)

CSV_MAX = 10_485_760
CSV = b"project_id,project_name,utility,state,lat_a,lon_a,in_service_date\nA,Alpha Rebuild,Utility A,SC,33.0,-81.0,2026-06-01\n"


ORIGINAL_SUMMARIZE = upload_job.default_summarize


@pytest.fixture(autouse=True)
def stub_summary(monkeypatch):
    """Never reach the real summary module (W6) from these offline job tests."""
    monkeypatch.setattr(upload_job, "default_summarize",
                        lambda store, upload_id, owner, *, progress=None: "rule_only")


class Recorder:
    def __init__(self):
        self.events = []

    def __call__(self, stage, done=None, total=None):
        self.events.append((stage, done, total))

    @property
    def stages(self):
        return [stage for stage, _, _ in self.events]


# -- pipeline callback ----------------------------------------------------------------------

def test_document_progress_order_through_process_plan(tmp_path):
    plan = tmp_path / "plan.pdf"
    plan.write_bytes(b"%PDF-1.7\nfixture")
    recorder = Recorder()
    provider = FakeCortex(rows=[row(latitude="33.0", longitude="-81.0")])
    result = process_plan(plan, MemoryStore(), provider, progress=recorder)
    assert result["collision_count"] == 1
    assert recorder.events == [("staging", None, None), ("parsing", None, None),
                               ("extracting", 0, 1), ("extracting", 1, 1),
                               ("locating", None, None), ("matching", None, None),
                               ("saving", None, None)]


def test_extracting_counts_every_unit_in_order(tmp_path):
    plan = tmp_path / "plan.pdf"
    plan.write_bytes(b"%PDF-1.7\nfixture")
    pages = [("line of scope text\n" * (CHUNK_CHARS // 10)), "Project two"]
    recorder = Recorder()
    provider = FakeCortex(pages=pages)
    extract_document(plan, provider, progress=recorder)
    extracting = [(done, total) for stage, done, total in recorder.events if stage == "extracting"]
    extracts = sum(1 for call in provider.calls if call[0] == "extract")
    assert extracts > 2
    assert extracting == [(i, extracts) for i in range(extracts + 1)]
    assert recorder.stages[:2] == ["staging", "parsing"]


def test_json_branch_emits_only_matching_and_saving(tmp_path):
    path = tmp_path / "projects.json"
    path.write_text(json.dumps([{"project_id": "P1", "project_name": "Alpha", "latitude": 33.0,
                                 "longitude": -81.0, "source_document": "x.pdf"}]), encoding="utf-8")
    recorder = Recorder()
    process_plan(path, MemoryStore(), None, progress=recorder)
    assert recorder.stages == ["matching", "saving"]


def test_structured_csv_emits_locating_matching_saving(tmp_path):
    path = tmp_path / "plan.csv"
    path.write_bytes(CSV)
    recorder = Recorder()
    result = process_plan(path, MemoryStore(), None, progress=recorder)
    assert result["upload_id"].startswith("UPL_")
    assert recorder.stages == ["locating", "matching", "saving"]


def test_callers_without_callback_are_unchanged(tmp_path):
    plan = tmp_path / "plan.pdf"
    plan.write_bytes(b"%PDF-1.7\nfixture")
    silent, observed = FakeCortex(), FakeCortex()
    projects, audit = extract_document(plan, silent)
    projects_cb, audit_cb = extract_document(plan, observed, progress=Recorder())
    assert projects == projects_cb and silent.calls == observed.calls
    assert {k: v for k, v in audit.items() if k != "stage_path"} == \
        {k: v for k, v in audit_cb.items() if k != "stage_path"}
    assert run_pipeline([plan], tmp_path / "out", client=FakeCortex(),
                        cache_dir=tmp_path / "cache")["project_count"] == 1


# -- reporter ---------------------------------------------------------------------------------

def processing_doc(gcs, sid="SES_" + "d" * 32):
    document = {"session_id": sid, "owner": "user_1", "status": "processing",
                "updated_at": "2026-09-27T12:00:00Z"}
    generation = gcs._put(session_name(sid), json.dumps(document).encode())
    return sid, document, generation


def stored(gcs, sid):
    return json.loads(gcs.objects[session_name(sid)][0])


def test_reporter_throttles_extracting_and_forces_final():
    gcs, clock = FakeGcs(), Clock()
    sid, document, generation = processing_doc(gcs)
    reporter = ProgressReporter(gcs, session_name(sid), document, generation, clock=clock)
    writes = lambda: sum(1 for call in gcs.calls if call[0] == "write_json")  # noqa: E731
    reporter("staging")
    reporter("staging")  # same stage, no detail: no write
    assert writes() == 1
    reporter("extracting", 0, 10)  # stage change: immediate
    assert writes() == 2 and stored(gcs, sid)["stage_detail"] == {"done": 0, "total": 10}
    clock.now = NOW + timedelta(seconds=4)
    reporter("extracting", 1, 10)
    assert writes() == 2
    clock.now = NOW + timedelta(seconds=5)
    reporter("extracting", 2, 10)
    assert writes() == 3 and stored(gcs, sid)["stage_detail"] == {"done": 2, "total": 10}
    clock.now = NOW + timedelta(seconds=6)
    reporter("extracting", 10, 10)  # forced final write
    doc = stored(gcs, sid)
    assert writes() == 4 and doc["stage_detail"] == {"done": 10, "total": 10}
    assert doc["stage_started_at"] == "2026-09-27T12:00:00Z"
    assert doc["stage_updated_at"] == "2026-09-27T12:00:06Z"
    assert doc["updated_at"] == "2026-09-27T12:00:00Z"
    reporter("locating")
    assert stored(gcs, sid)["stage_detail"] is None
    assert reporter.generation == gcs.objects[session_name(sid)][1]


def test_reporter_conflict_disables_without_raising():
    gcs = FakeGcs()
    sid, document, generation = processing_doc(gcs)
    reporter = ProgressReporter(gcs, session_name(sid), document, generation, clock=Clock())
    gcs._put(session_name(sid), json.dumps({**document, "status": "failed"}).encode())
    reporter("staging")
    assert not reporter.active and reporter.generation == generation
    reporter("parsing")
    assert stored(gcs, sid)["status"] == "failed" and "stage" not in stored(gcs, sid)


def test_reporter_conflict_with_a_cancel_sets_cancelled():
    gcs = FakeGcs()
    sid, document, generation = processing_doc(gcs)
    reporter = ProgressReporter(gcs, session_name(sid), document, generation, clock=Clock())
    assert reporter.cancelled is False
    gcs._put(session_name(sid), json.dumps({**document, "status": "cancelled"}).encode())
    reporter("staging")
    assert reporter.cancelled and not reporter.active
    reporter("parsing")
    assert stored(gcs, sid)["status"] == "cancelled" and "stage" not in stored(gcs, sid)

    # A failed conflict re-read is swallowed and does not claim a cancel.
    class ReadFails(FakeGcs):
        def read_json(self, name):
            raise GcsError("down")

    gcs = ReadFails()
    sid, document, generation = processing_doc(gcs)
    reporter = ProgressReporter(gcs, session_name(sid), document, generation, clock=Clock())
    gcs._put(session_name(sid), json.dumps({**document, "status": "cancelled"}).encode())
    reporter("staging")
    assert not reporter.cancelled and not reporter.active


def test_reporter_never_writes_over_a_cancelled_document():
    gcs = FakeGcs()
    sid, document, generation = processing_doc(gcs)
    reporter = ProgressReporter(gcs, session_name(sid), {**document, "status": "cancelled"},
                                generation, clock=Clock())
    reporter("saving")
    assert [c for c in gcs.calls if c[0] == "write_json"] == []


def test_job_stops_when_a_progress_write_finds_the_session_cancelled():
    gcs = FakeGcs()
    service, sid = queued(gcs)
    summaries = []

    def process(path, store, progress=None):
        service.cancel("user_1", sid)
        progress("saving")  # conflicts, re-reads, and flags the cancel
        return {"upload_id": "UPL_" + "9" * 32}

    status = upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                            process=process, summarize=lambda *a, **k: summaries.append(a))
    assert status == "cancelled" and summaries == []
    view = service.status("user_1", sid)
    assert view == {"session_id": sid, "status": "cancelled", "upload_id": None,
                    "error_code": None, "updated_at": view["updated_at"]}


def test_reporter_exception_disables_and_close_blocks():
    class Broken(FakeGcs):
        def write_json(self, name, document, *, if_generation_match):
            raise GcsError("boom")

    gcs = Broken()
    sid, document, generation = processing_doc(gcs)
    reporter = ProgressReporter(gcs, session_name(sid), document, generation, clock=Clock())
    reporter("staging")
    assert not reporter.active

    gcs = FakeGcs()
    sid, document, generation = processing_doc(gcs)
    reporter = ProgressReporter(gcs, session_name(sid), document, generation, clock=Clock())
    reporter.close()
    reporter("staging")
    assert "stage" not in stored(gcs, sid)


def test_reporter_never_writes_terminal_or_unknown_stages():
    gcs = FakeGcs()
    sid, document, generation = processing_doc(gcs)
    reporter = ProgressReporter(gcs, session_name(sid), {**document, "status": "succeeded"},
                                generation, clock=Clock())
    reporter("saving")
    reporter = ProgressReporter(gcs, session_name(sid), document, generation, clock=Clock())
    reporter("bogus")
    reporter("extracting", 5, 2)  # invalid detail is dropped, stage still written
    assert stored(gcs, sid)["stage"] == "extracting" and stored(gcs, sid)["stage_detail"] is None
    assert [c for c in gcs.calls if c[0] == "write_json"] == [
        ("write_json", session_name(sid), "processing")]


# -- job --------------------------------------------------------------------------------------

def queued(gcs, data=PDF, content_type=None, **config):
    service = make_service(gcs, **config)
    sid = service.create("user_1", len(data), content_type)["session_id"]
    kind = "csv" if content_type == "text/csv" else "pdf"
    gcs._put(object_name(sid, kind), data)
    assert service.process("user_1", sid) == (202, {"status": "queued"})
    return service, sid


@contextmanager
def fake_store():
    yield "store"


class StageLog(FakeGcs):
    def __init__(self):
        super().__init__()
        self.stages = []

    def write_json(self, name, document, *, if_generation_match):
        generation = super().write_json(name, document, if_generation_match=if_generation_match)
        if document.get("status") == "processing" and document.get("stage"):
            self.stages.append((document["stage"], document.get("stage_detail")))
        return generation


def test_job_reports_stages_then_summarizes_and_succeeds():
    gcs = StageLog()
    service, sid = queued(gcs)
    summaries = []

    def process(path, store, progress=None):
        progress("staging")
        progress("extracting", 0, 2)
        progress("extracting", 2, 2)
        progress("saving")
        return {"upload_id": "UPL_" + "e" * 32}

    def summarize(store, upload_id, owner, *, progress=None):
        summaries.append((store, upload_id, owner, progress is not None))
        return "rule_only"

    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=process, summarize=summarize, clock=Clock()) == "succeeded"
    assert [stage for stage, _ in gcs.stages] == ["validating", "staging", "extracting", "extracting",
                                                  "saving", "summarizing"]
    assert gcs.stages[3] == ("extracting", {"done": 2, "total": 2})
    assert summaries == [("store", "UPL_" + "e" * 32, "user_1", True)]
    view = service.status("user_1", sid)
    assert view["status"] == "succeeded" and "stage" not in view


@pytest.mark.parametrize("failure", [RuntimeError("model down"), ImportError("no module")])
def test_summary_failure_never_fails_the_job(failure):
    gcs = FakeGcs()
    service, sid = queued(gcs)

    def summarize(store, upload_id, owner, *, progress=None):
        raise failure

    status = upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                            process=lambda path, store, progress=None: {"upload_id": "UPL_" + "f" * 32},
                            summarize=summarize)
    assert status == "succeeded" and gcs.doc(sid)["upload_id"] == "UPL_" + "f" * 32


def test_missing_summary_module_is_tolerated(monkeypatch):
    monkeypatch.setitem(sys.modules, "backend.projectdata.summary", None)
    monkeypatch.setattr(upload_job, "default_summarize", ORIGINAL_SUMMARIZE)
    assert upload_job.default_summarize("store", "UPL_x", "user_1", progress=None) is None
    gcs = FakeGcs()
    service, sid = queued(gcs)
    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=lambda path, store, progress=None: {"upload_id": "UPL_" + "a" * 32}
                          ) == "succeeded"


def test_failure_keeps_last_stage_and_view_exposes_it():
    gcs = FakeGcs()
    service, sid = queued(gcs)

    def process(path, store, progress=None):
        progress("extracting", 3, 7)
        raise RuntimeError("boom")

    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=process, clock=Clock()) == "failed"
    view = service.status("user_1", sid)
    assert (view["status"], view["error_code"], view["stage"]) == ("failed", "internal", "extracting")
    assert view["stage_detail"] == {"done": 3, "total": 7}
    assert view["stage_started_at"] == "2026-09-27T12:00:00Z"


def test_progress_conflict_and_write_errors_do_not_fail_the_job():
    gcs = FakeGcs()
    service, sid = queued(gcs)
    gcs.race_on_write = lambda doc: doc.get("stage") == "saving"

    def process(path, store, progress=None):
        progress("saving")
        progress("matching")  # reporter is disabled after the conflict
        return {"upload_id": "UPL_" + "1" * 32}

    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=process) == "succeeded"
    assert gcs.doc(sid)["stage"] == "validating"

    class FlakyProgress(FakeGcs):
        def write_json(self, name, document, *, if_generation_match):
            if document.get("status") == "processing" and document.get("stage") == "saving":
                raise GcsError("transport")
            return super().write_json(name, document, if_generation_match=if_generation_match)

    gcs = FlakyProgress()
    service, sid = queued(gcs)
    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=process) == "succeeded"
    assert gcs.doc(sid)["status"] == "succeeded"


def test_final_write_recovers_when_a_progress_write_committed_unobserved():
    class LostAck(FakeGcs):
        def write_json(self, name, document, *, if_generation_match):
            generation = super().write_json(name, document, if_generation_match=if_generation_match)
            if document.get("status") == "processing" and document.get("stage") == "saving":
                raise GcsError("response lost after commit")
            return generation

    gcs = LostAck()
    service, sid = queued(gcs)
    status = upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                            process=lambda path, store, progress=None:
                            progress("saving") or {"upload_id": "UPL_" + "2" * 32})
    assert status == "succeeded" and gcs.doc(sid)["status"] == "succeeded"


def test_view_stage_fields_only_for_processing_and_failed_and_stale_timeout_unchanged():
    gcs, clock = FakeGcs(), Clock()
    service = make_service(gcs, clock=clock)
    sid = service.create("user_1", len(PDF))["session_id"]
    base = gcs.doc(sid)
    detail = {"stage": "extracting", "stage_detail": {"done": 1, "total": 4},
              "stage_started_at": "2026-09-27T12:00:00Z", "stage_updated_at": "2026-09-27T12:59:00Z"}
    for status in ("created", "queued", "succeeded"):
        assert "stage" not in service.view({**base, **detail, "status": status})
    view = service.view({**base, **detail, "status": "processing"})
    assert (view["stage"], view["stage_detail"]) == ("extracting", {"done": 1, "total": 4})
    assert "kind" not in view
    bad = service.view({**base, "status": "processing", "stage": "hacking",
                        "stage_detail": {"done": 9, "total": 1}, "stage_started_at": "x"})
    assert (bad["stage"], bad["stage_detail"], bad["stage_started_at"]) == (None, None, None)
    bad = service.view({**base, **detail, "status": "processing", "stage_detail": {"done": 5, "total": 4}})
    assert bad["stage_detail"] is None
    # A fresh stage_updated_at never extends the stale timeout, which reads updated_at only.
    clock.now = NOW + timedelta(seconds=3901)
    stale = service.view({**base, **detail, "status": "processing",
                          "stage_updated_at": "2026-09-27T13:05:00Z"})
    assert (stale["status"], stale["error_code"], stale["stage"]) == ("failed", "timeout", "extracting")


def test_stages_contract():
    assert STAGES == ("validating", "staging", "parsing", "extracting", "locating", "matching",
                      "saving", "summarizing")


# -- CSV sessions -----------------------------------------------------------------------------

@pytest.fixture
def api():
    gcs, launcher, clock = FakeGcs(), FakeLauncher(), Clock()
    service = make_service(gcs, launcher, clock)
    app = create_app()
    app.dependency_overrides[get_session_service] = lambda: service
    with TestClient(app) as http:
        yield http, gcs, launcher


def create_csv(http, size=len(CSV), content_type="text/csv"):
    return http.post("/projects/upload-sessions", json={"size_bytes": size, "content_type": content_type},
                     headers=USER)


def test_csv_create_signs_text_csv_with_csv_cap(api):
    http, gcs, _ = api
    response = create_csv(http)
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"session_id", "upload_url", "method", "required_headers", "expires_at"}
    sid = body["session_id"]
    assert body["required_headers"] == {"Content-Type": "text/csv",
                                        "x-goog-content-length-range": f"1,{CSV_MAX}"}
    assert body["upload_url"].startswith(f"https://storage.googleapis.com/{BUCKET}/uploads/{sid}.csv?")
    assert gcs.doc(sid)["kind"] == "csv"
    assert create_csv(http, CSV_MAX).status_code == 201


@pytest.mark.parametrize("payload", [{"size_bytes": CSV_MAX + 1, "content_type": "text/csv"},
                                     {"size_bytes": 10, "content_type": "image/png"},
                                     {"size_bytes": 10, "content_type": "text/csv; charset=utf-8"},
                                     {"size_bytes": 10, "content_type": 5}])
def test_csv_create_rejects_bad_type_or_size_without_gcs(api, payload):
    http, gcs, _ = api
    response = http.post("/projects/upload-sessions", json=payload, headers=USER)
    assert response.status_code == 422 and gcs.calls == []


def test_default_content_type_is_pdf(api):
    http, gcs, _ = api
    for payload in ({"size_bytes": 10}, {"size_bytes": 10, "content_type": None},
                    {"size_bytes": 10, "content_type": "application/pdf"}):
        body = http.post("/projects/upload-sessions", json=payload, headers=USER).json()
        assert body["required_headers"]["Content-Type"] == "application/pdf"
        assert f"/uploads/{body['session_id']}.pdf?" in body["upload_url"]
        assert gcs.doc(body["session_id"])["kind"] == "pdf"


def process_csv(http, gcs, data):
    sid = create_csv(http, len(data)).json()["session_id"]
    gcs._put(object_name(sid, "csv"), data)
    return sid, http.post(f"/projects/upload-sessions/{sid}/process", headers=USER)


def test_csv_process_accepts_valid_and_view_reports_kind(api):
    http, gcs, launcher = api
    sid, response = process_csv(http, gcs, b"\xef\xbb\xbf" + CSV)
    assert (response.status_code, response.json()) == (202, {"status": "queued"})
    assert launcher.launched == [sid]
    view = http.get(f"/projects/upload-sessions/{sid}", headers=USER).json()
    assert view["kind"] == "csv" and view["status"] == "queued"


@pytest.mark.parametrize("data", [
    "project_id,project_name,utility\nA,Caf\xe9,U\n".encode("latin-1"),   # not UTF-8
    b"project_id,name,utility\nA,Alpha,U\n",                               # missing column
    PDF,                                                                   # PDF sent as CSV
    b"project_id,project_name,utility",                                    # ok: single header line
])
def test_csv_process_rejects_bad_content(api, data):
    http, gcs, launcher = api
    sid, response = process_csv(http, gcs, data)
    if data == b"project_id,project_name,utility":
        assert response.status_code == 202
        return
    assert response.status_code == 422 and launcher.launched == []
    assert gcs.doc(sid)["error_code"] == "invalid_csv" and object_name(sid, "csv") in gcs.deleted


def test_csv_oversize_and_stored_content_type_mismatch():
    gcs = FakeGcs()
    service = make_service(gcs, max_csv_bytes=40)
    sid = service.create("user_1", 40, "text/csv")["session_id"]
    gcs._put(object_name(sid, "csv"), CSV)
    with pytest.raises(Exception) as raised:
        service.process("user_1", sid)
    assert raised.value.status_code == 422 and gcs.doc(sid)["error_code"] == "too_large"

    class Typed(FakeGcs):
        def stat(self, name):
            meta = super().stat(name)
            return meta and {**meta, "contentType": "application/pdf"}

    gcs = Typed()
    service = make_service(gcs)
    sid = service.create("user_1", len(CSV), "text/csv")["session_id"]
    gcs._put(object_name(sid, "csv"), CSV)
    with pytest.raises(Exception) as raised:
        service.process("user_1", sid)
    assert raised.value.status_code == 422 and gcs.doc(sid)["error_code"] == "invalid_csv"


def test_csv_config_env():
    env = {"UPLOAD_BUCKET": BUCKET, "UPLOAD_JOB_NAME": "shellhacks-upload-job"}
    assert UploadConfig.from_env(env).max_csv_bytes == CSV_MAX
    assert UploadConfig.from_env({**env, "UPLOAD_MAX_CSV_BYTES": "1000"}).limit("csv") == 1000
    with pytest.raises(ValueError):
        UploadConfig.from_env({**env, "UPLOAD_MAX_CSV_BYTES": "0"})


def test_job_processes_csv_with_csv_suffix():
    gcs = StageLog()
    service, sid = queued(gcs, CSV, "text/csv")
    seen = []

    def process(path, store, progress=None):
        seen.append((path.suffix, path.read_bytes()))
        return {"upload_id": "UPL_" + "3" * 32}

    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=process) == "succeeded"
    assert seen == [(".csv", CSV)] and object_name(sid, "csv") in gcs.deleted
    assert service.status("user_1", sid)["kind"] == "csv"


def test_job_rejects_csv_whose_body_is_not_utf8_beyond_the_checked_prefix():
    gcs = FakeGcs()
    data = CSV + b"B,Beta,U\n" * 8000 + b"C,\xff,U\n"
    assert len(data) > 65_536
    service, sid = queued(gcs, data, "text/csv")
    called = []
    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=lambda path, store, progress=None: called.append(path)) == "failed"
    assert called == [] and gcs.doc(sid)["error_code"] == "invalid_csv"
    assert gcs.doc(sid)["stage"] == "validating"


def test_legacy_session_without_kind_is_processed_as_pdf():
    gcs = FakeGcs()
    service, sid = queued(gcs)
    document = gcs.doc(sid)
    del document["kind"]
    gcs._put(session_name(sid), json.dumps(document).encode())
    seen = []
    assert upload_job.run(sid, gcs=gcs, config=service.config, store_factory=fake_store,
                          process=lambda path, store, progress=None:
                          seen.append(path.suffix) or {"upload_id": "UPL_" + "4" * 32}) == "succeeded"
    assert seen == [".pdf"] and object_name(sid) in gcs.deleted
    assert "kind" not in service.status("user_1", sid)
