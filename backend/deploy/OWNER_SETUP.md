# Cloud Run owner setup

Phase B begins only after the project owner has created a dedicated GCP project,
linked billing, and decided that this service may be deployed there. Do not use a
personal project as a temporary target.

Grant the deployer's own Google account these project-level roles before they run
the script:

- `roles/run.admin`
- `roles/artifactregistry.admin` (or `roles/artifactregistry.writer` after the
  repository exists)
- `roles/cloudbuild.builds.editor`
- `roles/serviceusage.serviceUsageAdmin` (only when the deployer runs `setup`)
- `roles/iam.serviceAccountUser` on the default Compute Engine service account
- `roles/storage.admin` for Cloud Build's source bucket

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

After the roles are granted, the deployer copies `cloudrun.env.example` to the
local-only `cloudrun.env`, sets `GCP_PROJECT_ID`, and runs:

Before the default `PUBLIC=1` deploy, confirm with the owner that public,
unauthenticated access is approved. Otherwise set `PUBLIC=0`.

```bash
bash backend/deploy/cloudrun.sh login
bash backend/deploy/cloudrun.sh setup
bash backend/deploy/cloudrun.sh deploy
```

`deploy` defaults to a public service for the frontend. If organization policy
blocks granting `allUsers` the invoker role, set `PUBLIC=0` and arrange an
authenticated caller before deploying. Missing billing, API permissions, or
`iam.serviceAccounts.actAs` permission will cause the corresponding setup or
deploy command to fail; the required roles above address those errors.
