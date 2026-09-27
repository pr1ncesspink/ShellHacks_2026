"""Minimal Cloud Storage access for large plan uploads, built on google-auth only.

Signing uses the V4 query-string algorithm with an injected signer (in production
``google.auth.iam.Signer``, i.e. IAM signBlob as the runtime service account), so no
private key file ever exists. Object/session access uses the JSON API through an
injected ``google.auth.transport.requests.AuthorizedSession``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from urllib.parse import quote

FIREBASE_PROJECT_ID = "shellhacks26-c78d4"
GCS_HOST = "storage.googleapis.com"
PDF_CONTENT_TYPE = "application/pdf"
CSV_CONTENT_TYPE = "text/csv"
SIGNABLE_CONTENT_TYPES = (PDF_CONTENT_TYPE, CSV_CONTENT_TYPE)
MAX_SIGNED_URL_SECONDS = 900
_API = f"https://{GCS_HOST}/storage/v1/b"
_UPLOAD_API = f"https://{GCS_HOST}/upload/storage/v1/b"


class GcsError(RuntimeError):
    """A Cloud Storage transport or status failure (no response bodies are kept)."""


class PreconditionFailed(GcsError):
    """An ifGenerationMatch write lost a race."""


def refuse_firebase_project(*values) -> None:
    """GCS/Run resources live in shellhacks-2026; never in the Firebase Auth project."""
    for value in values:
        if value and FIREBASE_PROJECT_ID in str(value):
            raise ValueError("Upload storage/job configuration must not reference the Firebase project")


def _encode(value: str, safe: str = "-_.~") -> str:
    return quote(value, safe=safe)


@dataclass(frozen=True)
class SignedPut:
    url: str
    headers: dict[str, str]
    expires_at: datetime
    canonical_request: str
    string_to_sign: str


def sign_put_url(bucket: str, name: str, max_bytes: int, expires_s: int, signer, email: str,
                 now: datetime, *, content_type: str = PDF_CONTENT_TYPE) -> SignedPut:
    """Return a V4 signed PUT URL bound to Content-Type and x-goog-content-length-range."""
    refuse_firebase_project(bucket, email)
    if content_type not in SIGNABLE_CONTENT_TYPES:
        raise ValueError("Unsupported upload content type")
    if not 0 < expires_s <= MAX_SIGNED_URL_SECONDS:
        raise ValueError("Signed URL expiry must be between 1 and 900 seconds")
    if type(max_bytes) is not int or max_bytes < 1:
        raise ValueError("max_bytes must be a positive integer")
    now = now.astimezone(timezone.utc)
    timestamp = now.strftime("%Y%m%dT%H%M%SZ")
    scope = f"{now.strftime('%Y%m%d')}/auto/storage/goog4_request"
    headers = {
        "content-type": content_type,
        "host": GCS_HOST,
        "x-goog-content-length-range": f"1,{max_bytes}",
    }
    signed_headers = ";".join(sorted(headers))
    canonical_headers = "".join(f"{key}:{headers[key]}\n" for key in sorted(headers))
    query = {
        "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
        "X-Goog-Credential": f"{email}/{scope}",
        "X-Goog-Date": timestamp,
        "X-Goog-Expires": str(expires_s),
        "X-Goog-SignedHeaders": signed_headers,
    }
    canonical_query = "&".join(f"{_encode(k)}={_encode(v)}" for k, v in sorted(query.items()))
    path = f"/{bucket}/{_encode(name, safe='/-_.~')}"
    canonical_request = "\n".join([
        "PUT", path, canonical_query, canonical_headers, signed_headers, "UNSIGNED-PAYLOAD",
    ])
    string_to_sign = "\n".join([
        "GOOG4-RSA-SHA256", timestamp, scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])
    signature = signer.sign(string_to_sign.encode("utf-8")).hex()
    return SignedPut(
        url=f"https://{GCS_HOST}{path}?{canonical_query}&X-Goog-Signature={signature}",
        headers={"Content-Type": content_type, "x-goog-content-length-range": f"1,{max_bytes}"},
        expires_at=now + timedelta(seconds=expires_s),
        canonical_request=canonical_request,
        string_to_sign=string_to_sign,
    )


def default_credentials():
    """ADC credentials plus an IAM signBlob signer for the runtime service account."""
    import google.auth
    from google.auth import iam
    from google.auth.transport.requests import AuthorizedSession, Request

    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    request = Request()
    credentials.refresh(request)  # Resolves the metadata-server service account email.
    email = getattr(credentials, "service_account_email", "")
    if not email or email == "default":
        raise ValueError("Signed uploads require service-account credentials")
    refuse_firebase_project(email)
    return AuthorizedSession(credentials), iam.Signer(request, credentials, email), email


class GcsClient:
    """Bucket-scoped JSON API operations; ``session`` is an AuthorizedSession-like object."""

    def __init__(self, bucket: str, session, *, timeout: float = 30.0):
        refuse_firebase_project(bucket)
        if not bucket:
            raise ValueError("A bucket name is required")
        self.bucket = bucket
        self.session = session
        self.timeout = timeout

    def _object_url(self, name: str) -> str:
        return f"{_API}/{_encode(self.bucket, safe='')}/o/{_encode(name, safe='')}"

    def _check(self, response, *ok):
        if response.status_code not in (ok or (200,)):
            raise GcsError(f"Cloud Storage returned HTTP {response.status_code}")
        return response

    def stat(self, name: str) -> dict | None:
        response = self.session.get(self._object_url(name), timeout=self.timeout)
        if response.status_code == 404:
            return None
        return self._check(response).json()

    def read_range(self, name: str, start: int, end: int) -> bytes:
        """Read bytes [start, end] inclusive."""
        response = self.session.get(self._object_url(name), params={"alt": "media"},
                                    headers={"Range": f"bytes={start}-{end}"}, timeout=self.timeout)
        return self._check(response, 200, 206).content[: end - start + 1]

    def download_to(self, name: str, path, max_bytes: int) -> int:
        response = self.session.get(self._object_url(name), params={"alt": "media"},
                                    stream=True, timeout=self.timeout)
        try:
            self._check(response)
            size = 0
            with Path(path).open("wb") as output:
                for chunk in response.iter_content(1024 * 1024):
                    size += len(chunk)
                    if size > max_bytes:
                        raise ValueError("Object exceeds the upload size limit")
                    output.write(chunk)
            return size
        finally:
            response.close()

    def read_json(self, name: str) -> tuple[dict | None, int | None]:
        """Return (document, generation), or (None, None) if absent."""
        meta = self.stat(name)
        if meta is None:
            return None, None
        generation = int(meta["generation"])
        response = self.session.get(self._object_url(name),
                                    params={"alt": "media", "generation": str(generation)},
                                    timeout=self.timeout)
        if response.status_code == 404:
            return None, None
        return json.loads(self._check(response).content), generation

    def write_json(self, name: str, document: dict, *, if_generation_match: int) -> int:
        """Write only if the current generation matches (0 = must not exist); return new generation."""
        response = self.session.post(
            f"{_UPLOAD_API}/{_encode(self.bucket, safe='')}/o",
            params={"uploadType": "media", "name": name, "ifGenerationMatch": str(if_generation_match)},
            data=json.dumps(document, separators=(",", ":")).encode("utf-8"),
            headers={"Content-Type": "application/json"}, timeout=self.timeout)
        if response.status_code == 412:
            raise PreconditionFailed("Session changed concurrently")
        return int(self._check(response).json()["generation"])

    def delete(self, name: str) -> None:
        response = self.session.delete(self._object_url(name), timeout=self.timeout)
        self._check(response, 200, 204, 404)
