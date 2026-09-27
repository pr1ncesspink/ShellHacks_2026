"""Distance correctness, source fidelity, persistence boundaries and upload/A2A wiring."""

import copy
import json
import math
from pathlib import Path
from unittest.mock import Mock

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.documentparsing.config import SnowflakeSettings
from backend.documentparsing.locations import haversine
from backend.documentparsing.snowflake import SnowflakeClient, SnowflakeError
from backend.projectdata.matching import EARTH_RADIUS_MILES, find_collisions
from backend.projectdata.pipeline import process_plan, score_collision_page
from backend.projectdata.records import ProjectPoint, parsed_points, reference_csv
from backend.projectdata.storage import DatabaseNames, ProjectStore
import backend.projectdata.__main__ as projectdata_cli


UPLOAD = "UPL_" + "a" * 32
ROOT = Path(__file__).resolve().parents[2]


def point(record_id, latitude=33.0, longitude=-81.0, **changes):
    values = dict(record_id=record_id, project_id=record_id, project_name="Transmission line rebuild",
                  latitude=latitude, longitude=longitude, semantic_text="115 kV line rebuild", owner="Same owner")
    return ProjectPoint(**{**values, **changes})


def test_real_reference_preserves_all_segments_years_and_sources():
    dataset_id, points = reference_csv(ROOT / "gridlock_real_projects_geospatial.csv")
    assert dataset_id.startswith("REF_")
    assert len(points) == 296 and len({p.project_id for p in points}) == 265
    assert len({p.record_id for p in points}) == 296
    assert all(p.latitude is not None and p.longitude is not None for p in points)
    assert all(p.in_service_date is None for p in points)
    assert all(p.source["raw"]["project_source_url"] for p in points)


def test_radius_inclusive_boundary_all_matches_same_owner_and_missing_dates():
    offset = math.degrees(25.0 / EARTH_RADIUS_MILES)
    refs = [point("same", 0, 0), point("boundary", offset, 0),
            point("outside", offset + .00001, 0), point("other-point", 0, .1, project_id="same")]
    result = find_collisions(UPLOAD, "REF", [point("user", 0, 0)], refs)
    assert {r["reference_project"]["record_id"] for r in result["collisions"]} == {"same", "boundary", "other-point"}
    assert all(r["time_gap_days"] is None for r in result["collisions"])
    assert result["owner_filter_applied"] is False
    assert result == find_collisions(UPLOAD, "REF", [point("user", 0, 0)], list(reversed(refs)))


def test_balltree_matches_bruteforce_haversine_including_antimeridian():
    rng = np.random.default_rng(71)
    refs = [point(str(i), *coords) for i, coords in enumerate(rng.uniform([32, -82], [34, -80], (100, 2)))]
    refs.extend([point("dateline", 0, -179.9), point("polar", 89.9, 100)])
    queries = [point("u1", 33, -81), point("u2", 0, 179.9), point("u3", 89.9, -100)]
    actual = find_collisions(UPLOAD, "REF", queries, refs)["collisions"]
    expected = {(u.record_id, r.record_id): haversine(u.latitude, u.longitude, r.latitude, r.longitude)
                for u in queries for r in refs
                if haversine(u.latitude, u.longitude, r.latitude, r.longitude) <= 25}
    assert {(r["uploaded_project"]["record_id"], r["reference_project"]["record_id"]) for r in actual} == set(expected)
    for row in actual:
        pair = row["uploaded_project"]["record_id"], row["reference_project"]["record_id"]
        assert row["distance_mi"] == pytest.approx(expected[pair], abs=1e-8)


def test_missing_locations_are_audited_not_silently_zeroed():
    missing = point("missing", None, None)
    result = find_collisions(UPLOAD, "REF", [missing], [point("r")])
    assert result["collisions"] == [] and result["excluded_upload_records"] == ["missing"]
    with pytest.raises(ValueError):
        point("invalid", float("nan"), -81)
    with pytest.raises(ValueError):
        point("invalid", 91, -81)


