"""Seed Snowflake and run the document-to-collision pipeline."""

import argparse
import json
from pathlib import Path

from backend.documentparsing.config import SnowflakeSettings
from backend.documentparsing.snowflake import SnowflakeClient, SnowflakeError
from .pipeline import process_plan, seed_reference
from .records import reference_csv
from .storage import ProjectStore


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("setup")
    sub.add_parser("check", help="Print the active Snowflake account, user, role, and warehouse")
    for name in ("inspect", "seed"):
        command = sub.add_parser(name)
        command.add_argument("--csv", type=Path, default=Path("gridlock_real_projects_geospatial.csv"))
    upload = sub.add_parser("upload")
    upload.add_argument("--input", type=Path, required=True)
    upload.add_argument("--output", type=Path, required=True, help="Collision JSON output file")
    upload.add_argument("--utility", default="")
    upload.add_argument("--state", default="")
    upload.add_argument("--osm-snapshot", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            dataset_id, points = reference_csv(args.csv)
            print(json.dumps({"dataset_id": dataset_id, "point_count": len(points),
                              "project_count": len({p.project_id for p in points}),
                              "located_point_count": sum(p.latitude is not None for p in points)}))
            return 0
        if args.command == "upload" and args.input.resolve() == args.output.resolve():
            raise ValueError("Collision output must not overwrite the input file")
        with SnowflakeClient(SnowflakeSettings.from_env()) as client:
            if args.command == "check":
                rows = client.query_rows(
                    "SELECT CURRENT_ACCOUNT(), CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE()",
                    context=False,
                )
                if len(rows) != 1 or not isinstance(rows[0], list) or len(rows[0]) != 4:
                    raise SnowflakeError("Snowflake connectivity check returned an unexpected result")
                account, user, role, warehouse = rows[0]
                result = {"account": account, "user": user, "role": role, "warehouse": warehouse}
            else:
                store = ProjectStore(client)
                if args.command in {"setup", "seed"}:
                    # Validate before creating any remote objects.
                    if args.command == "seed":
                        reference_csv(args.csv)
                    client.setup()
                    store.setup()
                    result = seed_reference(args.csv, store) if args.command == "seed" else {"status": "ready"}
                else:
                    result = process_plan(args.input, store, client, utility=args.utility, state=args.state,
                                          osm_snapshot=args.osm_snapshot)
                    args.output.parent.mkdir(parents=True, exist_ok=True)
                    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
            print(json.dumps({k: v for k, v in result.items() if k not in {"collisions", "extraction_audit"}}))
        return 0
    except (ValueError, OSError, SnowflakeError) as exc:
        parser.exit(2, f"Project dataset pipeline failed: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
