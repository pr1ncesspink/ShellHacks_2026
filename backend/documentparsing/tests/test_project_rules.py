import argparse
import csv
import json
import math
import os
import subprocess   
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import load_workbook

from backend.documentparsing.__main__ import run
from backend.documentparsing.collisions import collisions, write_csv
from backend.documentparsing.locations import Resolver, center, haversine
from backend.documentparsing.records import CEII, DESC, GPC, HEADERS, endpoint_names, scope_endpoints, read_seed


def project(pid="A", utility=DESC, **kwargs):
    return {"project_id": pid, "utility": utility, "state": "SC" if utility == DESC else "GA",
            "project_name": 'Line, "A"', "name_a": "Alpha", "name_b": "", "lat_a": 33., "lon_a": -81.,
            "lat_b": None, "lon_b": None, "confidence_a": 1., "confidence_b": 0.,
            "in_service_date": "2025-01-01", "location_evidence": {}, "warnings": [], "voltages_kv": [115.], **kwargs}


class CoreTests(unittest.TestCase):
    def test_cli_launch_modes(self):
        root = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as unrelated:
            entries = []
            for package in ("documentparsing", "pdfparsing"):
                script = root / "backend" / package / "__main__.py"
                entries.extend(((["-m", f"backend.{package}"], root),
                                ([str(script)], root), ([str(script)], unrelated)))
            for arguments, cwd in entries:
                with self.subTest(arguments=arguments, cwd=str(cwd)):
                    result = subprocess.run(
                        [sys.executable, "-B", *arguments, "run", "--help"],
                        cwd=cwd, capture_output=True, text=True, timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("--dominion-pdf", result.stdout)
                    self.assertIn("--starter-workbook", result.stdout)

    def test_center_both_and_single(self):
        self.assertEqual(center(project(lat_b=35., lon_b=-83., confidence_b=1.)), (34., -82.))
        self.assertEqual(center(project()), (33., -81.))
        self.assertEqual(center(project(lat_a=None, lon_a=None, confidence_a=0., lat_b=34., lon_b=-82., confidence_b=1.)), (34., -82.))

    def test_unlocated_and_low_confidence(self):
        self.assertEqual(center(project(confidence_a=.89)), (None, None))
        self.assertEqual(center(project(lat_a=float("nan"))), (None, None))

    def test_distance_known(self):
        self.assertAlmostEqual(haversine(0, 0, 0, 1), 69.0934, places=3)

    def test_threshold_unrounded(self):
        for distance, count in ((24.99, 1), (25., 0), (25.01, 0)):
            with self.subTest(distance=distance):
                self.assertEqual(len(collisions([project(), project("B", GPC)],
                                                distance_fn=lambda *_: distance)[0]), count)

    def test_geographic_boundary_real_coordinates(self):
        for distance, count in ((24.99, 1), (25.01, 0)):
            a = project(lat_a=0., lon_a=0.)
            b = project("B", GPC, lat_a=0., lon_a=math.degrees(distance / 3958.7613))
            self.assertEqual(len(collisions([a, b])[0]), count)

    def test_date_and_utility_rules(self):
        self.assertFalse(collisions([project(), project("B")])[0])
        rows, excluded = collisions([project(), project("B", GPC, in_service_date="")])
        self.assertFalse(rows)
        self.assertEqual(excluded[0]["reason"], "missing_or_multiphase_date")
        rows, _ = collisions([project(), project("B", GPC, in_service_date="2026-01-01")])
        self.assertEqual(rows[0]["time_gap (day)"], 365)

    def test_csv_exact_schema_and_quoting(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "collisions.csv"
            rows, _ = collisions([project(), project("B", GPC)])
            write_csv(f, HEADERS, rows)
            with f.open(newline="", encoding="utf-8") as stream:
                result = list(csv.reader(stream))
            self.assertEqual(result[0], HEADERS)
            self.assertTrue(all(len(row) == 9 for row in result))
            self.assertEqual(result[1][1], "0.00")
            self.assertEqual(result[1][5], 'Line, "A"')

    def test_empty_csv_keeps_header(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "x.csv"
            write_csv(f, HEADERS, [])
            self.assertEqual(f.read_text().strip(), ",".join(HEADERS))

    def test_ceii_variants(self):
        for text in ("CRITICAL ENERGY INFRASTRUCTURE INFORMATION", "confidential CEII", "CFR Sec. 388.113", "CEII - CONFIDENTIAL"):
            self.assertTrue(CEII.search(text))

    def test_endpoints(self):
        self.assertEqual(endpoint_names("Okatie–Bluffton 115kV: Rebuild")[:2], ("Okatie", "Bluffton"))
        self.assertEqual(endpoint_names("Square D to Hopkins 115 kV")[:2], ("Square D", "Hopkins"))
        self.assertEqual(endpoint_names("Harleyville Transmission Tap 115 kV")[:2], ("Harleyville", ""))
        self.assertEqual(endpoint_names("St George - Sumter 230 kV")[:2], ("St George", "Sumter"))
        self.assertTrue(endpoint_names("A - B - C 115 kV")[2])

    def test_sort_stability(self):
        p = [project("Z"), project("B", GPC), project("A")]
        self.assertEqual(collisions(p)[0], collisions(list(reversed(p)))[0])
        self.assertEqual([r["overlap_id"] for r in collisions(p)[0]], ["OVL_1", "OVL_2"])

    def test_description_and_subsection_endpoints(self):
        self.assertEqual(scope_endpoints("Cainhoy 115 kV Tap: Construct", "Construct a 115 kV tap from Cainhoy to Clements Ferry. Approximately 2.8 miles.")[:2], ("Cainhoy", "Clements Ferry"))
        self.assertEqual(scope_endpoints("Burton-St Helena 115kV: Rebuild Burton-Frogmore Transmission Section", "")[:2], ("Burton", "Frogmore"))
        self.assertEqual(scope_endpoints("Faber Place-Bayfront 115kV: Rebuild North Bridge Terrace to Bayfront Section", "")[:2], ("North Bridge Terrace", "Bayfront"))
        self.assertTrue(scope_endpoints("VCS1-Denny Terrace 230kV & VCS1-Pineland 230kV: Rebuild", "")[2])

    def test_cached_nominatim_fallback(self):
        import hashlib
        with tempfile.TemporaryDirectory() as d:
            key = hashlib.sha256(b"Alpha substation, SC, USA").hexdigest()[:20]
            (Path(d) / f"nominatim_{key}.json").write_text(json.dumps([{
                "osm_type": "node", "osm_id": 1, "lat": "33", "lon": "-81", "name": "Alpha", "class": "power", "type": "substation",
                "address": {"state": "South Carolina"}, "extratags": {"operator": "Dominion Energy", "voltage": "115000"}}]))
            resolver = Resolver(d, [])
            p = project(confidence_a=0., lat_a=None, lon_a=None)
            self.assertFalse(resolver.resolve([p]))
            self.assertEqual(center(p), (33., -81.))

    def test_network_failure_is_reviewable(self):
        with tempfile.TemporaryDirectory() as d, patch("urllib.request.urlopen", side_effect=OSError("unavailable")), patch("time.sleep"):
            resolver = Resolver(d, [], network=True, user_agent="test/1.0 (local test)")
            p = project(confidence_a=0., lat_a=None, lon_a=None)
            self.assertTrue(resolver.resolve([p]))
            self.assertTrue(resolver.stats["errors"])
            self.assertFalse(list(Path(d).glob("*.json")))

    def test_osm_match_and_cache(self):
        with tempfile.TemporaryDirectory() as d:
            snapshot = Path(d) / "overpass.json"
            snapshot.write_text(json.dumps({"elements": [{"type": "node", "id": 1, "lat": 33., "lon": -81.,
                "tags": {"name": "Alpha Substation", "operator": "Dominion Energy", "power": "substation", "voltage": "115000", "addr:state": "SC"}}]}))
            resolver = Resolver(d, [])
            p = project(confidence_a=0., lat_a=None, lon_a=None)
            self.assertFalse(resolver.resolve([p]))
            self.assertEqual(center(p), (33., -81.))
            self.assertEqual(resolver.stats["requests"], 0)
            self.assertEqual(resolver.stats["accepted_osm_matches"], 1)

    def test_ambiguous_osm_and_conflicting_seed(self):
        with tempfile.TemporaryDirectory() as d:
            elements = [{"type": "node", "id": i, "lat": 33. + i, "lon": -81.,
                "tags": {"name": "Alpha", "operator": "Dominion", "power": "substation"}} for i in (1, 2)]
            (Path(d) / "overpass.json").write_text(json.dumps({"elements": elements}))
            p = project(confidence_a=0., lat_a=None, lon_a=None)
            review = Resolver(d, []).resolve([p])
            self.assertEqual(review[0]["reason"], "ambiguous_candidates")
            self.assertEqual(center(p), (None, None))
            review = Resolver(d, [project("A"), project("B", lat_a=34.)]).resolve([p])
            self.assertEqual(review[0]["reason"], "conflicting_seed_coordinates")

    def test_town_result_cannot_be_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            resolver = Resolver(d, [])
            candidates = resolver.rank(project(), "Alpha", [{"id": "1", "lat": 33., "lon": -81., "tags": {"name": "Alpha", "place": "town"}}])
            self.assertLess(candidates[0]["score"], .90)

    def test_no_network_without_opt_in(self):
        with tempfile.TemporaryDirectory() as d, patch("urllib.request.urlopen", side_effect=AssertionError("unexpected network")):
            p = project(confidence_a=0., lat_a=None, lon_a=None)
            self.assertTrue(Resolver(d, []).resolve([p]))

    def test_explicit_snapshot_must_exist(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError, "snapshot.*exist"):
                Resolver(d, [], snapshot=Path(d) / "missing.json")

    def test_output_cannot_overwrite_snapshot(self):
        with tempfile.TemporaryDirectory() as d:
            snapshot = Path(d) / "pipeline_audit.json"
            original = b'{"elements": []}'
            snapshot.write_bytes(original)
            args = argparse.Namespace(output_dir=d, dominion_pdf="unused.pdf",
                                      starter_workbook="unused.xlsx", audit_pdf=[],
                                      osm_snapshot=str(snapshot))
            with self.assertRaisesRegex(ValueError, "aliases a source"):
                run(args)
            self.assertEqual(snapshot.read_bytes(), original)


@unittest.skipUnless(os.environ.get("GRIDLOCK_INPUT_DIR"), "Set GRIDLOCK_INPUT_DIR to run supplied-file integration checks")
class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs = Path(os.environ["GRIDLOCK_INPUT_DIR"])
        cls.workbook = cls.inputs / "Projects_Overlaps.xlsx"
        cls.seed = read_seed(cls.workbook)

    def test_six_sample_overlaps(self):
        actual, _ = collisions(self.seed)
        self.assertEqual(len(actual), 6)
        wb = load_workbook(self.workbook, read_only=True, data_only=True)
        try:
            expected = list(wb["overlaps"].values)[1:]
        finally:
            wb.close()
        by_pair = {(r["project_id_a"], r["project_id_b"]): r for r in actual}
        for r in expected:
            a = by_pair[(r[4], r[7])]
            self.assertLessEqual(abs(float(a["distance_mi"]) - r[1]), .02)
            self.assertEqual(a["time_gap (day)"], r[2])

    def test_repeatable_export(self):
        with tempfile.TemporaryDirectory() as d:
            args = argparse.Namespace(input=[str(self.workbook)], output_dir=d,
                                      cache_dir=str(Path(d) / "cache"), refresh_locations=False, user_agent="", osm_snapshot=None, audit_pdf=[])
            run(args)
            first = (Path(d) / "workbook.json").read_bytes()
            run(args)
            self.assertEqual(first, (Path(d) / "workbook.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
