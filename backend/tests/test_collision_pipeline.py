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


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class SequenceClient:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = 0

    async def diagnose(self, diagnosis_input):
        self.calls += 1
        return self.results[min(self.calls, len(self.results)) - 1]


MODEL_RESULT = DiagnosisClientResult(DiagnosisDecision(verdict="RESEQUENCE", rationale="Shift work."))


def clocked_pipeline(fake_encoder, client, clock):
    return CollisionPipeline(
        SnowflakeExportSource(FIXTURE), lambda: fake_encoder, client, Thresholds(), "stub-model", "diag.v2",
        clock=clock,
    )


def test_rule_only_expires_after_ttl_then_model_result_is_used(fake_encoder):
    clock = FakeClock()
    client = SequenceClient(DiagnosisClientResult(None), MODEL_RESULT)
    subject = clocked_pipeline(fake_encoder, client, clock)
    first = asyncio.run(subject.diagnose("OVL_2"))
    assert first.status == "rule_only" and client.calls == 1
    clock.now += 29.9
    within = asyncio.run(subject.diagnose("OVL_2"))
    assert within.cached is True and within.status == "rule_only" and client.calls == 1
    clock.now += 0.1
    second = asyncio.run(subject.diagnose("OVL_2"))
    assert client.calls == 2
    assert second.status == "model" and second.cached is False
    assert second.input_hash == first.input_hash


def test_model_result_stays_cached_after_ttl(fake_encoder):
    clock = FakeClock()
    client = SequenceClient(MODEL_RESULT, DiagnosisClientResult(None))
    subject = clocked_pipeline(fake_encoder, client, clock)
    asyncio.run(subject.diagnose("OVL_2"))
    clock.now += 10_000
    again = asyncio.run(subject.diagnose("OVL_2"))
    assert again.cached is True and again.status == "model"
    assert client.calls == 1


def test_reload_clears_failure_expiry(fake_encoder):
    subject = clocked_pipeline(fake_encoder, SequenceClient(DiagnosisClientResult(None)), FakeClock())
    asyncio.run(subject.diagnose("OVL_2"))
    assert subject._failure_expiry
    subject.reload()
    assert subject._failure_expiry == {} and subject._cache == {}


def test_run_diagnosis_without_failure_expiry_does_not_cache_rule_only(fake_encoder):
    from backend.app.agents.collision_pipeline.pipeline import run_diagnosis

    client = SequenceClient(DiagnosisClientResult(None), MODEL_RESULT)
    subject = pipeline(fake_encoder, client)
    diagnosis_input, eligible = subject._input("OVL_2")
    cache, locks = {}, {}

    async def run():
        return await run_diagnosis(
            diagnosis_input, eligible, overlap_id="OVL_2", client=client, thresholds=Thresholds(),
            model_id="stub-model", prompt_version="diag.v2", cache=cache, locks=locks,
        )

    first = asyncio.run(run())
    assert first.status == "rule_only" and cache == {}
    second = asyncio.run(run())
    assert second.status == "model" and client.calls == 2
    assert len(cache) == 1


def test_model_failure_logs_class_name_only(caplog):
    class Session:
        id = "session"

    class SessionService:
        async def create_session(self, **kwargs):
            return Session()

    class RaisingRunner:
        session_service = SessionService()

        async def run_async(self, **kwargs):
            raise RuntimeError("SECRET-SENTINEL")
            yield  # pragma: no cover

    client = InProcessDiagnosisClient(get_settings(), agent=object(), runner=RaisingRunner())
    fake_input = type("Input", (), {"model_dump_json": lambda self: "{}"})()
    with caplog.at_level("WARNING", logger="backend.app.agents.collision_pipeline.clients"):
        result = asyncio.run(client.diagnose(fake_input))
    assert result.decision is None and result.status == "model"
    assert "RuntimeError" in caplog.text
    assert "SECRET-SENTINEL" not in caplog.text
