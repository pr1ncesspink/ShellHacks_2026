from datetime import date, timedelta
import json
from pathlib import Path
import math

from fastapi.testclient import TestClient
from backend.app.main import create_app

client = TestClient(create_app())


def point(identity, year="2026", **extra):
    return dict(record_id=identity, project_id=identity, project_name=identity,
                latitude=40, longitude=-105, estimated_in_service_year=year, **extra)


def test_same_year_unknown_far_and_same_project():
    rows = [point("a"), point("b"), point("c", "2027"), point("d", "")]
    rows.append({**point("far"), "longitude": -110})
    rows.append({**point("a2"), "project_id": "a"})
    response = client.post("/projects/map-analysis", json={"projects": rows})
    assert response.status_code == 200
    body = response.json()
    assert {(r["a_id"], r["b_id"]) for r in body["pairs"]} == {("a", "b"), ("a2", "b")}
    assert body["unknown_timing_pairs"] == 4
    assert body["location_count"] == 6


def test_day_boundary_and_invalid_dates():
    start = date(2024, 1, 1)
    rows = [point("a", schedule=str(start)),
            point("b", schedule=str(start + timedelta(days=365))),
            point("c", schedule=str(start + timedelta(days=366))),
            point("bad", schedule="2026-99-99")]
    body = client.post("/projects/map-analysis", json={"projects": rows}).json()
    pairs = {(p["a_id"], p["b_id"]) for p in body["pairs"]}
    assert ("a", "b") in pairs
    assert ("a", "c") not in pairs
    assert all("bad" not in pair for pair in pairs)


def test_validation_and_full_map_dataset():
    assert client.post("/projects/map-analysis", json={"projects": [point("a"), point("a")]}).status_code == 422
    assert client.post("/projects/map-analysis", json={"projects": [{**point("a"), "latitude": 100}]}).status_code == 422
    rows = json.loads((Path(__file__).resolve().parents[2] / "src/data/project-locations.json").read_text())
    body = client.post("/projects/map-analysis", json={"projects": rows}).json()
    assert body["location_count"] == len(rows)
    assert len(body["pairs"]) > 6
    lookup = {r["record_id"]: r for r in rows}
    for pair in body["pairs"]:
        assert pair["miles"] <= 25.000001
        assert lookup[pair["a_id"]]["estimated_in_service_year"] == lookup[pair["b_id"]]["estimated_in_service_year"]


def test_25_mile_boundary_and_request_limit():
    rows = [{**point("a"), "latitude": 0, "longitude": 0},
            {**point("b"), "latitude": 0, "longitude": math.degrees(25 / 3958.7613)},
            {**point("c"), "latitude": 0, "longitude": math.degrees(25.01 / 3958.7613)}]
    body = client.post("/projects/map-analysis", json={"projects": rows}).json()
    pairs = {(p["a_id"], p["b_id"]) for p in body["pairs"]}
    assert ("a", "b") in pairs
    assert ("a", "c") not in pairs
    assert client.post("/projects/map-analysis", json={"projects": [point(str(i)) for i in range(501)]}).status_code == 422
