"""Health endpoint."""

from fastapi import APIRouter, Depends

from backend.app.api.deps import get_settings
from backend.app.core.config import Settings
from backend.app.schemas.health import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health(settings: Settings = Depends(get_settings)) -> HealthResponse:
    return HealthResponse(status="ok", model=settings.model_id, revision=settings.model_revision)
