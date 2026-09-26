"""Health response schema."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    model: str
    revision: str
