"""Whitelisted data contracts for automatic upload summaries and upload maps.

Every model here is allow-listed: stored project ``source`` and ``semantic_text``
never appear in any field, and model output is bounded before it is stored.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


SummaryStatus = Literal["model", "rule_only", "pending"]
PROMPT_VERSION = "summary.v1"
RULE_ONLY_MODEL = "rule_only"
MAX_PROJECTS = 40
MAX_COLLISIONS = 10
MAX_DESCRIPTION = 280
MAX_INPUT_BYTES = 24_000
MAX_OVERVIEW_WORDS = 120

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_CODE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


def clean(value: object, limit: int) -> object:
    """Strip control characters and bound length; non-strings pass through to validation."""
    if isinstance(value, str):
        return _CONTROL_CHARS.sub(" ", value).strip()[:limit]
    return value


def _histogram(value: dict[str, int]) -> dict[str, int]:
    if len(value) > 40:
        raise ValueError("Histogram has too many keys")
    if any(not _CODE.fullmatch(key) or type(count) is not int or count < 0 for key, count in value.items()):
        raise ValueError("Histogram keys must be short codes with nonnegative counts")
    return value


# -- map (response) ------------------------------------------------------------------------

class MapPoint(BaseModel):
    """Allow-listed project point; unknown keys (source, semantic_text, description) are dropped."""

    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)

    record_id: str = Field(min_length=1, max_length=256)
    project_id: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=300)
    owner: str | None = Field(default=None, max_length=200)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    coordinate_method: str | None = Field(default=None, max_length=64)
    status: str | None = Field(default=None, max_length=120)
    in_service_date: date | None = None
    estimated_in_service_year: int | None = Field(default=None, ge=1900, le=2200)

    @field_validator("record_id", "project_id", "coordinate_method", mode="before")
    @classmethod
    def _ids(cls, value: object) -> object:
        return clean(value, 256)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value: object) -> object:
        return clean(value, 300)

    @field_validator("owner", "status", mode="before")
    @classmethod
    def _short(cls, value: object) -> object:
        return clean(value, 120) or None


class MapCollision(BaseModel):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)

    overlap_id: str = Field(pattern=r"^COL_[a-f0-9]{24}$")
    distance_mi: float = Field(ge=0)
    time_gap_days: int | None = Field(default=None, ge=0)
    timing_basis: str | None = Field(default=None, max_length=64)
    uploaded: MapPoint
    reference: MapPoint


class UploadMap(BaseModel):
    upload_id: str
    points: list[MapPoint]
    collisions: list[MapCollision]


# -- agent input ---------------------------------------------------------------------------

class SummaryProject(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    project_id: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=300)
    owner: str | None = Field(default=None, max_length=120)
    status: str | None = Field(default=None, max_length=120)
    in_service_date: date | None = None
    estimated_in_service_year: int | None = Field(default=None, ge=1900, le=2200)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION)

    @field_validator("project_id", mode="before")
    @classmethod
    def _id(cls, value: object) -> object:
        return clean(value, 256)

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value: object) -> object:
        return clean(value, 300)

    @field_validator("owner", "status", mode="before")
    @classmethod
    def _short(cls, value: object) -> object:
        return clean(value, 120) or None

    @field_validator("description", mode="before")
    @classmethod
    def _description(cls, value: object) -> object:
        return clean(value, MAX_DESCRIPTION) or None


class SummaryCollision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)

    overlap_id: str = Field(pattern=r"^COL_[a-f0-9]{24}$")
    distance_mi: float = Field(ge=0)
    time_gap_days: int | None = Field(default=None, ge=0)
    timing_basis: str | None = Field(default=None, max_length=64)
    uploaded_project_id: str = Field(min_length=1, max_length=256)
    uploaded_name: str = Field(min_length=1, max_length=300)
    reference_project_id: str = Field(min_length=1, max_length=256)
    reference_name: str = Field(min_length=1, max_length=300)
    reference_owner: str | None = Field(default=None, max_length=120)


class SummaryAggregates(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    project_count: int = Field(ge=0)
    point_count: int = Field(ge=0)
    located_point_count: int = Field(ge=0)
    collision_count: int = Field(ge=0)
    unresolved_locations: int = Field(ge=0)
    missing_dates: int = Field(ge=0)
    coordinate_methods: dict[str, int] = Field(default_factory=dict)
    timing_tiers: dict[str, int] = Field(default_factory=dict)
    gap_buckets: dict[str, int] = Field(default_factory=dict)
    extraction_warnings: dict[str, int] = Field(default_factory=dict)

    @field_validator("coordinate_methods", "timing_tiers", "gap_buckets", "extraction_warnings")
    @classmethod
    def _hist(cls, value: dict[str, int]) -> dict[str, int]:
        return _histogram(value)


class SummaryInput(BaseModel):
    """Server-built payload accepted by the summary agent only."""

    model_config = ConfigDict(extra="forbid")

    upload_id: str = Field(pattern=r"^UPL_[a-f0-9]{32}$")
    aggregates: SummaryAggregates
    projects: list[SummaryProject] = Field(max_length=MAX_PROJECTS)
    nearest_collisions: list[SummaryCollision] = Field(max_length=MAX_COLLISIONS)
    truncated: bool = False


# -- agent output (what the model may return) -----------------------------------------------

def _words(value: str) -> str:
    if len(value.split()) > MAX_OVERVIEW_WORDS:
        raise ValueError(f"overview must be at most {MAX_OVERVIEW_WORDS} words")
    return value


class DraftKeyProject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=256)
    name: str = Field(default="", max_length=300)
    why: str = Field(min_length=1, max_length=240)


class DraftHotspot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    overlap_ids: list[str] = Field(min_length=1, max_length=MAX_COLLISIONS)
    label: str = Field(min_length=1, max_length=120)


class SummaryDraft(BaseModel):
    """The agent's output_schema: text only; coordinates and counts come from the server."""

    model_config = ConfigDict(extra="forbid")

    headline: str = Field(min_length=1, max_length=120)
    overview: str = Field(min_length=1, max_length=1000)
    key_projects: list[DraftKeyProject] = Field(default_factory=list, max_length=5)
    hotspots: list[DraftHotspot] = Field(default_factory=list, max_length=5)
    timing_notes: list[str] = Field(default_factory=list, max_length=3)

    @field_validator("overview")
    @classmethod
    def _overview_words(cls, value: str) -> str:
        return _words(value)

    @field_validator("timing_notes")
    @classmethod
    def _notes(cls, value: list[str]) -> list[str]:
        if any(not note or len(note) > 200 for note in value):
            raise ValueError("timing notes must be 1-200 characters")
        return value


