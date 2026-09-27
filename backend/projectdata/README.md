# Project database and 25-mile collision pipeline

This stage takes `gridlock_real_projects_geospatial.csv` into Snowflake and compares
each uploaded plan's located points with the reference points using scikit-learn
`BallTree(metric="haversine")`. The CSV has 296 point records belonging to 265 projects.
`record_id` identifies a point/segment; repeating `project_id` is intentional.

The pipeline creates two databases (names configurable):

- `GRIDLOCK_REFERENCE.APP.PROJECTS`: versioned reference points, including a GEOGRAPHY
  column and the normalized/original JSON in VARIANT. CSV SHA-256 identifies the snapshot.
- `GRIDLOCK_REFERENCE.APP.DATASETS`: published reference snapshots. Matching selects
  the newest successfully loaded snapshot and records its ID in each result.
- `GRIDLOCK_UPLOADS.APP.PROJECTS`: uploaded projects/points, separated by generated `UPL_…` IDs.
- `GRIDLOCK_UPLOADS.APP.COLLISIONS`: uploaded-point/reference-point pairs and their full metadata.
- `GRIDLOCK_UPLOADS.APP.DATASETS`: completed upload manifests, counts, exclusions, and parser audit.

Each database holds multiple datasets. An upload creates a dataset in the upload
database, not a new physical database for each file. This avoids repeated database
DDL while keeping uploads separately queryable. There are no destructive replacements.
A manifest is written after all points/pairs succeed; partial runs are not exposed by
the retrieval API. Reference loads are append-only snapshots with idempotent MERGE
operations. Run one reference seeding process at a time (Snowflake standard tables
do not enforce uniqueness constraints). Old snapshots and incomplete unpublished runs
are retained; no automatic retention/deletion is configured.

## Install and configure

From the repository root, use a dedicated environment:

```powershell
py -3.12 -m venv .venv-projectdata
.\.venv-projectdata\Scripts\python.exe -m pip install -r backend/requirements-projectdata.txt
```

Set `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_TOKEN` (programmatic access
token), and `SNOWFLAKE_WAREHOUSE` in the process environment. Optional settings are
documented in `../documentparsing/.env.example`; `.env` is not automatically loaded.
No secrets belong in source control. The configured role needs permission to create
the databases/schema/tables/stage during setup, read/write these tables, use the
warehouse, and run Cortex functions. Setup also provisions the existing parser's
configured database and document stage.

Optional data namespace settings:

```text
GRIDLOCK_REFERENCE_DATABASE=GRIDLOCK_REFERENCE
GRIDLOCK_UPLOAD_DATABASE=GRIDLOCK_UPLOADS
GRIDLOCK_DATA_SCHEMA=APP
```

### Local env file

Copy `backend/.env.snowflake.example` to `backend/.env.snowflake`, replace every
placeholder, then run commands through the loader. The local file is gitignored;
the Python CLI deliberately does not load it itself.

```powershell
scripts/snowflake.ps1 check
scripts/snowflake.ps1 setup
```

`check` is read-only. It prints the current account, user, role, and warehouse as
JSON without selecting a database or schema. `setup` creates the pipeline's
namespaces only when absent.

| Reported code | Likely configuration issue |
| --- | --- |
| 390303 or 390144 | The PAT is bad or expired, or its user is not covered by a network policy. |
| 390189 | The selected role is not granted to the token user. |
| 000606 | The warehouse is missing or the role lacks USAGE. |
| 003001 or 002003 | The role lacks CREATE DATABASE or an object privilege. |
| 390100 or HTTP 404 | `SNOWFLAKE_ACCOUNT` is incorrect. Use an account identifier, with `_` written as `-` in the host. |

Errors include only the HTTP status and safe Snowflake `code` and `sqlState`
identifiers. Response messages and token values are intentionally not shown.

The existing application requirements are hash-locked but their source lockfile is
absent. `requirements-projectdata.txt` is a bounded integration requirements file,
not a regenerated lock. The Dockerfile installs this overlay and runs `pip check`;
it may downgrade the legacy filelock pin to satisfy the Snowflake connector.

