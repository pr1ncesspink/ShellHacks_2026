"""Whitelisted data contracts for collision diagnosis."""

from __future__ import annotations

import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.app.schemas.overlaps import ScoredOverlap


Verdict = Literal["CO_SCHEDULE", "RESEQUENCE", "NO_ACTION"]
DiagnosisStatus = Literal["model", "rule_only", "rejected_input"]

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_STRING_LIMIT = 512


def _clean_string(value: str, *, limit: int = _STRING_LIMIT) -> str:
    return _CONTROL_CHARS.sub("", value)[:limit]


class ProjectContext(BaseModel):
    """Read-only project fields permitted in the diagnosis prompt."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    project_id: str = Field(min_length=1)
    project_name: str = Field(min_length=1)
    utility: str | None = None
    state: str | None = None
    status: str | None = None
    in_service_date: date | None = None
    asset_type: str | None = None
    voltages_kv: list[float] = Field(default_factory=list)
    line_length_mi: float | None = Field(default=None, ge=0)
    description: str | None = None
    need: str | None = None

    @field_validator("project_id", "project_name", "utility", "state", "status", "asset_type", mode="before")
    @classmethod
    def sanitize_strings(cls, value: object) -> object:
        return _clean_string(value) if isinstance(value, str) else value

    @field_validator("description", mode="before")
    @classmethod
    def sanitize_description(cls, value: object) -> object:
        return _clean_string(value, limit=600) if isinstance(value, str) else value

    @field_validator("need", mode="before")
    @classmethod
    def sanitize_need(cls, value: object) -> object:
        return _clean_string(value, limit=300) if isinstance(value, str) else value


class CollisionView(BaseModel):
    overlap: ScoredOverlap
    project_a: ProjectContext | None = None
    project_b: ProjectContext | None = None
    snowflake_eligible: bool | None = None


class Thresholds(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    max_distance_mi: float = Field(default=15.0, ge=0)
    max_gap_days: int = Field(default=1095, ge=0)
    co_schedule_min_similarity: float = Field(default=0.45, ge=0, le=1)


class DiagnosisOverlap(BaseModel):
    """Exactly the score and nine overlap fields used by the rule engine."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    overlap_id: str
    distance_mi: float = Field(ge=0)
    time_gap_days: int = Field(ge=0)
    utility_a: str
    project_id_a: str
    project_name_a: str
    utility_b: str
    project_id_b: str
    project_name_b: str
    name_similarity: float = Field(ge=-1, le=1)

    @field_validator(
        "overlap_id", "utility_a", "project_id_a", "project_name_a", "utility_b", "project_id_b", "project_name_b",
        mode="before",
    )
    @classmethod
    def sanitize_overlap_strings(cls, value: object) -> object:
        return _clean_string(value) if isinstance(value, str) else value


class DiagnosisInput(BaseModel):
    """Server-built payload accepted by the diagnosis agent only."""

    model_config = ConfigDict(extra="forbid")

    overlap: DiagnosisOverlap
    project_a: ProjectContext | None = None
    project_b: ProjectContext | None = None
    allowed_verdicts: list[Verdict] = Field(min_length=1)
    thresholds: Thresholds


class DiagnosisDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: Verdict
    rationale: str = Field(min_length=1, max_length=600)
    suggested_actions: list[str] = Field(default_factory=list, max_length=3)

    @field_validator("suggested_actions")
    @classmethod
    def action_lengths(cls, value: list[str]) -> list[str]:
        if any(len(action) > 200 for action in value):
            raise ValueError("Suggested actions must be at most 200 characters")
        return value


class DiagnosisEnvelope(BaseModel):
    overlap_id: str
    verdict: Verdict
    rationale: str
    suggested_actions: list[str]
    allowed_verdicts: list[Verdict]
    rule_reason: str
    overridden: bool
    status: DiagnosisStatus
    context_used: bool
    snowflake_eligible: bool | None = None
    model: str
    prompt_version: str
    input_hash: str
    cached: bool


class DiagnoseRequest(BaseModel):
    """Intentionally empty: the server builds diagnosis input from stored data."""

    model_config = ConfigDict(extra="forbid")
