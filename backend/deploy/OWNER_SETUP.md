# Cloud Run owner setup

Phase B begins only after the project owner has created a dedicated GCP project,
linked billing, and decided that this service may be deployed there. Do not use a
personal project as a temporary target.

## Owner console steps

In the Google Cloud console, the project owner opens **IAM & Admin** → **IAM**
→ **Grant access**, adds the deployer's Gmail address, and grants these six
project-level roles:

- Cloud Run Admin (`roles/run.admin`)
- Service Account User (`roles/iam.serviceAccountUser`)
- Cloud Build Editor (`roles/cloudbuild.builds.editor`)
- Artifact Registry Administrator (`roles/artifactregistry.admin`)
- Storage Admin (`roles/storage.admin`)
- Service Usage Admin (`roles/serviceusage.serviceUsageAdmin`)

The owner then sends the deployer the Project ID. No other console pages or
buttons are needed for routine setup.

The owner can instead run `setup` themselves. In that case the deployer needs
`roles/run.admin`, `roles/artifactregistry.writer`,
`roles/cloudbuild.builds.editor`, and `roles/iam.serviceAccountUser`.

Cloud Build also uses a build service account. The owner should identify it with
the explicitly scoped command below, then give that identity the permissions it
needs to build, push the Artifact Registry image, write build logs, and read the
uploaded source (commonly `roles/cloudbuild.builds.builder`, plus the applicable
Artifact Registry and source-bucket permissions):

```bash
gcloud --configuration=shellhacks --project=OWNER_PROJECT_ID builds get-default-service-account
```

If the human deployer uploads Cloud Build source or uses services on behalf of
the project, they may still need the corresponding Cloud Storage and
`serviceusage.services.use` permissions. Running `setup` as the owner does not
remove those requirements. Permission errors naming `actAs`, Artifact Registry,
Cloud Storage, Cloud Build, or Service Usage identify which of these grants is
missing.

No API key or service-account JSON key is required or should be exchanged. The
owner adds the deployer's Google account as an IAM principal; the deployer signs
in with that account through `gcloud auth login` in the dedicated `shellhacks`
configuration.

## First private deploy

After the roles are granted, the deployer runs these commands in Git Bash from
the repository root. They copy `cloudrun.env.example` to the local-only
`cloudrun.env`, set the owner-provided project ID, and leave
`CLOUDRUN_PUBLIC=0`:

```bash
cp backend/deploy/cloudrun.env.example backend/deploy/cloudrun.env
# Set GCP_PROJECT_ID=OWNER_PROJECT_ID in backend/deploy/cloudrun.env.
bash backend/deploy/cloudrun.sh --dry-run deploy
bash backend/deploy/cloudrun.sh login
bash backend/deploy/cloudrun.sh setup
bash backend/deploy/cloudrun.sh deploy
curl -i "$(bash backend/deploy/cloudrun.sh url)/health"
```

The dry run must show `--no-allow-unauthenticated`. The deploy command may take
about 10–20 minutes for the first build; it prints the service URL and a
token-authenticated `/health` JSON response containing `"status":"ok"` (and
other fields). The final curl has no token and should return `403`, confirming
that the service is private. To call `/similarity`
locally, optionally run:

```bash
gcloud --configuration=shellhacks --project=OWNER_PROJECT_ID run services proxy shellhacks-api --region=us-east1 --port=8081
```

Then POST to `http://localhost:8081/similarity` from another terminal.

Private access is the default. Public access requires explicit owner approval
and `CLOUDRUN_PUBLIC=1`; that setting makes the service reachable by anyone on
the internet.

## Agent limits and private user headers

The next human-run deploy uses `--max-instances=3`. Agent POST requests have
in-memory sliding 60-second limits of `AGENT_RATE_LIMIT_PER_CLIENT=45` per
client and `AGENT_RATE_LIMIT_TOTAL=25` total per instance. Across three instances,
the accepted fleet ceiling is `3 x 25 = 75` agent requests/minute; counters are
not shared and reset when instances restart. A value of `0` disables that limit,
and both `0` disables the middleware. Invalid negative or non-integer numeric
settings fail startup. Excess requests receive HTTP 429 and `Retry-After`
before an agent runs; ordinary API requests and agent-card GETs remain available.

`RATE_LIMIT_USER_HEADER` defaults to empty. Set it to `X-Authenticated-User`
**only while Cloud Run is private** (`--no-allow-unauthenticated`,
`CLOUDRUN_PUBLIC=0`), matching `HARNESS-NEXT-FRONTEND-001`. Cloud Run IAM admits
the Vercel server's service account; Next.js verifies Firebase users and forwards
their UID. That private boundary guarantees who supplied the trusted header.
Disable the header before any approved switch to public access. Missing or
malformed UIDs fall back to the client IP; accepted UIDs contain 1–128 ASCII
letters, digits, underscores, or hyphens. `RATE_LIMIT_TRUSTED_PROXY_HOPS=1`
defaults to the rightmost `X-Forwarded-For` entry. Setting it to `0`, or receiving
too few entries, uses the connection IP (`unknown` when absent).

The commented runtime values in `cloudrun.env.example` document this contract;
`cloudrun.sh` does not forward them from that file. A human must configure the
live runtime environment and run deployment for these settings to take effect.

## Troubleshooting

- `PERMISSION_DENIED` naming `run.services.create` or `setIamPolicy` means the
  deployer needs Cloud Run Admin. An `actAs` error means they need Service
  Account User; `storage.objects.create` means Storage Admin; and a
  `serviceusage` error means Service Usage Admin.
- If a build cannot push to Artifact Registry, the owner identifies the Cloud
  Build service account with the scoped `builds get-default-service-account`
  command above, then grants it Cloud Build Builder
  (`roles/cloudbuild.builds.builder`) and Artifact Registry Writer
  (`roles/artifactregistry.writer`) as applicable.
- If a revision does not start or the health check times out, inspect logs with:

  ```bash
  gcloud --configuration=shellhacks --project=OWNER_PROJECT_ID run services logs read shellhacks-api --region=us-east1
  ```

  The configured 2Gi memory is the baseline for model loading.
- A `403` from the token-authenticated `/health` request means the deployer may
  lack `run.invoker`, or the token account does not match the account in the
  `shellhacks` configuration.

With `min-instances=0`, idle cost is roughly $0; a build is roughly $0.15 and
image storage costs cents per month. Actual charges vary with usage.