def test_csv_bad_coordinate_and_duplicate_record_fail(tmp_path):
    path = tmp_path / "source.csv"
    path.write_text("record_id,project_id,project_name,latitude,longitude\nr,p,name,NaN,-81\n")
    with pytest.raises(ValueError, match="row 2"):
        reference_csv(path)
    path.write_text("record_id,project_id,project_name,latitude,longitude\nr,p,name,33,-81\nr,p,name,33,-81\n")
    with pytest.raises(ValueError, match="Duplicate"):
        reference_csv(path)


def test_parsed_points_keeps_endpoints_but_does_not_guess_locations():
    project = dict(project_id="P", project_name="A - B", lat_a=33, lon_a=-81, confidence_a=1,
                   lat_b=34, lon_b=-81, confidence_b=.95)
    assert [p.record_id for p in parsed_points([project])] == ["P:a", "P:b"]
    assert parsed_points([dict(project_id="X", project_name="Unknown")])[0].latitude is None


class MemoryStore:
    client = None

    def __init__(self):
        self.saved = {}

    def reference(self):
        return "REF", [point("reference")]

    def save_upload(self, upload_id, points, result, audit):
        manifest = {**{k: v for k, v in result.items() if k != "collisions"},
                    "collision_count": len(result["collisions"]), "point_count": len(points)}
        self.saved[upload_id] = {**manifest, "collisions": result["collisions"]}
        return manifest

    def collisions(self, upload_id, **kwargs):
        return self.saved[upload_id]


def test_cortex_to_persistence_and_semantic_payload(tmp_path, fake_encoder):
    from backend.documentparsing.tests.test_documents import FakeCortex, row
    plan = tmp_path / "plan.pdf"
    plan.write_bytes(b"%PDF-1.7\nfixture")
    provider = FakeCortex(rows=[row(latitude="33.0", longitude="-81.0", in_service_date="")])
    store = MemoryStore()
    result = process_plan(plan, store, provider)
    assert result["collision_count"] == 1
    assert provider.calls[1][0] == "parse"
    assert result["upload_id"] in store.saved
    collision = result["collisions"][0]
    assert collision["uploaded_project"]["latitude"] == 33.0
    assert "crane mobilization" in collision["uploaded_project"]["semantic_text"]
    page = score_collision_page(result, fake_encoder)
    assert -1 <= page["collisions"][0]["semantic_similarity"] <= 1
    assert "crane mobilization" in fake_encoder.calls[0][0]


