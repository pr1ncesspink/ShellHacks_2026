"""Upload sessions: signed direct-to-GCS PDF/CSV uploads processed by a Cloud Run Job.

Session state is a JSON document ``sessions/<id>.json`` in the upload bucket, always
written with ifGenerationMatch so only one ``created -> queued`` transition (and so one
job launch) can win. The object is ``uploads/<id>.pdf`` or ``uploads/<id>.csv`` depending
on the session ``kind`` (derived server-side from an allow-listed content type); user
filenames are never used. Sessions without a recorded kind are PDF sessions.

A session can be cancelled by its owner from any non-terminal status; ``cancelled`` is
terminal, and the job and progress writes never overwrite it (every write is
generation-matched and the job re-checks the status at safe points).
"""

from __future__ import annotations

import codecs
import csv
from dataclasses import dataclass
from datetime import datetime, timezone
import io
import os
import re
from uuid import uuid4

from .gcs import (
    CSV_CONTENT_TYPE, MAX_SIGNED_URL_SECONDS, PDF_CONTENT_TYPE, PreconditionFailed,
    refuse_firebase_project, sign_put_url,
)

PROJECT_ID = "shellhacks-2026"
DEFAULT_MAX_BYTES = 52_428_800
DEFAULT_MAX_CSV_BYTES = 10_485_760
SESSION_ID = re.compile(r"^SES_[a-f0-9]{32}$")
PDF_MAGIC = b"%PDF-"
KINDS = {PDF_CONTENT_TYPE: "pdf", CSV_CONTENT_TYPE: "csv"}
CONTENT_TYPES = {kind: content_type for content_type, kind in KINDS.items()}
CSV_REQUIRED_COLUMNS = ("project_id", "project_name", "utility")
CSV_HEADER_PREFIX_BYTES = 65_536
STATUSES = ("created", "queued", "processing", "succeeded", "failed", "cancelled")
TERMINAL_STATUSES = ("succeeded", "failed", "cancelled")
EXECUTION_NAME = re.compile(r"^[a-z0-9-]{1,63}$")
CANCEL_ATTEMPTS = 3
STAGES = ("validating", "staging", "parsing", "extracting", "locating", "matching", "saving",
          "summarizing")
ERROR_CODES = ("invalid_pdf", "invalid_csv", "too_large", "snowflake_failed",
               "reference_unavailable", "timeout", "internal")
STALE_GRACE_S = 300


class ConfigError(ValueError):
    """Upload sessions are not configured (reported as 503)."""


class SessionError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class UploadConfig:
    bucket: str
    max_bytes: int = DEFAULT_MAX_BYTES
    job_name: str = ""
    job_region: str = "us-east1"
    job_timeout_s: int = 3600
    max_csv_bytes: int = DEFAULT_MAX_CSV_BYTES

    def limit(self, kind: str) -> int:
        """Per-kind upload size cap in bytes."""
        return self.max_csv_bytes if kind == "csv" else self.max_bytes

    @classmethod
    def from_env(cls, env=None, *, require_job: bool = True) -> "UploadConfig":
        env = os.environ if env is None else env
        bucket = env.get("UPLOAD_BUCKET", "").strip()
        job_name = env.get("UPLOAD_JOB_NAME", "").strip()
        region = env.get("UPLOAD_JOB_REGION", "us-east1").strip() or "us-east1"
        if not bucket or (require_job and not job_name):
            raise ConfigError("Upload sessions are not configured")
        try:
            max_bytes = int(env.get("UPLOAD_MAX_BYTES", "") or DEFAULT_MAX_BYTES)
            max_csv_bytes = int(env.get("UPLOAD_MAX_CSV_BYTES", "") or DEFAULT_MAX_CSV_BYTES)
            timeout = int(env.get("UPLOAD_JOB_TIMEOUT_S", "") or 3600)
        except ValueError:
            raise ConfigError("Upload session limits must be integers") from None
        if max_bytes < 1 or max_csv_bytes < 1 or timeout < 1:
            raise ConfigError("Upload session limits must be positive")
        try:
            refuse_firebase_project(bucket, job_name, region)
        except ValueError as exc:
            raise ConfigError(str(exc)) from None
        for value in (bucket, job_name, region):
            if value and not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,221}", value):
                raise ConfigError("Upload bucket/job/region names are malformed")
        return cls(bucket, max_bytes, job_name, region, timeout, max_csv_bytes)


