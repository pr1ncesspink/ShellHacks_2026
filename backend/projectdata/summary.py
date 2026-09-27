"""Automatic, owner-scoped summaries of one published upload.

``summarize_upload`` runs inside the upload Cloud Run Job after the upload is published.
It builds a bounded, allow-listed ``SummaryInput`` from stored data, asks the summary
agent (through an injectable client) for text, validates what comes back against the
input, falls back to a deterministic rule-only summary on any model problem, and stores
the result insert-only in SUMMARIES. When the stored data cannot even be turned into an
input (a read fails or rows are unusable) it still stores a minimal rule-only summary
built from the upload manifest, so a published upload never stays ``pending`` forever and
can later be regenerated. It never raises: it returns ``model``, ``rule_only`` or
``failed`` (invalid owner/upload id, unpublished upload, or a failed write only).
"""

from __future__ import annotations

import asyncio
from collections import Counter
import hashlib
import logging
import re

from backend.app.schemas.summary import (
    MAX_COLLISIONS, MAX_INPUT_BYTES, MAX_PROJECTS, PROMPT_VERSION, RULE_ONLY_MODEL,
    DataGaps, GeneratedBy, Hotspot, KeyProject, MapCollision, MapPoint, SummaryAggregates,
    SummaryCollision, SummaryCounts, SummaryDraft, SummaryInput, SummaryProject, UploadSummary, clean,
)

from .storage import validate_owner, validate_upload_id

log = logging.getLogger(__name__)

MODEL_TIMEOUT_S = 90.0
_CODE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_MAX_HISTOGRAM_KEYS = 20


class SummaryRejected(ValueError):
    """Model output that does not match the supplied input."""


# -- input ---------------------------------------------------------------------------------

def _histogram(values) -> dict[str, int]:
    counts = Counter(value if isinstance(value, str) and _CODE.fullmatch(value) else "other"
                     for value in values)
    top = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:_MAX_HISTOGRAM_KEYS]
    return dict(sorted(top))


def _warning_codes(manifest: dict) -> dict[str, int]:
    audit = manifest.get("extraction_audit")
    entries = audit.get("warnings") if isinstance(audit, dict) else None
    codes = []
    for entry in entries if isinstance(entries, list) else []:
        warnings = entry.get("warnings") if isinstance(entry, dict) else None
        codes.extend(warnings if isinstance(warnings, list) else [])
    return _histogram(codes)


def _point_row(row: object) -> dict | None:
    """Copy of a stored point with an empty/invalid name replaced by its project or record id."""
    if not isinstance(row, dict):
        return None
    row = dict(row)
    name = clean(row.get("name"), 300)
    if not (isinstance(name, str) and name):
        for key in ("project_id", "record_id"):
            fallback = clean(row.get(key), 256)
            if isinstance(fallback, str) and fallback:
                row["name"] = fallback
                break
    return row


def map_points(rows) -> list[MapPoint]:
    """Validated map points; unusable rows are skipped instead of failing the whole list."""
    points = []
    for row in rows or []:
        try:
            points.append(MapPoint.model_validate(_point_row(row)))
        except ValueError:
            continue
    if len(points) != len(rows or []):
        log.warning("skipped %d unusable stored point(s)", len(rows or []) - len(points))
    return points


def map_collisions(rows) -> list[MapCollision]:
    """Validated collisions (endpoint names sanitized like points); unusable rows are skipped."""
    collisions = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        try:
            collisions.append(MapCollision.model_validate(
                {**row, "uploaded": _point_row(row.get("uploaded")), "reference": _point_row(row.get("reference"))}))
        except ValueError:
            continue
    if len(collisions) != len(rows or []):
        log.warning("skipped %d unusable stored collision(s)", len(rows or []) - len(collisions))
    return collisions


def _located(point: MapPoint) -> bool:
    return point.lat is not None and point.lon is not None


def canonical_json(summary_input: SummaryInput) -> str:
    from backend.app.agents.summary_agent.guardrails import canonical_input

    return canonical_input(summary_input)


