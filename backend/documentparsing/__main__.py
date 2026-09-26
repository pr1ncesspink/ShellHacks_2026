"""CLI entry point; all processing is in framework-independent services."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

if __name__ == "__main__" and not __package__:
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "backend.documentparsing"

from .config import SnowflakeSettings
from .extraction import DOCUMENT_TYPES, MAX_FILE_BYTES
from .snowflake import SnowflakeClient, SnowflakeError


def run(args, *, client=None):
    """Shared entry for parsed CLI arguments and the previous Python run(args) API."""
    from .pipeline import run_pipeline
    from .records import DESC

    inputs = list(getattr(args, "input", None) or [])
    utility, state = getattr(args, "utility", ""), getattr(args, "state", "")
    dominion_pdf = getattr(args, "dominion_pdf", None)
    if dominion_pdf:
        if inputs:
            raise ValueError("Use --input for multi-utility documents; --dominion-pdf supplies metadata for the whole run")
        inputs.append(dominion_pdf)
        utility, state = utility or DESC, state or "SC"
    return run_pipeline(inputs, getattr(args, "output_dir", "backend/documentparsing/outputs"),
                        starter_workbook=getattr(args, "starter_workbook", None),
                        utility=utility, state=state, client=client,
                        cache_dir=getattr(args, "cache_dir", ".cache/geocoding"),
                        osm_snapshot=getattr(args, "osm_snapshot", None),
                        refresh_locations=getattr(args, "refresh_locations", False),
                        user_agent=getattr(args, "user_agent", ""),
                        audit_inputs=getattr(args, "audit_pdf", ()))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Parse construction documents with Snowflake Cortex and export JSON")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("setup", help="Create the configured Snowflake database, schema, and document stage")
    sub.add_parser("capabilities", help="Print supported inputs and limits without connecting to Snowflake")
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--input", action="append", default=[], help="Document, reference XLSX, or projects CSV; repeat for multiple inputs")
    run_parser.add_argument("--dominion-pdf", help="Compatibility alias: adds one document and supplies Dominion/SC metadata")
    run_parser.add_argument("--starter-workbook", help="Optional workbook providing verified IDs and endpoint coordinates")
    run_parser.add_argument("--utility", default="", help="Fallback utility for documents that omit it")
    run_parser.add_argument("--state", default="", help="Fallback state for documents that omit it")
    run_parser.add_argument("--output-dir", default="backend/documentparsing/outputs")
    run_parser.add_argument("--cache-dir", default=".cache/geocoding")
    run_parser.add_argument("--osm-snapshot")
    run_parser.add_argument("--refresh-locations", action="store_true")
    run_parser.add_argument("--user-agent", default="")
    run_parser.add_argument("--audit-pdf", action="append", default=[], help="Parse and audit an additional PDF without extracting projects")
    args = parser.parse_args(argv)
    try:
        if args.command == "capabilities":
            print(json.dumps({"documents": DOCUMENT_TYPES, "structured_inputs": [".xlsx", ".csv"],
                              "max_document_bytes_exclusive": MAX_FILE_BYTES, "provider": "snowflake_cortex"}))
            return 0
        if args.command == "setup":
            with SnowflakeClient(SnowflakeSettings.from_env()) as client:
                client.setup()
            print("Snowflake document stage is ready.")
            return 0
        result = run(args)
        print(json.dumps({"projects": result["project_count"], "overlaps": result["overlap_count"],
                          "eligible_overlaps": len(result["eligible_overlap_ids"]),
                          "output_dir": str(Path(args.output_dir).resolve())}))
        return 0
    except (ValueError, OSError, KeyError, SnowflakeError) as exc:
        parser.exit(2, f"Document pipeline failed: {exc}\n")


if __name__ == "__main__":
    main()
