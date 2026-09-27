"""Upload plans and retrieve the resulting Snowflake collision dataset."""

from pathlib import Path
import re
from tempfile import TemporaryDirectory

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile

from backend.app.api.deps import get_upload_diagnosis_service
from backend.app.schemas.diagnosis import DiagnoseRequest, UploadDiagnosisResult
from backend.projectdata.diagnosis import UploadDiagnosisService


router = APIRouter(prefix="/projects", tags=["projects"])


def validated_collision_ids(upload_id: str, overlap_id: str) -> tuple[str, str]:
    from backend.projectdata.storage import validate_upload_id

    try:
        validate_upload_id(upload_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    if not re.fullmatch(r"COL_[a-f0-9]{24}", overlap_id):
        raise HTTPException(422, "Invalid overlap_id")
    return upload_id, overlap_id


def get_project_store():
    from backend.documentparsing.config import SnowflakeSettings
    from backend.documentparsing.snowflake import SnowflakeClient
    from backend.projectdata.storage import ProjectStore

    try:
        settings = SnowflakeSettings.from_env()
    except ValueError:
        raise HTTPException(503, "Snowflake project storage is not configured") from None
    with SnowflakeClient(settings) as client:
        yield ProjectStore(client)


@router.post("/uploads", status_code=201)
def upload_project_plan(file: UploadFile = File(...), utility: str = Form(""),
                        state: str = Form(""), store=Depends(get_project_store)):
    from backend.documentparsing.extraction import DOCUMENT_TYPES, MAX_FILE_BYTES
    from backend.documentparsing.snowflake import SnowflakeError
    from backend.projectdata.pipeline import process_plan

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {*DOCUMENT_TYPES, ".json", ".csv", ".xlsx"}:
        raise HTTPException(422, "Unsupported project plan file type")
    try:
        with TemporaryDirectory(prefix="gridlock-request-") as directory:
            path = Path(directory) / ("plan" + suffix)
            size = 0
            with path.open("wb") as output:
                while chunk := file.file.read(1024 * 1024):
                    size += len(chunk)
                    if size >= MAX_FILE_BYTES:
                        raise HTTPException(413, "Project plan must be smaller than 100,000,000 bytes")
                    output.write(chunk)
            if size == 0:
                raise HTTPException(422, "Project plan is empty")
            result = process_plan(path, store, store.client, utility=utility, state=state)
        # Retrieve large collision datasets by page instead of putting every pair in this response.
        return {**{k: v for k, v in result.items() if k not in {"collisions", "extraction_audit"}},
                "collisions_url": f"/projects/uploads/{result['upload_id']}/collisions"}
    except ValueError:
        raise HTTPException(422, "Invalid project data or reference dataset unavailable; inspect server configuration and input") from None
    except SnowflakeError:
        raise HTTPException(502, "Snowflake processing failed; the upload was not published") from None
    finally:
        file.file.close()


@router.get("/uploads/{upload_id}/collisions")
def upload_collisions(upload_id: str, offset: int = Query(0, ge=0),
                      limit: int = Query(100, ge=1, le=500), store=Depends(get_project_store)):
    from backend.documentparsing.snowflake import SnowflakeError

    try:
        return store.collisions(upload_id, offset=offset, limit=limit)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    except LookupError:
        raise HTTPException(404, "Upload not found or processing did not complete") from None
    except SnowflakeError:
        raise HTTPException(502, "Snowflake collision retrieval failed") from None


@router.post("/uploads/{upload_id}/collisions/{overlap_id}/diagnosis", response_model=UploadDiagnosisResult)
async def diagnose_upload_collision(
    ids: tuple[str, str] = Depends(validated_collision_ids), _: DiagnoseRequest | None = None,
    store=Depends(get_project_store), service: UploadDiagnosisService = Depends(get_upload_diagnosis_service),
) -> UploadDiagnosisResult:
    from fastapi.concurrency import run_in_threadpool
    from backend.documentparsing.snowflake import SnowflakeError

    upload_id, overlap_id = ids
    # Snowflake reads and MiniLM encoding are blocking; keep them off the event loop.
    try:
        collision = await run_in_threadpool(store.collision, upload_id, overlap_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    except LookupError:
        raise HTTPException(404, "Upload not found, processing did not complete, or unknown collision") from None
    except SnowflakeError:
        raise HTTPException(502, "Snowflake collision retrieval failed") from None
    try:
        prepared = await run_in_threadpool(service.prepare, collision)
    except (KeyError, TypeError, ValueError):
        # Malformed stored data is a server-side fault; do not echo stored values.
        raise HTTPException(502, "Stored collision record is invalid") from None
    return await service.diagnose(upload_id, collision, prepared)