## Seed and run

```powershell
# Validates the real CSV without credentials or network access:
python -m backend.projectdata inspect

# Creates the required namespaces/stage and loads the reference snapshot:
python -m backend.projectdata seed --csv gridlock_real_projects_geospatial.csv

# Parse a PDF/Office/image/text plan through the existing Snowflake pipeline:
python -m backend.projectdata upload --input plan.pdf --output collisions.json --utility "Company" --state SC

# Or use the already parsed projects.json list directly:
python -m backend.projectdata upload --input backend/documentparsing/outputs/projects.json --output collisions.json

# Serve the existing API with the new upload routes:
python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

Use the dedicated environment's Python for these commands. `setup` is also available
without loading the CSV. For locally verified geocoding of named endpoints, the CLI
accepts `--osm-snapshot`. No network geocoding is enabled automatically.

## API and A2A contract

`POST /projects/uploads` accepts multipart `file`, plus optional `utility` and `state`.
It parses and stores the projects, computes/stores collisions, and returns `upload_id`,
counts, exclusions, reference snapshot ID, and `collisions_url`. Processing is synchronous;
long plans may require a longer HTTP/proxy timeout. For PDFs up to 50 MB, use the
asynchronous upload sessions described in "Large PDF uploads" below.

`GET /projects/uploads/{upload_id}/collisions?offset=0&limit=100` reads completed results.
The response contains `collisions` and `next_offset`; follow pages until it is null.
Each collision includes `overlap_id`, `distance_mi`, nullable `time_gap_days`,
`uploaded_project`, and `reference_project` (coordinates, owner, scope text, dates,
precision, and source data). It never substitutes zero days for an unknown schedule.

`POST /projects/uploads/{upload_id}/collisions/{overlap_id}/diagnosis` diagnoses one
stored collision with the guarded Gemini diagnosis flow. The request body is empty.
The response contains `upload_id`, `overlap_id`, `timing_basis`, `missing_dates`, and
the existing `DiagnosisEnvelope` under `diagnosis`. Repeating the same request uses
the diagnosis cache. Missing project owners are shown as `Unknown utility`.

| Diagnosis timing tier | Stored collision fields | Diagnosis gap and verdict rule |
| --- | --- | --- |
| `exact_dates` | Integer `time_gap_days` | Use the stored day gap; existing verdict rules apply. |
| `year_precision` | Null gap; both projects have an exact date or estimated year | Use `max(0, abs(year_a - year_b) - 1) * 365`; existing verdict rules apply. |
| `timing_unknown` | Null gap; either project has no date or year | Use zero as a rule input, list sides missing dates in `missing_dates`, and exclude `CO_SCHEDULE`. |

The reference CSV contains year-only dates. An upload with an exact date or estimated
year therefore normally uses `year_precision`; an upload with no date or year uses
`timing_unknown`. The stored `collisions-v1` payload is not changed.

With `ENABLE_A2A=1`, the existing overlap agent exposes `get_upload_collisions`.
Pass the returned upload ID in the agent request. The tool reads the new dataset and
adds `semantic_similarity` using the existing encoder on project name plus available
description, asset type, and scope. This does not change the legacy CSV name-only
scorer or its `name_similarity` contract. No automatic outbound agent messages are sent.

These routes inherit the application's current lack of user authentication. An upload
ID scopes queries but is not an authorization boundary. Keep the service local or behind
authenticated access until tenant identity and ownership checks are implemented.

## Large PDF and CSV uploads (signed GCS URL + Cloud Run Job)

The browser uploads the PDF or projects CSV directly to Cloud Storage with a V4 signed PUT URL, then
a Cloud Run Job runs the existing `process_plan`. Neither Vercel nor a Cloud Run request
body carries the file. All four routes require `X-Authenticated-User` (set by the
Next.js server). A session owned by another user returns 404. Session IDs must match
`^SES_[a-f0-9]{32}$`; any other ID returns 422 before any storage call.

| Route | Response |
| --- | --- |
| `POST /projects/upload-sessions` `{"size_bytes": n, "content_type"?: "application/pdf" or "text/csv"}` | 201 `{session_id, upload_url, method: "PUT", required_headers: {"Content-Type": <content_type>, "x-goog-content-length-range": "1,<MAX>"}, expires_at}`. `content_type` is optional and defaults to `application/pdf` (the pre-CSV request shape still works). Any other value, or `n` outside 1..the kind's cap (`UPLOAD_MAX_BYTES` for PDF, `UPLOAD_MAX_CSV_BYTES` for CSV), returns 422 before any storage call. |
| `POST /projects/upload-sessions/{id}/process` | 202 `{status: "queued"}` and exactly one job launch. A repeat returns 200 with the GET shape. A missing object returns 409. An object that fails its kind's checks (below) returns 422, records `invalid_pdf`/`invalid_csv`/`too_large`, and deletes the object. |
| `GET /projects/upload-sessions/{id}` | `{session_id, status, upload_id, error_code, updated_at}`, plus `kind: "csv"` for CSV sessions (omitted for PDF), plus `stage`, `stage_detail`, `stage_started_at` when `status` is `processing` or `failed` (see *Processing stages*). `status` is `created`, `queued`, `processing`, `succeeded`, `failed`, or `cancelled`. A `cancelled` view is exactly `{session_id, status: "cancelled", upload_id: null, error_code: null, updated_at}` (+ `kind` for CSV), with no stage keys. |
| `POST /projects/upload-sessions/{id}/cancel` | Always 200 with the GET shape. A `created`, `queued` or `processing` session becomes `cancelled` (terminal; `cancelled_at` is recorded in the document); a session that is already `succeeded`, `failed` or `cancelled` is returned unchanged (idempotent, never 409). Unknown or foreign sessions return 404, a malformed id 422 (before any storage call), a storage error 502. Not rate-limited. |

- The browser PUTs to `upload_url` with the `required_headers` exactly as given. The URL
  expires after 900 seconds. The object name is `uploads/<session_id>.pdf` or
  `uploads/<session_id>.csv`. User filenames are never used.
- The session `kind` (`pdf` or `csv`) is derived server-side from the allow-listed
  `content_type` and recorded in the session document; the signed URL is bound to that
  Content-Type, so a PUT with another type is rejected by Cloud Storage. Session
  documents written before CSV support have no `kind` and are processed as PDFs.
- Kind checks, applied by `/process` and again by the job before any Snowflake call:
  PDF must start with `%PDF-` and be at most `UPLOAD_MAX_BYTES`; CSV must be at most
  `UPLOAD_MAX_CSV_BYTES`, decode as strict UTF-8 (a BOM is allowed; NUL is not) and have
  a header row containing `project_id`, `project_name` and `utility` (the structured
  import contract of `structured_projects` in `backend/documentparsing/pipeline.py`).
  `/process` checks the first 64 KiB; the job decodes the whole downloaded file. If the
  stored object reports a different Content-Type than the session kind, it is rejected.
- The signature is created by IAM `signBlob` as the runtime service account
  (`google.auth.iam.Signer`). No key file is used.
- Session state is stored as `sessions/<id>.json`, written with `ifGenerationMatch`. Only
  the `created -> queued` transition launches a job.
- The job re-checks the object for its kind and then calls `process_plan` with a
  `plan.pdf` or `plan.csv` path (CSV goes through the structured import, no Cortex calls).
  After a successful run it summarizes the upload (stage `summarizing`, below). It writes
  `succeeded` with an `upload_id`, or `failed` with an `error_code`. It always deletes the
  object. It exits 0 when processing fails, so the job is not retried. `error_code` is one of
  `invalid_pdf`, `invalid_csv`, `too_large`, `snowflake_failed`, `reference_unavailable`,
  `timeout`, or `internal`.
  `reference_unavailable` means only that no reference dataset is loaded. Other `ValueError`s,
  including missing Snowflake settings, are `internal`. Exception messages are never returned.
- A session left in `queued` or `processing` for more than `UPLOAD_JOB_TIMEOUT_S + 300`
  seconds is reported as `failed` with `timeout`. The stored state is not changed. If the
  job finishes late, the same session can later show `succeeded`. The same can happen after
  any client-side timeout.
- If the job cannot be launched, the process call returns 502. The object delete and the
  `failed`/`internal` write are both best effort.
- Configuration that references the Firebase project `shellhacks26-c78d4` is refused.
  Missing configuration returns 503. The create and `/process` POST routes count against
  the agent rate limit; `/cancel` does not (it only stops work).

### Cancel

`SessionService.cancel` loads the session (owner-checked), returns it unchanged if it is
terminal, and otherwise writes `status: "cancelled"` + `cancelled_at` with
`ifGenerationMatch`. On a lost race it re-reads and tries again (at most 3 attempts; a
concurrent terminal job write that lands first wins and is returned unchanged; three lost
races return 502). After the cancel is recorded, two best-effort steps follow and their
errors are swallowed, so a cancel never fails because of them:

1. delete `uploads/<id>.<kind>`;
2. cancel the recorded Cloud Run execution via
   `POST https://run.googleapis.com/v2/projects/shellhacks-2026/locations/<region>/jobs/<job>/executions/<execution>:cancel`
   (`JobLauncher.cancel`; the name must match `^[a-z0-9-]{1,63}$`).

