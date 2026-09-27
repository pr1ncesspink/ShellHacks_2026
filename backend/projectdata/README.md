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
long plans may require a longer HTTP/proxy timeout. There is no background job queue.

`GET /projects/uploads/{upload_id}/collisions?offset=0&limit=100` reads completed results.
The response contains `collisions` and `next_offset`; follow pages until it is null.
Each collision includes `overlap_id`, `distance_mi`, nullable `time_gap_days`,
`uploaded_project`, and `reference_project` (coordinates, owner, scope text, dates,
precision, and source data). It never substitutes zero days for an unknown schedule.

With `ENABLE_A2A=1`, the existing overlap agent exposes `get_upload_collisions`.
Pass the returned upload ID in the agent request. The tool reads the new dataset and
adds `semantic_similarity` using the existing encoder on project name plus available
description, asset type, and scope. This does not change the legacy CSV name-only
scorer or its `name_similarity` contract. No automatic outbound agent messages are sent.

These routes inherit the application's current lack of user authentication. An upload
ID scopes queries but is not an authorization boundary. Keep the service local or behind
authenticated access until tenant identity and ownership checks are implemented.

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
