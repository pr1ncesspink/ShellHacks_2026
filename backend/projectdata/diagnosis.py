"""Adapt stored collisions-v1 records to the guarded diagnosis contract."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from backend.app.agents.collision_pipeline.clients import DiagnosisClient
from backend.app.agents.collision_pipeline.pipeline import run_diagnosis
from backend.app.schemas.diagnosis import (
    DiagnosisEnvelope, DiagnosisInput, DiagnosisOverlap, ProjectContext, Thresholds,
    TimingBasis, UploadDiagnosisResult,
)
from backend.app.services.diagnosis_rules import allowed_verdicts
from backend.app.services.similarity import Encoder, score_pairs

from .records import ProjectPoint


UNKNOWN_UTILITY = "Unknown utility"


def point_year(point: ProjectPoint) -> int | None:
    if point.in_service_date is not None:
        return point.in_service_date.year
    return point.estimated_in_service_year


def timing(collision: dict) -> tuple[int, TimingBasis, list[str]]:
    """Use only stored dates, years, and exact gap; year gaps are lower bounds."""
    uploaded = ProjectPoint.model_validate(collision["uploaded_project"])
    reference = ProjectPoint.model_validate(collision["reference_project"])
    exact_gap = collision.get("time_gap_days")
    if type(exact_gap) is int:
        return exact_gap, "exact_dates", []
    if exact_gap is not None:
        raise ValueError("Invalid stored time_gap_days")
    year_a, year_b = point_year(uploaded), point_year(reference)
    if year_a is not None and year_b is not None:
        return max(0, abs(year_a - year_b) - 1) * 365, "year_precision", []
    missing = []
    if year_a is None:
        missing.append("uploaded_project")
    if year_b is None:
        missing.append("reference_project")
    return 0, "timing_unknown", missing


def upload_diagnosis_input(
    collision: dict, encoder: Encoder, thresholds: Thresholds,
) -> tuple[DiagnosisInput, TimingBasis, list[str]]:
    uploaded = ProjectPoint.model_validate(collision["uploaded_project"])
    reference = ProjectPoint.model_validate(collision["reference_project"])
    gap, basis, missing_dates = timing(collision)
    utility_a = (uploaded.owner or "").strip() or UNKNOWN_UTILITY
    utility_b = (reference.owner or "").strip() or UNKNOWN_UTILITY
    overlap = DiagnosisOverlap(
        overlap_id=collision["overlap_id"], distance_mi=collision["distance_mi"],
        time_gap_days=gap, timing_basis=basis,
        utility_a=utility_a, project_id_a=uploaded.project_id, project_name_a=uploaded.project_name,
        utility_b=utility_b, project_id_b=reference.project_id, project_name_b=reference.project_name,
        name_similarity=score_pairs([(uploaded.project_name, reference.project_name)], encoder)[0],
    )
    project_a = ProjectContext.model_validate({
        **uploaded.source,
        "project_id": uploaded.project_id, "project_name": uploaded.project_name,
        "utility": utility_a, "status": uploaded.status,
        "in_service_date": uploaded.in_service_date, "description": uploaded.description,
    })
    project_b = ProjectContext(
        project_id=reference.project_id, project_name=reference.project_name,
        utility=utility_b, status=reference.status,
        in_service_date=reference.in_service_date, description=reference.description,
    )
    diagnosis_input = DiagnosisInput(
        overlap=overlap, project_a=project_a, project_b=project_b,
        allowed_verdicts=list(allowed_verdicts(overlap, thresholds)), thresholds=thresholds,
    )
    return diagnosis_input, basis, missing_dates


class UploadDiagnosisService:
    def __init__(
        self, encoder_provider: Callable[[], Encoder], client: DiagnosisClient,
        thresholds: Thresholds, model_id: str, prompt_version: str,
    ) -> None:
        self.encoder_provider = encoder_provider
        self.client = client
        self.thresholds = thresholds
        self.model_id = model_id
        self.prompt_version = prompt_version
        self._cache: dict[str, DiagnosisEnvelope] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def prepare(self, collision: dict) -> tuple[DiagnosisInput, TimingBasis, list[str]]:
        """Synchronous (encoder) step; routes run it in the threadpool."""
        return upload_diagnosis_input(collision, self.encoder_provider(), self.thresholds)

    async def diagnose(self, upload_id: str, collision: dict,
                       prepared: tuple[DiagnosisInput, TimingBasis, list[str]] | None = None,
                       ) -> UploadDiagnosisResult:
        diagnosis_input, basis, missing_dates = prepared or self.prepare(collision)
        overlap_id = diagnosis_input.overlap.overlap_id
        diagnosis = await run_diagnosis(
            diagnosis_input, None, overlap_id=overlap_id, client=self.client,
            thresholds=self.thresholds, model_id=self.model_id, prompt_version=self.prompt_version,
            cache=self._cache, locks=self._locks,
        )
        return UploadDiagnosisResult(
            upload_id=upload_id, overlap_id=overlap_id, timing_basis=basis,
            missing_dates=missing_dates, diagnosis=diagnosis,
        )