The job records its execution name (`CLOUD_RUN_EXECUTION`, validated, else `null`) as
`job_execution` in its `queued -> processing` write, so a session cancelled while still
`queued` has no execution to cancel; the job then finds it not queued and exits. The job also
stops cooperatively: it re-reads the session after validating (before download), before
opening the Snowflake store, and after `process_plan` (before summarizing), and a progress
write that loses a race re-reads the document and flags the cancel. A cancelled run is never
summarized, never writes its final status, and returns `cancelled`; `_write_final` refuses to
overwrite any document that is no longer `processing` (it logs `cancelled`).

- **Orphan rows:** if the cancel lands after `ProjectStore.save_upload`, the upload's
  Snowflake rows remain but are unreachable (a cancelled session never exposes its
  `upload_id`). They are not rolled back.
- **Summarize window:** the last checkpoint is before `summarize_upload`. A cancel that
  lands while the summary is being generated does not interrupt it (unless the execution
  cancel stops the container); the summary row may be written for the orphaned upload,
  but the session stays `cancelled`.

### Processing stages

While a session is `processing`, the job writes its current pipeline stage into the
session document. Stages, in order (`STAGES` in `upload_sessions.py`):

| Stage | When | PDF | CSV |
| --- | --- | --- | --- |
| `validating` | job re-checks size/content of the object | yes | yes |
| `staging` | document bytes uploaded to the Snowflake stage | yes | - |
| `parsing` | `AI_PARSE_DOCUMENT` | yes | - |
| `extracting` | one `AI_EXTRACT` call per unit; `stage_detail` = `{done, total}` | yes | - |
| `locating` | location resolver (always runs in `run_pipeline`) | yes | yes |
| `matching` | 25-mile BallTree matching | yes | yes |
| `saving` | `ProjectStore.save_upload` | yes | yes |
| `summarizing` | `summarize_upload` after a successful save | yes | yes |