def test_pdf_upload_end_to_end_contracts(tmp_path, fake_encoder):
    from backend.documentparsing.extraction import Project
    from backend.documentparsing.tests.test_documents import FakeCortex, input_bytes, overlaps_pages, row

    fixture_pages = overlaps_pages()
    names = [
        "Hooks - Thurmond 115 kV Tie: Rebuild",
        "Jasper - Okatie 230 kV #2: Construct",
        "Stevens Creek - Hooks 115 kV / LR Plumb Branch 46 kV Rebuilds",
        "Okatie-Bluffton 115 kV: Rebuild",
        "EVANS PRIMARY - THURMOND DAM (USA) #5 115KV REBUILD",
        "SAV: MCINTOSH - PURRYSBURG 230KV REACTORS",
        "SAV: GOSHEN (SAV) - MCINTOSH 115KV LINE REBUILD",
    ]
    assert all(name in "\n".join(fixture_pages) for name in names)
    pages = fixture_pages.copy()
    coordinate_annotation = (
        "\n[Synthetic coordinate annotation for this test; absent from the source PDF]\n"
        f"project_name: {names[0]}\nlatitude: 33.0\nlongitude: -81.0"
    )
    pages[0] += coordinate_annotation
    rows = [row(project_name=name, published_project_id="",
                utility="Dominion Energy South Carolina" if index < 4 else "Georgia Power",
                state="", description="", line_length_mi="", in_service_date="",
                latitude="33.0" if index == 0 else "",
                longitude="-81.0" if index == 0 else "",
                voltages_kv="", total_cost="", cost_unit="")
            for index, name in enumerate(names)]

    class RecordingStore(MemoryStore):
        def __init__(self):
            super().__init__()
            self.save_calls = []

        def save_upload(self, upload_id, points, result, audit):
            self.save_calls.append((upload_id, points, result, audit))
            return super().save_upload(upload_id, points, result, audit)

    path = tmp_path / "plan.pdf"
    path.write_bytes(input_bytes(".pdf"))
    provider = FakeCortex(pages=pages, rows=rows)
    store = RecordingStore()

    result = process_plan(path, store, provider)

    assert [call[0] for call in provider.calls] == ["upload", "parse", "extract"]
    assert coordinate_annotation in provider.calls[2][1]
    assert len(store.save_calls) == 1
    upload_id, points, collision_result, audit = store.save_calls[0]
    assert upload_id == result["upload_id"]
    assert len(points) == 7
    assert len({point.project_id for point in points}) == 7
    normalized_names = names[:4] + [name.replace("KV", " kV") for name in names[4:]]
    assert {point.source["project_name"] for point in points} == set(normalized_names)
    assert all(Project.model_validate(point.source).project_id == point.project_id for point in points)
    assert all(point.source["source_references"][0]["page_end"] == 5 for point in points)
    assert audit["project_count"] == 7

    collision_keys = {
        "schema_version", "upload_id", "reference_dataset_id", "radius_miles",
        "distance_metric", "boundary", "schedule_filter_applied", "owner_filter_applied",
        "excluded_upload_records", "excluded_reference_records", "collisions",
    }
    assert set(collision_result) == collision_keys
    assert collision_keys <= set(result)
    assert result["schema_version"] == "collisions-v1"
    assert result["reference_dataset_id"] == "REF"
    assert result["radius_miles"] == 25.0
    assert result["distance_metric"] == "haversine"
    assert result["boundary"] == "inclusive"
    assert result["collision_count"] == 1
    assert result["point_count"] == 7
    unresolved = {point.record_id for point in points if point.latitude is None}
    assert len(unresolved) == 6
    assert all(record_id.endswith(":unresolved") for record_id in unresolved)
    assert set(result["excluded_upload_records"]) == unresolved
    assert len(result["collisions"]) == 1
    collision = result["collisions"][0]
    assert collision["overlap_id"].startswith("COL_")
    assert collision["distance_mi"] == pytest.approx(0.0)
    assert collision["time_gap_days"] is None
    assert collision["timing_basis"] == "unknown_exact_dates"
    assert collision["classification"] == "geographic_candidate"
    assert collision["uploaded_project"]["record_id"].endswith(":point")
    assert collision["reference_project"]["record_id"] == "reference"
    assert not unresolved.intersection({row["uploaded_project"]["record_id"]
                                        for row in result["collisions"]})

    stored_page = store.collisions(upload_id)
    assert stored_page["collisions"] == result["collisions"]
    scored_page = score_collision_page(stored_page, fake_encoder)
    assert len(scored_page["collisions"]) == len(stored_page["collisions"])
    assert all(-1 <= row["semantic_similarity"] <= 1 for row in scored_page["collisions"])
    assert [row["distance_mi"] for row in scored_page["collisions"]] == [
        row["distance_mi"] for row in stored_page["collisions"]]
    assert all("semantic_similarity" not in row for row in stored_page["collisions"])


def test_upload_json_endpoint_and_get_are_scoped(fake_encoder):
    from backend.app.api.routes.projects import get_project_store
    from backend.app.main import create_app
    store = MemoryStore()
    app = create_app()
    app.dependency_overrides[get_project_store] = lambda: store
    client = TestClient(app)
    data = json.dumps([dict(project_id="U", project_name="New line", latitude=33,
                            longitude=-81, source_document="plan.pdf")])
    response = client.post("/projects/uploads", files={"file": ("../plan.json", data, "application/json")})
    assert response.status_code == 201, response.text
    assert response.json()["collision_count"] == 1
    assert "collisions" not in response.json()
    matches = client.get(response.json()["collisions_url"])
    assert matches.status_code == 200 and len(matches.json()["collisions"]) == 1
    assert client.post("/projects/uploads", files={"file": ("x.exe", b"MZ")}).status_code == 422
    assert client.post("/projects/uploads", files={"file": ("x.pdf", b"")}).status_code == 422


