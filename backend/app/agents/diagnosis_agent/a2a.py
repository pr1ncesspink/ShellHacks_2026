"""A2A ASGI application for the diagnosis agent."""

from __future__ import annotations

from a2a.server.request_handlers.response_helpers import agent_card_to_dict
from a2a.server.tasks.inmemory_task_store import InMemoryTaskStore
from a2a.types import AgentSkill
from google.adk.a2a import _compat
from google.adk.a2a._compat import attach_a2a_routes_to_app
from google.adk.a2a.executor.a2a_agent_executor import A2aAgentExecutor
from google.adk.runners import InMemoryRunner
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from backend.app.core.config import Settings

from .agent import build_agent


def _agent_card(settings: Settings, agent):
    return _compat.build_agent_card(
        name="diagnosis_agent",
        description=agent.description,
        version="0.1.0",
        url=settings.diagnosis_a2a_public_url,
        protocol_binding=_compat.TP_JSONRPC.value,
        skills=[AgentSkill(
            id="diagnose_collision", name="diagnose_collision",
            description="Diagnose a server-validated collision.", tags=["diagnosis"],
            input_modes=["text/plain"], output_modes=["text/plain"],
        )],
    )


def build_diagnosis_a2a_app(settings: Settings) -> Starlette:
    agent = build_agent(settings)
    agent_card = _agent_card(settings, agent)

    async def card_endpoint(_: Request) -> JSONResponse:
        payload = agent_card_to_dict(agent_card)
        payload["url"] = settings.diagnosis_a2a_public_url.rstrip("/")
        return JSONResponse(payload)

    app = Starlette(routes=[Route("/.well-known/agent-card.json", card_endpoint, methods=["GET"])])
    attach_a2a_routes_to_app(
        app,
        agent_card=agent_card,
        agent_executor=A2aAgentExecutor(runner=InMemoryRunner(agent, app_name="diagnosis_agent")),
        task_store=InMemoryTaskStore(),
    )
    return app
