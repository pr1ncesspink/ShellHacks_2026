import pytest

from backend.app.core.config import get_settings
from backend.app.schemas.diagnosis import DiagnosisInput, DiagnosisOverlap, Thresholds
from backend.app.services.diagnosis_rules import allowed_verdicts, cache_key, guard


def overlap(identifier: str, distance: float, gap: int, similarity: float) -> DiagnosisOverlap:
    return DiagnosisOverlap(
        overlap_id=identifier, distance_mi=distance, time_gap_days=gap, utility_a="a",
        project_id_a="a", project_name_a="a", utility_b="b", project_id_b="b",
        project_name_b="b", name_similarity=similarity,
    )


def test_default_rule_table_matches_fixture_expectations():
    thresholds = Thresholds()
    cases = [
        ("OVL_1", 4.09, 3074, 0.5056, ("NO_ACTION",)),
        ("OVL_2", 5.65, 152, 0.3584, ("RESEQUENCE",)),
        ("OVL_3", 7.55, 517, 0.2280, ("RESEQUENCE",)),
        ("OVL_4", 8.01, 3074, 0.4394, ("NO_ACTION",)),
        ("OVL_5", 14.34, 365, 0.4270, ("RESEQUENCE",)),
        ("OVL_6", 14.81, 730, 0.4790, ("CO_SCHEDULE", "RESEQUENCE")),
    ]
    for identifier, distance, gap, similarity, expected in cases:
        assert allowed_verdicts(overlap(identifier, distance, gap, similarity), thresholds) == expected


def test_threshold_override_and_guard_never_widen_the_set():
    row = overlap("OVL_2", 5.65, 152, 0.3584)
    assert allowed_verdicts(row, Thresholds(max_gap_days=365)) == ("RESEQUENCE",)
    result = guard({"verdict": "CO_SCHEDULE", "rationale": "model chose a disallowed result"}, row, Thresholds())
    assert result.decision.verdict == "RESEQUENCE"
    assert result.overridden is True


def test_cache_key_includes_input_thresholds_model_and_prompt():
    row = overlap("OVL_6", 14.81, 730, 0.4790)
    diagnosis_input = DiagnosisInput(overlap=row, allowed_verdicts=["CO_SCHEDULE", "RESEQUENCE"], thresholds=Thresholds())
    baseline = cache_key(diagnosis_input, "model-a", "diag.v2")
    assert baseline != cache_key(diagnosis_input, "model-b", "diag.v2")
    assert baseline != cache_key(diagnosis_input, "model-a", "diag.v3")
    changed = diagnosis_input.model_copy(update={"thresholds": Thresholds(max_gap_days=365)})
    assert baseline != cache_key(changed, "model-a", "diag.v2")


def test_direct_input_rejects_invalid_overlap_numbers_and_unknown_thresholds():
    with pytest.raises(ValueError):
        overlap("bad", -1, 1, 0)
    with pytest.raises(ValueError):
        Thresholds.model_validate({"unknown": 1})


def test_diagnosis_threshold_environment_overrides(monkeypatch):
    monkeypatch.setenv("DIAG_MAX_DISTANCE_MI", "12.5")
    monkeypatch.setenv("DIAG_MAX_GAP_DAYS", "365")
    monkeypatch.setenv("DIAG_CO_SCHEDULE_MIN_SIM", "0.6")
    settings = get_settings()
    assert (settings.diag_max_distance_mi, settings.diag_max_gap_days, settings.diag_co_schedule_min_sim) == (12.5, 365, 0.6)


def test_similarity_rule_uses_unrounded_value_at_the_threshold_boundary():
    assert allowed_verdicts(overlap("near", 1, 1, 0.44996), Thresholds()) == ("RESEQUENCE",)
    assert allowed_verdicts(overlap("exact", 1, 1, 0.45), Thresholds()) == ("CO_SCHEDULE", "RESEQUENCE")


def test_unknown_timing_removes_co_schedule_and_preserves_no_action():
    high_similarity = overlap("unknown", 1, 0, 0.9).model_copy(update={"timing_basis": "timing_unknown"})
    assert allowed_verdicts(high_similarity, Thresholds()) == ("RESEQUENCE",)
    assert allowed_verdicts(high_similarity.model_copy(update={"distance_mi": 20}), Thresholds()) == ("NO_ACTION",)
    result = guard({"verdict": "CO_SCHEDULE", "rationale": "model choice"}, high_similarity, Thresholds())
    assert result.decision.verdict == "RESEQUENCE"
    assert result.overridden is True


@pytest.mark.parametrize("distance,gap,similarity", [
    (1, 0, 0.9), (1, 100, 0.1), (20, 0, 0.9), (1, 1460, 0.9),
])
def test_default_and_year_precision_keep_existing_rules(distance, gap, similarity):
    exact = overlap("default", distance, gap, similarity)
    year = exact.model_copy(update={"timing_basis": "year_precision"})
    assert exact.timing_basis == "exact_dates"
    assert allowed_verdicts(exact, Thresholds()) == allowed_verdicts(year, Thresholds())
