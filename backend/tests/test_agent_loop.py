from __future__ import annotations

import asyncio
import socket

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.genai import types

from backend.app.agents.overlap_agent.agent import build_agent
from backend.app.agents.overlap_agent import tools
from backend.app.core.config import get_settings


class StubLlm(BaseLlm):
    """Offline model that requests one overlap then returns a final response."""

    calls: int = 0

    async def generate_content_async(self, llm_request, stream: bool = False):
        del llm_request, stream
        self.calls += 1
        if self.calls == 1:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name="get_overlap", args={"overlap_id": "OVL_1"}
                            )
                        )
                    ],
                )
            )
            return
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="OVL_1 is available.")])
        )


def test_agent_loop_calls_get_overlap_without_network(fake_encoder, monkeypatch):
    def block_network(*args, **kwargs):
        raise AssertionError("offline agent test attempted a network connection")

    tools.set_encoder_provider(lambda: fake_encoder)
    model = StubLlm(model="stub")
    agent = build_agent(get_settings())
    agent.model = model
    runner = InMemoryRunner(agent, app_name="overlap_agent_test")

    async def run_agent():
        session = await runner.session_service.create_session(
            app_name=runner.app_name, user_id="test-user"
        )
        return [
            event
            async for event in runner.run_async(
                user_id="test-user",
                session_id=session.id,
                new_message=types.Content(role="user", parts=[types.Part(text="Find OVL_1")]),
            )
        ]

    loop = asyncio.new_event_loop()
    try:
        # Windows creates the event loop's internal socketpair up front.
        monkeypatch.setattr(socket.socket, "connect", block_network)
        events = loop.run_until_complete(run_agent())
    finally:
        loop.close()
    assert model.calls == 2
    assert len(fake_encoder.calls) == 1
    assert any(
        part.function_call and part.function_call.name == "get_overlap"
        for event in events
        if event.content and event.content.parts
        for part in event.content.parts
    )
    final_text = [
        part.text
        for event in events
        if event.is_final_response() and event.content and event.content.parts
        for part in event.content.parts
        if part.text
    ]
    assert final_text
