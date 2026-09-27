from __future__ import annotations

import asyncio
import json
import threading
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient
import pytest

from backend.app.agents.collision_pipeline.clients import DiagnosisClientResult
from backend.app.api.deps import get_upload_diagnosis_service
from backend.app.api.rate_limit import AGENT_PATH
from backend.app.api.routes.projects import get_project_store
from backend.app.main import create_app
from backend.app.schemas.diagnosis import DiagnosisDecision, Thresholds
from backend.app.services.diagnosis_rules import allowed_verdicts
from backend.app.services.similarity import score_pairs
from backend.documentparsing.snowflake import SnowflakeError
from backend.projectdata.diagnosis import UploadDiagnosisService, upload_diagnosis_input
from backend.projectdata.records import ProjectPoint
from backend.projectdata.storage import ProjectStore


UPLOAD = "UPL_" + "a" * 32
OVERLAP = "COL_" + "b" * 24
PATH = f"/projects/uploads/{UPLOAD}/collisions/{OVERLAP}/diagnosis"
RAW_SENTINEL = "REFERENCE_RAW_MUST_STAY_OUT"


def point(record_id, *, name="Grid upgrade", owner="Utility", date=None, year=None, reference=False):
    source = ({"document": "reference.csv", "row": 2, "raw": {"secret": RAW_SENTINEL}}
              if reference else {"project_id": record_id, "project_name": name, "utility": "source utility",
                                 "state": "SC", "need": "Improve reliability"})
    return ProjectPoint(
        record_id=record_id, project_id=record_id, project_name=name, owner=owner,
        latitude=33, longitude=-81, semantic_text=name, description="Line work",
        in_service_date=date, estimated_in_service_year=year,
        date_precision="day" if date else "year" if year else "unknown", source=source,
    ).model_dump(mode="json")


def collision(*, uploaded=None, reference=None, gap=None, distance=5):
    return {
        "overlap_id": OVERLAP, "distance_mi": distance, "time_gap_days": gap,
        "timing_basis": "in_service_date_proxy" if gap is not None else "unknown_exact_dates",
        "uploaded_project": uploaded or point("uploaded"),
        "reference_project": reference or point("reference", reference=True, year=2028),
    }


class StubClient:
    def __init__(self, verdict="RESEQUENCE"):
        self.verdict = verdict
        self.calls = 0
        self.inputs = []

    async def diagnose(self, diagnosis_input):
        self.calls += 1
        self.inputs.append(diagnosis_input)
        return DiagnosisClientResult(DiagnosisDecision(verdict=self.verdict, rationale="Move the work."))


def service(fake_encoder, client):
    return UploadDiagnosisService(lambda: fake_encoder, client, Thresholds(), "stub-model", "diag.v2")


def test_exact_dates_tier_and_one_client_call(fake_encoder):
    stored = collision(uploaded=point("uploaded", date="2028-05-01"),
                       reference=point("reference", reference=True, date="2028-05-31"), gap=30)
    client = StubClient("CO_SCHEDULE")
    result = asyncio.run(service(fake_encoder, client).diagnose(UPLOAD, stored))
    assert (result.upload_id, result.overlap_id, result.timing_basis, result.missing_dates) == (
        UPLOAD, OVERLAP, "exact_dates", [],
    )
    assert client.inputs[0].overlap.time_gap_days == 30
    assert client.inputs[0].allowed_verdicts == list(allowed_verdicts(client.inputs[0].overlap, Thresholds()))
    assert result.diagnosis.verdict == "CO_SCHEDULE"
    assert client.calls == 1


@pytest.mark.parametrize("reference_year,expected_gap,expected_allowed", [
    (2028, 0, ("CO_SCHEDULE", "RESEQUENCE")),
    (2029, 0, ("CO_SCHEDULE", "RESEQUENCE")),
    (2030, 365, ("CO_SCHEDULE", "RESEQUENCE")),
    (2032, 1095, ("CO_SCHEDULE", "RESEQUENCE")),
    (2033, 1460, ("NO_ACTION",)),
])
def test_year_precision_boundaries(fake_encoder, reference_year, expected_gap, expected_allowed):
    stored = collision(uploaded=point("uploaded", date="2028-05-01"),
                       reference=point("reference", reference=True, year=reference_year))
    client = StubClient("CO_SCHEDULE")
    result = asyncio.run(service(fake_encoder, client).diagnose(UPLOAD, stored))
    assert result.timing_basis == "year_precision"
    assert result.missing_dates == []
    assert client.inputs[0].overlap.time_gap_days == expected_gap
    assert tuple(result.diagnosis.allowed_verdicts) == expected_allowed
    assert client.calls == 1


