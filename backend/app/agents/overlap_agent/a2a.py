"""Eager A2A ASGI application construction for the overlap agent."""

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

from .agent import root_agent


def _agent_card(settings: Settings):
    skills = [
        AgentSkill(
            id=name,
            name=name,
            description=description,
            tags=["tools"],
            input_modes=["text/plain"],
            output_modes=["text/plain"],
        )
        for name, description in [
            ("score_project_names", "Score two utility project names."),
            ("get_overlap", "Retrieve one scored overlap by identifier."),
            ("list_overlaps", "List scored overlaps above a similarity threshold."),
            ("get_upload_collisions", "Read an uploaded plan's nearby reference projects and scope similarity."),
        ]
    ]
    return _compat.build_agent_card(
        name="overlap_agent",
        description=root_agent.description,
        version="0.1.0",
        url=settings.a2a_public_url,
        protocol_binding=_compat.TP_JSONRPC.value,
        skills=skills,
    )


def build_a2a_app(settings: Settings) -> Starlette:
    """Build an A2A application with routes available before parent startup.

    ADK's public ``to_a2a`` helper registers routes in lifespan startup, which
    Starlette does not run for a mounted sub-application. The ADK 2.10
    compatibility helper below eagerly adds the current a2a-sdk 1.x routes.
    """
    agent_card = _agent_card(settings)

    async def card_endpoint(_: Request) -> JSONResponse:
        payload = agent_card_to_dict(agent_card)
        # a2a-sdk 1.x carries this value in supportedInterfaces. Retaining this
        # field makes discovery compatible with clients expecting the 0.3 card.
        payload["url"] = settings.a2a_public_url.rstrip("/")
        return JSONResponse(payload)

    app = Starlette(
        routes=[Route("/.well-known/agent-card.json", card_endpoint, methods=["GET"])],
    )
    runner = InMemoryRunner(root_agent, app_name="overlap_agent")
    executor = A2aAgentExecutor(runner=runner)
    attach_a2a_routes_to_app(
        app,
        agent_card=agent_card,
        agent_executor=executor,
        task_store=InMemoryTaskStore(),
    )
    return app