def validate_session_id(value) -> str:
    if not isinstance(value, str) or not SESSION_ID.fullmatch(value):
        raise SessionError(422, "Invalid session_id")
    return value


def execution_name(value) -> str | None:
    """A Cloud Run execution short name (``^[a-z0-9-]{1,63}$``) or None."""
    if isinstance(value, str) and EXECUTION_NAME.fullmatch(value):
        return value
    return None


def kind_for_content_type(content_type) -> str:
    """Map a client-declared content type onto an allow-listed kind (omitted = pdf)."""
    if content_type is None:
        return "pdf"
    if not isinstance(content_type, str) or content_type not in KINDS:
        raise SessionError(422, "content_type must be application/pdf or text/csv")
    return KINDS[content_type]


def session_kind(document: dict) -> str:
    """The recorded kind; sessions created before CSV support are PDF sessions."""
    kind = document.get("kind") or "pdf"
    if kind not in CONTENT_TYPES:
        raise SessionError(422, "Unsupported upload kind")
    return kind


def object_name(session_id: str, kind: str = "pdf") -> str:
    if kind not in CONTENT_TYPES:
        raise ValueError("Unsupported upload kind")
    return f"uploads/{session_id}.{kind}"


def session_name(session_id: str) -> str:
    return f"sessions/{session_id}.json"


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class JobLauncher:
    """Start (or cancel) executions of the upload Cloud Run Job via the Run Admin v2 API."""

    def __init__(self, session, job_name: str, region: str = "us-east1", *, timeout: float = 30.0):
        refuse_firebase_project(job_name, region)
        self.session = session
        self.job_name = job_name
        self.region = region
        self.url = (f"https://run.googleapis.com/v2/projects/{PROJECT_ID}/locations/{region}"
                    f"/jobs/{job_name}:run")
        self.timeout = timeout

    def launch(self, session_id: str) -> None:
        validate_session_id(session_id)
        body = {"overrides": {"containerOverrides": [
            {"args": ["-m", "backend.projectdata.upload_job", "--session", session_id]},
        ]}}
        response = self.session.post(self.url, json=body, timeout=self.timeout)
        if not 200 <= response.status_code < 300:
            raise RuntimeError(f"Cloud Run job launch returned HTTP {response.status_code}")

    def cancel(self, execution: str) -> None:
        """Cancel one execution by short name; a non-2xx response raises RuntimeError."""
        if execution_name(execution) is None:
            raise ValueError("Malformed Cloud Run execution name")
        url = (f"https://run.googleapis.com/v2/projects/{PROJECT_ID}/locations/{self.region}"
               f"/jobs/{self.job_name}/executions/{execution}:cancel")
        response = self.session.post(url, json={}, timeout=self.timeout)
        if not 200 <= response.status_code < 300:
            raise RuntimeError(f"Cloud Run execution cancel returned HTTP {response.status_code}")


def csv_header_ok(data: bytes, *, complete: bool) -> bool:
    """Strict UTF-8 (optional BOM) whose header row contains the required columns.

    ``complete=False`` checks a prefix of the object: a multibyte character cut at the end
    of the prefix is tolerated, but the header row must end inside the prefix.
    """
    decoder = codecs.getincrementaldecoder("utf-8-sig")(errors="strict")
    try:
        text = decoder.decode(data, final=complete)
    except UnicodeDecodeError:
        return False
    if "\x00" in text:
        return False
    if not complete:
        end = max(text.rfind("\n"), text.rfind("\r"))
        if end < 0:
            return False
        text = text[: end + 1]
    try:
        header = next(csv.reader(io.StringIO(text, newline="")), None)
    except csv.Error:
        return False
    return header is not None and set(CSV_REQUIRED_COLUMNS).issubset(header)


