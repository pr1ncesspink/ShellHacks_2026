"""Pure ASGI admission gate for routes that can reach an agent or paid AI extraction."""

from __future__ import annotations

import re

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from backend.app.services.rate_limiter import AgentRateLimiter


AGENT_PATH = re.compile(r"^(/collisions/[^/]+/diagnosis|/projects/uploads|/a2a(/.*)?)$")
USER_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def client_key(scope: Scope, user_header: str, hops: int) -> str:
    """Use a configured, trusted UID, otherwise the trusted proxy/client IP.

    Cloud Run must remain private when user_header is configured: IAM admits
    the Next.js server, which verifies Firebase users and supplies this header.
    Duplicate UID headers are ambiguous and therefore fall back to the IP.
    """
    headers = scope.get("headers", [])
    if user_header:
        values = [
            value
            for name, value in headers
            if name.decode("latin-1").lower() == user_header.lower()
        ]
        if len(values) == 1 and 1 <= len(values[0]) <= 128:
            uid = values[0].decode("latin-1")
            if USER_ID.fullmatch(uid):
                return f"user:{uid}"

    client = scope.get("client")
    ip = client[0] if client and client[0] else "unknown"
    if hops >= 1:
        forwarded = [
            entry.strip()
            for name, value in headers
            if name.lower() == b"x-forwarded-for"
            for entry in value.decode("latin-1").split(",")
        ]
        if len(forwarded) >= hops and forwarded[-hops]:
            ip = forwarded[-hops]
    return f"ip:{ip}"


class AgentRateLimitMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        limiter: AgentRateLimiter,
        user_header: str = "",
        trusted_proxy_hops: int = 1,
    ) -> None:
        self.app = app
        self.limiter = limiter
        self.user_header = user_header
        self.trusted_proxy_hops = trusted_proxy_hops

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] == "http"
            and scope["method"] == "POST"
            and AGENT_PATH.fullmatch(scope["path"])
        ):
            decision = self.limiter.try_acquire(
                client_key(scope, self.user_header, self.trusted_proxy_hops)
            )
            if not decision.allowed:
                response = JSONResponse(
                    {"detail": "Agent rate limit exceeded", "scope": decision.scope},
                    status_code=429,
                    headers={"Retry-After": str(decision.retry_after)},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
