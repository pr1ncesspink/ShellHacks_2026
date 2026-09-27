# CollideAverse

![CollideAverse: two galaxies colliding](docs/assets/collideaverse-banner.jpg)

CollideAverse checks a new construction project against known projects before it
breaks ground. Upload a plan (PDF or CSV) and CollideAverse extracts the projects,
places them on a map, finds every known project within 25 miles, and writes a
Gemini summary of what it found — so you can see what a new project would
collide with and plan around it.

## How it works

1. **Upload** on the Budget page (`/budget`): up to 5 files — PDF up to 50 MB or
   CSV up to 10 MB. The browser uploads straight to Cloud Storage with a
   short-lived signed URL; the file never passes through the web server.
2. **Process** in a Cloud Run Job, with live progress on the page:
   Checking → Preparing → Uploading → Queued → Staging → Parsing → Extracting →
   Locating → Matching → Saving → Summarizing → Done (CSV skips the document steps).
   - PDFs are parsed by Snowflake Cortex (`AI_PARSE_DOCUMENT`, `AI_EXTRACT`).
   - CSVs are imported directly and must include `project_id`, `project_name`
     and `utility` columns (`latitude`/`longitude` let projects appear on the map).
3. **Match**: a haversine BallTree finds every reference project within 25 miles
   of each located upload point. Results are stored in Snowflake.
4. **Summarize**: Gemini on Vertex AI (deployed as `gemini-3.1-flash-lite` via
   `DIAGNOSIS_MODEL`) writes a summary —
   key projects, collision hotspots, timing notes and data gaps. If Gemini is
   unavailable, a deterministic rules-based summary is shown instead.
5. **See it**: the map zooms to where the upload collides, draws each nearby pair,
   and lists them in a table. The summary sits beside it.

An upload can be **cancelled** until it finishes; this stops the browser upload,
skips the summary, and (best effort) stops the Cloud Run job and deletes the stored file.

Collisions are planning candidates based on point proximity, not proof of
physical overlap or a construction schedule.

## Architecture

| Part | Where | Notes |
| --- | --- | --- |
| Web app | Next.js 16 (App Router), TypeScript, Tailwind v4, shadcn/ui — Vercel | Firebase email/password sign-in with verified email |
| API | FastAPI on private Cloud Run (`shellhacks-api`, project `shellhacks-2026`) | Called only server-side by Next.js via Google OIDC |
| Processing | Cloud Run Job `shellhacks-upload-job` | Same image as the API |
| Uploads | Cloud Storage `gs://shellhacks-2026-plan-uploads` | Signed PUT URLs; files deleted after processing |
| Data | Snowflake (`GRIDLOCK_REFERENCE`, `GRIDLOCK_UPLOADS`) | Reference projects, uploads, collisions, summaries |
| AI | Snowflake Cortex (documents), Vertex AI Gemini (summaries), MiniLM (name similarity) | |

Firebase Auth lives in a separate project (`shellhacks26-c78d4`); never mix the two
project IDs.

Pages: `/` (sign-in), `/signup`, `/verify-email`, `/dashboard` (overview and
reference map), `/budget` (upload, pipeline, collision map and summary), `/profile`. Old `/summary` links redirect to `/budget`.

## Run locally

Node.js 24 LTS is recommended. From the repository root:

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open http://127.0.0.1:5173. Fill the Firebase values in `.env.local` from your
Firebase web app and enable Email/Password sign-in.

- **Design preview (no sign-in):** add `GRIDLENS_LOCAL_PREVIEW=1` to `.env.local`
  (development on loopback only).
- **Example data:** leave `BACKEND_URL` empty; the dashboard shows labeled example data.
- **Local backend:** set `BACKEND_URL=http://127.0.0.1:8000` and `BACKEND_AUTH=none`,
  then start the API (below).

### Backend

```powershell
python -m venv backend/.venv
.\backend\.venv\Scripts\Activate.ps1
python -m pip install uv
uv --no-cache --system-certs pip install --index-strategy unsafe-best-match -r backend/requirements.txt
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

Snowflake, upload and summary features need the extra dependencies and settings in
[backend/projectdata/README.md](backend/projectdata/README.md) (Snowflake env file,
`scripts/snowflake.ps1`, upload bucket and job, local Google credentials that
impersonate the runtime service account, and bucket CORS for your local origin).

## Tests

```powershell
npm test
npm run lint
npm run typecheck
npm run build
python -m pytest backend/tests backend/documentparsing/tests -m "not model and not gemini"
```

## Deploy

Deploy in this order so the website never calls a backend that lacks its routes:

1. Snowflake setup (creates tables): `powershell -ExecutionPolicy Bypass -File scripts/snowflake.ps1 setup`
2. Backend: `bash backend/deploy/cloudrun.sh --dry-run deploy`, then `bash backend/deploy/cloudrun.sh deploy`
3. Upload job image (the job also needs the Vertex/`DIAGNOSIS_MODEL` env vars set once; see
   [backend/projectdata/README.md](backend/projectdata/README.md)): `gcloud --configuration=shellhacks --project=shellhacks-2026 run jobs update shellhacks-upload-job --region=us-east1 --image=us-east1-docker.pkg.dev/shellhacks-2026/shellhacks/shellhacks-api:<TAG>`
4. Frontend: merge to `main`; Vercel deploys the production site.

Setup details: [Cloud Run runtime secrets and Gemini](backend/deploy/OWNER_SETUP.md),
[Firebase and Vercel](docs/FIREBASE_VERCEL_SETUP.md), and
[uploads, summaries and cancel](backend/projectdata/README.md). Always pass
`--configuration=shellhacks` to `gcloud`, and quote comma-separated flag values in
PowerShell (`'--update-env-vars=A=1,B=2'`).

## More documentation

- [Document ingestion (Snowflake Cortex)](backend/documentparsing/README.md)
- [Project data, uploads, collisions and summaries](backend/projectdata/README.md)
- [Agents (ADK, A2A)](backend/app/agents/README.md)
