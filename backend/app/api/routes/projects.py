"""Upload plans and retrieve the resulting Snowflake collision dataset."""

from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile


router = APIRouter(prefix="/projects", tags=["projects"])


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
