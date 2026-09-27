from __future__ import annotations

import asyncio
import os

import pytest
from google.adk.runners import InMemoryRunner
from google.genai import types

from backend.app.agents.overlap_agent.agent import build_agent
from backend.app.core.config import get_settings


pytestmark = pytest.mark.gemini


def _has_credentials() -> bool:
    if os.getenv("GOOGLE_API_KEY"):
        return True
    return os.getenv("GOOGLE_GENAI_USE_VERTEXAI") == "TRUE" and bool(
        os.getenv("GOOGLE_CLOUD_PROJECT") and os.getenv("GOOGLE_CLOUD_LOCATION")
    )


@pytest.mark.skipif(
    os.getenv("RUN_GEMINI_TESTS") != "1" or not _has_credentials(),
    reason="set RUN_GEMINI_TESTS=1 and configure Google AI Studio or Vertex credentials",
)
def test_gemini_agent_uses_get_overlap_for_ovl_1():
    agent = build_agent(get_settings())
    runner = InMemoryRunner(agent, app_name="overlap_agent_live_test")

    async def run_agent():
        session = await runner.session_service.create_session(
            app_name=runner.app_name, user_id="live-test"
        )
        return [
            event
            async for event in runner.run_async(
                user_id="live-test",
                session_id=session.id,
                new_message=types.Content(
                    role="user", parts=[types.Part(text="What is the name similarity for OVL_1?")]
                ),
            )
        ]

    events = asyncio.run(run_agent())
    assert any(
        part.function_call and part.function_call.name == "get_overlap"
        for event in events
        if event.content and event.content.parts
        for part in event.content.parts
    )
    assert any(
        part.text
        for event in events
        if event.is_final_response() and event.content and event.content.parts
        for part in event.content.parts
    )