def build_summary_input(upload_id: str, manifest: dict, points: list[dict], collisions: list[dict],
                        gap_buckets: dict[str, int]) -> tuple[SummaryInput, list[MapCollision], dict]:
    """Return (bounded input, validated nearest collisions, project names by id)."""
    validated = map_points(points)
    descriptions = {row.get("record_id"): row.get("description") for row in points if isinstance(row, dict)}
    by_project: dict[str, list[MapPoint]] = {}
    for point in sorted(validated, key=lambda p: p.record_id):
        by_project.setdefault(point.project_id, []).append(point)

    def missing_date(group):
        return all(p.in_service_date is None and p.estimated_in_service_year is None for p in group)

    tiers = Counter(
        "exact_date" if any(p.in_service_date for p in group)
        else "year_only" if any(p.estimated_in_service_year for p in group) else "unknown"
        for group in by_project.values())
    nearest = sorted((c for c in map_collisions(collisions) if _located(c.uploaded)),
                     key=lambda c: (c.distance_mi, c.overlap_id))[:MAX_COLLISIONS]
    aggregates = SummaryAggregates(
        project_count=len(by_project), point_count=len(validated),
        located_point_count=sum(_located(p) for p in validated),
        collision_count=int(manifest.get("collision_count") or 0),
        unresolved_locations=sum(not any(_located(p) for p in group) for group in by_project.values()),
        missing_dates=sum(missing_date(group) for group in by_project.values()),
        coordinate_methods=_histogram(p.coordinate_method or "unknown" for p in validated),
        timing_tiers=dict(sorted(tiers.items())),
        gap_buckets={key: int(count) for key, count in sorted(gap_buckets.items())
                     if isinstance(key, str) and _CODE.fullmatch(key)},
        extraction_warnings=_warning_codes(manifest),
    )
    projects = []
    for project_id in sorted(by_project):
        first = by_project[project_id][0]
        projects.append(SummaryProject(
            project_id=project_id, name=first.name, owner=first.owner, status=first.status,
            in_service_date=next((p.in_service_date for p in by_project[project_id] if p.in_service_date), None),
            estimated_in_service_year=first.estimated_in_service_year,
            description=descriptions.get(first.record_id),
        ))
    truncated = len(projects) > MAX_PROJECTS
    projects = projects[:MAX_PROJECTS]
    summary_collisions = [SummaryCollision(
        overlap_id=c.overlap_id, distance_mi=round(c.distance_mi, 2), time_gap_days=c.time_gap_days,
        timing_basis=c.timing_basis, uploaded_project_id=c.uploaded.project_id, uploaded_name=c.uploaded.name,
        reference_project_id=c.reference.project_id, reference_name=c.reference.name,
        reference_owner=c.reference.owner,
    ) for c in nearest]
    summary_input = SummaryInput(upload_id=upload_id, aggregates=aggregates, projects=projects,
                                 nearest_collisions=summary_collisions, truncated=truncated)
    # Hard size cap: drop projects from the end, then collisions, until the canonical JSON fits.
    while len(canonical_json(summary_input).encode("utf-8")) > MAX_INPUT_BYTES:
        if summary_input.projects:
            summary_input = summary_input.model_copy(update={"projects": summary_input.projects[:-1],
                                                             "truncated": True})
        elif summary_input.nearest_collisions:
            summary_input = summary_input.model_copy(update={
                "nearest_collisions": summary_input.nearest_collisions[:-1], "truncated": True})
        else:
            raise ValueError("summary aggregates exceed the input cap")
    kept = {c.overlap_id for c in summary_input.nearest_collisions}
    names = {project_id: group[0].name for project_id, group in by_project.items()}
    return summary_input, [c for c in nearest if c.overlap_id in kept], names


# -- output --------------------------------------------------------------------------------

def _common(summary_input: SummaryInput, model: str) -> dict:
    a = summary_input.aggregates
    return {
        "data_gaps": DataGaps(unresolved_locations=a.unresolved_locations, missing_dates=a.missing_dates,
                              truncated=summary_input.truncated),
        "counts": SummaryCounts(projects=a.project_count, points=a.point_count,
                                located_points=a.located_point_count, collisions=a.collision_count),
        "generated_by": GeneratedBy(
            model=model, prompt_version=PROMPT_VERSION,
            input_hash="sha256:" + hashlib.sha256(canonical_json(summary_input).encode("utf-8")).hexdigest()),
    }


