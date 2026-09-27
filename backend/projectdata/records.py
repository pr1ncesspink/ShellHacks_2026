"""Normalize source records without inventing locations or exact schedule dates."""

from __future__ import annotations

import csv
from datetime import date
import hashlib
import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend.documentparsing.locations import THRESHOLD, valid_point


class ProjectPoint(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    record_id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    project_name: str = Field(min_length=1)
    owner: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    coordinate_method: str = "unresolved"
    description: str = ""
    semantic_text: str
    status: str | None = None
    in_service_date: date | None = None
    estimated_in_service_year: int | None = Field(default=None, ge=1900, le=2200)
    date_precision: str = "unknown"
    source: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def paired_coordinates(self):
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("Latitude and longitude must both be present or both be unknown")
        return self


def semantic_text(row):
    fields = ("project_name", "segment", "description", "need", "asset_type",
              "origin_substation", "destination_substation")
    return " | ".join(str(row[key]).strip() for key in fields if row.get(key))


def reference_csv(path: Path) -> tuple[str, list[ProjectPoint]]:
    data = path.read_bytes()
    dataset_id = "REF_" + hashlib.sha256(data).hexdigest()
    # Read the same bytes used for the version identifier.
    import io
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
    required = {"record_id", "project_id", "project_name", "latitude", "longitude"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Reference CSV missing columns: " + ", ".join(sorted(required - set(reader.fieldnames or []))))
    points = []
    for line, row in enumerate(reader, 2):
        year = row.get("estimated_in_service_year") or None
        try:
            points.append(ProjectPoint(
                record_id=row["record_id"].strip(), project_id=row["project_id"].strip(),
                project_name=row["project_name"].strip(), owner=row.get("owner") or None,
                latitude=row["latitude"] or None, longitude=row["longitude"] or None,
                coordinate_method=row.get("coordinate_method") or "source_point",
                description=row.get("description") or row.get("segment") or "",
                semantic_text=semantic_text(row), status=row.get("status") or None,
                estimated_in_service_year=year, date_precision="year" if year else "unknown",
                source={"document": path.name, "row": line, "raw": row},
            ))
        except ValueError as exc:
            raise ValueError(f"Invalid reference CSV row {line}: {exc}") from exc
    validate_points(points)
    return dataset_id, points


def validate_points(points):
    if not points:
        raise ValueError("Dataset contains no project records")
    if len({p.record_id for p in points}) != len(points):
        raise ValueError("Duplicate record_id values; project_id may repeat for separate points")


def parsed_points(projects: list[dict]) -> list[ProjectPoint]:
    points = []
    for row in projects:
        locations = []
        # Keep each explicitly parsed point and each verified endpoint; do not fabricate endpoints.
        if valid_point(row.get("latitude"), row.get("longitude")):
            locations.append(("point", row["latitude"], row["longitude"], "document_coordinates"))
        for side in ("a", "b"):
            lat, lon = row.get(f"lat_{side}"), row.get(f"lon_{side}")
            if row.get(f"confidence_{side}", 0) >= THRESHOLD and valid_point(lat, lon):
                locations.append((side, lat, lon, "verified_endpoint"))
        if not locations and valid_point(row.get("lat_center"), row.get("lon_center")):
            locations.append(("center", row["lat_center"], row["lon_center"], "project_center"))
        if not locations:
            locations.append(("unresolved", None, None, "unresolved"))
        for side, lat, lon, method in locations:
            points.append(ProjectPoint(
                record_id=f"{row['project_id']}:{side}", project_id=row["project_id"],
                project_name=row["project_name"], owner=row.get("utility"),
                latitude=lat, longitude=lon, coordinate_method=method,
                description=row.get("description") or "", semantic_text=semantic_text(row),
                status=row.get("status"), in_service_date=row.get("in_service_date"),
                date_precision="day" if row.get("in_service_date") else "unknown",
                source=row,
            ))
    validate_points(points)
    return points


def json_text(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
