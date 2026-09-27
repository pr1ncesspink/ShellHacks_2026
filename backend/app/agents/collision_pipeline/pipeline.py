"""Deterministic collision scoring, context joining, and guarded diagnosis."""

from __future__ import annotations

import asyncio
from typing import Callable

from backend.app.schemas.diagnosis import (
    CollisionView, DiagnosisDecision, DiagnosisEnvelope, DiagnosisInput, DiagnosisOverlap, Thresholds,
)
from backend.app.services.diagnosis_rules import allowed_verdicts, cache_key, guard
from backend.app.services.overlap_sources import CollisionBundle, OverlapSource
from backend.app.services.overlaps import score_overlaps

from .clients import DiagnosisClient


class CollisionPipeline:
    def __init__(self, source: OverlapSource, encoder_provider: Callable, client: DiagnosisClient,
                 thresholds: Thresholds, model_id: str, prompt_version: str) -> None:
        self.source = source
        self.encoder_provider = encoder_provider
        self.client = client
        self.thresholds = thresholds
        self.model_id = model_id
        self.prompt_version = prompt_version
        self._bundle: CollisionBundle | None = None
        self._scored = None
        self._cache: dict[str, DiagnosisEnvelope] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def reload(self) -> None:
        self._bundle = None
        self._scored = None
        self._cache.clear()
        self._locks.clear()

    def _load(self) -> tuple[CollisionBundle, list]:
        if self._bundle is None:
            self._bundle = self.source.load()
        if self._scored is None:
            self._scored = score_overlaps(self._bundle.overlaps, self.encoder_provider())
        return self._bundle, self._scored

    def list_views(self) -> list[CollisionView]:
        bundle, scored = self._load()
        return [
            CollisionView(
                overlap=row.model_copy(update={"name_similarity": round(row.name_similarity, 4)}),
                project_a=bundle.projects.get(row.project_id_a), project_b=bundle.projects.get(row.project_id_b),
                snowflake_eligible=(row.overlap_id in bundle.eligible_ids) if bundle.eligible_ids is not None else None,
            )
            for row in scored
        ]

    def _input(self, overlap_id: str) -> tuple[DiagnosisInput, bool | None]:
        bundle, scored = self._load()
        for row in scored:
            if row.overlap_id == overlap_id:
                input_overlap = DiagnosisOverlap(
                    overlap_id=row.overlap_id, distance_mi=row.distance_mi, time_gap_days=row.time_gap_days,
                    utility_a=row.utility_a, project_id_a=row.project_id_a, project_name_a=row.project_name_a,
                    utility_b=row.utility_b, project_id_b=row.project_id_b, project_name_b=row.project_name_b,
                    name_similarity=row.name_similarity,
                )
                allowed = list(allowed_verdicts(input_overlap, self.thresholds))
                return DiagnosisInput(
                    overlap=input_overlap, project_a=bundle.projects.get(row.project_id_a),
                    project_b=bundle.projects.get(row.project_id_b),
                    allowed_verdicts=allowed, thresholds=self.thresholds,
                ), (row.overlap_id in bundle.eligible_ids) if bundle.eligible_ids is not None else None
        raise KeyError(overlap_id)

    async def diagnose(self, overlap_id: str) -> DiagnosisEnvelope:
        diagnosis_input, eligible = self._input(overlap_id)
        key = cache_key(diagnosis_input, self.model_id, self.prompt_version)
        cached = self._cache.get(key)
        if cached is not None:
            return cached.model_copy(update={"cached": True})
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._cache.get(key)
            if cached is not None:
                return cached.model_copy(update={"cached": True})
            result = await self.client.diagnose(diagnosis_input)
            if result.status == "rejected_input":
                decision = DiagnosisDecision(
                    verdict=diagnosis_input.allowed_verdicts[-1], rationale="Diagnosis input was rejected."
                )
                envelope = DiagnosisEnvelope(
                    overlap_id=overlap_id, verdict=decision.verdict, rationale=decision.rationale,
                    suggested_actions=[], allowed_verdicts=diagnosis_input.allowed_verdicts,
                    rule_reason="rejected_input", overridden=True, status="rejected_input",
                    context_used=bool(diagnosis_input.project_a or diagnosis_input.project_b),
                    snowflake_eligible=eligible, model=self.model_id, prompt_version=self.prompt_version,
                    input_hash=key, cached=False,
                )
            else:
                guarded = guard(result.decision, diagnosis_input.overlap, self.thresholds)
                envelope = DiagnosisEnvelope(
                    overlap_id=overlap_id, verdict=guarded.decision.verdict, rationale=guarded.decision.rationale,
                    suggested_actions=guarded.decision.suggested_actions,
                    allowed_verdicts=diagnosis_input.allowed_verdicts, rule_reason=guarded.rule_reason,
                    overridden=guarded.overridden, status=guarded.status,
                    context_used=bool(diagnosis_input.project_a or diagnosis_input.project_b),
                    snowflake_eligible=eligible, model=self.model_id, prompt_version=self.prompt_version,
                    input_hash=key, cached=False,
                )
            self._cache[key] = envelope
            return envelope
