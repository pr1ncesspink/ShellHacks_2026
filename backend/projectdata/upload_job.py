"""Cloud Run Job entrypoint: process one queued upload session.

``python -m backend.projectdata.upload_job --session SES_<hex>``

The uploaded PDF or CSV is re-validated before any Snowflake call, the session ends
``succeeded`` or ``failed`` with a generic error code, and the GCS object is deleted in
``finally``. While processing, the current pipeline stage is written into the session
document (best effort, see ``progress.ProgressReporter``). After a successful run the
upload is summarized (stage ``summarizing``); a summary failure never fails the job.
Processing failures exit 0 because the job runs with max-retries 0 (no double billing).

The owner may cancel the session at any time. The job records its Cloud Run execution
name (``CLOUD_RUN_EXECUTION``) so the API can cancel it, and also stops cooperatively at
safe points (before download, before processing, after processing and before summarizing):
a cancelled session is never summarized and its final status is never written over.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import logging
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from .gcs import PreconditionFailed
from .progress import ProgressReporter
from .upload_sessions import (
    UploadConfig, execution_name, iso, object_name, session_kind, session_name, utc_now, validate_download,
    validate_object, validate_session_id, SessionError,
)

log = logging.getLogger("backend.projectdata.upload_job")


@contextmanager
def snowflake_store():
    from backend.documentparsing.config import SnowflakeSettings
    from backend.documentparsing.snowflake import SnowflakeClient
    from .storage import ProjectStore

    with SnowflakeClient(SnowflakeSettings.from_env()) as client:
        yield ProjectStore(client)


def default_process(path, store, *, progress=None):
    from .pipeline import process_plan

    return process_plan(path, store, store.client, progress=progress)


def default_summarize(store, upload_id: str, owner: str, *, progress=None):
    """Summarize via backend.projectdata.summary when it is available (imported lazily)."""
    try:
        from .summary import summarize_upload
    except ImportError as exc:
        log.warning("upload summaries unavailable: %s", type(exc).__name__)
        return None
    return summarize_upload(store, upload_id, owner, progress=progress)


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


def _summarize(summarize, store, upload_id, owner, reporter, session_id) -> None:
    reporter("summarizing")
    try:
        summarize(store, upload_id, owner, progress=reporter)
    except Exception as exc:  # noqa: BLE001 - a summary never fails the job
        log.error("session %s summary failed: %s", session_id, type(exc).__name__)


class _Cancelled(Exception):
    """The owner cancelled the session; stop at this safe point."""


def _cancelled(gcs, key) -> bool:
    """True when the stored session is cancelled (a read error counts as not cancelled)."""
    try:
        current, _ = gcs.read_json(key)
    except Exception as exc:  # noqa: BLE001
        log.warning("session status re-read failed: %s", type(exc).__name__)
        return False
    return isinstance(current, dict) and current.get("status") == "cancelled"


def _check_cancel(gcs, key, reporter) -> None:
    if reporter.cancelled or _cancelled(gcs, key):
        raise _Cancelled()


def _write_final(gcs, key, session_id, document, generation) -> str | None:
    """Write the final status; return the status now stored (None when unknown).

    Never writes over a document that is no longer ``processing`` (for example cancelled).
    """
    try:
        gcs.write_json(key, document, if_generation_match=generation)
        return document["status"]
    except PreconditionFailed:
        pass
    except Exception as exc:  # noqa: BLE001
        log.error("session %s status write failed: %s", session_id, type(exc).__name__)
        return None
    # A progress write may have landed without its generation being observed (for
    # example a transport error after the commit). Only this job writes a processing
    # session, so retry once on top of the current document if it is still processing.
    try:
        current, current_generation = gcs.read_json(key)
        status = current.get("status") if isinstance(current, dict) else None
        if status == "cancelled":
            log.info("session %s was cancelled; final status not written", session_id)
            return "cancelled"
        if status != "processing":
            log.error("session %s status write lost a race", session_id)
            return status
        gcs.write_json(key, {**current, **{k: document[k] for k in
                                           ("status", "error_code", "upload_id", "updated_at")}},
                       if_generation_match=current_generation)
        return document["status"]
    except Exception as exc:  # noqa: BLE001
        log.error("session %s status write failed: %s", session_id, type(exc).__name__)
        return None


def run(session_id: str, *, gcs, config: UploadConfig, store_factory=snowflake_store,
        process=default_process, summarize=None, clock=utc_now, env=None) -> str | None:
    """Process a queued session; return the final status (None if skipped).

    Returns ``cancelled`` when the owner cancelled the session while it ran.
    ``summarize(store, upload_id, owner, *, progress=None)`` defaults to
    ``backend.projectdata.summary.summarize_upload`` (looked up at call time).
    """
    summarize = summarize or default_summarize
    env = os.environ if env is None else env
    key = session_name(session_id)
    document, generation = gcs.read_json(key)
    if document is None or document.get("status") != "queued":
        log.warning("session %s is not queued; nothing to do", session_id)
        return None
    try:
        kind = session_kind(document)
    except SessionError:
        log.error("session %s has an unsupported kind", session_id)
        return None
    name = object_name(session_id, kind)
    try:
        document = {**document, "status": "processing",
                    "job_execution": execution_name(env.get("CLOUD_RUN_EXECUTION")),
                    "updated_at": iso(clock())}
        generation = gcs.write_json(key, document, if_generation_match=generation)
    except PreconditionFailed:
        log.warning("session %s changed concurrently; not processing", session_id)
        return None

    reporter = ProgressReporter(gcs, key, document, generation, clock=clock)
    limit = config.limit(kind)
    final = {"status": "failed", "error_code": "internal", "upload_id": None}
    cancelled = False
    written = None
    try:
        reporter("validating")
        error_code, _ = validate_object(gcs, name, limit, kind)
        if error_code:
            final["error_code"] = error_code
        else:
            _check_cancel(gcs, key, reporter)
            with TemporaryDirectory(prefix="gridlock-session-") as directory:
                path = Path(directory) / f"plan.{kind}"
                try:
                    gcs.download_to(name, path, limit)
                except ValueError:
                    final["error_code"] = "too_large"
                else:
                    error_code = validate_download(path, kind)
                    if error_code:
                        final["error_code"] = error_code
                    else:
                        _check_cancel(gcs, key, reporter)
                        with store_factory() as store:
                            result = process(path, _ReferenceGuardedStore(store), progress=reporter)
                            upload_id = result["upload_id"]
                            # Rows saved by a cancelled run stay unreachable (no upload_id is
                            # ever exposed); never spend a summary on them.
                            _check_cancel(gcs, key, reporter)
                            _summarize(summarize, store, upload_id, document.get("owner", ""),
                                       reporter, session_id)
                        final = {"status": "succeeded", "error_code": None, "upload_id": upload_id}
    except _Cancelled:
        cancelled = True
        log.info("session %s was cancelled; stopping", session_id)
    except Exception as exc:  # noqa: BLE001 - report a generic code, never the message
        final["error_code"] = classify(exc)
        log.error("session %s failed: %s", session_id, type(exc).__name__)
    finally:
        reporter.close()
        try:
            gcs.delete(name)
        except Exception as exc:  # noqa: BLE001
            log.error("session %s object delete failed: %s", session_id, type(exc).__name__)
        if not cancelled:
            # The last progress document keeps its stage, so a failure shows where it stopped.
            written = _write_final(gcs, key, session_id,
                                   {**reporter.document, **final, "updated_at": iso(clock())},
                                   reporter.generation)
    if cancelled or written == "cancelled":
        return "cancelled"
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
