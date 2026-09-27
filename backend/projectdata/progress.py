"""Best-effort pipeline stage reporting into an upload session document.

The Cloud Run Job owns a session while it is ``processing``. ``ProgressReporter`` writes the
current stage (and, while extracting, ``done/total``) into ``sessions/<id>.json`` with
ifGenerationMatch, tracking the generation each write returns so the job's final status
write can follow on from it. Progress is advisory: a lost race or any storage error logs the
exception class only and disables the reporter; it never raises into the pipeline, never
touches ``updated_at`` (the stale-session timeout keeps its meaning), and never writes over
a terminal status.
"""

from __future__ import annotations

import logging

from .gcs import PreconditionFailed
from .upload_sessions import STAGES, iso, utc_now

log = logging.getLogger("backend.projectdata.progress")

THROTTLE_S = 5.0
MAX_DETAIL = 100_000
TERMINAL = ("succeeded", "failed")


def stage_detail(done, total) -> dict | None:
    """Return a valid ``{done, total}`` pair or None (0 <= done <= total <= 100000)."""
    if type(done) is not int or type(total) is not int:
        return None
    if not 0 <= done <= total <= MAX_DETAIL:
        return None
    return {"done": done, "total": total}


class ProgressReporter:
    """Callable ``reporter(stage, done=None, total=None)``; see the module docstring."""

    def __init__(self, gcs, key: str, document: dict, generation: int, *, clock=utc_now,
                 throttle_s: float = THROTTLE_S):
        self._gcs = gcs
        self._key = key
        self._document = dict(document)
        self._generation = generation
        self._clock = clock
        self._throttle_s = throttle_s
        self._last_write = None
        self._disabled = False
        self._closed = False

    @property
    def document(self) -> dict:
        """The latest document this reporter wrote (or was given)."""
        return dict(self._document)

    @property
    def generation(self) -> int:
        """The generation returned by the latest successful write."""
        return self._generation

    @property
    def active(self) -> bool:
        return not (self._disabled or self._closed)

    def close(self) -> None:
        """Block every later write (the job is about to write the final status)."""
        self._closed = True

    def __call__(self, stage: str, done=None, total=None) -> None:
        if not self.active:
            return
        try:
            self._report(stage, done, total)
        except Exception as exc:  # noqa: BLE001 - progress must never fail the job
            self._disabled = True
            log.warning("progress reporting disabled: %s", type(exc).__name__)

    def _report(self, stage, done, total) -> None:
        if stage not in STAGES or self._document.get("status") in TERMINAL:
            return
        if self._document.get("status") != "processing":
            return
        detail = stage_detail(done, total)
        now = self._clock()
        current = self._document.get("stage")
        if stage == current:
            if detail == self._document.get("stage_detail"):
                return
            final = detail is not None and detail["done"] == detail["total"]
            elapsed = (now - self._last_write).total_seconds() if self._last_write else None
            if not final and elapsed is not None and elapsed < self._throttle_s:
                return
            started = self._document.get("stage_started_at")
        else:
            started = iso(now)
        updated = {**self._document, "stage": stage, "stage_detail": detail,
                   "stage_started_at": started, "stage_updated_at": iso(now)}
        try:
            generation = self._gcs.write_json(self._key, updated,
                                              if_generation_match=self._generation)
        except PreconditionFailed:
            # Someone else owns the document now (for example a terminal write): stop.
            self._disabled = True
            log.warning("progress reporting disabled: %s", PreconditionFailed.__name__)
            return
        self._document, self._generation, self._last_write = updated, generation, now
