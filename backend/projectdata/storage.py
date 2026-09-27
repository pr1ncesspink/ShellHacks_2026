"""Versioned reference snapshots and isolated upload datasets over the SQL REST API."""

from __future__ import annotations

from dataclasses import dataclass
import os
import re

from backend.documentparsing.snowflake import json_object
from .records import ProjectPoint, json_text, validate_points


@dataclass(frozen=True)
class DatabaseNames:
    reference: str = "GRIDLOCK_REFERENCE"
    uploads: str = "GRIDLOCK_UPLOADS"
    schema: str = "APP"

    def __post_init__(self):
        for value in (self.reference, self.uploads, self.schema):
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", value):
                raise ValueError("Project database/schema names must be unquoted SQL identifiers")
        if self.reference.upper() == self.uploads.upper():
            raise ValueError("Reference and upload databases must be different")

    @classmethod
    def from_env(cls):
        return cls(os.getenv("GRIDLOCK_REFERENCE_DATABASE", "GRIDLOCK_REFERENCE"),
                   os.getenv("GRIDLOCK_UPLOAD_DATABASE", "GRIDLOCK_UPLOADS"),
                   os.getenv("GRIDLOCK_DATA_SCHEMA", "APP"))


def validate_upload_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"UPL_[a-f0-9]{32}", value):
        raise ValueError("Invalid upload_id")
    return value


