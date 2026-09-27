from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
import pytest

from backend.app.api.deps import get_collision_pipeline, get_encoder_dep
from backend.app.api.rate_limit import AgentRateLimitMiddleware, client_key
from backend.app.main import create_app
from backend.app.schemas.diagnosis import DiagnosisEnvelope
from backend.app.services.rate_limiter import AgentRateLimiter


UID_HEADER = "X-Authenticated-User"
DIAGNOSIS_PATH = "/collisions/OVL_2/diagnosis"


@pytest.fixture(autouse=True)
def isolated_rate_settings(monkeypatch):
    for name in (
        "AGENT_RATE_LIMIT_PER_CLIENT", "AGENT_RATE_LIMIT_TOTAL", "RATE_LIMIT_TRUSTED_PROXY_HOPS",
        "RATE_LIMIT_USER_HEADER", "ENABLE_A2A",
    ):
        monkeypatch.delenv(name, raising=False)


def configure(monkeypatch, *, per_client=2, total=0, user_header=UID_HEADER):
    monkeypatch.setenv("AGENT_RATE_LIMIT_PER_CLIENT", str(per_client))
    monkeypatch.setenv("AGENT_RATE_LIMIT_TOTAL", str(total))
    monkeypatch.setenv("RATE_LIMIT_USER_HEADER", user_header)


def make_scope(headers=(), *, client=("192.0.2.9", 1234)):
    return {"type": "http", "method": "POST", "path": DIAGNOSIS_PATH,
            "headers": list(headers), "client": client}


@pytest.mark.parametrize("uid, expected", [
    (b"abc_123", "user:abc_123"),
    (b"A-Z_09", "user:A-Z_09"),
    (b"a" * 128, "user:" + "a" * 128),
    (b"a b", "ip:192.0.2.9"),
    (b"../", "ip:192.0.2.9"),
    (b"a" * 129, "ip:192.0.2.9"),
    (b"", "ip:192.0.2.9"),
    (b"abc\n", "ip:192.0.2.9"),
    (b"\xff", "ip:192.0.2.9"),
])
def test_user_key_requires_a_complete_well_formed_uid(uid, expected):
    scope = make_scope([(b"x-authenticated-user", uid)])
    assert client_key(scope, UID_HEADER, 1) == expected


def test_user_headers_are_case_insensitive_explicit_and_unambiguous():
    assert client_key(make_scope(), UID_HEADER, 1) == "ip:192.0.2.9"
    scope = make_scope([(b"X-Authenticated-User", b"abc_123")])
    assert client_key(scope, "x-authenticated-user", 1) == "user:abc_123"
    assert client_key(scope, "", 1) == "ip:192.0.2.9"
    scope["headers"].append((b"x-authenticated-user", b"another"))
    assert client_key(scope, UID_HEADER, 1) == "ip:192.0.2.9"


@pytest.mark.parametrize("headers, hops, client, expected", [
    ([(b"x-forwarded-for", b"spoofed, 198.51.100.7, 203.0.113.8")], 1, ("192.0.2.9", 1), "203.0.113.8"),
    ([(b"x-forwarded-for", b"spoofed, 198.51.100.7, 203.0.113.8")], 2, ("192.0.2.9", 1), "198.51.100.7"),
    ([(b"x-forwarded-for", b"203.0.113.8")], 2, ("192.0.2.9", 1), "192.0.2.9"),
    ([(b"x-forwarded-for", b"203.0.113.8")], 0, ("192.0.2.9", 1), "192.0.2.9"),
    ([], 1, ("192.0.2.9", 1), "192.0.2.9"),
    ([], 1, None, "unknown"),
    ([(b"x-forwarded-for", b"203.0.113.8")], 2, None, "unknown"),
    ([(b"x-forwarded-for", b"spoofed, ")], 1, None, "unknown"),
    ([(b"X-Forwarded-For", b"spoofed"), (b"x-forwarded-for", b"203.0.113.8")], 1, None, "203.0.113.8"),
])
def test_proxy_hops_are_counted_from_the_right(headers, hops, client, expected):
    assert client_key(make_scope(headers, client=client), "", hops) == f"ip:{expected}"


class StubPipeline:
    def __init__(self):
        self.calls = []
        self.provider_calls = 0

    def provider(self):
        self.provider_calls += 1
        return self

    def list_views(self):
        return []

    async def diagnose(self, overlap_id):
        self.calls.append(overlap_id)
        return DiagnosisEnvelope(
            overlap_id=overlap_id, verdict="RESEQUENCE", rationale="Move one window.",
            suggested_actions=[], allowed_verdicts=["RESEQUENCE"], rule_reason="test", overridden=False,
            status="model", context_used=False, model="stub", prompt_version="test", input_hash="test", cached=False,
        )


