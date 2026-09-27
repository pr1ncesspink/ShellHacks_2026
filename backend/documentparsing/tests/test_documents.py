import argparse
import ast
from contextlib import contextmanager
import copy
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import httpx
from openpyxl import Workbook

from backend.documentparsing.config import SnowflakeSettings
from backend.documentparsing.extraction import (
    COLUMNS, DOCUMENT_TYPES, Project, chunks, deduplicate, extract_document,
    extraction_rows, normalize_project, parsed_pages, validate_document,
)
from backend.documentparsing.pipeline import OUTPUTS, build_workbook, run_pipeline
from backend.documentparsing.snowflake import SnowflakeClient, SnowflakeError
from backend.documentparsing.records import HEADERS
from backend.documentparsing.locations import Resolver


def row(**changes):
    values = {column: "" for column in COLUMNS}
    values.update(project_name="Alpha - Beta 115 kV Rebuild", published_project_id="P-1",
                  utility="Utility A", state="SC", in_service_date="2026-06-01",
                  description="Rebuild line and share crane mobilization.",
                  total_cost="$1,200.50", cost_unit="USD", voltages_kv="115;230", line_length_mi="2.5")
    values.update(changes)
    return values


def extracted(*rows):
    return {"error": None, "response": {"projects": {key: [r[key] for r in rows] for key in COLUMNS}}}


REFERENCE = {"document": "plan.pdf", "sha256": "a" * 64, "page": 1, "start": 0, "end": 100}


class FakeCortex:
    def __init__(self, rows=None, pages=None, failure=False):
        self.rows = [row()] if rows is None else rows
        self.pages = pages or ["Construction project Alpha - Beta 115 kV Rebuild"]
        self.failure = failure
        self.calls = []

    def upload(self, path, digest):
        assert path.read_bytes()
        assert digest == hashlib.sha256(path.read_bytes()).hexdigest()
        self.calls.append(("upload", path.name))
        return digest + "/" + path.name

    def parse(self, staged, *, page_split):
        self.calls.append(("parse", page_split))
        value = {"pages": [{"index": i, "content": text} for i, text in enumerate(self.pages)]}
        if not page_split:
            value = {"content": self.pages[0]}
        return {"value": value, "error": None, "metadata": {"pageCount": len(self.pages)}}

    def extract(self, text, schema):
        self.calls.append(("extract", text))
        if self.failure:
            raise SnowflakeError("simulated provider failure")
        return extracted(*self.rows)