# -- stored / served summary ----------------------------------------------------------------

class KeyProject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str
    name: str
    why: str = Field(max_length=240)


class Hotspot(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    overlap_ids: list[str] = Field(min_length=1, max_length=MAX_COLLISIONS)
    label: str = Field(max_length=120)
    nearest_mi: float = Field(ge=0)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class DataGaps(BaseModel):
    model_config = ConfigDict(extra="forbid")

    unresolved_locations: int = Field(ge=0)
    missing_dates: int = Field(ge=0)
    truncated: bool


class SummaryCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    projects: int = Field(ge=0)
    points: int = Field(ge=0)
    located_points: int = Field(ge=0)
    collisions: int = Field(ge=0)


class GeneratedBy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str
    prompt_version: str
    input_hash: str


class UploadSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: SummaryStatus
    headline: str = Field(max_length=120)
    overview: str = Field(default="", max_length=1000)
    key_projects: list[KeyProject] = Field(default_factory=list, max_length=5)
    hotspots: list[Hotspot] = Field(default_factory=list, max_length=5)
    timing_notes: list[str] = Field(default_factory=list, max_length=3)
    data_gaps: DataGaps | None = None
    counts: SummaryCounts | None = None
    generated_by: GeneratedBy | None = None

    @field_validator("overview")
    @classmethod
    def _overview_words(cls, value: str) -> str:
        return _words(value)


class UploadSummaryResponse(UploadSummary):
    upload_id: str
    created_at: str | None = None


class RecentUpload(BaseModel):
    upload_id: str
    created_at: str | None = None
    status: SummaryStatus
    headline: str
    counts: SummaryCounts | None = None


class RecentUploads(BaseModel):
    uploads: list[RecentUpload]
