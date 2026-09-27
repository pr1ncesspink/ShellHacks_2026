"""FastAPI dependency providers."""

from functools import lru_cache

from backend.app.core.config import Settings, get_settings as load_settings
from backend.app.schemas.diagnosis import Thresholds
from backend.app.services.similarity import Encoder, get_encoder


def get_settings() -> Settings:
    return load_settings()


def get_encoder_dep() -> Encoder:
    return get_encoder()


def _thresholds(settings: Settings) -> Thresholds:
    return Thresholds(
        max_distance_mi=settings.diag_max_distance_mi,
        max_gap_days=settings.diag_max_gap_days,
        co_schedule_min_similarity=settings.diag_co_schedule_min_sim,
    )


def _diagnosis_client(settings: Settings):
    from backend.app.agents.collision_pipeline.clients import A2ADiagnosisClient, InProcessDiagnosisClient

    if settings.diagnosis_transport == "inprocess":
        return InProcessDiagnosisClient(settings)
    if settings.diagnosis_transport == "a2a":
        return A2ADiagnosisClient(settings.diagnosis_a2a_url)
    raise ValueError(f"Unsupported DIAGNOSIS_TRANSPORT: {settings.diagnosis_transport!r}")


@lru_cache(maxsize=1)
def get_collision_pipeline():
    """Construct the collision pipeline only on its first use."""
    from backend.app.agents.collision_pipeline.pipeline import CollisionPipeline
    from backend.app.agents.diagnosis_agent.agent import PROMPT_VERSION
    from backend.app.services.overlap_sources import get_overlap_source

    settings = load_settings()
    return CollisionPipeline(
        get_overlap_source(settings), get_encoder, _diagnosis_client(settings), _thresholds(settings),
        settings.diagnosis_model, PROMPT_VERSION,
    )


@lru_cache(maxsize=1)
def get_upload_diagnosis_service():
    from backend.app.agents.diagnosis_agent.agent import PROMPT_VERSION
    from backend.projectdata.diagnosis import UploadDiagnosisService

    settings = load_settings()
    return UploadDiagnosisService(
        get_encoder, _diagnosis_client(settings), _thresholds(settings),
        settings.diagnosis_model, PROMPT_VERSION,
    )
