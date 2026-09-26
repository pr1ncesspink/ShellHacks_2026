"""FastAPI application entrypoint."""

from fastapi import FastAPI

from backend.app.api.routes.health import router as health_router
from backend.app.api.routes.overlaps import router as overlaps_router
from backend.app.api.routes.similarity import router as similarity_router


def create_app() -> FastAPI:
    app = FastAPI(title="ShellHacks 2026 API")
    app.include_router(health_router)
    app.include_router(similarity_router)
    app.include_router(overlaps_router)
    return app


app = create_app()