def invalid_code(kind: str) -> str:
    return "invalid_csv" if kind == "csv" else "invalid_pdf"


def validate_object(gcs, name: str, max_bytes: int, kind: str = "pdf") -> tuple[str | None, int]:
    """Return (error_code or None, size) for an uploaded object that is known to exist.

    PDFs must start with ``%PDF-``; CSVs must be strict UTF-8 with the required header
    columns (checked here on a prefix; the job re-checks the whole downloaded file).
    """
    meta = gcs.stat(name)
    if meta is None:
        return "internal", 0
    size = int(meta.get("size", 0))
    if size < 1 or size > max_bytes:
        return "too_large" if size > max_bytes else invalid_code(kind), size
    stored_type = meta.get("contentType")
    if isinstance(stored_type, str) and \
            stored_type.split(";")[0].strip().lower() != CONTENT_TYPES[kind]:
        return invalid_code(kind), size
    if kind == "csv":
        prefix = gcs.read_range(name, 0, min(size, CSV_HEADER_PREFIX_BYTES) - 1)
        if not csv_header_ok(prefix, complete=size <= CSV_HEADER_PREFIX_BYTES):
            return "invalid_csv", size
        return None, size
    if gcs.read_range(name, 0, len(PDF_MAGIC) - 1) != PDF_MAGIC:
        return "invalid_pdf", size
    return None, size


def validate_download(path, kind: str) -> str | None:
    """Re-validate a downloaded object in full; return an error code or None."""
    if kind == "csv":
        return None if csv_header_ok(path.read_bytes(), complete=True) else "invalid_csv"
    with path.open("rb") as handle:
        return None if handle.read(len(PDF_MAGIC)) == PDF_MAGIC else "invalid_pdf"


