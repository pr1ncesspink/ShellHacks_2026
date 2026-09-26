# GridLens

Next.js App Router + TypeScript + shadcn/ui frontend with a separate FastAPI backend hosted on Google Cloud Run.

The frontend and backend are intentionally disconnected for now. The website is a design preview using labeled example data; you do not need Python, Cloud Run credentials, or a running backend to view it.

## Frontend

Use Node.js 24 LTS. From the repository root:

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open http://127.0.0.1:5173. Routes:

- `/` — two-step authentication design preview. No real login, verification, or access control.
- `/dashboard` — overlap statistics, a map placeholder, and local file selection.
- `/budget` — budget input/response placeholders and a map placeholder.
- `/signup` — account creation preview linked from the login page; no accounts are created.
- `/profile` — example account, organization, and verification details, linked from the header avatar on the dashboard and budget pages.

Keep `BACKEND_URL` empty in `.env.local` and in the frontend hosting environment:

```dotenv
BACKEND_URL=
```

With this setting empty, the dashboard uses example data and makes no requests to the backend. The displayed project counts and similarity scores are illustrative, not live project results.

File selection accepts up to five PDF/PNG/JPG files, 20 MB each. Files stay in browser memory, are cleared when leaving the page, and are not uploaded or processed. Authentication, maps, and budget analysis intentionally remain placeholders.

For production:

```powershell
npm run build
npm start
```

The production server listens on http://127.0.0.1:4173, matching the existing temporary tunnel. Deploy the frontend to a host that supports a Next.js server; it is not a static export. `npm run preview` is an alias for `npm start`.

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

The document-ingestion implementation on GitHub's `main` branch uses Snowflake Cortex. See [setup, supported formats and JSON outputs](https://github.com/pr1ncesspink/ShellHacks_2026/blob/main/backend/documentparsing/README.md). If your checkout predates those additions, integrate the latest `main` before running this pipeline.

The canonical pipeline is `python -m backend.documentparsing`. It sends documents through Snowflake `AI_PARSE_DOCUMENT` and `AI_EXTRACT`, validates project records, and exports structured JSON for the existing overlap and similarity workflow.

The previous `python -m backend.pdfparsing` command and Python `run(args)` entry point forward to that pipeline; the local PDF extraction implementation has been removed on `main`. Use the dedicated `.venv-documents` environment described in the ingestion documentation.

The frontend file picker is not connected to this pipeline. Selecting a file does not send it to Snowflake or Cloud Run.

## Future backend integration

A server-side adapter exists for `GET /overlaps/similarity`, but connecting it is deferred. When integration is requested, configure `BACKEND_URL` and the frontend server's access to the API. Current `main` deploys Cloud Run privately by default, so a URL alone is insufficient: authenticated requests and an authorized server identity will be needed. Cloud Run IAM authentication is not implemented in the frontend adapter yet.

Keep the backend private; connecting the frontend should not require making it public. An unavailable or invalid configured backend shows an error instead of silently substituting examples. Backend deployment and frontend hosting remain separate.

## Validation and deployment

```powershell
npm run lint
npm test
npm run build
npm run typecheck
```

The frontend migration leaves the Python backend and its requirements unchanged. Tests cover response validation, the backend time-gap alias, negative cosine scores, unique project counts, similarity-band boundaries, and empty results.

Design guidance: [Vercel React best practices](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices), [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines), and [shadcn/ui](https://ui.shadcn.com/docs/installation/next). UI components are generated from the official shadcn registry and customized to the GridLens palette.