A validated `projects.json` passed to `process_plan` reports only `matching` and `saving`.

Session document fields written by progress (the GET view exposes the first three only
for `processing` and `failed`; unknown stages and invalid details read back as `null`):

- `stage`: one of the stages above, or `null`.
- `stage_detail`: `{"done": int, "total": int}` with `0 <= done <= total <= 100000`, or `null`
  (only `extracting` sets it).
- `stage_started_at`: ISO-8601 UTC time the current stage began, or `null`.
- `stage_updated_at`: time of the last progress write (document only, not in the view).

Progress is best effort (`progress.ProgressReporter`): a stage change is written
immediately; `extracting` updates at most every 5 seconds, plus a forced write when
`done == total`. Every write uses `ifGenerationMatch` and tracks the returned generation;
the job's final status write builds on the latest one and keeps `stage` on failure, so
the UI can show where it stopped. A lost race or any storage error logs the exception
class only and disables progress for the rest of the run; it never fails the job.
Progress never writes over a terminal status and never changes `updated_at`, so the
stale-session timeout above is unchanged.

The callback is `progress(stage, done=None, total=None)`, a keyword-only argument of
`process_plan`, `run_pipeline` and `extract_document` that defaults to a no-op, so the
CLI, `/projects/uploads`, and A2A callers are unchanged.

