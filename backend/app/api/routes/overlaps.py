"""Overlap scoring endpoint."""

from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Depends

from backend.app.api.deps import get_encoder_dep, get_settings
from backend.app.core.config import Settings
from backend.app.schemas.overlaps import ScoredOverlap
from backend.app.services.overlaps import load_overlaps, score_overlaps
from backend.app.services.similarity import Encoder

router = APIRouter(tags=["overlaps"])


@lru_cache(maxsize=None)
def _load_cached(path: str):
    return load_overlaps(Path(path))


@lru_cache(maxsize=None)
def _score_cached(path: str, encoder: Encoder) -> tuple[ScoredOverlap, ...]:
    return tuple(score_overlaps(_load_cached(path), encoder))


@router.get("/overlaps/similarity", response_model=list[ScoredOverlap])
def overlap_similarity(
    settings: Settings = Depends(get_settings), encoder: Encoder = Depends(get_encoder_dep)
) -> list[ScoredOverlap]:
    return [row.model_copy(update={"name_similarity": round(row.name_similarity, 4)}) for row in _score_cached(str(settings.data_path), encoder)]
