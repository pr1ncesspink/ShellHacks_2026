"""Deterministic limits and output guard for collision diagnosis."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
from math import isfinite
from typing import Any

from backend.app.schemas.diagnosis import DiagnosisDecision, DiagnosisInput, Thresholds, Verdict


def allowed_verdicts(overlap: Any, thresholds: Thresholds) -> tuple[Verdict, ...]:
    """Return the hard verdict set from overlap numbers alone."""
    if not isfinite(overlap.distance_mi) or overlap.distance_mi < 0:
        raise ValueError("distance_mi must be a finite non-negative number")
    if not isfinite(overlap.name_similarity):
        raise ValueError("name_similarity must be finite")
    if overlap.time_gap_days < 0:
        raise ValueError("time_gap_days must be non-negative")
    if overlap.distance_mi > thresholds.max_distance_mi or overlap.time_gap_days > thresholds.max_gap_days:
        return ("NO_ACTION",)
    if getattr(overlap, "timing_basis", "exact_dates") == "timing_unknown":
        return ("RESEQUENCE",)
    if overlap.name_similarity >= thresholds.co_schedule_min_similarity:
        return ("CO_SCHEDULE", "RESEQUENCE")
    return ("RESEQUENCE",)


def default_verdict(overlap: Any, thresholds: Thresholds) -> Verdict:
    return allowed_verdicts(overlap, thresholds)[-1]


@dataclass(frozen=True)
class GuardResult:
    decision: DiagnosisDecision
    overridden: bool
    rule_reason: str
    status: str


def guard(candidate: object, overlap: Any, thresholds: Thresholds) -> GuardResult:
    """Normalize arbitrary model output to a rule-compliant decision."""
    allowed = allowed_verdicts(overlap, thresholds)
    default = default_verdict(overlap, thresholds)
    try:
        decision = candidate if isinstance(candidate, DiagnosisDecision) else DiagnosisDecision.model_validate(candidate)
    except Exception:
        return GuardResult(
            decision=DiagnosisDecision(verdict=default, rationale="Rule-only diagnosis: model output was invalid."),
            overridden=True,
            rule_reason="malformed_model_output",
            status="rule_only",
        )
    if decision.verdict not in allowed:
        return GuardResult(
            decision=DiagnosisDecision(verdict=default, rationale="Rule guard selected the permitted default verdict."),
            overridden=True,
            rule_reason="model_verdict_not_allowed",
            status="model",
        )
    return GuardResult(decision=decision, overridden=False, rule_reason="model_verdict_allowed", status="model")


def cache_key(diagnosis_input: DiagnosisInput, model_id: str, prompt_version: str) -> str:
    """Hash canonical server-built input plus the model and prompt versions."""
    payload = {
        "input": diagnosis_input.model_dump(mode="json"),
        "model_id": model_id,
        "prompt_version": prompt_version,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256(canonical.encode("utf-8")).hexdigest()