### Summaries in the job

After `process_plan` succeeds the job reports `summarizing` and calls
`backend.projectdata.summary.summarize_upload(store, upload_id, owner, progress=...)`
(imported lazily). An import error or any exception is logged by class name only; the
session still ends `succeeded`. Without Vertex settings the summary falls back to `rule_only`.

`summarize_upload` returns `failed` (and stores nothing) only for an invalid or empty
owner/upload id, an unpublished upload (no manifest, or the manifest read fails), a
same-upload row owned by someone else, or a failed `SUMMARIES` write. Stored points whose
name cleans to empty are named by their `project_id` (or `record_id`); points and
collisions that still fail validation are skipped, not fatal. If reading points,
collisions or gap buckets fails, or the input cannot be built, it stores a minimal
deterministic `rule_only` summary from the manifest counts (`data_gaps.truncated = true`,
no key projects or hotspots), so `GET .../summary` never stays `pending` forever,
`GET .../map` works, and `POST .../summary/regenerate` can upgrade the row later.

`GET /projects/uploads/{id}/map` returns at most `MAX_MAP_POINTS = 2000` points (the same
cap as `MAX_MAP_POINTS` in `src/lib/upload-summary.ts`) plus `points_truncated: true`
when more are stored; the frontend parser ignores the extra key.

Known gap (deferred owner-scoping follow-up): while a published upload has no summary row
yet, `GET /projects/uploads/{id}/summary` returns `pending` to any authenticated user,
because manifests are ownerless and ownership exists only once the job writes
`SUMMARIES.OWNER_UID`. No upload data is returned in that state. The follow-up is to record
the owner when the upload session is created and return 404 to other callers.

### Environment

Service environment: `UPLOAD_BUCKET=shellhacks-2026-plan-uploads`,
`UPLOAD_JOB_NAME=shellhacks-upload-job`, `UPLOAD_MAX_BYTES=52428800` (default),
`UPLOAD_MAX_CSV_BYTES=10485760` (default), `UPLOAD_JOB_REGION=us-east1` (default),
`UPLOAD_JOB_TIMEOUT_S=3600` (default).

The job needs `UPLOAD_BUCKET`, `UPLOAD_MAX_BYTES`, `UPLOAD_MAX_CSV_BYTES` (when not the
default), the service's Snowflake/`GRIDLOCK_*` settings, and, for model-written summaries,
`GOOGLE_GENAI_USE_VERTEXAI=TRUE`, `GOOGLE_CLOUD_PROJECT=shellhacks-2026`,
`GOOGLE_CLOUD_LOCATION=global` and `DIAGNOSIS_MODEL=gemini-3.1-flash-lite`. Quote the
whole flag in PowerShell so the commas are not parsed as array separators:

```powershell
gcloud run jobs update shellhacks-upload-job --project=shellhacks-2026 --region=us-east1 `
  '--update-env-vars=GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=shellhacks-2026,GOOGLE_CLOUD_LOCATION=global,DIAGNOSIS_MODEL=gemini-3.1-flash-lite'
gcloud run jobs update shellhacks-upload-job --project=shellhacks-2026 --region=us-east1 `
  '--update-env-vars=UPLOAD_MAX_CSV_BYTES=10485760'
gcloud run services update shellhacks-api --project=shellhacks-2026 --region=us-east1 `
  '--update-env-vars=UPLOAD_MAX_CSV_BYTES=10485760'