def test_timing_unknown_excludes_co_schedule_and_guard_overrides(fake_encoder):
    client = StubClient("CO_SCHEDULE")
    result = asyncio.run(service(fake_encoder, client).diagnose(UPLOAD, collision()))
    assert result.timing_basis == "timing_unknown"
    assert result.missing_dates == ["uploaded_project"]
    assert client.inputs[0].overlap.time_gap_days == 0
    assert result.diagnosis.allowed_verdicts == ["RESEQUENCE"]
    assert result.diagnosis.verdict == "RESEQUENCE"
    assert result.diagnosis.overridden is True
    assert client.calls == 1
    both_missing = upload_diagnosis_input(
        collision(reference=point("reference", reference=True)), fake_encoder, Thresholds(),
    )
    assert both_missing[2] == ["uploaded_project", "reference_project"]
    far = upload_diagnosis_input(collision(distance=20), fake_encoder, Thresholds())[0]
    assert far.allowed_verdicts == ["NO_ACTION"]


def test_input_gate_accepts_adapter_output(fake_encoder):
    pytest.importorskip("google.adk")
    from google.genai import types
    from backend.app.agents.diagnosis_agent.guardrails import input_gate

    for stored in (
        collision(uploaded=point("uploaded", date="2028-05-01"),
                  reference=point("reference", reference=True, date="2028-05-31"), gap=30),
        collision(uploaded=point("uploaded", date="2028-05-01")),
        collision(),
    ):
        diagnosis_input = upload_diagnosis_input(stored, fake_encoder, Thresholds())[0]
        request = SimpleNamespace(contents=[types.Content(
            role="user", parts=[types.Part(text=diagnosis_input.model_dump_json())],
        )])
        assert asyncio.run(input_gate(None, request)) is None


def test_unknown_utility_placeholder_and_reference_raw_not_in_input(fake_encoder):
    diagnosis_input, _, _ = upload_diagnosis_input(
        collision(uploaded=point("uploaded", owner=None),
                  reference=point("reference", reference=True, owner=None)),
        fake_encoder, Thresholds(),
    )
    assert diagnosis_input.overlap.utility_a == diagnosis_input.overlap.utility_b == "Unknown utility"
    assert diagnosis_input.project_a.utility == diagnosis_input.project_b.utility == "Unknown utility"
    assert RAW_SENTINEL not in diagnosis_input.model_dump_json()
    assert diagnosis_input.project_a.state == "SC"


def test_whitespace_owner_becomes_unknown_utility(fake_encoder):
    diagnosis_input = upload_diagnosis_input(
        collision(uploaded=point("uploaded", owner="   "),
                  reference=point("reference", reference=True, owner="   ")),
        fake_encoder, Thresholds(),
    )[0]
    assert diagnosis_input.overlap.utility_a == diagnosis_input.overlap.utility_b == "Unknown utility"
    assert diagnosis_input.project_a.utility == diagnosis_input.project_b.utility == "Unknown utility"


def test_name_similarity_uses_names(fake_encoder):
    stored = collision(uploaded=point("uploaded", name="Alpha one"),
                       reference=point("reference", name="Beta two", reference=True))
    diagnosis_input = upload_diagnosis_input(stored, fake_encoder, Thresholds())[0]
    assert diagnosis_input.overlap.name_similarity == score_pairs([("Alpha one", "Beta two")], fake_encoder)[0]


def test_cached_second_call(fake_encoder):
    client = StubClient()
    subject = service(fake_encoder, client)
    stored = collision()

    async def run():
        return await subject.diagnose(UPLOAD, stored), await subject.diagnose(UPLOAD, stored)

    first, second = asyncio.run(run())
    assert first.diagnosis.cached is False
    assert second.diagnosis.cached is True
    assert client.calls == 1


def test_storage_collision_requires_manifest_and_binds_ids():
    database = Mock()
    database.query_rows.side_effect = [[], [[json.dumps({"published": True})]], [[json.dumps(collision())]]]
    store = ProjectStore(database)
    with pytest.raises(LookupError):
        store.collision(UPLOAD, OVERLAP)
    assert database.query_rows.call_count == 1
    assert store.collision(UPLOAD, OVERLAP)["overlap_id"] == OVERLAP
    assert database.query_rows.call_args_list[-1].args[1] == (UPLOAD, OVERLAP)
    assert "WHERE UPLOAD_ID=? AND COLLISION_ID=?" in database.query_rows.call_args_list[-1].args[0]
    before = database.query_rows.call_count
    with pytest.raises(ValueError):
        store.collision("../bad", OVERLAP)
    with pytest.raises(ValueError):
        store.collision(UPLOAD, "../bad")
    assert database.query_rows.call_count == before


