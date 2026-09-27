from __future__ import annotations

import importlib

from backend.app.core.config import get_settings


def test_root_agent_import_needs_no_credentials(monkeypatch):
    for name in [
        "GOOGLE_API_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "ADK_MODEL",
    ]:
        monkeypatch.delenv(name, raising=False)

    import backend.app.agents.overlap_agent.agent as agent_module

    agent_module = importlib.reload(agent_module)
    root_agent = agent_module.root_agent
    assert root_agent.name == "overlap_agent"
    assert root_agent.model == get_settings().agent_model
    assert {tool.__name__ for tool in root_agent.tools} == {
        "score_project_names",
        "get_overlap",
        "list_overlaps",
        "get_upload_collisions",
    }


def test_build_agent_uses_adk_model_override(monkeypatch):
    monkeypatch.setenv("ADK_MODEL", "gemini-test-model")
    from backend.app.agents.overlap_agent.agent import build_agent

    assert build_agent(get_settings()).model == "gemini-test-model"