```

The job's service account also needs permission to call Vertex AI in `shellhacks-2026`
(for example `roles/aiplatform.user`). Redeploy both the service and the job image after
changing this code.

**Deploy order** (summaries release; each step must finish before the next):

1. Create the `SUMMARIES` table in Snowflake (idempotent `CREATE TABLE IF NOT EXISTS`):
   `powershell -ExecutionPolicy Bypass -File scripts/snowflake.ps1 setup`
   (or `python -m backend.projectdata setup` with the Snowflake env already loaded).
2. Deploy the `shellhacks-api` service (new summary/map/regenerate routes).
3. Update the `shellhacks-upload-job` image to the same build and set the Vertex env,
   quoting the whole flag in PowerShell:
   `gcloud run jobs update shellhacks-upload-job --project=shellhacks-2026 --region=us-east1 --image=<same image as shellhacks-api> '--update-env-vars=GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=shellhacks-2026,GOOGLE_CLOUD_LOCATION=global,DIAGNOSIS_MODEL=gemini-3.1-flash-lite'`
4. Deploy the frontend last, so it never calls routes the backend does not serve yet.

**Deploy order** (cancel release; no env changes):

1. Confirm the runtime service account can cancel executions (the role bound on the job
   must include `run.executions.cancel`):
   `gcloud iam roles describe roles/run.jobsExecutorWithOverrides --format=json | findstr executions.cancel`
   If it is missing, grant `roles/run.developer` on the job only:
   `gcloud run jobs add-iam-policy-binding shellhacks-upload-job --project=shellhacks-2026 --region=us-east1 --member="serviceAccount:shellhacks-api-runtime@shellhacks-2026.iam.gserviceaccount.com" --role=roles/run.developer`
   (Without it, cancel still marks the session `cancelled` and deletes the object; the job
   then stops at its next checkpoint instead of immediately.)
2. Deploy the `shellhacks-api` service (new `/cancel` route).
3. Update the `shellhacks-upload-job` image to the same tag (records `job_execution`,
   cooperative cancel checks):
   `gcloud run jobs update shellhacks-upload-job --project=shellhacks-2026 --region=us-east1 --image=<same image as shellhacks-api>`
4. Deploy the frontend last.

Operational notes:

- Keep `UPLOAD_MAX_BYTES` at `52428800` (52_428_800) and `UPLOAD_MAX_CSV_BYTES` at
  `10485760`. The frontend has its own limits (`src/lib/upload-sessions.ts`,
  `src/lib/plan-upload.ts`). Change both sides together or not at all.
- Size-cap coupling: `UPLOAD_MAX_BYTES` / `UPLOAD_MAX_CSV_BYTES` (service and job) must
  not exceed the frontend `MAX_BYTES_BY_KIND` (`pdf` / `csv`) in `src/lib/upload-sessions.ts`.
  The frontend rejects a session whose `x-goog-content-length-range` maximum is above its
  own cap, so raising only the backend breaks every upload of that kind. Raise the frontend
  first (or together), and lower the backend first.
- Every upload-session route requires `X-Authenticated-User`. Local preview with
  `BACKEND_AUTH=none` and no signed-in user gets 401, so upload sessions cannot be used there.
- Status polling depends on the browser sending the `Sec-Fetch-Site` header. Older Safari
  versions that do not send it are not supported.

### Runbook (human-run, in `shellhacks-2026` only)

```powershell
gcloud services enable iamcredentials.googleapis.com run.googleapis.com --project=shellhacks-2026

gcloud storage buckets create gs://shellhacks-2026-plan-uploads --project=shellhacks-2026 `
  --location=us-east1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://shellhacks-2026-plan-uploads --cors-file=cors.json
gcloud storage buckets update gs://shellhacks-2026-plan-uploads --lifecycle-file=lifecycle.json

$SA = "shellhacks-api-runtime@shellhacks-2026.iam.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding gs://shellhacks-2026-plan-uploads `
  --member="serviceAccount:$SA" --role=roles/storage.objectAdmin
