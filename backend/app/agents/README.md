# Overlap agent

The Google ADK agent in `overlap_agent` explains utility-project overlaps by
calling the backend's existing similarity and overlap services. It does not
store sessions or project data; ADK uses its in-memory session service.

For local development, copy `overlap_agent/.env.example` to
`overlap_agent/.env`, replace `GOOGLE_API_KEY`, and run:

```powershell
$env:PYTHONPATH='.'
adk web backend/app/agents
```

`ADK_MODEL` defaults to `gemini-flash-latest`. A local FastAPI server exposes
the agent's A2A endpoint only when `ENABLE_A2A=1`; `A2A_PUBLIC_URL` defaults to
`http://localhost:8000/a2a` and is published in its agent card.

`adk web` reads the agent-directory `.env` for local development. For FastAPI
or pytest, provide the same values through the shell environment; the backend
does not load or persist credentials itself.

## Collision diagnosis agent

`diagnosis_agent` is available only when `ENABLE_A2A=1`, at
`/a2a/diagnosis`. Its only skill, `diagnose_collision`, accepts server-built
`DiagnosisInput` JSON and rejects free text or mismatched rules before a model
call. `DIAGNOSIS_MODEL` defaults to `ADK_MODEL`; use
`DIAGNOSIS_TRANSPORT=inprocess` (default) or `a2a` with `DIAGNOSIS_A2A_URL`.

Collision data defaults to `COLLISION_SOURCE=csv`. To read an export, set
`COLLISION_SOURCE=snowflake_export` and `COLLISION_EXPORT_DIR` to a read-only
documentparsing output directory containing `overlaps.json` and `projects.json`.
`pipeline_audit.json` eligibility is informational. The diagnosis limits are
`DIAG_MAX_DISTANCE_MI=15`, `DIAG_MAX_GAP_DAYS=1095`, and
`DIAG_CO_SCHEDULE_MIN_SIM=0.45`; set `DIAG_MAX_GAP_DAYS=365` to match the
documentparsing eligibility threshold.

Extracted description and need fields are untrusted data and capped before they
are enclosed as JSON. Gemini output is not bit-deterministic; the hard-rule
guard and per-process cache provide the response guarantee. Render rationales
as text, never HTML.