def input_bytes(suffix):
    if suffix in (".docx", ".pptx"):
        stream = io.BytesIO()
        with ZipFile(stream, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("word/document.xml" if suffix == ".docx" else "ppt/presentation.xml", "<document/>")
        return stream.getvalue()
    return {".pdf": b"%PDF-1.7\nfixture", ".png": b"\x89PNG\r\n\x1a\nfixture",
            ".jpg": b"\xff\xd8\xfffixture", ".jpeg": b"\xff\xd8\xfffixture",
            ".tif": b"II\x2a\x00fixture", ".tiff": b"MM\x00\x2afixture",
            ".html": b"<html>Construction plan</html>", ".txt": b"Construction plan"}[suffix]


def seed_workbook(path):
    book = Workbook()
    projects = book.active
    projects.title = "projects"
    projects.append(["project_id", "utility", "state", "project_name", "name_a", "lat_a", "lon_a",
                     "name_b", "lat_b", "lon_b", "in_service_date"])
    projects.append(["A", "Utility A", "SC", "Alpha - Beta 115 kV Rebuild", "Alpha", 33.0, -81.0,
                     "Beta", None, None, "6/1/2026"])
    projects.append(["B", "Utility B", "GA", "Gamma - Delta 115 kV Rebuild", "Gamma", 33.001, -81.0,
                     "Delta", None, None, "6/1/2027"])
    overlaps = book.create_sheet("overlaps")
    overlaps.append(HEADERS)
    overlaps.append(["OVL_7", .07, 365, "Utility A", "A", "Alpha - Beta 115 kV Rebuild",
                     "Utility B", "B", "Gamma - Delta 115 kV Rebuild"])
    book.save(path)
    book.close()


class DocumentTests(unittest.TestCase):
    def test_formats_route_through_cortex_with_correct_page_options(self):
        with tempfile.TemporaryDirectory() as directory:
            for suffix in DOCUMENT_TYPES:
                with self.subTest(suffix=suffix):
                    path = Path(directory) / ("plan" + suffix)
                    path.write_bytes(input_bytes(suffix))
                    provider = FakeCortex()
                    projects, report = extract_document(path, provider)
                    self.assertEqual(len(projects), 1)
                    self.assertEqual(projects[0]["total_cost"], 1200.5)
                    self.assertEqual(provider.calls[1], ("parse", suffix in {".pdf", ".docx", ".pptx"}))
                    self.assertEqual(report["parser"], "snowflake_cortex")

    def test_bad_input_rejected_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            for suffix, data in ((".pdf", b"not a PDF"), (".docx", b"bad zip"), (".exe", b"MZ"), (".txt", b"\xff")):
                path = Path(directory) / ("bad" + suffix)
                path.write_bytes(data)
                provider = FakeCortex()
                with self.assertRaises(ValueError):
                    extract_document(path, provider)
                self.assertEqual(provider.calls, [])
            path.write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "nonempty"):
                validate_document(path)

    def test_parse_wrapper_errors_and_incomplete_pages(self):
        for result in ({"value": None, "error": "bad file"},
                       {"value": {"pages": [{"index": 1, "content": "missing page zero"}]}},
                       {"value": {"content": "not page split"}},
                       {"value": {"pages": [{"index": 0, "content": "a", "error": "partial"}]}},
                       {"value": {"pages": [{"index": 0, "content": "a"}]}, "metadata": {"pageCount": 2}}):
            with self.subTest(result=result), self.assertRaises(SnowflakeError):
                parsed_pages(result, True)
        self.assertEqual(parsed_pages({"value": '{"pages":[{"index":0,"content":"a"}]}'}, True), [(1, "a")])

    def test_misaligned_or_missing_columns_are_not_silently_zipped(self):
        payload = extracted(row())
        payload["response"]["projects"]["utility"] = []
        with self.assertRaisesRegex(SnowflakeError, "misaligned"):
            extraction_rows(payload)
        payload = extracted(row())
        del payload["response"]["projects"]["state"]
        with self.assertRaisesRegex(SnowflakeError, "incomplete"):
            extraction_rows(payload)
        self.assertEqual(extraction_rows(extracted()), [])
        with self.assertRaises(SnowflakeError):
            extraction_rows({"error": "failed", "response": None})

    def test_normalization_does_not_invent_dates_costs_or_locations(self):
        project = normalize_project(row(in_service_date="2026-01-01;2027-01-01", total_cost="$12,34",
                                        line_length_mi="NaN", utility="", state="", name_a="Alpha"), REFERENCE, "text")
        self.assertIsNone(project["in_service_date"])
        self.assertIsNone(project["total_cost"])
        self.assertIsNone(project["line_length_mi"])
        self.assertIsNone(project["lat_a"])
        self.assertEqual(project["confidence_a"], 0)
        self.assertIsNone(project["utility"])
        self.assertIn("multiple_phase_dates", project["warnings"])
        self.assertIn("invalid_total_cost", project["warnings"])
        project = normalize_project(row(total_cost="2.5", cost_unit="million USD"), REFERENCE, "text")
        self.assertEqual(project["total_cost"], 2_500_000)
        project = normalize_project(row(cost_unit="EUR"), REFERENCE, "text")
        self.assertIsNone(project["total_cost"])
        self.assertIn("unknown_unit_total_cost", project["warnings"])

    def test_duplicate_pages_merge_provenance_and_flag_conflicting_facts(self):
        a = normalize_project(row(), REFERENCE, "page 1")
        b = normalize_project(row(total_cost="1500", in_service_date="2027-01-01"), {**REFERENCE, "page": 2}, "page 2")
        merged = deduplicate([a, b])
        self.assertEqual(len(merged), 1)
        self.assertEqual(len(merged[0]["source_references"]), 2)
        self.assertIsNone(merged[0]["in_service_date"])
        self.assertIsNone(merged[0]["total_cost"])
        self.assertIn("conflicting_total_cost", merged[0]["warnings"])
        self.assertNotEqual(a["project_id"], normalize_project(row(utility="Utility B"), REFERENCE, "text")["project_id"])

    def test_cross_page_context_and_ceii_exclusions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.pdf"
            path.write_bytes(input_bytes(".pdf"))
            provider = FakeCortex(pages=["Project starts here", "Continued scope", "CONFIDENTIAL CEII secret"])
            projects, report = extract_document(path, provider)
            calls = [value for operation, value in provider.calls if operation == "extract"]
            self.assertIn("Continued scope", calls[0])
            self.assertFalse(any("secret" in text for text in calls))
            self.assertNotIn("secret", json.dumps(report))
            self.assertEqual(len(projects), 1)
            self.assertEqual(report["skipped_pages"], [{"page": 3, "reason": "ceii"}])

    def test_duplicate_ids_cannot_merge_different_utilities(self):
        a = normalize_project(row(), REFERENCE, "page 1")
        b = normalize_project(row(utility="Utility B"), REFERENCE, "page 2")
        b["project_id"] = a["project_id"]
        with self.assertRaisesRegex(ValueError, "conflicting utilities"):
            deduplicate([a, b])

    def test_invalid_duplicate_date_is_excluded_regardless_of_order(self):
        for reverse in (False, True):
            with self.subTest(reverse=reverse):
                a = normalize_project(row(), REFERENCE, "page 1")
                b = normalize_project(row(in_service_date="2026-01-01; unconfirmed"), REFERENCE, "page 2")
                merged = deduplicate([b, a] if reverse else [a, b])[0]
                self.assertIsNone(merged["in_service_date"])
                self.assertIn("missing_or_invalid_date", merged["warnings"])

    def test_nullable_project_context_is_compatible_with_location_ranking(self):
        project = normalize_project(row(description="", need=""), REFERENCE, "page 1")
        feature = {"id": "node/1", "lat": 33.0, "lon": -81.0,
                   "tags": {"name": "Alpha", "power": "substation"}}
        with tempfile.TemporaryDirectory() as directory:
            resolver = Resolver(directory, [], network=False)
            candidates = resolver.rank(project, "Alpha", [feature])
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["name_similarity"], 1.0)

    def test_chunks_cover_all_characters_without_unbounded_calls(self):
        source = ("A project description.\n" * 2000)
        parts = list(chunks(source))
        self.assertLess(len(parts), 10)
        self.assertEqual(parts[0][0], 0)
        self.assertEqual(parts[-1][1], len(source))
        for index, (start, end, text) in enumerate(parts):
            self.assertEqual(text, source[start:end])
            self.assertLessEqual(len(text), 10_000)
            if index:
                self.assertLess(start, parts[index - 1][1])


