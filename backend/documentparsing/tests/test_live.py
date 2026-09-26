"""Explicitly opt-in provider smoke test. Requires a preconfigured stage and Cortex access."""

import os
from pathlib import Path
import tempfile
import unittest

from backend.documentparsing.config import SnowflakeSettings
from backend.documentparsing.extraction import extract_document
from backend.documentparsing.snowflake import SnowflakeClient


@unittest.skipUnless(os.getenv("RUN_SNOWFLAKE_LIVE") == "1", "Set RUN_SNOWFLAKE_LIVE=1 for billable Snowflake smoke test")
class LiveSnowflakeTests(unittest.TestCase):
    def test_document_to_validated_project(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "construction-smoke.txt"
            path.write_text(
                "Construction Project\nProject name: Alpha - Beta 115 kV Rebuild\n"
                "Project ID: SMOKE-001\nUtility: Example Utility\nState: SC\n"
                "Description: Rebuild the transmission line from Alpha to Beta.\n"
                "Planned in-service date: 2027-06-01\nTotal cost: USD 1,200,000\n",
                encoding="utf-8",
            )
            with SnowflakeClient(SnowflakeSettings.from_env()) as client:
                projects, report = extract_document(path, client)
            self.assertEqual(len(projects), 1)
            self.assertEqual(projects[0]["published_project_id"], "SMOKE-001")
            self.assertEqual(projects[0]["in_service_date"], "2027-06-01")
            self.assertEqual(projects[0]["total_cost"], 1_200_000)
            self.assertEqual(report["parser"], "snowflake_cortex")


if __name__ == "__main__":
    unittest.main()
