"""Build a haversine BallTree from validated coordinates, never serialized models."""

from __future__ import annotations

import hashlib
import math

import numpy as np
from sklearn.neighbors import BallTree

from .records import ProjectPoint, json_text


EARTH_RADIUS_MILES = 3958.7613
RADIUS_MILES = 25.0


def find_collisions(upload_id: str, reference_id: str, uploaded: list[ProjectPoint],
                    reference: list[ProjectPoint]) -> dict:
    """All uploaded/reference point pairs at <=25 miles, including unknown schedules."""
    located = lambda p: p.latitude is not None and p.longitude is not None
    refs = sorted((p for p in reference if located(p)), key=lambda p: p.record_id)
    queries = sorted((p for p in uploaded if located(p)), key=lambda p: p.record_id)
    result = {
        "schema_version": "collisions-v1", "upload_id": upload_id,
        "reference_dataset_id": reference_id, "radius_miles": RADIUS_MILES,
        "distance_metric": "haversine", "boundary": "inclusive",
        "schedule_filter_applied": False, "owner_filter_applied": False,
        "excluded_upload_records": [p.record_id for p in uploaded if not located(p)],
        "excluded_reference_records": [p.record_id for p in reference if not located(p)],
        "collisions": [],
    }
    if not queries or not refs:
        return result
    coordinates = np.radians([[p.latitude, p.longitude] for p in refs])
    tree = BallTree(coordinates, metric="haversine")
    # A tiny angular tolerance includes the mathematical boundary despite float roundoff.
    radius = RADIUS_MILES / EARTH_RADIUS_MILES
    tolerance = 1e-12
    for start in range(0, len(queries), 256):
        batch = queries[start:start + 256]
        indices, distances = tree.query_radius(
            np.radians([[p.latitude, p.longitude] for p in batch]),
            r=radius + tolerance, return_distance=True, sort_results=True,
        )
        for user_point, neighbors, angular_distances in zip(batch, indices, distances):
            for index, angular in zip(neighbors, angular_distances):
                distance = float(angular) * EARTH_RADIUS_MILES
                if distance > RADIUS_MILES and not math.isclose(distance, RADIUS_MILES, abs_tol=tolerance * EARTH_RADIUS_MILES, rel_tol=0):
                    continue
                ref = refs[int(index)]
                identity = [upload_id, user_point.record_id, reference_id, ref.record_id]
                gap = (abs((user_point.in_service_date - ref.in_service_date).days)
                       if user_point.in_service_date and ref.in_service_date else None)
                result["collisions"].append({
                    "overlap_id": "COL_" + hashlib.sha256(json_text(identity).encode()).hexdigest()[:24],
                    "distance_mi": distance, "time_gap_days": gap,
                    "timing_basis": "in_service_date_proxy" if gap is not None else "unknown_exact_dates",
                    "classification": "geographic_candidate",
                    "uploaded_project": user_point.model_dump(mode="json"),
                    "reference_project": ref.model_dump(mode="json"),
                })
    result["collisions"].sort(key=lambda row: (
        row["uploaded_project"]["record_id"], row["distance_mi"], row["reference_project"]["record_id"]))
    return result
