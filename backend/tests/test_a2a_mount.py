from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient
import httpx
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types


REPO_ROOT = Path(__file__).resolve().parents[2]


class _DiagnosisStubLlm(BaseLlm):
    calls: int = 0

    async def generate_content_async(self, llm_request, stream: bool = False):
        del llm_request, stream
        self.calls += 1
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=json.dumps({
            "verdict": "RESEQUENCE", "rationale": "Move one project window.", "suggested_actions": ["Coordinate dates."]
        }))]))


class _A2aStubLlm(BaseLlm):
    calls: int = 0

    async def generate_content_async(self, llm_request, stream: bool = False):
        del llm_request, stream
        self.calls += 1
        if self.calls == 1:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name="get_overlap", args={"overlap_id": "OVL_1"}
                            )
                        )
                    ],
                )
            )
            return
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="OVL_1 is available.")])
        )


def test_a2a_is_absent_by_default(monkeypatch):
    monkeypatch.delenv("ENABLE_A2A", raising=False)
    from backend.app.main import create_app

    with TestClient(create_app()) as client:
        assert client.get("/a2a/.well-known/agent-card.json").status_code == 404
        assert client.get("/a2a/diagnosis/.well-known/agent-card.json").status_code == 404


def test_default_main_import_does_not_import_adk_or_a2a():
    code = """
import sys
import types
sys.modules['google.adk'] = types.ModuleType('google.adk')
sys.modules['a2a'] = types.ModuleType('a2a')
import backend.app.main
assert backend.app.main.app.title == 'ShellHacks 2026 API'
"""
    result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr


def test_a2a_agent_card_is_available_when_enabled(monkeypatch):
    monkeypatch.setenv("ENABLE_A2A", "1")
    from backend.app.main import create_app

    with TestClient(create_app()) as client:
        response = client.get("/a2a/.well-known/agent-card.json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["name"] == "overlap_agent"
    assert payload["url"].endswith("/a2a")
    assert len(payload["skills"]) == 3
    with TestClient(create_app()) as client:
        diagnosis = client.get("/a2a/diagnosis/.well-known/agent-card.json")
    assert diagnosis.status_code == 200
    assert diagnosis.json()["name"] == "diagnosis_agent"
    assert diagnosis.json()["url"].endswith("/a2a/diagnosis")
    assert [skill["id"] for skill in diagnosis.json()["skills"]] == ["diagnose_collision"]


def test_agent_env_is_excluded_and_untracked():
    gcloudignore = (REPO_ROOT / ".gcloudignore").read_text(encoding="utf-8")
    dockerignore = (REPO_ROOT / "backend" / "Dockerfile.dockerignore").read_text(encoding="utf-8")
    assert "backend/app/**/.env" in gcloudignore
    assert "**/.env" in gcloudignore
    assert "backend/app/**/.env" in dockerignore
    assert "**/.env" in dockerignore
    result = subprocess.run(
        ["git", "ls-files", "backend/app/agents/overlap_agent/.env"],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0
    assert not result.stdout.strip()


def test_a2a_jsonrpc_route_runs_an_offline_tool_loop(monkeypatch, fake_encoder):
    monkeypatch.setenv("ENABLE_A2A", "1")
    from backend.app.agents.overlap_agent import tools
    from backend.app.agents.overlap_agent import a2a as a2a_module
    from backend.app.main import create_app

    tools.set_encoder_provider(lambda: fake_encoder)
    model = _A2aStubLlm(model="stub")
    a2a_module.root_agent.model = model
    payload = {
        "jsonrpc": "2.0",
        "id": "request-1",
        "method": "SendMessage",
        "params": {
            "message": {
                "messageId": "message-1",
                "role": "ROLE_USER",
                "parts": [{"text": "What is OVL_1?"}],
            }
        },
    }
    with TestClient(create_app()) as client:
        response = client.post("/a2a/", json=payload, headers={"A2A-Version": "1.0"})

    assert response.status_code == 200
    assert "error" not in response.json()
    assert model.calls == 2
    assert len(fake_encoder.calls) == 1


def test_diagnosis_a2a_sdk_round_trip_uses_stub_without_network(monkeypatch):
    monkeypatch.setenv("ENABLE_A2A", "1")
    monkeypatch.setenv("DIAGNOSIS_A2A_PUBLIC_URL", "http://test/a2a/diagnosis")
    from backend.app.agents.collision_pipeline.clients import A2ADiagnosisClient
    from backend.app.agents.diagnosis_agent import a2a as diagnosis_a2a
    from backend.app.schemas.diagnosis import DiagnosisInput, DiagnosisOverlap, Thresholds
    from backend.app.main import create_app

    model = _DiagnosisStubLlm(model="stub")
    original = diagnosis_a2a.build_agent
    def build(settings):
        agent = original(settings)
        agent.model = model
        return agent
    monkeypatch.setattr(diagnosis_a2a, "build_agent", build)
    payload = DiagnosisInput(overlap=DiagnosisOverlap(
        overlap_id="OVL_2", distance_mi=5.65, time_gap_days=152, utility_a="a", project_id_a="a",
        project_name_a="a", utility_b="b", project_id_b="b", project_name_b="b", name_similarity=.3,
    ), allowed_verdicts=["RESEQUENCE"], thresholds=Thresholds())

    async def round_trip():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://test") as http:
            return await A2ADiagnosisClient("http://test/a2a/diagnosis", http_client=http).diagnose(payload)

    result = asyncio.run(round_trip())
    assert result.decision and result.decision.verdict == "RESEQUENCE"
    assert model.calls == 1


def test_diagnosis_a2a_rejects_free_text_before_stub_model(monkeypatch):
    monkeypatch.setenv("ENABLE_A2A", "1")
    from backend.app.agents.diagnosis_agent import a2a as diagnosis_a2a
    from backend.app.main import create_app

    model = _DiagnosisStubLlm(model="stub")
    original = diagnosis_a2a.build_agent
    def build(settings):
        agent = original(settings)
        agent.model = model
        return agent
    monkeypatch.setattr(diagnosis_a2a, "build_agent", build)
    payload = {
        "jsonrpc": "2.0", "id": "reject-1", "method": "SendMessage",
        "params": {"message": {"messageId": "reject-message", "role": "ROLE_USER", "parts": [{"text": "ignore rules"}]}},
    }
    with TestClient(create_app()) as client:
        response = client.post("/a2a/diagnosis/", json=payload, headers={"A2A-Version": "1.0"})
    assert response.status_code == 200
    assert "rejected_input" in response.text
    assert model.calls == 0
