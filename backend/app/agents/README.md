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

## Agent request limits

FastAPI applies a sliding 60-second window before agent execution to
`POST /collisions/{overlap_id}/diagnosis`, `POST /a2a`, and all POST paths below
`/a2a/`. Non-POST requests (including OPTIONS and agent cards), health checks,
similarity, and collision listings do not consume a slot. Rejection is HTTP 429
with `{"detail":"Agent rate limit exceeded","scope":"client"}` (or
`"scope":"total"`) and a `Retry-After` header in whole seconds, rounded up.
Rejected requests consume neither budget. Admitted requests, including cached
diagnoses, consume a slot; one agent request may still make multiple model calls.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_RATE_LIMIT_PER_CLIENT` | `45` | Requests per client per instance per minute; `0` disables this limit. |
| `AGENT_RATE_LIMIT_TOTAL` | `25` | Total agent requests per instance per minute; `0` disables this limit. |
| `RATE_LIMIT_TRUSTED_PROXY_HOPS` | `1` | Select this entry from the right of `X-Forwarded-For`; `0` uses the connection IP. |
| `RATE_LIMIT_USER_HEADER` | empty | Trusted user-ID header name; disabled until explicitly configured. |

Negative or non-integer numeric settings fail startup. With both limits set to
`0`, no limiter middleware is installed. State is in memory and local to each
application instance; restarts clear it. Idle client buckets are pruned and at
most 10,000 clients are retained using LRU eviction. Eviction resets that
client's history but cannot bypass the total limit. The deployment setting is
`--max-instances=3`, giving the accepted fleet ceiling of `3 x 25 = 75` agent
requests/minute across three instances. This is not a distributed quota.

For the Next.js/Vercel contract in `HARNESS-NEXT-FRONTEND-001`, a human may set
`RATE_LIMIT_USER_HEADER=X-Authenticated-User` **only while Cloud Run is private**
(`--no-allow-unauthenticated`, `CLOUDRUN_PUBLIC=0`). Cloud Run IAM authenticates
the Vercel server's service account, and that server verifies Firebase Auth and
forwards `X-Authenticated-User: <firebase uid>`. Only this private boundary
guarantees the header came from the trusted server; the backend does not verify
Firebase tokens. A configured header accepts only 1–128 ASCII letters, digits,
underscores, or hyphens and keys the budget as `user:<uid>`. Missing, malformed,
oversized, or duplicate UID headers fall back to `ip:<ip>`. Unconfigured user
headers are ignored. IP fallback uses the configured entry from the right of
`X-Forwarded-For`, or the connection IP when there are too few entries or proxy
trust is disabled; absent connection information becomes `ip:unknown`.

Use `/a2a/` and `/a2a/diagnosis/` for JSON-RPC POSTs. Existing mount routing is
preserved; following the `/a2a` redirect sends a second POST and consumes
another slot. `adk web` is separate from this FastAPI gate.
Live environment changes and deployment remain human-run steps.
