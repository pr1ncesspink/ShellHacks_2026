# Dashboard map integration

The dashboard preserves `stage`'s Firebase sign-in and server-side backend authentication. It adds the local PDF review workspace, editable coordinates and dates, map replacement, and orange markers for different projects at most 25 miles apart. Restoring the CSV returns to the bundled reference locations.

PDF extraction and proximity calculations run in the browser. They do not upload documents to Snowflake or update the backend's project dataset. The separately labeled backend similarity results retain the existing `/overlaps/similarity` connection. A successful local map import does not demonstrate a successful backend upload.

## Run together

1. Install frontend packages with `npm ci`.
2. Configure Firebase in `.env.local` using `.env.example` and `docs/FIREBASE_VERCEL_SETUP.md`. Keep real credentials out of Git.
3. Follow the backend installation instructions in the root README and start `python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000` from the repository root.
4. Set `BACKEND_URL=http://127.0.0.1:8000` and `BACKEND_AUTH=none` in `.env.local`, then run `npm run dev`. Restart Next.js after changing environment variables.
5. Sign in with a verified Firebase account and open `/dashboard`. The map is usable independently; the backend section reports live results or a connection error explicitly.

The backend similarity endpoint also needs its configured overlap CSV and pinned embedding model. Snowflake uploads and Gemini diagnosis require their own setup described in the backend documentation. Local API tests substitute deterministic encoders and stores; they do not verify those cloud services.

MapLibre and PDF.js workers are copied to `public` automatically by `predev` and `prebuild`; generated worker files are ignored by Git. The basemap defaults to OpenFreeMap; `NEXT_PUBLIC_MAPTILER_KEY` is optional.

## Checks

Run `npm run lint`, `npm test`, and `npm run build`. Run backend tests with the development dependencies described in the README. Do not interpret a successful build as verification of Firebase, Cloud Run, Snowflake, Gemini, or live model access.