def _hotspot(label: str, overlap_ids: list[str], collisions: dict[str, MapCollision]) -> Hotspot:
    chosen = sorted((collisions[i] for i in dict.fromkeys(overlap_ids)), key=lambda c: (c.distance_mi, c.overlap_id))
    nearest = chosen[0]
    return Hotspot(overlap_ids=[c.overlap_id for c in chosen], label=label[:120],
                   nearest_mi=round(nearest.distance_mi, 2), lat=nearest.uploaded.lat, lon=nearest.uploaded.lon)


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def rule_only_summary(summary_input: SummaryInput, collisions: list[MapCollision], names: dict) -> UploadSummary:
    """Deterministic summary built only from server-side aggregates."""
    a = summary_input.aggregates
    by_id = {c.overlap_id: c for c in collisions}
    headline = (f"{_plural(a.project_count, 'project')} uploaded with "
                f"{_plural(a.collision_count, 'nearby reference collision')}")[:120]
    sentences = [f"This upload contains {_plural(a.project_count, 'project')} at "
                 f"{_plural(a.point_count, 'mapped point')}, {a.located_point_count} of them located."]
    if a.collision_count:
        nearest = collisions[0] if collisions else None
        sentences.append(f"There are {_plural(a.collision_count, 'reference collision')} within 25 miles"
                         + (f"; the nearest is {nearest.distance_mi:.1f} miles away." if nearest else "."))
    else:
        sentences.append("No reference projects were found within 25 miles.")
    if a.unresolved_locations:
        sentences.append(f"{_plural(a.unresolved_locations, 'project')} could not be located.")
    if a.missing_dates:
        sentences.append(f"{_plural(a.missing_dates, 'project')} lack an in-service date or year.")
    if summary_input.truncated:
        sentences.append("Only part of the upload was included in this summary.")
    groups: dict[str, list[MapCollision]] = {}
    for collision in collisions:
        groups.setdefault(collision.uploaded.project_id, []).append(collision)
    key_projects, hotspots = [], []
    for project_id, group in list(groups.items())[:5]:
        first = group[0]
        name = names.get(project_id, first.uploaded.name)
        key_projects.append(KeyProject(
            project_id=project_id, name=name,
            why=f"Nearest reference project is {first.distance_mi:.1f} miles away."))
        hotspots.append(_hotspot(f"Near {name}", [c.overlap_id for c in group], by_id))
    gaps = a.gap_buckets
    notes = []
    close = gaps.get("within_180_days", 0) + gaps.get("within_1_year", 0)
    if close:
        notes.append(f"{_plural(close, 'collision')} have in-service dates within a year of each other.")
    if gaps.get("within_3_years", 0):
        notes.append(f"{_plural(gaps['within_3_years'], 'collision')} are one to three years apart.")
    if gaps.get("unknown", 0):
        notes.append(f"{_plural(gaps['unknown'], 'collision')} lack exact dates on at least one side.")
    return UploadSummary(status="rule_only", headline=headline, overview=" ".join(sentences),
                         key_projects=key_projects, hotspots=hotspots, timing_notes=notes[:3],
                         **_common(summary_input, RULE_ONLY_MODEL))


def _count(manifest: dict, key: str) -> int:
    value = manifest.get(key)
    return value if type(value) is int and value >= 0 else 0


def minimal_summary(upload_id: str, manifest: dict) -> UploadSummary:
    """Deterministic rule-only summary from manifest counts alone, used when stored rows are unusable."""
    counts = {key: _count(manifest, key) for key in ("project_count", "point_count", "collision_count")}
    try:
        warnings = _warning_codes(manifest)
    except Exception:  # noqa: BLE001 - malformed audit; warnings are optional
        warnings = {}
    summary_input = SummaryInput(
        upload_id=upload_id, projects=[], nearest_collisions=[], truncated=True,
        aggregates=SummaryAggregates(
            project_count=counts["project_count"], point_count=counts["point_count"], located_point_count=0,
            collision_count=counts["collision_count"], unresolved_locations=0, missing_dates=0,
            extraction_warnings=warnings))
    a = summary_input.aggregates
    headline = (f"{_plural(a.project_count, 'project')} uploaded with "
                f"{_plural(a.collision_count, 'nearby reference collision')}")[:120]
    overview = (f"This upload contains {_plural(a.project_count, 'project')} at "
                f"{_plural(a.point_count, 'mapped point')} with "
                f"{_plural(a.collision_count, 'reference collision')} within 25 miles. "
                "A detailed summary could not be built from the stored data yet.")
    return UploadSummary(status="rule_only", headline=headline, overview=overview,
                         **_common(summary_input, RULE_ONLY_MODEL))


