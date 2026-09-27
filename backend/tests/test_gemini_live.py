"""Opt-in live coverage for the diagnosis model; excluded from the offline gate."""

import asyncio
import os
from pathlib import Path

import pytest
from google.adk.runners import InMemoryRunner
from google.genai import types

from backend.app.agents.collision_pipeline.clients import InProcessDiagnosisClient
from backend.app.agents.collision_pipeline.pipeline import CollisionPipeline
from backend.app.agents.diagnosis_agent.agent import PROMPT_VERSION
from backend.app.agents.overlap_agent.agent import build_agent
from backend.app.core.config import get_settings
from backend.app.schemas.diagnosis import Thresholds
from backend.app.services.overlap_sources import SnowflakeExportSource
from backend.app.services.similarity import get_encoder


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
        session = await runner.session_service.create_session(app_name=runner.app_name, user_id="live-test")
        return [
            event async for event in runner.run_async(
                user_id="live-test", session_id=session.id,
                new_message=types.Content(
                    role="user", parts=[types.Part(text="What is the name similarity for OVL_1?")]
                ),
            )
        ]

    events = asyncio.run(run_agent())
    assert any(
        part.function_call and part.function_call.name == "get_overlap"
        for event in events if event.content and event.content.parts for part in event.content.parts
    )
    assert any(
        part.text for event in events
        if event.is_final_response() and event.content and event.content.parts for part in event.content.parts
    )


@pytest.mark.skipif(
    os.getenv("RUN_GEMINI_TESTS") != "1" or not _has_credentials(),
    reason="set RUN_GEMINI_TESTS=1 and configure Google AI Studio or Vertex credentials",
)
def test_fixture_diagnoses_are_allowed_and_cached_with_live_gemini():
    settings = get_settings()
    thresholds = Thresholds(
        max_distance_mi=settings.diag_max_distance_mi,
        max_gap_days=settings.diag_max_gap_days,
        co_schedule_min_similarity=settings.diag_co_schedule_min_sim,
    )
    pipeline = CollisionPipeline(
        SnowflakeExportSource(Path("backend/tests/fixtures/snowflake_export")), get_encoder,
        InProcessDiagnosisClient(settings), thresholds, settings.diagnosis_model, PROMPT_VERSION,
    )
    for overlap_id in ("OVL_2", "OVL_6"):
        first = asyncio.run(pipeline.diagnose(overlap_id))
        second = asyncio.run(pipeline.diagnose(overlap_id))
        assert first.status == "model"
        assert first.verdict in first.allowed_verdicts
        assert second.verdict in second.allowed_verdicts
        assert first.model_dump(exclude={"cached"}) == second.model_dump(exclude={"cached"})
        assert first.cached is False and second.cached is True
