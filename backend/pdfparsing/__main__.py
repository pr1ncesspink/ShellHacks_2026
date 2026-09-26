"""Compatibility entry point. All ingestion is implemented by documentparsing."""

from pathlib import Path

# Preserve IDE "Run Python File" from any working directory.
if __name__ == "__main__" and not __package__:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.documentparsing.__main__ import main, run


if __name__ == "__main__":
    raise SystemExit(main())
