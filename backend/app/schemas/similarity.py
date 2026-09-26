"""Similarity request and response schemas."""

from pydantic import BaseModel, Field


class SimilarityRequest(BaseModel):
    text_a: str = Field(min_length=1, max_length=512)
    text_b: str = Field(min_length=1, max_length=512)


class SimilarityResponse(BaseModel):
    score: float
