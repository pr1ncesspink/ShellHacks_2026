"""Upload sessions: signed direct-to-GCS PDF uploads processed by a Cloud Run Job.

Session state is a JSON document ``sessions/<id>.json`` in the upload bucket, always
written with ifGenerationMatch so only one ``created -> queued`` transition (and so one
job launch) can win. The PDF object is ``uploads/<id>.pdf``; user filenames are never used.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import os
import re
from uuid import uuid4

from .gcs import MAX_SIGNED_URL_SECONDS, PreconditionFailed, refuse_firebase_project, sign_put_url

PROJECT_ID = "shellhacks-2026"
DEFAULT_MAX_BYTES = 52_428_800
SESSION_ID = re.compile(r"^SES_[a-f0-9]{32}$")
PDF_MAGIC = b"%PDF-"
STATUSES = ("created", "queued", "processing", "succeeded", "failed")
ERROR_CODES = ("invalid_pdf", "too_large", "snowflake_failed", "reference_unavailable", "timeout", "internal")
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
            timeout = int(env.get("UPLOAD_JOB_TIMEOUT_S", "") or 3600)
        except ValueError:
            raise ConfigError("Upload session limits must be integers") from None
        if max_bytes < 1 or timeout < 1:
            raise ConfigError("Upload session limits must be positive")
        try:
            refuse_firebase_project(bucket, job_name, region)
        except ValueError as exc:
            raise ConfigError(str(exc)) from None
        for value in (bucket, job_name, region):
            if value and not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,221}", value):
                raise ConfigError("Upload bucket/job/region names are malformed")
        return cls(bucket, max_bytes, job_name, region, timeout)


def validate_session_id(value) -> str:
    if not isinstance(value, str) or not SESSION_ID.fullmatch(value):
        raise SessionError(422, "Invalid session_id")
    return value


def object_name(session_id: str) -> str:
    return f"uploads/{session_id}.pdf"


def session_name(session_id: str) -> str:
    return f"sessions/{session_id}.json"


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class JobLauncher:
    """Start one execution of the upload Cloud Run Job via the Run Admin v2 API."""

    def __init__(self, session, job_name: str, region: str = "us-east1", *, timeout: float = 30.0):
        refuse_firebase_project(job_name, region)
        self.session = session
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


def validate_object(gcs, name: str, max_bytes: int) -> tuple[str | None, int]:
    """Return (error_code or None, size) for an uploaded object that is known to exist."""
    meta = gcs.stat(name)
    if meta is None:
        return "internal", 0
    size = int(meta.get("size", 0))
    if size < 1 or size > max_bytes:
        return "too_large" if size > max_bytes else "invalid_pdf", size
    if gcs.read_range(name, 0, len(PDF_MAGIC) - 1) != PDF_MAGIC:
        return "invalid_pdf", size
    return None, size


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
        status, error_code = document["status"], document.get("error_code")
        if status in ("queued", "processing"):
            age = (self.clock() - parse_iso(document["updated_at"])).total_seconds()
            if age > self.config.job_timeout_s + STALE_GRACE_S:
                status, error_code = "failed", "timeout"
        return {
            "session_id": document["session_id"],
            "status": status,
            "upload_id": document.get("upload_id") if status == "succeeded" else None,
            "error_code": error_code if status == "failed" else None,
            "updated_at": document["updated_at"],
        }

    # -- API -------------------------------------------------------------------------
    def create(self, owner: str, size_bytes) -> dict:
        if type(size_bytes) is not int or not 1 <= size_bytes <= self.config.max_bytes:
            raise SessionError(422, f"size_bytes must be between 1 and {self.config.max_bytes}")
        session_id = "SES_" + uuid4().hex
        now = self.clock()
        signed = sign_put_url(self.config.bucket, object_name(session_id), self.config.max_bytes,
                              MAX_SIGNED_URL_SECONDS, self.signer, self.email, now)
        document = {
            "session_id": session_id, "owner": owner, "status": "created", "size_bytes": size_bytes,
            "upload_id": None, "error_code": None, "created_at": iso(now), "updated_at": iso(now),
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
        name = object_name(session_id)
        if self.gcs.stat(name) is None:
            raise SessionError(409, "The PDF has not been uploaded yet")
        error_code, _ = validate_object(self.gcs, name, self.config.max_bytes)
        if error_code:
            self.gcs.delete(name)
            try:
                self._write(document, generation, status="failed", error_code=error_code)
            except PreconditionFailed:
                pass
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

    def status(self, owner: str, session_id: str) -> dict:
        document, _ = self._load(owner, session_id)
        return self.view(document)
