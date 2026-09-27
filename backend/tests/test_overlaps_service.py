from pathlib import Path

import pytest

from backend.app.core.config import get_settings
from backend.app.schemas.overlaps import ScoredOverlap
from backend.app.services.overlaps import load_overlaps, score_overlaps, write_scored_csv


def test_committed_csv_loads_expected_rows():
    rows = load_overlaps(get_settings().data_path)
    assert [row.overlap_id for row in rows] == [f"OVL_{i}" for i in range(1, 7)]
    assert rows[0].time_gap_days == 3074


def test_missing_column_names_it(tmp_path: Path):
    path = tmp_path / "bad.csv"
    path.write_text("overlap_id\nOVL_1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="project_name_a"):
        load_overlaps(path)


def test_blank_name_includes_overlap_id(tmp_path: Path):
    source = get_settings().data_path.read_text(encoding="utf-8")
    path = tmp_path / "blank.csv"
    path.write_text(source.replace("Hooks - Thurmond 115 kV Tie: Rebuild", "", 1), encoding="utf-8")
    with pytest.raises(ValueError, match="OVL_1"):
        load_overlaps(path)


def test_scored_csv_appends_score_and_keeps_order(tmp_path: Path, fake_encoder):
    rows = score_overlaps(load_overlaps(get_settings().data_path), fake_encoder)
    destination = tmp_path / "scored.csv"
    write_scored_csv(rows, destination)
    lines = destination.read_text(encoding="utf-8").splitlines()
    assert lines[0].endswith(",name_similarity")
    assert [line.split(",", 1)[0] for line in lines[1:]] == [f"OVL_{i}" for i in range(1, 7)]


def test_csv_writer_preserves_reordered_extra_columns(tmp_path: Path, fake_encoder):
    source = get_settings().data_path.read_text(encoding="utf-8")
    header, *data = source.splitlines()
    reordered = header.split(",")[::-1] + ["source_note"]
    rows = [dict(zip(header.split(","), line.split(","), strict=True)) for line in data]
    path = tmp_path / "reordered.csv"
    path.write_text(
        ",".join(reordered) + "\n" + "\n".join(
            ",".join([row.get(column, "test") if column != "source_note" else "test" for column in reordered])
            for row in rows
        ) + "\n",
        encoding="utf-8",
    )
    output = tmp_path / "output.csv"
    write_scored_csv(score_overlaps(load_overlaps(path), fake_encoder), output)
    assert output.read_text(encoding="utf-8").splitlines()[0] == ",".join([*reordered, "name_similarity"])


def test_csv_writer_uses_standard_columns_without_source_metadata(tmp_path: Path):
    row = ScoredOverlap(
        overlap_id="OVL_X", distance_mi=1, **{"time_gap (day)": 2}, utility_a="a",
        project_id_a="a1", project_name_a="name a", utility_b="b", project_id_b="b1",
        project_name_b="name b", name_similarity=0.123456,
    )
    output = tmp_path / "manual.csv"
    write_scored_csv([row], output)
    assert output.read_text(encoding="utf-8").splitlines()[0].endswith(",name_similarity")
