# GridLens

Next.js App Router + TypeScript + shadcn/ui frontend with a separate FastAPI backend hosted on Google Cloud Run.

The frontend supports verified Firebase accounts and can either show labeled
example data or connect server-side to the private Cloud Run backend. Example
mode does not require Python, Cloud Run credentials, or a running backend.

## Frontend

### Local design preview (no sign-in)

To edit the frontend without Firebase setup, add `GRIDLENS_LOCAL_PREVIEW=1`
to your ignored `.env.local`, then run `npm run dev` and open
`http://127.0.0.1:5173/dashboard`. This opt-in works only in development on a
loopback address. It shows a preview account and example similarity data,
while the map uses the bundled project dataset. To read real local similarity
results, set `BACKEND_URL=http://127.0.0.1:8002` and `BACKEND_AUTH=none`.
Preview mode only allows a loopback backend and sends no authenticated user
header. It does not connect to Cloud Run. Public hostnames and production
builds still require real sign-in. Remove the setting to test Firebase locally.

### Real sign-in

The Budget Summary schedule planner posts its displayed locations to `/api/map-analysis`, which forwards
them to the backend's `/projects/map-analysis` endpoint. This uses the existing
Haversine BallTree matcher across the full map dataset. Pairs must be within
25 miles and 365 days when both dates are exact; year-only records must share
the same published year. Unknown schedules are reported separately and never
highlighted as confirmed matches. These are planning candidates, not proof of
physical overlap. The legacy six-pair similarity dataset is not used by the map.

For local map development, run the backend from the repository root:

```powershell
backend\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8002
```

The matching endpoint needs the optional dependencies in
`backend/requirements-projectdata.txt`. It does not require Snowflake credentials
or an AI model; it analyzes the supplied coordinates and schedules without
persisting them. Reviewed PDF records go through the same matching endpoint.
PDF text extraction still happens locally in the browser.

The schedule planner on `/budget` offers Current plan and Proposed plan views in the same
map. Before generating a proposal, choose the overlap window and maximum moves
earlier/later (calendar years or exact-date days). Limits apply to every project;
all records of one project move together. Unknown schedules stay unchanged.
Calendar-year mode compares published years, while day mode requires full ISO
dates. The backend uses a bounded deterministic search to reduce matching pairs;
it is not an AI recommendation or proof of a feasible/optimal construction plan.
Original data is preserved, proposals remain in browser memory, and the review
list shows every proposed schedule change and remaining matches.

Use Node.js 24 LTS. From the repository root:

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Fill the Firebase values in `.env.local` from the Web app in your Firebase
project (it may be separate from the Cloud Run project), then enable
Email/Password in Firebase Authentication. Open
http://127.0.0.1:5173. Anyone can create an account at `/signup`; Firebase sends
an email verification link, and `/dashboard`, `/budget`, and `/profile` stay
server-protected until the address is verified. The profile displays the real
Firebase name and email while organization, role, and budget analysis stay
labeled as previews.

Keep `BACKEND_URL` empty to use the explicitly labeled example dashboard:

```dotenv
BACKEND_URL=
BACKEND_AUTH=none
```

With this setting empty, the dashboard makes no backend request. The displayed
project counts and similarity scores are illustrative. To use local uvicorn,
start the backend as described below and set:

```dotenv
BACKEND_URL=http://127.0.0.1:8000
BACKEND_AUTH=none
```

File selection accepts up to five PDF/PNG/JPG files, 20 MB each. Files stay in browser memory, are cleared when leaving the page, and are not uploaded or processed. The dashboard map shows a static reference dataset of project locations; budget analysis intentionally remains a placeholder.

For production:

```powershell
npm run build
npm start
```

The production server listens on http://127.0.0.1:4173. Deploy the frontend to
a host that supports a Next.js server; it is not a static export. `npm run
preview` is an alias for `npm start`. Private Cloud Run access uses Vercel OIDC,
Google Workload Identity Federation, and service-account impersonation without
a stored Google key. See [Firebase and Vercel setup](docs/FIREBASE_VERCEL_SETUP.md)
for the complete human-run configuration.

## Run the backend locally (optional)

This is a separate backend development workflow and is not required for the frontend preview. Install Python (the backend is tested here with Python 3.14) first. From the project root, set up the backend in PowerShell once:

```powershell
python -m venv backend/.venv
.\backend\.venv\Scripts\Activate.ps1
python -m ensurepip --upgrade
python -m pip install uv
uv --no-cache --system-certs pip install --index-strategy unsafe-best-match -r backend/requirements.txt
```

