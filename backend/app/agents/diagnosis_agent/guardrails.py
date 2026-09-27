"""Input gate for the diagnosis agent."""

from __future__ import annotations

import json
from typing import Any

from backend.app.schemas.diagnosis import DiagnosisInput
from backend.app.services.diagnosis_rules import allowed_verdicts


def _last_user_text(request: Any) -> str | None:
    contents = getattr(request, "contents", None) or []
    for content in reversed(contents):
        if getattr(content, "role", None) != "user":
            continue
        for part in reversed(getattr(content, "parts", None) or []):
            text = getattr(part, "text", None)
            if isinstance(text, str):
                return text
    return None


async def input_gate(_: Any, request: Any):
    """Accept only canonical server-built DiagnosisInput JSON.

    A returned error response short-circuits ADK before any model call.
    """
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types

    text = _last_user_text(request)
    try:
        diagnosis_input = DiagnosisInput.model_validate_json(text or "")
        expected = list(allowed_verdicts(diagnosis_input.overlap, diagnosis_input.thresholds))
        if diagnosis_input.allowed_verdicts != expected:
            raise ValueError("allowed_verdicts do not match rules")
    except Exception as exc:
        return LlmResponse(error_code="rejected_input", error_message=str(exc))

    canonical = json.dumps(
        diagnosis_input.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    request.contents = [types.Content(
        role="user", parts=[types.Part(text=f"<diagnosis-data>\n{canonical}\n</diagnosis-data>")]
    )]
    return None
