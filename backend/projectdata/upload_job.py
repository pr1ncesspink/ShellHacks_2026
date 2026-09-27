"""Cloud Run Job entrypoint: process one queued upload session.

``python -m backend.projectdata.upload_job --session SES_<hex>``

The PDF is re-validated before any Snowflake call, the session ends ``succeeded`` or
``failed`` with a generic error code, and the GCS object is deleted in ``finally``.
Processing failures exit 0 because the job runs with max-retries 0 (no double billing).
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import logging
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from .gcs import PreconditionFailed
from .upload_sessions import (
    PDF_MAGIC, UploadConfig, iso, object_name, session_name, utc_now, validate_object,
    validate_session_id, SessionError,
)

log = logging.getLogger("backend.projectdata.upload_job")


@contextmanager
def snowflake_store():
    from backend.documentparsing.config import SnowflakeSettings
    from backend.documentparsing.snowflake import SnowflakeClient
    from .storage import ProjectStore

    with SnowflakeClient(SnowflakeSettings.from_env()) as client:
        yield ProjectStore(client)


def default_process(path, store):
    from .pipeline import process_plan

    return process_plan(path, store, store.client)


class ReferenceUnavailable(Exception):
    """ProjectStore.reference() found no loaded reference dataset."""


class _ReferenceGuardedStore:
    """Delegate to a store, tagging only reference() ValueErrors as ReferenceUnavailable.

    ProjectStore.reference raises a plain ValueError when no reference dataset is
    loaded; catching it at this one call site keeps other ValueErrors (for example
    SnowflakeSettings.from_env config errors) classified as internal.
    """

    def __init__(self, store):
        self._store = store

    def reference(self):
        try:
            return self._store.reference()
        except ValueError:
            raise ReferenceUnavailable() from None

    def __getattr__(self, name):
        return getattr(self._store, name)


def classify(exc: BaseException) -> str:
    from backend.documentparsing.snowflake import SnowflakeError

    if isinstance(exc, ReferenceUnavailable):
        return "reference_unavailable"
    if isinstance(exc, SnowflakeError):
        return "snowflake_failed"
    return "internal"


def run(session_id: str, *, gcs, config: UploadConfig, store_factory=snowflake_store,
        process=default_process, clock=utc_now) -> str | None:
    """Process a queued session; return the final status written (None if skipped)."""
    name, key = object_name(session_id), session_name(session_id)
    document, generation = gcs.read_json(key)
    if document is None or document.get("status") != "queued":
        log.warning("session %s is not queued; nothing to do", session_id)
        return None
    try:
        document = {**document, "status": "processing", "updated_at": iso(clock())}
        generation = gcs.write_json(key, document, if_generation_match=generation)
    except PreconditionFailed:
        log.warning("session %s changed concurrently; not processing", session_id)
        return None

    final = {"status": "failed", "error_code": "internal", "upload_id": None}
    try:
        error_code, _ = validate_object(gcs, name, config.max_bytes)
        if error_code:
            final["error_code"] = error_code
        else:
            with TemporaryDirectory(prefix="gridlock-session-") as directory:
                path = Path(directory) / "plan.pdf"
                try:
                    gcs.download_to(name, path, config.max_bytes)
                except ValueError:
                    final["error_code"] = "too_large"
                else:
                    with path.open("rb") as handle:
                        header = handle.read(len(PDF_MAGIC))
                    if header != PDF_MAGIC:
                        final["error_code"] = "invalid_pdf"
                    else:
                        with store_factory() as store:
                            result = process(path, _ReferenceGuardedStore(store))
                        final = {"status": "succeeded", "error_code": None,
                                 "upload_id": result["upload_id"]}
    except Exception as exc:  # noqa: BLE001 - report a generic code, never the message
        final["error_code"] = classify(exc)
        log.error("session %s failed: %s", session_id, type(exc).__name__)
    finally:
        try:
            gcs.delete(name)
        except Exception as exc:  # noqa: BLE001
            log.error("session %s object delete failed: %s", session_id, type(exc).__name__)
        try:
            gcs.write_json(key, {**document, **final, "updated_at": iso(clock())},
                           if_generation_match=generation)
        except Exception as exc:  # noqa: BLE001
            log.error("session %s status write failed: %s", session_id, type(exc).__name__)
    return final["status"]


def main(argv=None, *, gcs=None, config=None, **kwargs) -> int:
    parser = argparse.ArgumentParser(prog="python -m backend.projectdata.upload_job")
    parser.add_argument("--session", required=True)
    args = parser.parse_args(argv)
    try:
        session_id = validate_session_id(args.session)
    except SessionError:
        log.error("invalid session id")
        return 2
    if config is None:
        config = UploadConfig.from_env(require_job=False)
    if gcs is None:
        from .gcs import GcsClient, default_credentials

        session, _, _ = default_credentials()
        gcs = GcsClient(config.bucket, session)
    run(session_id, gcs=gcs, config=config, **kwargs)
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    sys.exit(main())
