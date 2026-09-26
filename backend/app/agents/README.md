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


