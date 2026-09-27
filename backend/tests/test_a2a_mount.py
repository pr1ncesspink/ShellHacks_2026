from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types


REPO_ROOT = Path(__file__).resolve().parents[2]


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
    assert len(payload["skills"]) == 4


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