class ProjectStore:
    def __init__(self, client, names=None):
        self.client = client
        self.names = names or DatabaseNames.from_env()

    def table(self, kind, table):
        database = self.names.reference if kind == "reference" else self.names.uploads
        return f"{database.upper()}.{self.names.schema.upper()}.{table}"

    def setup(self):
        for database in (self.names.reference, self.names.uploads):
            schema = f"{database.upper()}.{self.names.schema.upper()}"
            for sql in (
                f"CREATE DATABASE IF NOT EXISTS {database.upper()}",
                f"CREATE SCHEMA IF NOT EXISTS {schema}",
                f"CREATE TABLE IF NOT EXISTS {schema}.DATASETS ("
                "DATASET_ID VARCHAR NOT NULL, CREATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(), PAYLOAD VARIANT)",
                f"CREATE TABLE IF NOT EXISTS {schema}.PROJECTS ("
                "DATASET_ID VARCHAR NOT NULL, RECORD_ID VARCHAR NOT NULL, PROJECT_ID VARCHAR NOT NULL, "
                "LATITUDE DOUBLE, LONGITUDE DOUBLE, LOCATION GEOGRAPHY, PAYLOAD VARIANT)",
            ):
                self.client.execute(sql, context=False)
        self.client.execute(
            f"CREATE TABLE IF NOT EXISTS {self.table('uploads', 'COLLISIONS')} ("
            "UPLOAD_ID VARCHAR NOT NULL, COLLISION_ID VARCHAR NOT NULL, PAYLOAD VARIANT)", context=False)

    def _manifest(self, kind, dataset_id, payload):
        # This is the publication marker: readers never see an incomplete load/run.
        self.client.execute(
            f"MERGE INTO {self.table(kind, 'DATASETS')} t USING "
            "(SELECT ? AS ID, PARSE_JSON(?) AS PAYLOAD) s ON t.DATASET_ID=s.ID "
            "WHEN NOT MATCHED THEN INSERT (DATASET_ID, PAYLOAD) VALUES (s.ID, s.PAYLOAD)",
            (dataset_id, json_text(payload)), context=False)

    def _write_points(self, kind, dataset_id, points):
        validate_points(points)
        for start in range(0, len(points), 100):
            payload = [p.model_dump(mode="json") for p in points[start:start + 100]]
            self.client.execute(
                f"MERGE INTO {self.table(kind, 'PROJECTS')} t USING "
                "(SELECT ? AS DATASET_ID, value AS P FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?)))) s "
                "ON t.DATASET_ID=s.DATASET_ID AND t.RECORD_ID=s.P:record_id::VARCHAR "
                "WHEN NOT MATCHED THEN INSERT "
                "(DATASET_ID, RECORD_ID, PROJECT_ID, LATITUDE, LONGITUDE, LOCATION, PAYLOAD) VALUES "
                "(s.DATASET_ID, s.P:record_id::VARCHAR, s.P:project_id::VARCHAR, "
                "s.P:latitude::DOUBLE, s.P:longitude::DOUBLE, "
                "ST_MAKEPOINT(s.P:longitude::DOUBLE, s.P:latitude::DOUBLE), s.P)",
                (dataset_id, json_text(payload)), context=False)

    def load_reference(self, dataset_id, points):
        self._write_points("reference", dataset_id, points)
        manifest = {"dataset_id": dataset_id, "point_count": len(points),
                    "project_count": len({p.project_id for p in points})}
        self._manifest("reference", dataset_id, manifest)
        return manifest

    def reference(self):
        rows = self.client.query_rows(
            f"SELECT DATASET_ID FROM {self.table('reference', 'DATASETS')} "
            "ORDER BY CREATED_AT DESC, DATASET_ID DESC LIMIT 1", context=False)
        if not rows:
            raise ValueError("No reference dataset loaded; run python -m backend.projectdata seed first")
        dataset_id = rows[0][0]
        points = self.client.query_rows(
            f"SELECT TO_JSON(PAYLOAD) FROM {self.table('reference', 'PROJECTS')} "
            "WHERE DATASET_ID=? ORDER BY RECORD_ID", (dataset_id,), context=False)
        records = [ProjectPoint.model_validate(json_object(row[0], "project record")) for row in points]
        validate_points(records)
        return dataset_id, records

    def save_upload(self, upload_id, points, result, audit):
        validate_upload_id(upload_id)
        self._write_points("uploads", upload_id, points)
        matches = result["collisions"]
        for start in range(0, len(matches), 100):
            self.client.execute(
                f"MERGE INTO {self.table('uploads', 'COLLISIONS')} t USING "
                "(SELECT ? AS UPLOAD_ID, value AS P FROM TABLE(FLATTEN(INPUT => PARSE_JSON(?)))) s "
                "ON t.UPLOAD_ID=s.UPLOAD_ID AND t.COLLISION_ID=s.P:overlap_id::VARCHAR "
                "WHEN NOT MATCHED THEN INSERT (UPLOAD_ID, COLLISION_ID, PAYLOAD) "
                "VALUES (s.UPLOAD_ID, s.P:overlap_id::VARCHAR, s.P)",
                (upload_id, json_text(matches[start:start + 100])), context=False)
        manifest = {key: value for key, value in result.items() if key != "collisions"}
        manifest.update(point_count=len(points), project_count=len({p.project_id for p in points}),
                        collision_count=len(matches), extraction_audit=audit)
        self._manifest("uploads", upload_id, manifest)
        return manifest

    def collisions(self, upload_id, *, offset=0, limit=100):
        validate_upload_id(upload_id)
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 500:
            raise ValueError("offset must be nonnegative and limit must be between 1 and 500")
        rows = self.client.query_rows(
            f"SELECT TO_JSON(PAYLOAD) FROM {self.table('uploads', 'DATASETS')} WHERE DATASET_ID=?",
            (upload_id,), context=False)
        if not rows:
            raise LookupError("Upload not found or processing did not complete")
        manifest = json_object(rows[0][0], "upload manifest")
        collisions = self.client.query_rows(
            f"SELECT TO_JSON(PAYLOAD) FROM {self.table('uploads', 'COLLISIONS')} "
            f"WHERE UPLOAD_ID=? ORDER BY COLLISION_ID LIMIT {limit} OFFSET {offset}",
            (upload_id,), context=False)
        return {**manifest, "collisions": [json_object(row[0], "collision") for row in collisions],
                "offset": offset, "limit": limit,
                "next_offset": offset + limit if offset + limit < manifest["collision_count"] else None}

    def collision(self, upload_id, overlap_id):
        validate_upload_id(upload_id)
        if not isinstance(overlap_id, str) or not re.fullmatch(r"COL_[a-f0-9]{24}", overlap_id):
            raise ValueError("Invalid overlap_id")
        manifest = self.client.query_rows(
            f"SELECT TO_JSON(PAYLOAD) FROM {self.table('uploads', 'DATASETS')} WHERE DATASET_ID=?",
            (upload_id,), context=False)
        if not manifest:
            raise LookupError("Upload not found or processing did not complete")
        rows = self.client.query_rows(
            f"SELECT TO_JSON(PAYLOAD) FROM {self.table('uploads', 'COLLISIONS')} "
            "WHERE UPLOAD_ID=? AND COLLISION_ID=?",
            (upload_id, overlap_id), context=False)
        if not rows:
            raise LookupError("Collision not found")
        return json_object(rows[0][0], "collision")
