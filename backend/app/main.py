"""FastAPI application entrypoint."""

from fastapi import FastAPI
from backend.app.api.routes.map_analysis import router as map_analysis_router

from backend.app.api.rate_limit import AgentRateLimitMiddleware
from backend.app.api.routes.health import router as health_router
from backend.app.api.routes.collisions import router as collisions_router
from backend.app.api.routes.overlaps import router as overlaps_router
from backend.app.api.routes.similarity import router as similarity_router
from backend.app.api.routes.projects import router as projects_router
from backend.app.api.routes.upload_sessions import router as upload_sessions_router
from backend.app.api.routes.upload_summary import router as upload_summary_router
from backend.app.core.config import get_settings
from backend.app.services.rate_limiter import AgentRateLimiter


def create_app() -> FastAPI:
    app = FastAPI(title="ShellHacks 2026 API")
    app.include_router(health_router)
    app.include_router(similarity_router)
    app.include_router(overlaps_router)
    app.include_router(collisions_router)
    app.include_router(projects_router)
    app.include_router(upload_sessions_router)
    app.include_router(upload_summary_router)
    app.include_router(map_analysis_router)
    settings = get_settings()
    if settings.agent_rate_limit_per_client or settings.agent_rate_limit_total:
        app.add_middleware(
            AgentRateLimitMiddleware,
            limiter=AgentRateLimiter(
                per_client=settings.agent_rate_limit_per_client,
                total=settings.agent_rate_limit_total,
            ),
            user_header=settings.rate_limit_user_header,
            trusted_proxy_hops=settings.rate_limit_trusted_proxy_hops,
        )
    if settings.enable_a2a:
        from backend.app.agents.diagnosis_agent.a2a import build_diagnosis_a2a_app
        from backend.app.agents.overlap_agent.a2a import build_a2a_app

        app.mount("/a2a/diagnosis", build_diagnosis_a2a_app(settings))
        app.mount("/a2a", build_a2a_app(settings))
    return app


app = create_app()
