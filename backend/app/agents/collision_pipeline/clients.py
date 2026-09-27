"""Diagnosis transports kept independent from FastAPI."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import uuid4

from backend.app.schemas.diagnosis import DiagnosisDecision, DiagnosisInput

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DiagnosisClientResult:
    decision: DiagnosisDecision | None
    status: str = "model"


class DiagnosisClient(Protocol):
    async def diagnose(self, diagnosis_input: DiagnosisInput) -> DiagnosisClientResult: ...


class InProcessDiagnosisClient:
    def __init__(self, settings, *, agent: Any = None, runner: Any = None) -> None:
        self._settings = settings
        self._agent = agent
        self._runner = runner

    async def diagnose(self, diagnosis_input: DiagnosisInput) -> DiagnosisClientResult:
        from google.adk.runners import InMemoryRunner
        from google.genai import types

        if self._agent is None:
            from backend.app.agents.diagnosis_agent.agent import build_agent
            self._agent = build_agent(self._settings)
        runner = self._runner or InMemoryRunner(self._agent, app_name="diagnosis_agent")
        session = await runner.session_service.create_session(
            app_name="diagnosis_agent", user_id="collision_pipeline", session_id=str(uuid4())
        )
        message = types.Content(role="user", parts=[types.Part(text=diagnosis_input.model_dump_json())])
        text = None
        try:
            async for event in runner.run_async(
                user_id="collision_pipeline", session_id=session.id, new_message=message
            ):
                if getattr(event, "error_code", None) == "rejected_input":
                    return DiagnosisClientResult(None, status="rejected_input")
                content = getattr(event, "content", None)
                for part in getattr(content, "parts", None) or []:
                    if isinstance(getattr(part, "text", None), str):
                        text = part.text
        except Exception as exc:
            # Class name only: exception messages may echo credentials or model text.
            logger.warning("diagnosis model call failed; using rule-only fallback (%s)", type(exc).__name__)
            return DiagnosisClientResult(None)
        try:
            return DiagnosisClientResult(DiagnosisDecision.model_validate_json(text or ""))
        except Exception:
            logger.warning("diagnosis model returned missing or invalid JSON; using rule-only fallback")
            return DiagnosisClientResult(None)


class A2ADiagnosisClient:
    """A2A SDK client with an injectable AsyncClient for ASGI tests."""

    def __init__(self, url: str, *, http_client: Any = None) -> None:
        self.url = url.rstrip("/")
        self.http_client = http_client

    @staticmethod
    def _texts(value: Any):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "text" and isinstance(item, str):
                    yield item
                yield from A2ADiagnosisClient._texts(item)
        elif isinstance(value, list):
            for item in value:
                yield from A2ADiagnosisClient._texts(item)

    async def diagnose(self, diagnosis_input: DiagnosisInput) -> DiagnosisClientResult:
        from a2a.client import ClientConfig, ClientFactory, client as client_module
        from google.protobuf.json_format import MessageToDict

        async def send(http_client):
            factory = ClientFactory(ClientConfig(httpx_client=http_client))
            client = await factory.create_from_url(self.url)
            # Starlette's mounted A2A app serves its JSON-RPC root at a trailing
            # slash, while discovery intentionally publishes the canonical URL.
            client._transport.url = self.url + "/"  # a2a-sdk 1.x transport
            request = client_module.SendMessageRequest()
            request.message.message_id = str(uuid4())
            request.message.role = 1  # ROLE_USER
            request.message.parts.add().text = diagnosis_input.model_dump_json()
            async for response in client.send_message(request):
                body = MessageToDict(response, preserving_proto_field_name=True)
                serialized = str(body)
                if "rejected_input" in serialized:
                    return DiagnosisClientResult(None, status="rejected_input")
                for text in self._texts(body):
                    try:
                        return DiagnosisClientResult(DiagnosisDecision.model_validate_json(text))
                    except Exception:
                        continue
            return DiagnosisClientResult(None)

        if self.http_client is not None:
            return await send(self.http_client)
        import httpx
        async with httpx.AsyncClient() as http_client:
            return await send(http_client)
