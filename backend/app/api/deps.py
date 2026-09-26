"""FastAPI dependency providers."""

from backend.app.core.config import Settings, get_settings as load_settings
from backend.app.services.similarity import Encoder, get_encoder


def get_settings() -> Settings:
    return load_settings()


def get_encoder_dep() -> Encoder:
    return get_encoder()