def app_with_pipeline():
    app = create_app()
    pipeline = StubPipeline()
    app.dependency_overrides[get_collision_pipeline] = pipeline.provider
    return app, pipeline


def assert_denied(response, scope):
    assert response.status_code == 429
    assert response.headers["content-type"] == "application/json"
    assert 1 <= int(response.headers["retry-after"]) <= 60
    assert response.json() == {"detail": "Agent rate limit exceeded", "scope": scope}


def test_users_sharing_one_ip_get_separate_client_budgets(monkeypatch):
    configure(monkeypatch)
    app, pipeline = app_with_pipeline()
    with TestClient(app) as http:
        for _ in range(2):
            assert http.post(DIAGNOSIS_PATH, headers={UID_HEADER: "u1"}).status_code == 200
        assert_denied(http.post(DIAGNOSIS_PATH, headers={UID_HEADER: "u1"}), "client")
        assert http.post(DIAGNOSIS_PATH, headers={UID_HEADER: "u2"}).status_code == 200
    assert len(pipeline.calls) == pipeline.provider_calls == 3


def test_rotating_users_cannot_bypass_total_budget(monkeypatch):
    configure(monkeypatch, per_client=5, total=2)
    app, pipeline = app_with_pipeline()
    with TestClient(app) as http:
        for uid in ("u1", "u2"):
            assert http.post(DIAGNOSIS_PATH, headers={UID_HEADER: uid}).status_code == 200
        assert_denied(http.post(DIAGNOSIS_PATH, headers={UID_HEADER: "u3"}), "total")
    assert len(pipeline.calls) == pipeline.provider_calls == 2


@pytest.mark.parametrize("configured", [False, True])
def test_ignored_or_malformed_uids_share_ip_budget(monkeypatch, configured):
    configure(monkeypatch, per_client=1, user_header=UID_HEADER if configured else "")
    app, pipeline = app_with_pipeline()
    uids = ("bad uid", "../") if configured else ("u1", "u2")
    with TestClient(app) as http:
        assert http.post(DIAGNOSIS_PATH, headers={UID_HEADER: uids[0]}).status_code == 200
        assert_denied(http.post(DIAGNOSIS_PATH, headers={UID_HEADER: uids[1]}), "client")
    assert len(pipeline.calls) == 1


def test_non_agent_routes_still_work_when_budgets_are_exhausted(monkeypatch, fake_encoder):
    configure(monkeypatch, per_client=1, total=1)
    app, pipeline = app_with_pipeline()
    app.dependency_overrides[get_encoder_dep] = lambda: fake_encoder
    with TestClient(app) as http:
        assert http.post(DIAGNOSIS_PATH).status_code == 200
        assert_denied(http.post(DIAGNOSIS_PATH), "total")
        for path in ("/health", "/collisions", "/overlaps/similarity"):
            assert http.get(path).status_code == 200
        assert http.post("/similarity", json={"text_a": "same", "text_b": "same"}).status_code == 200
        for path in (DIAGNOSIS_PATH, "/a2a", "/a2a/diagnosis", "/a2a/anything"):
            assert http.options(path).status_code != 429
            assert http.get(path).status_code != 429
        assert http.get("/a2a/.well-known/agent-card.json").status_code == 404
    assert len(pipeline.calls) == 1


def test_upload_diagnosis_route_is_counted(monkeypatch, fake_encoder):
    from backend.app.api.deps import get_upload_diagnosis_service
    from backend.app.api.routes.projects import get_project_store
    from backend.tests.test_upload_diagnosis import PATH, StubClient, collision, service

    class StubStore:
        calls = 0

        def collision(self, upload_id, overlap_id):
            StubStore.calls += 1
            return collision()

    configure(monkeypatch, per_client=1)
    client = StubClient()
    subject = service(fake_encoder, client)
    app = create_app()
    app.dependency_overrides[get_project_store] = StubStore
    app.dependency_overrides[get_upload_diagnosis_service] = lambda: subject
    with TestClient(app) as http:
        assert http.post(PATH, headers={UID_HEADER: "u1"}).status_code == 200
        assert_denied(http.post(PATH, headers={UID_HEADER: "u1"}), "client")
    assert StubStore.calls == client.calls == 1


