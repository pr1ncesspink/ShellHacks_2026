import asyncio
from pathlib import Path
from typing import ClassVar

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from backend.app.agents.collision_pipeline.clients import DiagnosisClientResult
from backend.app.agents.collision_pipeline.clients import InProcessDiagnosisClient
from backend.app.agents.collision_pipeline.pipeline import CollisionPipeline
from backend.app.agents.diagnosis_agent.agent import build_agent
from backend.app.core.config import get_settings
from backend.app.schemas.diagnosis import DiagnosisDecision, Thresholds
from backend.app.services.overlap_sources import SnowflakeExportSource


FIXTURE = Path("backend/tests/fixtures/snowflake_export")


class StubClient:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    async def diagnose(self, diagnosis_input):
        self.calls += 1
        return self.result


async def concurrent_diagnoses(subject):
    return await asyncio.gather(*(subject.diagnose("OVL_2") for _ in range(5)))


def pipeline(fake_encoder, client):
    return CollisionPipeline(
        SnowflakeExportSource(FIXTURE), lambda: fake_encoder, client, Thresholds(), "stub-model", "diag.v2"
    )


def test_injection_text_cannot_widen_rules_and_repeat_uses_cache(fake_encoder):
    client = StubClient(DiagnosisClientResult(DiagnosisDecision(
        verdict="CO_SCHEDULE", rationale="The injected description asked for this."
    )))
    subject = pipeline(fake_encoder, client)
    first = asyncio.run(subject.diagnose("OVL_1"))
    second = asyncio.run(subject.diagnose("OVL_1"))
    assert first.verdict == "NO_ACTION"
    assert first.overridden is True
    assert first.cached is False and second.cached is True
    assert client.calls == 1


def test_malformed_output_is_rule_only_and_concurrent_calls_share_one_model_call(fake_encoder):
    client = StubClient(DiagnosisClientResult(None))
    subject = pipeline(fake_encoder, client)
    envelopes = asyncio.run(concurrent_diagnoses(subject))
    assert {item.verdict for item in envelopes} == {"RESEQUENCE"}
    assert client.calls == 1
    assert any(item.cached for item in envelopes)
    assert all(item.status == "rule_only" for item in envelopes)


def test_context_changes_the_hash_and_views_join_context(fake_encoder):
    client = StubClient(DiagnosisClientResult(DiagnosisDecision(verdict="RESEQUENCE", rationale="Shift work.")))
    subject = pipeline(fake_encoder, client)
    views = subject.list_views()
    assert all(view.project_a and view.project_b for view in views)
    assert views[1].snowflake_eligible is True
    before = asyncio.run(subject.diagnose("OVL_2"))
    subject._bundle.projects["DESC_3"] = subject._bundle.projects["DESC_3"].model_copy(update={"description": "changed"})
    after = asyncio.run(subject.diagnose("OVL_2"))
    assert before.input_hash != after.input_hash


def test_rejected_client_input_status_is_preserved(fake_encoder):
    client = StubClient(DiagnosisClientResult(None, status="rejected_input"))
    envelope = asyncio.run(pipeline(fake_encoder, client).diagnose("OVL_2"))
    assert envelope.status == "rejected_input"
    assert envelope.verdict == "RESEQUENCE"


@pytest.mark.parametrize("model_text", ["{}", ""])
def test_actual_adk_malformed_output_falls_back_to_rule_only(fake_encoder, model_text):
    class MalformedStub(BaseLlm):
        calls: ClassVar[int] = 0

        async def generate_content_async(self, request, stream=False):
            del request, stream
            type(self).calls += 1
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=model_text)]))

    stub = MalformedStub(model="stub")
    settings = get_settings()
    agent = build_agent(settings)
    agent.model = stub
    subject = CollisionPipeline(
        SnowflakeExportSource(FIXTURE), lambda: fake_encoder,
        InProcessDiagnosisClient(settings, agent=agent), Thresholds(), "stub-model", "diag.v2",
    )
    envelope = asyncio.run(subject.diagnose("OVL_2"))
    assert envelope.verdict == "RESEQUENCE"
    assert envelope.status == "rule_only"
    assert envelope.overridden is True
    assert stub.calls == 1