def test_route_errors_and_response(fake_encoder, monkeypatch):
    database = Mock()
    database.query_rows.side_effect = [
        [[json.dumps({"published": True})]], [[json.dumps(collision())]],
        [],
        [[json.dumps({"published": True})]], [],
        SnowflakeError("failed"),
        [[json.dumps({"published": True})]], [[json.dumps({"overlap_id": OVERLAP, "secret_field": "x"})]],
    ]
    client = StubClient()
    app = create_app()
    app.dependency_overrides[get_project_store] = lambda: ProjectStore(database)
    app.dependency_overrides[get_upload_diagnosis_service] = lambda: service(fake_encoder, client)
    with TestClient(app) as http:
        response = http.post(PATH)
        assert response.status_code == 200, response.text
        assert response.json()["diagnosis"]["verdict"] == "RESEQUENCE"
        assert http.post(PATH, json={"prompt": "extra"}).status_code == 422
        assert http.post(PATH.replace(UPLOAD, "bad")).status_code == 422
        assert http.post(PATH.replace(OVERLAP, "bad")).status_code == 422
        assert http.post(PATH).status_code == 404  # unpublished upload
        assert http.post(PATH).status_code == 404  # unknown collision
        assert http.post(PATH).status_code == 502
        malformed = http.post(PATH)  # stored record missing required fields
        assert malformed.status_code == 502
        assert "secret_field" not in malformed.text and "distance_mi" not in malformed.text
    assert client.calls == 1

    from backend.documentparsing.config import SnowflakeSettings

    def unconfigured():
        raise ValueError("missing")

    monkeypatch.setattr(SnowflakeSettings, "from_env", staticmethod(unconfigured))
    unavailable = create_app()
    unavailable.dependency_overrides[get_upload_diagnosis_service] = lambda: service(fake_encoder, StubClient())
    with TestClient(unavailable) as http:
        assert http.post(PATH).status_code == 503
        assert http.post(PATH.replace(UPLOAD, "bad")).status_code == 422


def test_route_repeat_uses_one_client_call(fake_encoder):
    database = Mock()
    database.query_rows.side_effect = [
        [[json.dumps({"published": True})]], [[json.dumps(collision())]],
        [[json.dumps({"published": True})]], [[json.dumps(collision())]],
    ]
    client = StubClient()
    subject = service(fake_encoder, client)
    app = create_app()
    app.dependency_overrides[get_project_store] = lambda: ProjectStore(database)
    app.dependency_overrides[get_upload_diagnosis_service] = lambda: subject
    with TestClient(app) as http:
        first = http.post(PATH)
        second = http.post(PATH)
    assert first.status_code == second.status_code == 200
    assert first.json()["diagnosis"]["cached"] is False
    assert second.json()["diagnosis"]["cached"] is True
    assert client.calls == 1


def test_route_runs_blocking_steps_off_event_loop(fake_encoder):
    threads = {}

    class ThreadStore:
        def collision(self, upload_id, overlap_id):
            threads["store"] = threading.get_ident()
            return collision()

    class ThreadService(UploadDiagnosisService):
        def prepare(self, stored):
            threads["prepare"] = threading.get_ident()
            return super().prepare(stored)

        async def diagnose(self, upload_id, stored, prepared=None):
            threads["loop"] = threading.get_ident()
            return await super().diagnose(upload_id, stored, prepared)

    client = StubClient()
    subject = ThreadService(lambda: fake_encoder, client, Thresholds(), "stub-model", "diag.v2")
    app = create_app()
    app.dependency_overrides[get_project_store] = ThreadStore
    app.dependency_overrides[get_upload_diagnosis_service] = lambda: subject
    with TestClient(app) as http:
        assert http.post(PATH).status_code == 200
    assert threads["store"] != threads["loop"]
    assert threads["prepare"] != threads["loop"]
    assert client.calls == 1


def test_rate_limit_path():
    assert AGENT_PATH.fullmatch(PATH)
    assert not AGENT_PATH.fullmatch(PATH + "/extra")


def test_upload_service_retries_rule_only_after_ttl(fake_encoder):
    class FlakyClient(StubClient):
        async def diagnose(self, diagnosis_input):
            self.calls += 1
            if self.calls == 1:
                return DiagnosisClientResult(None)
            return DiagnosisClientResult(DiagnosisDecision(verdict=self.verdict, rationale="Move the work."))

    now = [0.0]
    client = FlakyClient()
    subject = UploadDiagnosisService(
        lambda: fake_encoder, client, Thresholds(), "stub-model", "diag.v2", clock=lambda: now[0],
    )
    stored = collision()
    first = asyncio.run(subject.diagnose(UPLOAD, stored))
    assert first.diagnosis.status == "rule_only"
    now[0] = 29.0
    assert asyncio.run(subject.diagnose(UPLOAD, stored)).diagnosis.cached is True
    assert client.calls == 1
    now[0] = 30.0
    second = asyncio.run(subject.diagnose(UPLOAD, stored))
    assert client.calls == 2
    assert second.diagnosis.status == "model" and second.diagnosis.cached is False
