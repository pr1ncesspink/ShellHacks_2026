"""Collision diagnosis API routes."""

from fastapi import APIRouter, Depends, HTTPException

from backend.app.agents.collision_pipeline.pipeline import CollisionPipeline
from backend.app.api.deps import get_collision_pipeline
from backend.app.schemas.diagnosis import CollisionView, DiagnoseRequest, DiagnosisEnvelope


router = APIRouter(tags=["collisions"])


@router.get("/collisions", response_model=list[CollisionView])
def collisions(pipeline: CollisionPipeline = Depends(get_collision_pipeline)) -> list[CollisionView]:
    try:
        return pipeline.list_views()
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/collisions/{overlap_id}/diagnosis", response_model=DiagnosisEnvelope)
async def diagnose_collision(
    overlap_id: str, _: DiagnoseRequest | None = None, pipeline: CollisionPipeline = Depends(get_collision_pipeline)
) -> DiagnosisEnvelope:
    try:
        return await pipeline.diagnose(overlap_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown overlap_id: {overlap_id}") from exc
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
