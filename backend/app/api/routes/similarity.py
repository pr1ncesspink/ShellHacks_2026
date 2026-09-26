"""Pair similarity endpoint."""

from fastapi import APIRouter, Depends

from backend.app.api.deps import get_encoder_dep
from backend.app.schemas.similarity import SimilarityRequest, SimilarityResponse
from backend.app.services.similarity import Encoder, score_pair

router = APIRouter(tags=["similarity"])


@router.post("/similarity", response_model=SimilarityResponse)
def similarity(request: SimilarityRequest, encoder: Encoder = Depends(get_encoder_dep)) -> SimilarityResponse:
    return SimilarityResponse(score=round(score_pair(request.text_a, request.text_b, encoder), 4))
