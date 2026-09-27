"""Read-only overlap sources for collision diagnosis."""

from __future__ import annotations

from dataclasses import dataclass
import json
from math import isfinite
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from pydantic import ValidationError

from backend.app.schemas.diagnosis import ProjectContext
from backend.app.schemas.overlaps import OverlapRow
from backend.app.services.overlaps import load_overlaps

if TYPE_CHECKING:
    from backend.app.core.config import Settings


@dataclass(frozen=True)
class CollisionBundle:
    overlaps: list[OverlapRow]
    projects: dict[str, ProjectContext]
    eligible_ids: frozenset[str] | None
    warnings: tuple[str, ...] = ()


class OverlapSource(Protocol):
    def load(self) -> CollisionBundle: ...


@dataclass(frozen=True)
class InvalidOverlapSource:
    message: str

    def load(self) -> CollisionBundle:
        raise ValueError(self.message)


@dataclass(frozen=True)
class CsvOverlapSource:
    path: Path

    def load(self) -> CollisionBundle:
        return CollisionBundle(overlaps=load_overlaps(self.path), projects={}, eligible_ids=None)


@dataclass(frozen=True)
class SnowflakeExportSource:
    directory: Path

    def _read_json(self, path: Path) -> object:
        try:
            with path.open(encoding="utf-8") as stream:
                return json.load(stream)
        except FileNotFoundError:
            raise
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"Invalid JSON in {path}: {exc}") from exc

    def _overlap_payload(self) -> tuple[Path, object]:
        path = self.directory / "overlaps.json"
        if path.is_file():
            return path, self._read_json(path)
        workbook = self.directory / "workbook.json"
        if not workbook.is_file():
            raise FileNotFoundError(f"Missing required export file: {path} (or {workbook} fallback)")
        value = self._read_json(workbook)
        if not isinstance(value, dict) or "overlaps" not in value:
            raise ValueError(f"{workbook} must contain an overlaps list")
        return workbook, value["overlaps"]

    @staticmethod
    def _list(value: object, path: Path) -> list[object]:
        if not isinstance(value, list):
            raise ValueError(f"{path} must contain a JSON list")
        return value

    @staticmethod
    def _validate_overlap(raw: object, path: Path, index: int) -> OverlapRow:
        label = raw.get("overlap_id", "<unknown>") if isinstance(raw, dict) else "<unknown>"
        try:
            if not isinstance(raw, dict):
                raise ValueError("row is not an object")
            if not (raw.get("project_name_a") or "").strip() or not (raw.get("project_name_b") or "").strip():
                raise ValueError("blank project name")
            row = OverlapRow.model_validate(raw)
            if not isfinite(row.distance_mi) or row.distance_mi < 0:
                raise ValueError("distance_mi must be a finite non-negative number")
            if row.time_gap_days < 0:
                raise ValueError("time_gap_days must be non-negative")
            return row
        except (ValidationError, ValueError) as exc:
            raise ValueError(f"Invalid overlap in {path} at row {index} ({label}): {exc}") from exc

    @staticmethod
    def _validate_project(raw: object, path: Path, index: int) -> ProjectContext:
        label = raw.get("project_id", "<unknown>") if isinstance(raw, dict) else "<unknown>"
        try:
            if not isinstance(raw, dict):
                raise ValueError("row is not an object")
            return ProjectContext.model_validate(raw)
        except (ValidationError, ValueError) as exc:
            raise ValueError(f"Invalid project in {path} at row {index} ({label}): {exc}") from exc

    def load(self) -> CollisionBundle:
        overlaps_path, overlap_payload = self._overlap_payload()
        projects_path = self.directory / "projects.json"
        if not projects_path.is_file():
            raise FileNotFoundError(f"Missing required export file: {projects_path}")

        overlaps: list[OverlapRow] = []
        overlap_ids: set[str] = set()
        for index, raw in enumerate(self._list(overlap_payload, overlaps_path)):
            row = self._validate_overlap(raw, overlaps_path, index)
            if row.overlap_id in overlap_ids:
                raise ValueError(f"Duplicate overlap_id {row.overlap_id!r} in {overlaps_path} at row {index}")
            overlap_ids.add(row.overlap_id)
            overlaps.append(row)

        projects: dict[str, ProjectContext] = {}
        for index, raw in enumerate(self._list(self._read_json(projects_path), projects_path)):
            project = self._validate_project(raw, projects_path, index)
            if project.project_id in projects:
                raise ValueError(f"Duplicate project_id {project.project_id!r} in {projects_path} at row {index}")
            projects[project.project_id] = project

        audit_path = self.directory / "pipeline_audit.json"
        eligible_ids: frozenset[str] | None = None
        if audit_path.is_file():
            audit = self._read_json(audit_path)
            if not isinstance(audit, dict):
                raise ValueError(f"{audit_path} must contain a JSON object")
            if "eligible_overlap_ids" in audit:
                values = audit["eligible_overlap_ids"]
                if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
                    raise ValueError(f"{audit_path} eligible_overlap_ids must be a list of strings")
                eligible_ids = frozenset(values)

        warnings = []
        for row in overlaps:
            missing = [project_id for project_id in (row.project_id_a, row.project_id_b) if project_id not in projects]
            if missing:
                warnings.append(f"Overlap {row.overlap_id} references missing project_id(s): {', '.join(missing)}")
        return CollisionBundle(overlaps=overlaps, projects=projects, eligible_ids=eligible_ids, warnings=tuple(warnings))


def get_overlap_source(settings: Settings) -> OverlapSource:
    if settings.collision_source == "csv":
        return CsvOverlapSource(settings.data_path)
    if settings.collision_source == "snowflake_export":
        return SnowflakeExportSource(settings.collision_export_dir)
    return InvalidOverlapSource(f"Unsupported COLLISION_SOURCE: {settings.collision_source!r}")
