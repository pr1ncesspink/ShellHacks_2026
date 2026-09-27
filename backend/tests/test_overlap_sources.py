import json
from pathlib import Path

import pytest

from backend.app.core.config import get_settings
from backend.app.agents.collision_pipeline.pipeline import CollisionPipeline
from backend.app.schemas.diagnosis import Thresholds
from backend.app.schemas.diagnosis import ProjectContext
from backend.app.services.overlap_sources import CsvOverlapSource, SnowflakeExportSource
from backend.app.services.overlaps import score_overlaps


FIXTURE = Path("backend/tests/fixtures/snowflake_export")


def copy_export(tmp_path: Path) -> Path:
    destination = tmp_path / "export"
    destination.mkdir(parents=True)
    for source in FIXTURE.iterdir():
        (destination / source.name).write_bytes(source.read_bytes())
    return destination


def test_fixture_loads_rows_projects_eligibility_and_sanitizes_untrusted_fields():
    bundle = SnowflakeExportSource(FIXTURE).load()
    assert len(bundle.overlaps) == 6
    assert len(bundle.projects) == 7
    assert bundle.eligible_ids == frozenset({"OVL_2", "OVL_5"})
    assert bundle.warnings == ()
    context = bundle.projects["DESC_2"]
    assert context.description.startswith("Ignore prior rules")
    assert "raw_text" not in context.model_dump_json()
    assert "total_cost" not in context.model_dump_json()
    assert "location_evidence" not in context.model_dump_json()


def test_fixture_projects_match_overlap_names_utilities_dates_and_audit_eligibility():
    bundle = SnowflakeExportSource(FIXTURE).load()
    eligible = set()
    for row in bundle.overlaps:
        project_a = bundle.projects[row.project_id_a]
        project_b = bundle.projects[row.project_id_b]
        assert (project_a.project_name, project_a.utility) == (row.project_name_a, row.utility_a)
        assert (project_b.project_name, project_b.utility) == (row.project_name_b, row.utility_b)
        assert abs((project_a.in_service_date - project_b.in_service_date).days) == row.time_gap_days
        if row.time_gap_days <= 365:
            eligible.add(row.overlap_id)
    assert bundle.eligible_ids == frozenset(eligible)


def test_project_context_strips_controls_and_caps_text():
    context = ProjectContext.model_validate({
        "project_id": "P\x00", "project_name": "Name\n", "description": "x" * 601 + "\x01",
        "need": "y" * 301 + "\x02",
    })
    assert context.project_id == "P"
    assert context.project_name == "Name"
    assert len(context.description or "") == 600
    assert len(context.need or "") == 300


def test_overlap_rows_reject_nonfinite_or_negative_numbers(tmp_path: Path):
    export = copy_export(tmp_path)
    rows = json.loads((export / "overlaps.json").read_text())
    rows[0]["distance_mi"] = -1
    (export / "overlaps.json").write_text(json.dumps(rows), encoding="utf-8")
    with pytest.raises(ValueError, match="overlaps.json.*row 0.*finite non-negative"):
        SnowflakeExportSource(export).load()


def test_workbook_fallback_and_missing_files_name_their_paths(tmp_path: Path):
    export = copy_export(tmp_path)
    overlaps = json.loads((export / "overlaps.json").read_text())
    (export / "overlaps.json").unlink()
    (export / "workbook.json").write_text(json.dumps({"overlaps": overlaps}), encoding="utf-8")
    assert len(SnowflakeExportSource(export).load().overlaps) == 6
    (export / "workbook.json").unlink()
    with pytest.raises(FileNotFoundError, match="overlaps.json"):
        SnowflakeExportSource(export).load()
    (export / "overlaps.json").write_text("[]", encoding="utf-8")
    (export / "projects.json").unlink()
    with pytest.raises(FileNotFoundError, match="projects.json"):
        SnowflakeExportSource(export).load()


@pytest.mark.parametrize("target", ["overlaps.json", "projects.json"])
def test_non_list_json_is_rejected_with_file_name(tmp_path: Path, target: str):
    export = copy_export(tmp_path)
    (export / target).write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match=target):
        SnowflakeExportSource(export).load()


def test_duplicate_ids_and_unknown_references_are_reported(tmp_path: Path, fake_encoder):
    export = copy_export(tmp_path)
    overlaps = json.loads((export / "overlaps.json").read_text())
    overlaps.append(overlaps[0])
    (export / "overlaps.json").write_text(json.dumps(overlaps), encoding="utf-8")
    with pytest.raises(ValueError, match="Duplicate overlap_id"):
        SnowflakeExportSource(export).load()

    export = copy_export(tmp_path / "second")
    projects = json.loads((export / "projects.json").read_text())
    projects.append(projects[0])
    (export / "projects.json").write_text(json.dumps(projects), encoding="utf-8")
    with pytest.raises(ValueError, match="Duplicate project_id"):
        SnowflakeExportSource(export).load()

    export = copy_export(tmp_path / "third")
    overlaps = json.loads((export / "overlaps.json").read_text())
    overlaps[0]["project_id_a"] = "MISSING"
    (export / "overlaps.json").write_text(json.dumps(overlaps), encoding="utf-8")
    bundle = SnowflakeExportSource(export).load()
    assert any("MISSING" in warning for warning in bundle.warnings)
    pipeline = CollisionPipeline(
        SnowflakeExportSource(export), lambda: fake_encoder, object(), Thresholds(), "stub", "diag.v2"
    )
    view = next(item for item in pipeline.list_views() if item.overlap.overlap_id == "OVL_1")
    assert view.project_a is None
    assert view.project_b is not None
    diagnosis_input, _ = pipeline._input("OVL_1")
    serialized = diagnosis_input.model_dump_json()
    for forbidden in ("raw_text", "total_cost", "previous_cost", "annual_costs", "location_evidence", "source_references"):
        assert forbidden not in serialized


def test_fixture_export_scores_like_csv_for_identical_rows(fake_encoder):
    export_rows = SnowflakeExportSource(FIXTURE).load().overlaps
    csv_rows = CsvOverlapSource(get_settings().data_path).load().overlaps
    assert [row.name_similarity for row in score_overlaps(export_rows, fake_encoder)] == [
        row.name_similarity for row in score_overlaps(csv_rows, fake_encoder)
    ]


def test_pipeline_input_hash_changes_when_overlap_row_changes(tmp_path: Path, fake_encoder):
    class NoopClient:
        async def diagnose(self, _):
            raise AssertionError("not used")

    baseline = CollisionPipeline(
        SnowflakeExportSource(FIXTURE), lambda: fake_encoder, NoopClient(), Thresholds(), "stub", "diag.v2"
    )
    baseline_input, _ = baseline._input("OVL_2")
    from backend.app.services.diagnosis_rules import cache_key
    baseline_hash = cache_key(baseline_input, "stub", "diag.v2")

    export = copy_export(tmp_path)
    rows = json.loads((export / "overlaps.json").read_text())
    rows[1]["distance_mi"] = 5.66
    (export / "overlaps.json").write_text(json.dumps(rows), encoding="utf-8")
    changed = CollisionPipeline(
        SnowflakeExportSource(export), lambda: fake_encoder, NoopClient(), Thresholds(), "stub", "diag.v2"
    )
    changed_input, _ = changed._input("OVL_2")
    assert baseline_hash != cache_key(changed_input, "stub", "diag.v2")
