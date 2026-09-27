"""Plain tool functions for the overlap agent."""

from __future__ import annotations

from math import isfinite
from typing import Callable

from backend.app.core.config import get_settings
from backend.app.services.overlaps import load_overlaps, score_overlaps
from backend.app.services.similarity import Encoder, get_encoder, score_pair


_encoder_provider: Callable[[], Encoder] = get_encoder
_scored_rows_cache: dict[tuple[str, int], tuple[dict[str, object], ...]] = {}


def set_encoder_provider(provider: Callable[[], Encoder]) -> None:
    """Set the encoder provider used by the tools.

    This narrow override keeps tool calls deterministic in offline tests.
    """
    global _encoder_provider
    _encoder_provider = provider
    clear_cache()


def reset_encoder_provider() -> None:
    """Restore the production encoder provider after a test override."""
    global _encoder_provider
    _encoder_provider = get_encoder
    clear_cache()


def clear_cache() -> None:
    """Discard cached scored overlap rows."""
    _scored_rows_cache.clear()


def _validate_name(name: str, parameter: str) -> str | None:
    if not isinstance(name, str) or not name.strip():
        return f"{parameter} must not be empty"
    if len(name) > 512:
        return f"{parameter} must be at most 512 characters"
    return None


def _scored_rows() -> tuple[dict[str, object], ...]:
    settings = get_settings()
    encoder = _encoder_provider()
    cache_key = (str(settings.data_path), id(encoder))
    cached = _scored_rows_cache.get(cache_key)
    if cached is None:
        rows = score_overlaps(load_overlaps(settings.data_path), encoder)
        cached = tuple(
            {
                **row.model_dump(by_alias=False),
                "name_similarity": round(row.name_similarity, 4),
            }
            for row in rows
        )
        _scored_rows_cache[cache_key] = cached
    return cached


def score_project_names(name_a: str, name_b: str) -> dict[str, object]:
    """Score two project names using the configured semantic-similarity model.

    Args:
        name_a: The first utility project name.
        name_b: The second utility project name.

    Returns:
        A status dictionary containing the cosine similarity score, or an error.
    """
    error = _validate_name(name_a, "name_a") or _validate_name(name_b, "name_b")
    if error:
        return {"status": "error", "error_message": error}
    try:
        score = round(score_pair(name_a, name_b, _encoder_provider()), 4)
    except (OSError, ValueError) as exc:
        return {"status": "error", "error_message": str(exc)}
    return {"status": "success", "score": score}


def get_overlap(overlap_id: str) -> dict[str, object]:
    """Get one scored overlap by its overlap identifier.

    Args:
        overlap_id: The identifier from the project-overlaps data set.

    Returns:
        A status dictionary containing the scored overlap, or an error.
    """
    if not isinstance(overlap_id, str) or not overlap_id.strip():
        return {"status": "error", "error_message": "overlap_id must not be empty"}
    try:
        row = next((row for row in _scored_rows() if row["overlap_id"] == overlap_id), None)
    except (OSError, ValueError) as exc:
        return {"status": "error", "error_message": str(exc)}
    if row is None:
        return {"status": "error", "error_message": f"Overlap {overlap_id!r} was not found"}
    return {"status": "success", "overlap": dict(row)}


def list_overlaps(min_similarity: float = -1.0) -> dict[str, object]:
    """List scored overlaps at or above a similarity threshold.

    Args:
        min_similarity: Lowest cosine similarity to include, from -1 through 1.

    Returns:
        A status dictionary containing descending scored overlaps, or an error.
    """
    if not isinstance(min_similarity, (int, float)) or not isfinite(min_similarity):
        return {"status": "error", "error_message": "min_similarity must be a finite number"}
    try:
        overlaps = [dict(row) for row in _scored_rows() if row["name_similarity"] >= min_similarity]
    except (OSError, ValueError) as exc:
        return {"status": "error", "error_message": str(exc)}
    overlaps.sort(key=lambda row: float(row["name_similarity"]), reverse=True)
    return {"status": "success", "overlaps": overlaps}


def get_upload_collisions(upload_id: str, offset: int = 0, limit: int = 100) -> dict[str, object]:
    """Read and score one page of an uploaded plan's 25-mile collision candidates.

    Args:
        upload_id: The UPL_ identifier returned by the project upload endpoint.
        offset: Number of collision records to skip.
        limit: Maximum records to return, between 1 and 500. Follow next_offset for more.
    """
    from backend.documentparsing.config import SnowflakeSettings
    from backend.documentparsing.snowflake import SnowflakeClient, SnowflakeError
    from backend.projectdata.pipeline import score_collision_page
    from backend.projectdata.storage import ProjectStore, validate_upload_id

    try:
        validate_upload_id(upload_id)
        with SnowflakeClient(SnowflakeSettings.from_env()) as client:
            page = ProjectStore(client).collisions(upload_id, offset=offset, limit=limit)
        return {"status": "success", **score_collision_page(page, _encoder_provider())}
    except (ValueError, LookupError, OSError, SnowflakeError):
        return {"status": "error", "error_message": "Collision retrieval failed; verify upload_id, pagination, and Snowflake configuration"}
