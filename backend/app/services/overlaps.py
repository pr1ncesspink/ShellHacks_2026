"""CSV loading, scoring, and writing."""

from __future__ import annotations

import csv
from pathlib import Path

from backend.app.schemas.overlaps import OverlapRow, ScoredOverlap
from backend.app.services.similarity import Encoder, score_pairs


CSV_FIELDS = [
    "overlap_id", "distance_mi", "time_gap (day)", "utility_a", "project_id_a",
    "project_name_a", "utility_b", "project_id_b", "project_name_b",
]


def load_overlaps(path: Path) -> list[OverlapRow]:
    with path.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        actual = reader.fieldnames or []
        missing = [field for field in CSV_FIELDS if field not in actual]
        if missing:
            raise ValueError(f"CSV is missing required column(s): {', '.join(missing)}")
        rows = []
        for raw in reader:
            overlap_id = raw.get("overlap_id", "<unknown>")
            if not (raw.get("project_name_a") or "").strip() or not (raw.get("project_name_b") or "").strip():
                raise ValueError(f"Blank project name in overlap {overlap_id}")
            row = OverlapRow.model_validate(raw)
            row._source_columns = tuple(actual)
            rows.append(row)
    return rows


def score_overlaps(rows: list[OverlapRow], encoder: Encoder) -> list[ScoredOverlap]:
    scores = score_pairs([(row.project_name_a, row.project_name_b) for row in rows], encoder)
    scored_rows = []
    for row, score in zip(rows, scores, strict=True):
        scored = ScoredOverlap(**row.model_dump(), name_similarity=score)
        scored._source_columns = row._source_columns
        scored_rows.append(scored)
    return scored_rows


def write_scored_csv(rows: list[ScoredOverlap], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as stream:
        original_columns = list(rows[0]._source_columns) if rows and rows[0]._source_columns else CSV_FIELDS
        writer = csv.DictWriter(stream, fieldnames=[*original_columns, "name_similarity"])
        writer.writeheader()
        for row in rows:
            raw = row.model_dump(by_alias=True)
            raw["name_similarity"] = f"{row.name_similarity:.4f}"
            writer.writerow(raw)
