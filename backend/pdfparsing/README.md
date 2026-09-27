# Compatibility entry point

Document ingestion is owned by [backend.documentparsing](../documentparsing/README.md).
The local PDF extractor has been removed. This package forwards both the CLI and
the Python `run(args)` entry point to the same Snowflake pipeline.

Existing commands using `python -m backend.pdfparsing` or direct execution of
`backend/pdfparsing/__main__.py` continue to work. The `--dominion-pdf` and
`--starter-workbook` arguments remain supported. Document extraction requires
Snowflake credentials and produces the JSON artifacts described in the linked guide.

Use `.venv-documents` and `backend/requirements-documentparsing.txt` for installation.
`backend/requirements-pdfparsing.txt` is now an alias of those requirements.

For Python integrations, use `backend.documentparsing.pipeline.run_pipeline` or
`backend.documentparsing.extraction.extract_document`. The former `parsing`,
`locations`, and `collisions` modules under this package have been removed;
reusable rules now live in `documentparsing.records`, `documentparsing.locations`,
and `documentparsing.collisions`. Their tests are in `documentparsing/tests`.