def model_summary(draft: SummaryDraft, summary_input: SummaryInput, collisions: list[MapCollision],
                  names: dict, model_id: str) -> UploadSummary:
    """Validate model text against the input; ids outside the input are rejected."""
    by_id = {c.overlap_id: c for c in collisions}
    allowed_projects = {p.project_id for p in summary_input.projects}
    key_projects = []
    for item in draft.key_projects:
        if item.project_id not in allowed_projects:
            raise SummaryRejected("key project outside the input")
        key_projects.append(KeyProject(project_id=item.project_id, name=names[item.project_id], why=item.why))
    hotspots = []
    for item in draft.hotspots:
        if any(overlap_id not in by_id for overlap_id in item.overlap_ids):
            raise SummaryRejected("hotspot overlap id outside the input")
        hotspots.append(_hotspot(item.label, item.overlap_ids, by_id))
    return UploadSummary(status="model", headline=draft.headline, overview=draft.overview,
                         key_projects=key_projects, hotspots=hotspots, timing_notes=draft.timing_notes,
                         **_common(summary_input, model_id))


# -- orchestration -------------------------------------------------------------------------

def default_client():
    from backend.app.agents.summary_agent.client import InProcessSummaryClient
    from backend.app.core.config import get_settings

    settings = get_settings()
    return InProcessSummaryClient(settings), settings.diagnosis_model


def _ask_model(client, summary_input: SummaryInput):
    async def call():
        return await asyncio.wait_for(client.summarize(summary_input), MODEL_TIMEOUT_S)

    return asyncio.run(call())


def generate_summary(summary_input: SummaryInput, collisions: list[MapCollision], names: dict,
                     client, model_id: str) -> UploadSummary:
    """Model summary when the client returns a valid, input-consistent draft; otherwise rule_only."""
    try:
        if client is None:
            client, model_id = default_client()
        result = _ask_model(client, summary_input)
        draft = getattr(result, "draft", None)
        if not isinstance(draft, SummaryDraft):
            log.warning("summary model unavailable (%s); using rule-only summary",
                        str(getattr(result, "status", "no_result"))[:32])
        else:
            return model_summary(draft, summary_input, collisions, names, model_id or "unknown")
    except Exception as exc:  # noqa: BLE001 - class name only; messages may echo model text
        log.warning("summary model failed; using rule-only summary (%s)", type(exc).__name__)
    return rule_only_summary(summary_input, collisions, names)


def summarize_upload(store, upload_id: str, owner: str, *, progress=None, client=None,
                     model_id: str | None = None, regenerate: bool = False) -> str:
    """Summarize and store one upload; returns 'model', 'rule_only' or 'failed'. Never raises.

    An existing summary is left as is (idempotent) unless ``regenerate`` is set and the
    stored summary is a same-owner ``rule_only`` one.
    """
    if progress is not None:
        try:
            progress("summarizing")
        except Exception:  # noqa: BLE001 - progress is best effort
            pass
    try:
        validate_upload_id(upload_id)
        validate_owner(owner)
    except ValueError:
        log.warning("summary skipped: invalid upload id or owner")
        return "failed"
    try:
        existing = store.summary(upload_id)
        if existing is not None:
            status = existing["payload"].get("status")
            if existing["owner"] != owner:
                return "failed"
            if not (regenerate and status == "rule_only"):
                return status if status in ("model", "rule_only") else "failed"
        manifest = store.upload_manifest(upload_id)
    except Exception as exc:  # noqa: BLE001
        log.error("summary lookup for %s failed: %s", upload_id, type(exc).__name__)
        return "failed"
    if not isinstance(manifest, dict):
        log.warning("summary skipped: upload %s is not published", upload_id)
        return "failed"
    summary = None
    try:
        summary_input, collisions, names = build_summary_input(
            upload_id, manifest, store.upload_points(upload_id),
            store.nearest_collisions(upload_id, limit=MAX_COLLISIONS), store.collision_gap_buckets(upload_id))
        summary = generate_summary(summary_input, collisions, names, client, model_id or "")
    except Exception as exc:  # noqa: BLE001
        log.error("summary input for %s failed (%s); storing minimal rule-only summary",
                  upload_id, type(exc).__name__)
    try:
        if summary is None:
            summary = minimal_summary(upload_id, manifest)
        store.save_summary(upload_id, owner, summary.model_dump(mode="json"), replace_rule_only=regenerate)
    except Exception as exc:  # noqa: BLE001
        log.error("summary write for %s failed: %s", upload_id, type(exc).__name__)
        return "failed"
    return summary.status