class TransportTests(unittest.TestCase):
    def settings(self, **changes):
        return SnowflakeSettings(**{**dict(account="org-account", user="user", token="secret-pat", warehouse="compute_wh"), **changes})

    def client(self, handler, **changes):
        http = httpx.Client(transport=httpx.MockTransport(handler))
        self.addCleanup(http.close)
        return SnowflakeClient(self.settings(**changes), http=http, sleep=lambda _: None)

    def test_auth_config_redaction_and_identifier_validation(self):
        self.assertNotIn("secret-pat", repr(self.settings()))
        with self.assertRaises(ValueError):
            self.settings(stage="a; DROP TABLE x")
        with self.assertRaises(ValueError):
            self.settings(account="https://elsewhere.example")
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, "SNOWFLAKE_ACCOUNT"):
            SnowflakeSettings.from_env()

    def test_polling_429_and_bound_values(self):
        requests = []
        def handler(request):
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(202, json={"statementHandle": "abc-123", "statementStatusUrl": "https://untrusted.example/steal"})
            if len(requests) == 2:
                return httpx.Response(429, json={"statementHandle": "abc-123"})
            return httpx.Response(200, json={"code": "090001", "data": [[json.dumps(extracted(row()))]]})
        result = self.client(handler).extract("Project's text; DROP TABLE x", {"schema": {}})
        self.assertEqual(result, extracted(row()))
        self.assertTrue(all(request.url.host == "org-account.snowflakecomputing.com" for request in requests))
        body = json.loads(requests[0].content)
        self.assertNotIn("Project's", body["statement"])
        self.assertEqual(body["bindings"]["1"]["value"], "Project's text; DROP TABLE x")
        self.assertEqual(requests[0].headers["X-Snowflake-Authorization-Token-Type"], "PROGRAMMATIC_ACCESS_TOKEN")

    def test_retry_preserves_request_id(self):
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(503 if len(requests) == 1 else 200, json={"data": [["{}"]]})
        self.client(handler).scalar_json("SELECT ?", ["a"])
        self.assertEqual(requests[0].url.params["requestId"], requests[1].url.params["requestId"])
        self.assertEqual(requests[1].url.params["retry"], "true")

    def test_timeout_cancels_statement(self):
        calls = []
        def handler(request):
            calls.append(request.url.path)
            return httpx.Response(200 if request.url.path.endswith("cancel") else 202,
                                  json={"statementHandle": "abc-123"})
        with patch("backend.documentparsing.snowflake.time.monotonic", side_effect=[0, 301]):
            with self.assertRaisesRegex(SnowflakeError, "timed out"):
                self.client(handler).execute("SELECT 1")
        self.assertEqual(calls[-1], "/api/v2/statements/abc-123/cancel")

    def test_parse_options_and_setup(self):
        bodies = []
        def handler(request):
            bodies.append(json.loads(request.content))
            return httpx.Response(200, json={"data": [["{}"]]})
        client = self.client(handler)
        client.parse("hash/source.png", page_split=False)
        self.assertNotIn("page_split", json.loads(bodies[-1]["bindings"]["3"]["value"]))
        client.parse("hash/source.pdf", page_split=True)
        self.assertTrue(json.loads(bodies[-1]["bindings"]["3"]["value"])["page_split"])
        client.setup()
        self.assertEqual(len(bodies), 5)
        self.assertTrue(all("IF NOT EXISTS" in body["statement"] for body in bodies[-3:]))
        self.assertTrue(all("database" not in body for body in bodies[-3:]))
        # The SQL API rejects session parameters such as AUTOCOMMIT with HTTP 400 (code 391917).
        self.assertTrue(all("parameters" not in body for body in bodies))

    def test_sql_failures_do_not_leak_response_details(self):
        def handler(_):
            return httpx.Response(422, json={"message": "secret-pat bad query", "code": "bad"})
        with self.assertRaises(SnowflakeError) as caught:
            self.client(handler).execute("SELECT 1")
        self.assertNotIn("secret-pat", str(caught.exception))
        for payload in ({"data": [[None]]}, {"data": [None]}, {"data": [["not JSON"]]}):
            with self.subTest(payload=payload), self.assertRaises(SnowflakeError):
                self.client(lambda _: httpx.Response(200, json=payload)).scalar_json("SELECT 1")

    def test_sql_api_error_includes_only_safe_status_identifiers(self):
        def handler(_):
            return httpx.Response(400, json={"code": "390189", "sqlState": "08004", "message": "secret-pat role X"})
        with self.assertRaises(SnowflakeError) as caught:
            self.client(handler).execute("SELECT 1")
        self.assertIn("400", str(caught.exception))
        self.assertIn("390189", str(caught.exception))
        self.assertIn("08004", str(caught.exception))
        self.assertNotIn("secret-pat", str(caught.exception))

    def test_sql_api_error_ignores_invalid_or_non_json_status_identifiers(self):
        for content in (b"not json", {"code": "a b;DROP", "sqlState": "wrong state"}):
            with self.subTest(content=content), self.assertRaisesRegex(SnowflakeError, r"HTTP 422$"):
                self.client(lambda _: httpx.Response(422, content=content) if isinstance(content, bytes)
                            else httpx.Response(422, json=content)).execute("SELECT 1")

    def test_statement_failure_includes_safe_sql_state_only(self):
        with self.assertRaisesRegex(SnowflakeError, r"code 000606, sqlState 42501") as caught:
            self.client(lambda _: httpx.Response(200, json={
                "code": "000606", "sqlState": "42501", "message": "secret-pat warehouse",
            })).execute("SELECT 1")
        self.assertNotIn("secret-pat", str(caught.exception))

    def test_upload_checks_transfer_status_and_preserves_file_extension(self):
        class Cursor:
            description = [("status",)]
            status = "UPLOADED"
            statement = ""
            def execute(self, statement):
                self.statement = statement
            def fetchall(self):
                return [(self.status,)]
        cursor = Cursor()
        @contextmanager
        def connect(**kwargs):
            self.assertEqual(kwargs["password"], "secret-pat")
            class Connection:
                @contextmanager
                def cursor(self):
                    yield cursor
            yield Connection()
        client = SnowflakeClient(self.settings(), connect=connect)
        self.addCleanup(client.http.close)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.pdf"
            path.write_bytes(input_bytes(".pdf"))
            self.assertEqual(client.upload(path, "a" * 64), "a" * 64 + "/source.pdf")
            self.assertIn("AUTO_COMPRESS=FALSE", cursor.statement)
            self.assertIn("OVERWRITE=FALSE", cursor.statement)
            cursor.status = "ERROR"
            with self.assertRaisesRegex(SnowflakeError, "confirm"):
                client.upload(path, "a" * 64)


