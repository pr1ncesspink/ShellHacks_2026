"""Overlap CSV schemas."""

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr


class OverlapRow(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="allow")

    overlap_id: str
    distance_mi: float
    time_gap_days: int = Field(alias="time_gap (day)")
    utility_a: str
    project_id_a: str
    project_name_a: str
    utility_b: str
    project_id_b: str
    project_name_b: str
    _source_columns: tuple[str, ...] = PrivateAttr(default=())


class ScoredOverlap(OverlapRow):
    name_similarity: float
