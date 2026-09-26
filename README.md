# GridLens

React + Vite frontend for the FastAPI project similarity service.

## Run locally

Install Python (the backend is tested here with Python 3.14) and Node.js/npm first. From the project root, set up the backend in PowerShell once:

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

In a second terminal:

```powershell
npm install
npm run dev
```

Open the localhost URL printed by Vite. Keep both terminals running. The Vite development server forwards `/api` requests to `http://127.0.0.1:8000`.

The first scores request downloads the pinned sentence-transformer model from Hugging Face and may take longer. Internet access and valid TLS certificates are required for that download. The model is then cached locally.

After a successful first request, you can optionally set `$env:HF_HUB_OFFLINE = '1'` before starting the backend to use the cached model without contacting Hugging Face. This only affects the similarity model; live Gemini agent calls still require network access and credentials. The Docker image downloads its model during the build, so its existing offline settings are intentional.

## Backend development and agents

For tests and development CLI tools, install the development requirements in the same activated environment. This file also includes the runtime dependencies:

```powershell
uv --no-cache --system-certs pip install --index-strategy unsafe-best-match -r backend/requirements-dev.txt
python -m pytest backend/tests -m "not model and not gemini"
```

Google ADK, Google GenAI, and A2A dependencies remain included in the runtime requirements. See [the agent setup instructions](backend/app/agents/README.md) for credentials and `adk web`. The FastAPI A2A endpoint is opt-in through `ENABLE_A2A=1`; the React dashboard uses the similarity endpoints directly.

## Features

- Live overlap scores from `GET /overlaps/similarity`
- Search by project name, utility, or overlap ID
- Minimum score filter and ascending/descending sort
- Pair comparison through `POST /similarity`
- Loading, empty, and retryable error states

Scores are cosine similarities in the range -1 to 1, not percentages or probabilities. The current backend implements semantic similarity; it does not expose a named entity recognition (NER) endpoint.

## Validation and deployment

```powershell
npm run lint
npm run build
```

For deployment, configure a same-origin `/api` reverse proxy to FastAPI, or set `VITE_API_BASE_URL` to your API URL before building. A separate API origin also requires appropriate CORS configuration on the backend. Vite's development proxy is not bundled into the production build.


Document ingestion now uses Snowflake Cortex. See [setup, supported formats and JSON outputs](backend/documentparsing/README.md).

The canonical pipeline is `python -m backend.documentparsing`. It sends documents
through Snowflake `AI_PARSE_DOCUMENT` and `AI_EXTRACT`, validates project records,
and exports structured JSON for the existing overlap and similarity workflow.

The previous `python -m backend.pdfparsing` command and Python `run(args)` entry point
forward to that pipeline; the local PDF extraction implementation has been removed.
Use the dedicated `.venv-documents` environment as documented.