def test_disabled_middleware_and_separate_app_instances(monkeypatch):
    configure(monkeypatch, per_client=0, total=0)
    app, pipeline = app_with_pipeline()
    assert all(middleware.cls is not AgentRateLimitMiddleware for middleware in app.user_middleware)
    with TestClient(app) as http:
        assert all(http.post(DIAGNOSIS_PATH).status_code == 200 for _ in range(4))
    assert len(pipeline.calls) == 4

    configure(monkeypatch, per_client=1, total=1)
    app_a, _ = app_with_pipeline()
    app_b, _ = app_with_pipeline()
    with TestClient(app_a) as a, TestClient(app_b) as b:
        assert a.post(DIAGNOSIS_PATH).status_code == 200
        assert_denied(a.post(DIAGNOSIS_PATH), "total")
        assert b.post(DIAGNOSIS_PATH).status_code == 200


def test_invalid_rate_config_fails_app_creation(monkeypatch):
    monkeypatch.setenv("AGENT_RATE_LIMIT_TOTAL", "-1")
    with pytest.raises(ValueError, match="AGENT_RATE_LIMIT_TOTAL"):
        create_app()


@pytest.mark.parametrize("path", [DIAGNOSIS_PATH, "/projects/uploads", "/a2a", "/a2a/", "/a2a/diagnosis", "/a2a/arbitrary/deep/path"])
def test_every_agent_post_is_rejected_without_reading_body_or_calling_app(path):
    clock = [0.0]
    limiter = AgentRateLimiter(0, 1, clock=lambda: clock[0])
    assert limiter.try_acquire("first").allowed
    clock[0] = 58.1
    app = AsyncMock()
    receive = AsyncMock(side_effect=AssertionError("rejected body must not be read"))
    sent = []

    async def send(message):
        sent.append(message)

    scope = make_scope()
    scope["path"] = path
    asyncio.run(AgentRateLimitMiddleware(app, limiter)(scope, receive, send))
    app.assert_not_awaited()
    receive.assert_not_awaited()
    assert sent[0]["status"] == 429
    assert dict(sent[0]["headers"])[b"retry-after"] == b"2"
    assert json.loads(sent[1]["body"]) == {"detail": "Agent rate limit exceeded", "scope": "total"}


@pytest.mark.parametrize("method, path", [
    ("POST", "/similarity"), ("POST", "/collisions/a/diagnosis/extra"),
    ("POST", "/collisions/a/b/diagnosis"), ("POST", "/a2a-other"),
    ("GET", "/a2a/.well-known/agent-card.json"), ("GET", "/health"),
    ("GET", "/projects/uploads/UPL_1/collisions"), ("POST", "/projects/uploads/extra"),
    *[(method, DIAGNOSIS_PATH) for method in ("GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE")],
])
def test_outside_agent_post_surface_bypasses_exhausted_limiter(method, path):
    limiter = AgentRateLimiter(1, 1, clock=lambda: 0.0)
    assert limiter.try_acquire("ip:192.0.2.9").allowed
    app, receive, send = AsyncMock(), AsyncMock(), AsyncMock()
    scope = make_scope()
    scope.update(method=method, path=path)
    asyncio.run(AgentRateLimitMiddleware(app, limiter)(scope, receive, send))
    app.assert_awaited_once_with(scope, receive, send)
    receive.assert_not_awaited()
    send.assert_not_awaited()


@pytest.mark.parametrize("scope_type", ["lifespan", "websocket"])
def test_non_http_scopes_pass_through(scope_type):
    app, receive, send = AsyncMock(), AsyncMock(), AsyncMock()
    scope = {"type": scope_type}
    asyncio.run(AgentRateLimitMiddleware(app, AgentRateLimiter(1, 1))(scope, receive, send))
    app.assert_awaited_once_with(scope, receive, send)


def test_admitted_asgi_request_and_stream_are_forwarded_unchanged():
    scope = make_scope()
    requests = [
        {"type": "http.request", "body": b"\x00first", "more_body": True},
        {"type": "http.request", "body": b"last\xff", "more_body": False},
    ]
    responses = [
        {"type": "http.response.start", "status": 201, "headers": [(b"x-test", b"one"), (b"x-test", b"two")]},
        {"type": "http.response.body", "body": b"chunk\x00", "more_body": True},
        {"type": "http.response.body", "body": b"end\xff", "more_body": False},
    ]
    seen = []
    receive = AsyncMock(side_effect=requests)

    async def send(message):
        seen.append(message)

    async def streaming_app(actual_scope, actual_receive, actual_send):
        assert actual_scope is scope and actual_receive is receive and actual_send is send
        assert await actual_receive() is requests[0]
        await actual_send(responses[0])
        await actual_send(responses[1])
        assert seen == responses[:2]  # Sent before the rest of the request or response exists.
        assert await actual_receive() is requests[1]
        await actual_send(responses[2])

    asyncio.run(AgentRateLimitMiddleware(streaming_app, AgentRateLimiter(1, 1))(scope, receive, send))
    assert all(actual is expected for actual, expected in zip(seen, responses, strict=True))


