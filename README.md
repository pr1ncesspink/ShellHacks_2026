# ShellHacks_2026

Document ingestion now uses Snowflake Cortex. See [setup, supported formats and JSON outputs](backend/documentparsing/README.md).

The canonical pipeline is `python -m backend.documentparsing`. It sends documents
through Snowflake `AI_PARSE_DOCUMENT` and `AI_EXTRACT`, validates project records,
and exports structured JSON for the existing overlap and similarity workflow.

The previous `python -m backend.pdfparsing` command and Python `run(args)` entry point
forward to that pipeline; the local PDF extraction implementation has been removed.
Use the dedicated `.venv-documents` environment as documented.
