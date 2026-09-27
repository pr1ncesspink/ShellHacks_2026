"""Command-line overlap scoring."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from backend.app.core.config import get_settings
from backend.app.services.overlaps import load_overlaps, score_overlaps, write_scored_csv
from backend.app.services.similarity import get_encoder


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Score project-overlap names")
    subparsers = parser.add_subparsers(dest="command", required=True)
    score = subparsers.add_parser("score")
    settings = get_settings()
    score.add_argument("--input", type=Path, default=settings.data_path)
    score.add_argument("--output", type=Path, default=settings.output_path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        rows = score_overlaps(load_overlaps(args.input), get_encoder())
        write_scored_csv(rows, args.output)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print("overlap_id  name_similarity")
    for row in rows:
        print(f"{row.overlap_id:<10}  {row.name_similarity:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
