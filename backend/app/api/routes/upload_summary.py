"""Owner-scoped upload summaries, recent uploads, and upload map data.

Ownership comes from SUMMARIES.OWNER_UID (upload manifests are write-once and
ownerless). Absent and foreign uploads are indistinguishable (404). GET routes only
read stored data and never call the summary model.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from backend.app.api.routes.projects import get_project_store
from backend.app.api.routes.upload_sessions import authenticated_owner
from backend.app.schemas.summary import RecentUploads, UploadMap, UploadSummary, UploadSummaryResponse


router = APIRouter(prefix="/projects", tags=["upload-summaries"])
MAP_COLLISION_LIMIT = 200
RECENT_LIMIT = 20
NOT_FOUND = "Upload not found"


class UploadMapResponse(UploadMap):
    """Upload map plus whether points were capped at MAX_MAP_POINTS (the frontend ignores extra keys)."""

    points_truncated: bool = False


def checked_upload_id(upload_id: str) -> str:
    from backend.projectdata.storage import validate_upload_id

    try:
        return validate_upload_id(upload_id)
    except ValueError:
        raise HTTPException(422, "Invalid upload_id") from None


def get_summary_client():
    """(client, model_id) for regeneration; tests override this dependency."""
    from backend.projectdata.summary import default_client

    return default_client()


def _call(function, *args, **kwargs):
    from backend.documentparsing.snowflake import SnowflakeError

    try:
        return function(*args, **kwargs)
    except SnowflakeError:
        raise HTTPException(502, "Upload summary storage is unavailable") from None


def _owned(store, upload_id: str, owner: str) -> dict | None:
    """The caller's stored summary row, or None when no row exists yet; 404 when foreign."""
    row = _call(store.summary, upload_id)
    if row is not None and row["owner"] != owner:
        raise HTTPException(404, NOT_FOUND)
    return row


def _response(upload_id: str, row: dict) -> UploadSummaryResponse:
    try:
        summary = UploadSummary.model_validate(row["payload"])
    except ValueError:
        raise HTTPException(502, "Stored upload summary is invalid") from None
    return UploadSummaryResponse(upload_id=upload_id, created_at=row.get("created_at"),
                                 **summary.model_dump())


@router.get("/uploads", response_model=RecentUploads)
def recent_uploads(owner: str = Depends(authenticated_owner), store=Depends(get_project_store)):
    rows = _call(store.recent_summaries, owner, RECENT_LIMIT)
    uploads = []
    for row in rows:
        try:
            uploads.append({"upload_id": row["upload_id"], "created_at": row.get("created_at"),
                            "status": row["status"], "headline": row["headline"], "counts": row.get("counts")})
        except KeyError:
            continue
    try:
        return RecentUploads.model_validate({"uploads": uploads})
    except ValueError:
        raise HTTPException(502, "Stored upload summary is invalid") from None


@router.get("/uploads/{upload_id}/summary", response_model=UploadSummaryResponse)
def upload_summary(upload_id: str = Depends(checked_upload_id), owner: str = Depends(authenticated_owner),
                   store=Depends(get_project_store)):
    row = _owned(store, upload_id, owner)
    if row is not None:
        return _response(upload_id, row)
    if _call(store.upload_manifest, upload_id) is None:
        raise HTTPException(404, NOT_FOUND)
    # Known gap (deferred owner-scoping follow-up): while a published upload has no summary row
    # yet, any authenticated caller gets 'pending' here, because manifests are ownerless and
    # ownership only exists once the job writes SUMMARIES.OWNER_UID. No upload data is returned;
    # the follow-up is to record the owner at session creation and 404 foreign callers.
    return UploadSummaryResponse(upload_id=upload_id, status="pending", headline="Summary in progress")


@router.get("/uploads/{upload_id}/map", response_model=UploadMapResponse)
def upload_map(upload_id: str = Depends(checked_upload_id), owner: str = Depends(authenticated_owner),
               store=Depends(get_project_store)):
    if _owned(store, upload_id, owner) is None:
        raise HTTPException(404, NOT_FOUND)
    from backend.projectdata.storage import MAX_MAP_POINTS
    from backend.projectdata.summary import map_collisions, map_points

    # One extra row tells us whether the stored points exceed the map cap.
    rows = _call(store.upload_points, upload_id, limit=MAX_MAP_POINTS + 1)
    points = map_points(rows[:MAX_MAP_POINTS])  # unusable rows are skipped, not a 502
    collisions = map_collisions(_call(store.nearest_collisions, upload_id, limit=MAP_COLLISION_LIMIT))
    collisions.sort(key=lambda c: (c.distance_mi, c.overlap_id))
    return UploadMapResponse(upload_id=upload_id, points=points, collisions=collisions,
                             points_truncated=len(rows) > MAX_MAP_POINTS)


@router.post("/uploads/{upload_id}/summary/regenerate", response_model=UploadSummaryResponse)
def regenerate_summary(upload_id: str = Depends(checked_upload_id), owner: str = Depends(authenticated_owner),
                       store=Depends(get_project_store), summary_client=Depends(get_summary_client)):
    """Retry the model for a rule_only summary; rate-limited as an agent path."""
    from backend.projectdata.summary import summarize_upload

    row = _owned(store, upload_id, owner)
    if row is None:
        raise HTTPException(404, NOT_FOUND)
    if row["payload"].get("status") != "rule_only":
        raise HTTPException(409, "Only rule-only summaries can be regenerated")
    client, model_id = summary_client
    if summarize_upload(store, upload_id, owner, client=client, model_id=model_id, regenerate=True) == "failed":
        raise HTTPException(502, "Summary regeneration failed")
    row = _owned(store, upload_id, owner)
    if row is None:
        raise HTTPException(502, "Summary regeneration failed")
    return _response(upload_id, row)
