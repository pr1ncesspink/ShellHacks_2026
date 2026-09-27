"""Analyze the exact points displayed by the frontend without storing uploads."""
from datetime import date
import re
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field


router = APIRouter(prefix="/projects", tags=["projects"])


class MapPoint(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    record_id: str = Field(min_length=1, max_length=500)
    project_id: str | None = None
    project_name: str = Field(min_length=1, max_length=2000)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    estimated_in_service_year: str = Field(default="", max_length=100)
    schedule: str = Field(default="", max_length=500)


class PlanPreferences(BaseModel):
    unit: Literal["years", "days"] = "years"
    window: int = Field(default=0, ge=0, le=3650)
    earlier: int = Field(default=1, ge=0, le=3650)
    later: int = Field(default=1, ge=0, le=3650)


class MapAnalysisRequest(BaseModel):
    projects: list[MapPoint] = Field(min_length=1, max_length=500)
    preferences: PlanPreferences | None = None


def schedule(point):
    raw = point.schedule.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        try:
            parsed = date.fromisoformat(raw)
            return parsed, parsed.year
        except ValueError:
            return None, None
    year = raw or point.estimated_in_service_year.strip()
    return (None, int(year)) if re.fullmatch(r"(?:19|20|21)\d{2}", year) else (None, None)


@router.post("/map-analysis")
def analyze_map(body: MapAnalysisRequest):
    from backend.projectdata.matching import find_collisions
    from backend.projectdata.records import ProjectPoint
    if len({p.record_id for p in body.projects}) != len(body.projects):
        raise HTTPException(422, "Duplicate record IDs")
    points = [ProjectPoint(
        record_id=p.record_id, project_id=p.project_id or p.record_id,
        project_name=p.project_name, latitude=p.latitude, longitude=p.longitude,
        semantic_text=p.project_name,
    ) for p in body.projects]
    schedules = {p.record_id: schedule(p) for p in body.projects}
    result = find_collisions("map", "map", points, points)
    if body.preferences is not None:
        from backend.projectdata.schedule_plan import propose_schedule
        if body.preferences.unit == "years" and max(body.preferences.window, body.preferences.earlier, body.preferences.later) > 10:
            raise HTTPException(422, "Year limits must be between 0 and 10")
        return propose_schedule(body.projects, result["collisions"], schedules, body.preferences)
    pairs, unknown = [], 0
    geographic = 0
    for row in result["collisions"]:
        a, b = row["uploaded_project"], row["reference_project"]
        if a["record_id"] >= b["record_id"] or a["project_id"] == b["project_id"]:
            continue
        geographic += 1
        date_a, year_a = schedules[a["record_id"]]
        date_b, year_b = schedules[b["record_id"]]
        if year_a is None or year_b is None:
            unknown += 1
            continue
        gap = abs((date_a - date_b).days) if date_a and date_b else None
        matches = gap <= 365 if gap is not None else year_a == year_b
        if matches:
            pairs.append({"a_id": a["record_id"], "b_id": b["record_id"],
                          "miles": row["distance_mi"], "gap_days": gap,
                          "timing": f"{gap} days apart" if gap is not None else f"Same published year ({year_a})"})
    pairs.sort(key=lambda row: (row["miles"], row["a_id"], row["b_id"]))
    return {"pairs": pairs, "location_count": len(points),
            "geographic_pair_count": geographic, "unknown_timing_pairs": unknown,
            "radius_miles": 25, "max_gap_days": 365}