The requirements use both PyPI and the official PyTorch CPU index. The index flag allows uv to resolve pinned packages across those two indexes.

Start the backend in that terminal:

```powershell
.\backend\.venv\Scripts\Activate.ps1
Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue
Remove-Item Env:TRANSFORMERS_OFFLINE -ErrorAction SilentlyContinue
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

You can work on this API independently. Leave the frontend's `BACKEND_URL` empty to keep the website in preview mode.

The first scores request downloads the pinned sentence-transformer model from Hugging Face and may take longer. Internet access and valid TLS certificates are required for that download. The model is then cached locally.

After a successful first request, you can optionally set `$env:HF_HUB_OFFLINE = '1'` before starting the backend to use the cached model without contacting Hugging Face. This only affects the similarity model; live Gemini agent calls still require network access and credentials. The Docker image downloads its model during the build, so its existing offline settings are intentional.

## Backend development and agents

For tests and development CLI tools, install the development requirements in the same activated environment. This file also includes the runtime dependencies:

```powershell
uv --no-cache --system-certs pip install --index-strategy unsafe-best-match -r backend/requirements-dev.txt
python -m pytest backend/tests -m "not model and not gemini"
```

Google ADK, Google GenAI, and A2A dependencies remain included in the runtime requirements. See [the agent setup instructions](backend/app/agents/README.md) for credentials and `adk web`. The FastAPI A2A endpoint is opt-in through `ENABLE_A2A=1`. The frontend preview does not call these services.

Scores are cosine similarities in the range -1 to 1, not percentages or probabilities. The current backend implements semantic similarity; it does not expose a named entity recognition (NER) endpoint.

## Document ingestion (Snowflake)

Document ingestion uses Snowflake Cortex. See [setup, supported formats and JSON outputs](backend/documentparsing/README.md).

The canonical pipeline is `python -m backend.documentparsing`. It sends documents through Snowflake `AI_PARSE_DOCUMENT` and `AI_EXTRACT`, validates project records, and exports structured JSON for the existing overlap and similarity workflow.

The previous `python -m backend.pdfparsing` command and Python `run(args)` entry point forward to that pipeline; the local PDF extraction implementation has been removed. Use the dedicated `.venv-documents` environment described in the ingestion documentation.

The frontend file picker is not connected to this pipeline. Selecting a file does not send it to Snowflake or Cloud Run.

## Private backend integration

The dashboard server calls `GET /overlaps/similarity`. With
`BACKEND_AUTH=google-oidc`, it mints a Google ID token for the Cloud Run origin
through Vercel OIDC and Workload Identity Federation, then forwards the verified
Firebase uid in `X-Authenticated-User`. The browser receives neither the Cloud
Run URL nor a Google credential. Cloud Run remains private.

An unavailable backend or invalid configuration shows dashboard error mode
instead of substituting example rows. Use `BACKEND_AUTH=none` only for local
uvicorn. Production and preview setup, IAM bindings, environment variables, and
smoke tests are in [the setup runbook](docs/FIREBASE_VERCEL_SETUP.md).

## Validation and deployment

### Gemini planning responses

The budget page's Generate summary button sends the question and selected project to the server-only `/api/budget-response` route. Generate proposal first runs the existing schedule analysis, then asks Gemini to explain the computed counts, preferences, and up to 50 schedule changes. The planner still analyzes the full dataset; selecting a map point does not limit its scope. Gemini does not apply changes or produce verified cost estimates.

Set `GEMINI_API_KEY` in the ignored `.env.local` file (or the frontend hosting environment), then restart Next.js. `GOOGLE_API_KEY` is also supported. Optionally set `GEMINI_MODEL`; it defaults to `gemini-flash-latest`. Never prefix these secrets with `NEXT_PUBLIC_` or commit them. Requests use Google's [generateContent API](https://ai.google.dev/api/generate-content) directly, independently of the Python ADK diagnosis agents. Without a key, the response panel displays a configuration error rather than example AI output. Production requires sign-in; the existing development-only local preview is supported. Requests are limited to 25 per minute per server instance, with provider quotas applying separately.

```powershell
npm run lint
npm test
npm run build
npm run typecheck
```

The frontend migration leaves the Python backend and its requirements unchanged. Tests cover response validation, the backend time-gap alias, negative cosine scores, unique project counts, similarity-band boundaries, and empty results.

Design guidance: [Vercel React best practices](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices), [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines), and [shadcn/ui](https://ui.shadcn.com/docs/installation/next). UI components are generated from the official shadcn registry and customized to the GridLens palette.