class PipelineTests(unittest.TestCase):
    def test_legacy_python_entry_calls_snowflake_and_exports_json(self):
        from backend.documentparsing.__main__ import run
        from backend.pdfparsing.__main__ import run as legacy_run

        self.assertIs(legacy_run, run)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / "plan.pdf"
            pdf.write_bytes(input_bytes(".pdf"))
            provider = FakeCortex()
            args = argparse.Namespace(dominion_pdf=str(pdf), output_dir=str(root / "out"),
                                      cache_dir=str(root / "cache"))
            result = legacy_run(args, client=provider)
            self.assertEqual(result["project_count"], 1)
            self.assertEqual([call[0] for call in provider.calls], ["upload", "parse", "extract"])
            projects = json.loads((root / "out" / "projects.json").read_text())
            self.assertEqual(projects[0]["published_project_id"], "P-1")
            audit = json.loads((root / "out" / "extraction_audit.json").read_text())
            self.assertEqual(audit["sources"][0]["parser"], "snowflake_cortex")

    def test_canonical_cli_runs_without_legacy_modules_or_pdf_libraries(self):
        script = """
import sys
sys.modules['backend.pdfparsing'] = None
sys.modules['pdfplumber'] = None
sys.modules['pdfminer'] = None
from backend.documentparsing.__main__ import main
raise SystemExit(main(sys.argv[1:]))
"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workbook = root / "seed.xlsx"
            seed_workbook(workbook)
            result = subprocess.run([sys.executable, "-B", "-c", script, "run", "--input", str(workbook),
                                     "--output-dir", str(root / "out"), "--cache-dir", str(root / "cache")],
                                    cwd=Path(__file__).resolve().parents[3], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["projects"], 2)
            self.assertTrue(all((root / "out" / name).is_file() for name in OUTPUTS))

    def test_both_cli_names_export_identical_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workbook = root / "seed.xlsx"
            seed_workbook(workbook)
            outputs = []
            for package in ("documentparsing", "pdfparsing"):
                out = root / package
                result = subprocess.run([sys.executable, "-B", "-m", f"backend.{package}", "run",
                                         "--input", str(workbook), "--output-dir", str(out),
                                         "--cache-dir", str(root / "cache")],
                                        cwd=Path(__file__).resolve().parents[3], capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                outputs.append({name: (out / name).read_bytes() for name in OUTPUTS})
            self.assertEqual(outputs[0], outputs[1])

    def test_complete_snowflake_to_json_pipeline_and_failure_preserves_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workbook = root / "seed.xlsx"
            seed_workbook(workbook)
            pdf = root / "plan.pdf"
            pdf.write_bytes(input_bytes(".pdf"))
            out = root / "out"
            kwargs = dict(starter_workbook=workbook, cache_dir=root / "cache")
            result = run_pipeline([pdf], out, client=FakeCortex(), **kwargs)
            self.assertEqual(result["project_count"], 2)
            self.assertEqual(result["eligible_overlap_ids"], ["OVL_7"])
            self.assertTrue(all((out / filename).is_file() for filename in OUTPUTS))
            exported = json.loads((out / "workbook.json").read_text())
            self.assertEqual(exported["projects"][0]["project_id"], "A")
            self.assertEqual(exported["projects"][0]["overlap_count"], 1)
            self.assertEqual(list(exported["overlaps"][0]), HEADERS)
            self.assertIsInstance(exported["overlaps"][0]["distance_mi"], float)
            previous = {name: (out / name).read_bytes() for name in OUTPUTS}
            run_pipeline([pdf], out, client=FakeCortex(), **kwargs)
            self.assertEqual(previous, {name: (out / name).read_bytes() for name in OUTPUTS})
            with self.assertRaises(SnowflakeError):
                run_pipeline([pdf], out, client=FakeCortex(failure=True), **kwargs)
            self.assertEqual(previous, {name: (out / name).read_bytes() for name in OUTPUTS})

    def test_structured_inputs_work_without_credentials(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            root = Path(directory)
            workbook = root / "seed.xlsx"
            seed_workbook(workbook)
            result = run_pipeline([workbook], root / "xlsx", cache_dir=root / "cache")
            self.assertEqual(result["overlap_count"], 1)
            csv_path = root / "projects.csv"
            csv_path.write_text("project_id,project_name,utility,state,in_service_date,lat_a,lon_a\nA,Alpha,Utility A,SC,2026-01-01,33,-81\n")
            self.assertEqual(run_pipeline([csv_path], root / "csv", cache_dir=root / "cache")["project_count"], 1)

    def test_four_or_more_links_are_not_truncated(self):
        projects = [{"project_id": str(i)} for i in range(5)]
        overlaps = [{"project_id_a": "0", "project_id_b": str(i)} for i in range(1, 5)]
        book = build_workbook(projects, overlaps)
        self.assertEqual(book["projects"][0]["overlap_4"], "4")
        self.assertEqual(book["projects"][0]["overlap_count"], 4)

    def test_output_alias_is_rejected_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "workbook.json"
            source.write_text("source")
            provider = FakeCortex()
            with self.assertRaisesRegex(ValueError, "aliases"):
                run_pipeline([source], directory, client=provider)
            self.assertEqual(source.read_text(), "source")
            self.assertEqual(provider.calls, [])

    def test_cli_launch_modes_and_missing_credentials(self):
        root = Path(__file__).resolve().parents[3]
        result = subprocess.run([sys.executable, "-m", "backend.documentparsing", "capabilities"],
                                cwd=root, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["provider"], "snowflake_cortex")
        env = {key: value for key, value in os.environ.items() if not key.startswith("SNOWFLAKE_")}
        result = subprocess.run([sys.executable, "-m", "backend.documentparsing", "setup"],
                                cwd=root, capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Missing Snowflake settings", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_document_services_do_not_import_legacy_parser_or_api_runtimes(self):
        root = Path(__file__).resolve().parents[1]
        for file in root.glob("*.py"):
            tree = ast.parse(file.read_text())
            modules = []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    modules.extend(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom):
                    modules.append(node.module or "")
            forbidden = ("pdfplumber", "pdfminer", "backend.pdfparsing", "fastapi", "google.adk", "a2a", "backend.app.api")
            self.assertFalse(any(name.startswith(forbidden) for name in modules), file.name)


if __name__ == "__main__":
    unittest.main()
