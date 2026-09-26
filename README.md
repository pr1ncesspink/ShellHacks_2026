# GridLens

React + Vite frontend for the FastAPI project similarity service.

## Run locally

From the project root, start the backend in one PowerShell terminal:

```powershell
.\backend\.venv\Scripts\Activate.ps1
$env:HF_HUB_OFFLINE = '1'
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

In a second terminal:

```powershell
npm install
npm run dev
```

Open the localhost URL printed by Vite. Keep both terminals running. The Vite development server forwards `/api` requests to `http://127.0.0.1:8000`.

The initial scores request may take longer because the backend loads its sentence-transformer model on first use. Offline mode uses the model already cached on this computer and avoids local certificate errors when contacting Hugging Face. On a fresh machine, download the configured model first with offline mode unset.

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