def test_enabled_a2a_mounts_share_budgets_and_reject_before_executor_or_llm(monkeypatch):
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.adk.a2a.executor.a2a_agent_executor import A2aAgentExecutor
    from google.genai import types

    from backend.app.agents.diagnosis_agent import a2a as diagnosis_a2a
    from backend.app.agents.overlap_agent import a2a as overlap_a2a
    from backend.app.schemas.diagnosis import DiagnosisInput, DiagnosisOverlap, Thresholds

    class StubLlm(BaseLlm):
        calls: int = 0

        async def generate_content_async(self, llm_request, stream=False):
            del llm_request, stream
            self.calls += 1
            text = json.dumps({"verdict": "RESEQUENCE", "rationale": "Move one window.", "suggested_actions": []})
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=text)]))

    configure(monkeypatch, per_client=2, total=3)
    monkeypatch.setenv("ENABLE_A2A", "1")
    overlap_model, diagnosis_model = StubLlm(model="stub"), StubLlm(model="stub")
    monkeypatch.setattr(overlap_a2a.root_agent, "model", overlap_model)
    original_build = diagnosis_a2a.build_agent

    def build(settings):
        agent = original_build(settings)
        agent.model = diagnosis_model
        return agent

    monkeypatch.setattr(diagnosis_a2a, "build_agent", build)
    executor_calls = []
    original_execute = A2aAgentExecutor.execute

    async def execute(self, *args, **kwargs):
        executor_calls.append(self)
        return await original_execute(self, *args, **kwargs)

    monkeypatch.setattr(A2aAgentExecutor, "execute", execute)
    diagnosis = DiagnosisInput(overlap=DiagnosisOverlap(
        overlap_id="OVL_2", distance_mi=5.65, time_gap_days=152, utility_a="a", project_id_a="a",
        project_name_a="a", utility_b="b", project_id_b="b", project_name_b="b", name_similarity=.3,
    ), allowed_verdicts=["RESEQUENCE"], thresholds=Thresholds())

    def rpc(text, uid):
        return {"jsonrpc": "2.0", "id": uid, "method": "SendMessage", "params": {
            "message": {"messageId": uid, "role": "ROLE_USER", "parts": [{"text": text}]},
        }}

    app, pipeline = app_with_pipeline()
    with TestClient(app) as http:
        headers = {UID_HEADER: "u1", "A2A-Version": "1.0"}
        overlap = http.post("/a2a/", json=rpc("Explain an overlap.", "overlap"), headers=headers)
        assert overlap.status_code == 200 and "error" not in overlap.json()
        diagnosis_response = http.post("/a2a/diagnosis/", json=rpc(diagnosis.model_dump_json(), "diagnosis"), headers=headers)
        assert diagnosis_response.status_code == 200 and "error" not in diagnosis_response.json()
        assert (overlap_model.calls, diagnosis_model.calls, len(executor_calls)) == (1, 1, 2)
        for path in ("/a2a", "/a2a/diagnosis", "/a2a/", "/a2a/diagnosis/", DIAGNOSIS_PATH):
            assert_denied(http.post(path, json={}, headers=headers, follow_redirects=False), "client")
        # Diagnosis HTTP and both A2A agents also share the instance-wide budget.
        assert http.post(DIAGNOSIS_PATH, headers={UID_HEADER: "u2"}).status_code == 200
        assert_denied(http.post("/a2a/", json={}, headers={UID_HEADER: "u3"}), "total")
        for path in ("/a2a/.well-known/agent-card.json", "/a2a/diagnosis/.well-known/agent-card.json"):
            assert http.get(path).status_code == 200
        assert (overlap_model.calls, diagnosis_model.calls, len(executor_calls)) == (1, 1, 2)
        assert len(pipeline.calls) == pipeline.provider_calls == 1


def test_slashless_a2a_routing_is_preserved_and_each_post_consumes_a_slot(monkeypatch):
    configure(monkeypatch, per_client=0, total=2)
    monkeypatch.setenv("ENABLE_A2A", "1")
    with TestClient(create_app()) as http:
        for path, expected in (("/a2a", 307), ("/a2a/diagnosis", 404)):
            response = http.post(path, follow_redirects=False)
            assert response.status_code == expected
            if expected == 307:
                assert response.headers["location"].endswith(path + "/")
        assert_denied(http.post("/a2a/", json={}), "total")