def test_storage_binds_text_and_publishes_manifest_last():
    client = Mock()
    store = ProjectStore(client)
    p = point("r", project_name="O'Brien; DROP TABLE PROJECTS")
    store.load_reference("version", [p])
    sql, bindings = client.execute.call_args_list[0].args
    assert p.project_name not in sql and p.project_name in bindings[1]
    assert "GRIDLOCK_REFERENCE.APP.PROJECTS" in sql
    assert "DATASETS" in client.execute.call_args_list[-1].args[0]
    assert "ST_MAKEPOINT(s.P:longitude::DOUBLE, s.P:latitude::DOUBLE)" in sql
    client.reset_mock()
    client.execute.side_effect = SnowflakeError("failure")
    with pytest.raises(SnowflakeError):
        store.load_reference("version", [p])
    assert client.execute.call_count == 1
    with pytest.raises(ValueError):
        DatabaseNames(reference="unsafe; DROP DATABASE X")


def test_collision_storage_is_upload_scoped_with_pagination():
    client = Mock()
    client.query_rows.side_effect = [[[json.dumps({"collision_count": 3})]], [[json.dumps({"overlap_id": "C"})]]]
    page = ProjectStore(client).collisions(UPLOAD, limit=2)
    assert page["next_offset"] == 2
    assert all(call.args[1] == (UPLOAD,) for call in client.query_rows.call_args_list)
    assert all("WHERE" in call.args[0] for call in client.query_rows.call_args_list)
    with pytest.raises(ValueError):
        ProjectStore(client).collisions("../another-upload")


def test_sql_api_reads_all_result_partitions():
    requests = []
    def respond(request):
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(200, json={"statementHandle": "handle-123", "data": [["first"]],
                "resultSetMetaData": {"numRows": 2, "partitionInfo": [{}, {}]}})
        assert request.url.params["partition"] == "1"
        return httpx.Response(200, json={"data": [["second"]]})
    settings = SnowflakeSettings(account="test", user="test", token="secret", warehouse="WH")
    with httpx.Client(transport=httpx.MockTransport(respond)) as http:
        assert SnowflakeClient(settings, http=http).query_rows("SELECT X") == [["first"], ["second"]]


def test_check_cli_reports_connection_context_without_database_context(monkeypatch, capsys):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"data": [["account", "user", "role", "warehouse"]]})

    settings = SnowflakeSettings(account="test", user="user", token="secret", warehouse="WH")
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        monkeypatch.setattr(projectdata_cli.SnowflakeSettings, "from_env", lambda: settings)
        monkeypatch.setattr(projectdata_cli, "SnowflakeClient",
                            lambda configured: SnowflakeClient(configured, http=http, sleep=lambda _: None))
        assert projectdata_cli.main(["check"]) == 0
    assert json.loads(capsys.readouterr().out) == {
        "account": "account", "user": "user", "role": "role", "warehouse": "warehouse",
    }
    assert len(requests) == 1
    body = json.loads(requests[0].content)
    assert body["statement"] == "SELECT CURRENT_ACCOUNT(), CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE()"
    assert "database" not in body and "schema" not in body


def test_a2a_upload_tool_reads_new_dataset(monkeypatch, fake_encoder):
    from backend.app.agents.overlap_agent import tools
    from backend.projectdata import storage
    from backend.documentparsing import snowflake
    page = find_collisions(UPLOAD, "REF", [point("u")], [point("r")])
    fake_client = Mock()
    fake_client.__enter__ = Mock(return_value=fake_client)
    fake_client.__exit__ = Mock(return_value=False)
    monkeypatch.setattr(snowflake, "SnowflakeClient", lambda settings: fake_client)
    monkeypatch.setattr(SnowflakeSettings, "from_env", lambda: None)
    monkeypatch.setattr(storage.ProjectStore, "collisions", lambda self, upload_id, **kwargs: copy.deepcopy(page))
    monkeypatch.setattr(tools, "_encoder_provider", lambda: fake_encoder)
    result = tools.get_upload_collisions(UPLOAD)
    assert result["status"] == "success"
    assert "semantic_similarity" in result["collisions"][0]