class SessionService:
    def __init__(self, config: UploadConfig, gcs, *, signer=None, email: str = "", launcher=None,
                 clock=utc_now):
        refuse_firebase_project(config.bucket, email)
        self.config = config
        self.gcs = gcs
        self.signer = signer
        self.email = email
        self.launcher = launcher
        self.clock = clock

    # -- helpers -------------------------------------------------------------------
    def _load(self, owner: str, session_id: str):
        validate_session_id(session_id)
        document, generation = self.gcs.read_json(session_name(session_id))
        # Absent and foreign sessions are indistinguishable to the caller.
        if document is None or document.get("owner") != owner:
            raise SessionError(404, "Upload session not found")
        return document, generation

    def _write(self, document: dict, generation: int, **changes) -> tuple[dict, int]:
        updated = {**document, **changes, "updated_at": iso(self.clock())}
        return updated, self.gcs.write_json(session_name(document["session_id"]), updated,
                                            if_generation_match=generation)

    def view(self, document: dict) -> dict:
        from .progress import stage_detail

        status, error_code = document["status"], document.get("error_code")
        if status in ("queued", "processing"):
            age = (self.clock() - parse_iso(document["updated_at"])).total_seconds()
            if age > self.config.job_timeout_s + STALE_GRACE_S:
                status, error_code = "failed", "timeout"
        view = {
            "session_id": document["session_id"],
            "status": status,
            "upload_id": document.get("upload_id") if status == "succeeded" else None,
            "error_code": error_code if status == "failed" else None,
            "updated_at": document["updated_at"],
        }
        kind = document.get("kind")
        if kind in CONTENT_TYPES and kind != "pdf":
            # Omitted for PDF sessions so existing clients see an unchanged payload.
            view["kind"] = kind
        if status in ("processing", "failed"):
            stage = document.get("stage")
            stage = stage if stage in STAGES else None
            detail, started = document.get("stage_detail"), document.get("stage_started_at")
            view["stage"] = stage
            view["stage_detail"] = (stage_detail(detail.get("done"), detail.get("total"))
                                    if stage and isinstance(detail, dict) else None)
            view["stage_started_at"] = started if stage and isinstance(started, str) else None
        return view

    # -- API -------------------------------------------------------------------------
    def create(self, owner: str, size_bytes, content_type=None) -> dict:
        kind = kind_for_content_type(content_type)
        limit = self.config.limit(kind)
        if type(size_bytes) is not int or not 1 <= size_bytes <= limit:
            raise SessionError(422, f"size_bytes must be between 1 and {limit}")
        session_id = "SES_" + uuid4().hex
        now = self.clock()
        signed = sign_put_url(self.config.bucket, object_name(session_id, kind), limit,
                              MAX_SIGNED_URL_SECONDS, self.signer, self.email, now,
                              content_type=CONTENT_TYPES[kind])
        document = {
            "session_id": session_id, "owner": owner, "status": "created", "kind": kind,
            "size_bytes": size_bytes, "upload_id": None, "error_code": None,
            "created_at": iso(now), "updated_at": iso(now),
        }
        self.gcs.write_json(session_name(session_id), document, if_generation_match=0)
        return {
            "session_id": session_id,
            "upload_url": signed.url,
            "method": "PUT",
            "required_headers": signed.headers,
            "expires_at": iso(signed.expires_at),
        }

    def process(self, owner: str, session_id: str) -> tuple[int, dict]:
        document, generation = self._load(owner, session_id)
        if document["status"] != "created":
            return 200, self.view(document)
        kind = session_kind(document)
        name = object_name(session_id, kind)
        if self.gcs.stat(name) is None:
            raise SessionError(409, f"The {kind.upper()} has not been uploaded yet")
        error_code, _ = validate_object(self.gcs, name, self.config.limit(kind), kind)
        if error_code:
            self.gcs.delete(name)
            try:
                self._write(document, generation, status="failed", error_code=error_code)
            except PreconditionFailed:
                pass
            if kind == "csv":
                raise SessionError(422, "The uploaded file is not a UTF-8 projects CSV "
                                        "with project_id, project_name and utility columns "
                                        "within the size limit")
            raise SessionError(422, "The uploaded file is not a PDF within the size limit")
        try:
            queued, generation = self._write(document, generation, status="queued")
        except PreconditionFailed:
            current, _ = self._load(owner, session_id)
            return 200, self.view(current)
        try:
            self.launcher.launch(session_id)
        except Exception:
            # Best-effort cleanup: nothing here may mask the intended 502.
            try:
                self.gcs.delete(name)
            except Exception:  # noqa: BLE001
                pass
            try:
                self._write(queued, generation, status="failed", error_code="internal")
            except Exception:  # noqa: BLE001
                pass
            raise SessionError(502, "Processing could not be started") from None
        return 202, {"status": "queued"}

    def cancel(self, owner: str, session_id: str) -> dict:
        """Cancel a non-terminal session (idempotent); terminal sessions are returned unchanged.

        The status write is generation-matched, so a concurrent job/final write either lands
        first (and is then returned unchanged if terminal) or loses to the cancel. Deleting
        the object and cancelling the recorded Cloud Run execution are best effort.
        """
        for _ in range(CANCEL_ATTEMPTS):
            document, generation = self._load(owner, session_id)
            if document["status"] in TERMINAL_STATUSES:
                return self.view(document)
            try:
                updated, _ = self._write(document, generation, status="cancelled",
                                         cancelled_at=iso(self.clock()))
            except PreconditionFailed:
                continue
            self._cancel_cleanup(document)
            return self.view(updated)
        raise SessionError(502, "The upload could not be cancelled; try again")

    def _cancel_cleanup(self, document: dict) -> None:
        # Nothing here may turn a recorded cancel into an error.
        try:
            self.gcs.delete(object_name(document["session_id"], session_kind(document)))
        except Exception:  # noqa: BLE001
            pass
        execution = execution_name(document.get("job_execution"))
        if execution and self.launcher is not None:
            try:
                self.launcher.cancel(execution)
            except Exception:  # noqa: BLE001
                pass

    def status(self, owner: str, session_id: str) -> dict:
        document, _ = self._load(owner, session_id)
        return self.view(document)
