"""Direct-to-GCS large PDF upload sessions processed asynchronously by a Cloud Run Job."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, StrictInt

from backend.projectdata.upload_sessions import SessionError, validate_session_id


router = APIRouter(prefix="/projects", tags=["upload-sessions"])
OWNER = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class CreateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    size_bytes: StrictInt


def get_session_service():
    """Build the production service; tests override this dependency."""
    from backend.projectdata.gcs import GcsClient, default_credentials
    from backend.projectdata.upload_sessions import (
        ConfigError, JobLauncher, SessionService, UploadConfig,
    )

    try:
        config = UploadConfig.from_env()
    except ConfigError:
        raise HTTPException(503, "Large uploads are not configured") from None
    try:
        session, signer, email = default_credentials()
    except Exception:
        raise HTTPException(503, "Large uploads are not configured") from None
    return SessionService(config, GcsClient(config.bucket, session), signer=signer, email=email,
                          launcher=JobLauncher(session, config.job_name, config.job_region))


def authenticated_owner(x_authenticated_user: str | None = Header(None)) -> str:
    if not x_authenticated_user or not OWNER.fullmatch(x_authenticated_user):
        raise HTTPException(401, "Authenticated user required")
    return x_authenticated_user


def checked_session_id(session_id: str) -> str:
    try:
        return validate_session_id(session_id)
    except SessionError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None


def _call(function, *args):
    from backend.projectdata.gcs import GcsError

    try:
        return function(*args)
    except SessionError as exc:
        raise HTTPException(exc.status_code, exc.detail) from None
    except GcsError:
        raise HTTPException(502, "Upload storage is unavailable") from None


@router.post("/upload-sessions", status_code=201)
def create_upload_session(body: CreateSessionRequest, owner: str = Depends(authenticated_owner),
                          service=Depends(get_session_service)):
    return _call(service.create, owner, body.size_bytes)


@router.post("/upload-sessions/{session_id}/process", status_code=202)
def process_upload_session(response: Response, session_id: str = Depends(checked_session_id),
                           owner: str = Depends(authenticated_owner),
                           service=Depends(get_session_service)):
    status_code, payload = _call(service.process, owner, session_id)
    response.status_code = status_code
    return payload


@router.get("/upload-sessions/{session_id}")
def upload_session_status(session_id: str = Depends(checked_session_id),
                          owner: str = Depends(authenticated_owner),
                          service=Depends(get_session_service)):
    return _call(service.status, owner, session_id)