gcloud iam service-accounts add-iam-policy-binding $SA --project=shellhacks-2026 `
  --member="serviceAccount:$SA" --role=roles/iam.serviceAccountTokenCreator

# The image's default command is uvicorn. The job therefore sets --command=python. Each
# execution overrides args with ["-m","backend.projectdata.upload_job","--session",<id>].
gcloud run jobs create shellhacks-upload-job --project=shellhacks-2026 --region=us-east1 `
  --image=<same image as shellhacks-api> --service-account=$SA `
  --command=python --args=-m,backend.projectdata.upload_job `
  --max-retries=0 --task-timeout=3600 --memory=4Gi --cpu=2 `
  --set-secrets=SNOWFLAKE_TOKEN=snowflake-pat:latest `
  --set-env-vars=UPLOAD_BUCKET=shellhacks-2026-plan-uploads,UPLOAD_MAX_BYTES=52428800,<same SNOWFLAKE_*/GRIDLOCK_* values as the service>
gcloud run jobs add-iam-policy-binding shellhacks-upload-job --project=shellhacks-2026 `
  --region=us-east1 --member="serviceAccount:$SA" --role=roles/run.jobsExecutorWithOverrides

gcloud run services update shellhacks-api --project=shellhacks-2026 --region=us-east1 `
  --update-env-vars=UPLOAD_BUCKET=shellhacks-2026-plan-uploads,UPLOAD_JOB_NAME=shellhacks-upload-job,UPLOAD_MAX_BYTES=52428800
```

`cors.json` allows only the production site (`https://shell-hacks-2026.vercel.app`) and local
development. Preview deployments are excluded:

```json
[{"origin": ["https://shell-hacks-2026.vercel.app", "http://localhost:3000"],
  "method": ["PUT"],
  "responseHeader": ["Content-Type", "x-goog-content-length-range"],
  "maxAgeSeconds": 3600}]
```

`lifecycle.json` deletes leftover uploads after 1 day and session records after 7 days:

```json
{"rule": [
  {"action": {"type": "Delete"}, "condition": {"age": 1, "matchesPrefix": ["uploads/"]}},
  {"action": {"type": "Delete"}, "condition": {"age": 7, "matchesPrefix": ["sessions/"]}}
]}
```

## Matching rules and data limits

- Tree input and queries are `[latitude, longitude]` in radians. Radius is
  `25 / 3958.7613` radians, using the same Earth radius as the existing haversine helper.
  The boundary is inclusive, with a numerical tolerance of about 0.006 millimeters.
- A new tree is built once from the selected reference snapshot per upload; queries
  are batched. There is no all-pairs Python loop and no downloaded model/pickle.
- Every located uploaded point is compared only with reference points. All owners,
  statuses, and schedules are retained, including same-owner or completed projects.
  Downstream agents can filter them. Geographic candidates alone are not confirmed
  construction conflicts or estimates of savings.
- Each verified endpoint becomes its own point. Explicit decimal latitude/longitude
  printed in a document is now part of Cortex extraction. A derived project center is
  a fallback. Missing/unresolved coordinates are stored and listed as excluded.
- The CSV's estimated years remain year-only. Its coordinate method is preserved:
  many positions are single named endpoints or endpoint midpoints, not full routes.
  This detects point proximity, not intersections between complete line geometries.
- The named Hugging Face repository `manbearpig-mb/joblib-sklearn-balltree-oob`
  describes malicious serialized-tree proof-of-concept files. It is not used.
  Standard scikit-learn BallTree is constructed from validated numeric arrays.

## Verification

```powershell
python -m pip install pytest
python -m pytest backend/tests/test_projectdata.py backend/documentparsing/tests backend/pdfparsing/tests -q
```

Offline tests cover the real CSV, exact radius boundary, brute-force haversine
equivalence, antimeridian/polar points, repeated projects, unresolved coordinates,
Cortex-to-collision wiring, SQL binding/partitioning, upload pagination, and the A2A tool.
Offline tests do not establish that a live Snowflake account has been provisioned.
