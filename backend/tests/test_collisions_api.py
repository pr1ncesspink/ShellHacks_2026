from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.agents.collision_pipeline.clients import DiagnosisClientResult
from backend.app.agents.collision_pipeline.pipeline import CollisionPipeline
from backend.app.api.deps import get_collision_pipeline
from backend.app.main import create_app
from backend.app.schemas.diagnosis import DiagnosisDecision, Thresholds
from backend.app.services.overlap_sources import SnowflakeExportSource


class Client:
    async def diagnose(self, _):
        return DiagnosisClientResult(DiagnosisDecision(verdict="RESEQUENCE", rationale="Move one window."))


def test_collisions_api_empty_request_extra_rejection_and_unknown_id(fake_encoder):
    pipeline = CollisionPipeline(SnowflakeExportSource(Path("backend/tests/fixtures/snowflake_export")), lambda: fake_encoder,
                                 Client(), Thresholds(), "stub", "diag.v2")
    app = create_app()
    app.dependency_overrides[get_collision_pipeline] = lambda: pipeline
    with TestClient(app) as http:
        assert len(http.get("/collisions").json()) == 6
        assert http.post("/collisions/OVL_2/diagnosis").status_code == 200
        assert http.post("/collisions/OVL_2/diagnosis", json={"prompt": "inject"}).status_code == 422
        assert http.post("/collisions/nope/diagnosis").status_code == 404


def test_collision_source_error_is_503(monkeypatch):
    monkeypatch.setenv("COLLISION_SOURCE", "bad-source")
    get_collision_pipeline.cache_clear()
    with TestClient(create_app()) as http:
        assert http.get("/collisions").status_code == 503
    get_collision_pipeline.cache_clear()
