from fastapi.testclient import TestClient
from backend.app.main import create_app

client = TestClient(create_app())


def point(identity, **extra):
    return dict(record_id=identity, project_id=identity, project_name=identity,
                latitude=40, longitude=-105, estimated_in_service_year="2026", **extra)


def plan(rows, **prefs):
    response = client.post("/projects/map-analysis", json={"projects": rows, "preferences": prefs})
    assert response.status_code == 200, response.text
    return response.json()


def test_earlier_only_groups_all_segments_and_keeps_original():
    rows = [point("a"), {**point("a2"), "project_id": "a"}, point("b")]
    result = plan(rows, unit="years", window=0, earlier=1, later=0)
    assert len(result["pairs"]) == 2
    assert len(result["proposal"]["analysis"]["pairs"]) == 0
    proposed = {p["record_id"]: p for p in result["proposal"]["projects"]}
    assert proposed["a"]["schedule"] == proposed["a2"]["schedule"] == "2025"
    assert rows[0]["estimated_in_service_year"] == "2026"
    assert all(c["shift"] == -1 for c in result["proposal"]["changes"])


def test_no_movement_and_unresolvable_window():
    rows = [point("a"), point("b")]
    for prefs in [dict(window=0, earlier=0, later=0), dict(window=2, earlier=1, later=1)]:
        result = plan(rows, unit="years", **prefs)
        assert result["proposal"]["changes"] == []
        assert len(result["proposal"]["analysis"]["pairs"]) == 1


def test_days_requires_exact_dates_and_honors_window():
    result = plan([point("a", schedule="2026-01-01"), point("b", schedule="2026-01-01"), point("year")],
                  unit="days", window=7, earlier=0, later=8)
    assert result["unknown_timing_pairs"] == 2
    assert result["proposal"]["resolved_pairs"] == 1
    assert result["proposal"]["changes"][0]["after"] == "2026-01-09"
    assert all(c["record_id"] != "year" for c in result["proposal"]["changes"])


def test_full_dataset_improves_without_new_conflicts_or_exceeding_bounds():
    import json
    from pathlib import Path
    rows = json.loads((Path(__file__).resolve().parents[2] / "src/data/project-locations.json").read_text())
    prefs = dict(unit="years", window=0, earlier=1, later=1)
    result = plan(rows, **prefs)
    proposal = result["proposal"]
    assert proposal["resolved_pairs"] > 0
    assert all(-1 <= change["shift"] <= 1 for change in proposal["changes"])
    checked = plan(proposal["projects"], unit="years", window=0, earlier=0, later=0)
    assert checked["pairs"] == proposal["analysis"]["pairs"]
    assert len(checked["pairs"]) < len(result["pairs"])


def test_invalid_limits_rejected():
    for prefs in [dict(unit="years", window=11), dict(unit="days", earlier=-1), dict(unit="days", window=1.5)]:
        response = client.post("/projects/map-analysis", json={"projects": [point("a")], "preferences": prefs})
        assert response.status_code == 422
