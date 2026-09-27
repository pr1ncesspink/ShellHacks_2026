"""In-process ADK client for the summary agent (injectable; tests use fakes)."""

from __future__ import annotations

from dataclasses import dataclass
import logging
from typing import Any, Protocol
from uuid import uuid4

from backend.app.schemas.summary import SummaryDraft, SummaryInput

from .guardrails import canonical_input

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SummaryClientResult:
    draft: SummaryDraft | None
    status: str = "model"


class SummaryClient(Protocol):
    async def summarize(self, summary_input: SummaryInput) -> SummaryClientResult: ...


class InProcessSummaryClient:
    def __init__(self, settings, *, agent: Any = None, runner: Any = None) -> None:
        self._settings = settings
        self._agent = agent
        self._runner = runner

    async def summarize(self, summary_input: SummaryInput) -> SummaryClientResult:
        from google.adk.runners import InMemoryRunner
        from google.genai import types

        if self._agent is None:
            from .agent import build_agent
            self._agent = build_agent(self._settings)
        runner = self._runner or InMemoryRunner(self._agent, app_name="summary_agent")
        session = await runner.session_service.create_session(
            app_name="summary_agent", user_id="upload_job", session_id=str(uuid4())
        )
        message = types.Content(role="user", parts=[types.Part(text=canonical_input(summary_input))])
        text = None
        try:
            async for event in runner.run_async(user_id="upload_job", session_id=session.id, new_message=message):
                if getattr(event, "error_code", None) == "rejected_input":
                    return SummaryClientResult(None, status="rejected_input")
                content = getattr(event, "content", None)
                for part in getattr(content, "parts", None) or []:
                    if isinstance(getattr(part, "text", None), str):
                        text = part.text
        except Exception as exc:
            # Class name only: exception messages may echo credentials or model text.
            logger.warning("summary model call failed; using rule-only fallback (%s)", type(exc).__name__)
            return SummaryClientResult(None, status="error")
        try:
            return SummaryClientResult(SummaryDraft.model_validate_json(text or ""))
        except Exception:
            logger.warning("summary model returned missing or invalid JSON; using rule-only fallback")
            return SummaryClientResult(None, status="invalid_output")
