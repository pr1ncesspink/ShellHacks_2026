"""Shared orchestration for CLI, upload API, and A2A tools."""

from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from .matching import find_collisions
from .records import parsed_points, reference_csv


def seed_reference(path, store):
    dataset_id, points = reference_csv(Path(path))
    return store.load_reference(dataset_id, points)


def process_plan(path, store, client, *, utility="", state="", osm_snapshot=None):
    """Parse, persist uploaded points, match reference points, and publish collisions."""
    from backend.documentparsing.extraction import Project
    from backend.documentparsing.pipeline import run_pipeline

    # Fail before spending parsing credits if the reference data is not ready.
    reference_id, reference = store.reference()
    path = Path(path)
    with TemporaryDirectory(prefix="gridlock-upload-") as temporary:
        if path.suffix.lower() == ".json":
            projects = json.loads(path.read_text(encoding="utf-8-sig"))
            if not isinstance(projects, list):
                raise ValueError("Parsed JSON must contain a list of project records")
            projects = [Project.model_validate(p).model_dump(mode="json") for p in projects]
            audit = {"parser": "validated_projects_json", "project_count": len(projects)}
        else:
            audit = run_pipeline([path], temporary, client=client, utility=utility, state=state,
                                 osm_snapshot=osm_snapshot, cache_dir=Path(temporary) / "geocoding",
                                 compute_overlaps=False)
            projects = json.loads((Path(temporary) / "projects.json").read_text(encoding="utf-8"))
    points = parsed_points(projects)
    upload_id = "UPL_" + uuid4().hex
    result = find_collisions(upload_id, reference_id, points, reference)
    manifest = store.save_upload(upload_id, points, result, audit)
    return {**manifest, "collisions": result["collisions"]}


def score_collision_page(page, encoder):
    """Use the existing semantic encoder; keep geography and similarity separate."""
    from backend.app.services.similarity import score_pairs

    pairs = [(r["uploaded_project"]["semantic_text"], r["reference_project"]["semantic_text"])
             for r in page["collisions"]]
    scores = score_pairs(pairs, encoder)
    return {**page, "collisions": [{**row, "semantic_similarity": float(score)}
                                 for row, score in zip(page["collisions"], scores, strict=True)]}
