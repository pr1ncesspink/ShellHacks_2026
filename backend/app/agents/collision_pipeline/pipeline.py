"""Deterministic collision scoring, context joining, and guarded diagnosis."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable

from backend.app.schemas.diagnosis import (
    CollisionView, DiagnosisDecision, DiagnosisEnvelope, DiagnosisInput, DiagnosisOverlap, Thresholds,
)
from backend.app.services.diagnosis_rules import allowed_verdicts, cache_key, guard
from backend.app.services.overlap_sources import CollisionBundle, OverlapSource
from backend.app.services.overlaps import score_overlaps

from .clients import DiagnosisClient

logger = logging.getLogger(__name__)

RULE_ONLY_TTL_S = 30.0


class CollisionPipeline:
    def __init__(self, source: OverlapSource, encoder_provider: Callable, client: DiagnosisClient,
                 thresholds: Thresholds, model_id: str, prompt_version: str, *,
                 clock: Callable[[], float] = time.monotonic) -> None:
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
        self._failure_expiry: dict[str, float] = {}
        self._clock = clock

    def reload(self) -> None:
        self._bundle = None
        self._scored = None
        self._cache.clear()
        self._locks.clear()
        self._failure_expiry.clear()

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
        return await run_diagnosis(
            diagnosis_input, eligible, overlap_id=overlap_id, client=self.client,
            thresholds=self.thresholds, model_id=self.model_id, prompt_version=self.prompt_version,
            cache=self._cache, locks=self._locks, failure_expiry=self._failure_expiry, clock=self._clock,
        )


async def run_diagnosis(
    diagnosis_input: DiagnosisInput, eligible: bool | None, *, overlap_id: str,
    client: DiagnosisClient, thresholds: Thresholds, model_id: str, prompt_version: str,
    cache: dict[str, DiagnosisEnvelope], locks: dict[str, asyncio.Lock],
    failure_expiry: dict[str, float] | None = None, failure_ttl_s: float = RULE_ONLY_TTL_S,
    clock: Callable[[], float] = time.monotonic,
) -> DiagnosisEnvelope:
    """Diagnose once per input hash.

    model and rejected_input envelopes are cached indefinitely. rule_only
    envelopes (model failure or invalid output) are cached only when a
    ``failure_expiry`` map is supplied, and only until ``failure_ttl_s``
    elapses, so a transient model failure is retried later.
    """
    key = cache_key(diagnosis_input, model_id, prompt_version)

    def fresh() -> DiagnosisEnvelope | None:
        cached = cache.get(key)
        if cached is None:
            return None
        if failure_expiry is not None and key in failure_expiry and clock() >= failure_expiry[key]:
            cache.pop(key, None)
            failure_expiry.pop(key, None)
            return None
        return cached.model_copy(update={"cached": True})

    cached = fresh()
    if cached is not None:
        return cached
    lock = locks.setdefault(key, asyncio.Lock())
    async with lock:
        cached = fresh()
        if cached is not None:
            return cached
        result = await client.diagnose(diagnosis_input)
        if result.status == "rejected_input":
            decision = DiagnosisDecision(
                verdict=diagnosis_input.allowed_verdicts[-1], rationale="Diagnosis input was rejected."
            )
            envelope = DiagnosisEnvelope(
                overlap_id=overlap_id, verdict=decision.verdict, rationale=decision.rationale,
                suggested_actions=[], allowed_verdicts=diagnosis_input.allowed_verdicts,
                rule_reason="rejected_input", overridden=True, status="rejected_input",
                context_used=bool(diagnosis_input.project_a or diagnosis_input.project_b),
                snowflake_eligible=eligible, model=model_id, prompt_version=prompt_version,
                input_hash=key, cached=False,
            )
        else:
            guarded = guard(result.decision, diagnosis_input.overlap, thresholds)
            envelope = DiagnosisEnvelope(
                overlap_id=overlap_id, verdict=guarded.decision.verdict, rationale=guarded.decision.rationale,
                suggested_actions=guarded.decision.suggested_actions,
                allowed_verdicts=diagnosis_input.allowed_verdicts, rule_reason=guarded.rule_reason,
                overridden=guarded.overridden, status=guarded.status,
                context_used=bool(diagnosis_input.project_a or diagnosis_input.project_b),
                snowflake_eligible=eligible, model=model_id, prompt_version=prompt_version,
                input_hash=key, cached=False,
            )
        if envelope.status == "rule_only":
            logger.warning("diagnosis fell back to rule_only (overlap_id=%s input_hash=%s)", overlap_id, key)
            if failure_expiry is None:
                return envelope
            failure_expiry[key] = clock() + failure_ttl_s
        cache[key] = envelope
        return envelope
