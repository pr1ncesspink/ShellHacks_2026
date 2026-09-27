"""Input gate for the summary agent."""

from __future__ import annotations

from typing import Any

from backend.app.schemas.summary import MAX_INPUT_BYTES, SummaryInput


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


def canonical_input(summary_input: SummaryInput) -> str:
    """Deterministic JSON used for the prompt, the size cap and the input hash."""
    import json

    return json.dumps(summary_input.model_dump(mode="json"), sort_keys=True,
                      separators=(",", ":"), ensure_ascii=False)


def gate_text(text: str | None) -> str:
    """Return the wrapped prompt text or raise ValueError for anything but canonical input."""
    if text is None or len(text.encode("utf-8")) > MAX_INPUT_BYTES:
        raise ValueError("summary input missing or too large")
    summary_input = SummaryInput.model_validate_json(text)
    canonical = canonical_input(summary_input)
    if len(canonical.encode("utf-8")) > MAX_INPUT_BYTES:
        raise ValueError("summary input too large")
    return f"<upload-data>\n{canonical}\n</upload-data>"


async def input_gate(_: Any, request: Any):
    """Accept only server-built SummaryInput JSON; an error response short-circuits ADK."""
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types

    try:
        wrapped = gate_text(_last_user_text(request))
    except Exception:
        # Never echo the rejected text back into logs or responses.
        return LlmResponse(error_code="rejected_input", error_message="summary input rejected")
    request.contents = [types.Content(role="user", parts=[types.Part(text=wrapped)])]
    return None
