# Firebase, Vercel, and private Cloud Run setup

This runbook configures GridLens email/password accounts and lets the Next.js
server call the private `shellhacks-api` Cloud Run service without storing a
Google service-account key. A human must run every console and CLI step below.
Replace every `<PLACEHOLDER>` first. Do not commit `.env.local` or credentials.

## Two projects, two sets of placeholders

GridLens touches two Google projects. They may be the same project or separate
ones; both layouts work.

| Placeholder | Meaning |
| --- | --- |
| `<FIREBASE_PROJECT_ID>` | The Firebase project that holds Authentication and the Web app. |
| `<CLOUD_RUN_PROJECT_ID>` | The Google Cloud project that runs `shellhacks-api`. |
| `<CLOUD_RUN_PROJECT_NUMBER>` | The numeric project number of that **Cloud Run** project (`gcloud projects describe <CLOUD_RUN_PROJECT_ID> --format="value(projectNumber)"`). Never the Firebase project's number. |

Firebase only verifies users. The service account, Workload Identity pool, and
Run Invoker binding all live in the Cloud Run project.

## 1. Set up Firebase Authentication

1. In Firebase Console, create a project, or choose **Add project** and select
   an existing Google Cloud project. This becomes `<FIREBASE_PROJECT_ID>`.
2. In **Project settings > General**, add a Web app.
3. Copy its `apiKey`, `authDomain`, `projectId`, and `appId`. These Firebase Web
   App values are public identifiers, not secrets.
4. Open **Build > Authentication** and choose **Get started** if it has never
   been enabled.
5. In **Authentication > Sign-in method**, enable **Email/Password**. Leave
   account creation enabled because GridLens sign-up is open.
6. In **Authentication > Settings**, enable email enumeration protection.
7. In **Authentication > Settings > Authorized domains**, check for and add
   both `localhost` and `127.0.0.1` if either is absent; local development uses
   `127.0.0.1`. Add the exact Vercel production domain. Firebase does not accept
   a wildcard preview domain here.
8. Optionally customize the verification and password-reset email templates.
   Firebase's default sender often lands in spam; a custom sending domain
   (**Templates > pencil > Customize domain**) improves delivery.

Firebase sends a verification **link**. GridLens does not implement a six-digit
email code, TOTP, SMS, or multi-factor enrollment in this release.

## 2. Configure local development

Create the ignored local file and replace the Firebase placeholders:

```powershell
Copy-Item .env.example .env.local
```

For example dashboard rows, leave `BACKEND_URL` empty and keep
`BACKEND_AUTH=none`. For a local backend, start uvicorn on port 8000 and use:

```dotenv
BACKEND_URL=http://127.0.0.1:8000
BACKEND_AUTH=none
FIREBASE_PROJECT_ID=<FIREBASE_PROJECT_ID>
NEXT_PUBLIC_FIREBASE_API_KEY=<FIREBASE_WEB_API_KEY>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<FIREBASE_PROJECT_ID>.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=<FIREBASE_PROJECT_ID>
NEXT_PUBLIC_FIREBASE_APP_ID=<FIREBASE_WEB_APP_ID>
```

Start the local backend with the same rate-limit header name used in Cloud Run:

```powershell
$env:RATE_LIMIT_USER_HEADER = "X-Authenticated-User"
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

The `NEXT_PUBLIC_FIREBASE_*` values are embedded at build time. Restart the dev
server after changing them. Vercel must rebuild and redeploy after these public
values change.

## 3. Create the Cloud Run invoker service account

Run these commands in a human-controlled terminal after replacing the
placeholders. Every command targets the **Cloud Run** project:

```powershell
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com run.googleapis.com --project="<CLOUD_RUN_PROJECT_ID>"

gcloud iam service-accounts create vercel-frontend --project="<CLOUD_RUN_PROJECT_ID>" --display-name="Vercel GridLens frontend"

gcloud run services add-iam-policy-binding shellhacks-api --project="<CLOUD_RUN_PROJECT_ID>" --region="us-east1" --member="serviceAccount:vercel-frontend@<CLOUD_RUN_PROJECT_ID>.iam.gserviceaccount.com" --role="roles/run.invoker"
```

Keep Cloud Run private. Review its IAM policy and ensure this service account is
the only non-owner principal with `roles/run.invoker` that the deployment needs.

## 4. Create Workload Identity Federation for Vercel

Create the pool and Vercel OIDC provider in the **Cloud Run** project. The
attribute condition is essential: it admits only **production** deployments of
the intended Vercel project, so preview branches cannot reach Cloud Run.

```powershell
gcloud iam workload-identity-pools create "vercel" --project="<CLOUD_RUN_PROJECT_ID>" --location="global" --display-name="Vercel deployments"

gcloud iam workload-identity-pools providers create-oidc "<VERCEL_PROVIDER_ID>" --project="<CLOUD_RUN_PROJECT_ID>" --location="global" --workload-identity-pool="vercel" --display-name="GridLens Vercel project" --issuer-uri="https://oidc.vercel.com/<TEAM_SLUG>" --allowed-audiences="https://vercel.com/<TEAM_SLUG>" --attribute-mapping="google.subject=assertion.sub,attribute.vercel_project_id=assertion.project_id,attribute.environment=assertion.environment" --attribute-condition="assertion.project_id == '<VERCEL_PROJECT_ID>' && assertion.environment == 'production'"
```

Grant the provider permission to impersonate only `vercel-frontend`. Use the
Cloud Run project's **number** in the principal set:

```powershell
$principalSet = "principalSet://iam.googleapis.com/projects/<CLOUD_RUN_PROJECT_NUMBER>/locations/global/workloadIdentityPools/vercel/attribute.vercel_project_id/<VERCEL_PROJECT_ID>"

gcloud iam service-accounts add-iam-policy-binding "vercel-frontend@<CLOUD_RUN_PROJECT_ID>.iam.gserviceaccount.com" --project="<CLOUD_RUN_PROJECT_ID>" --member="$principalSet" --role="roles/iam.workloadIdentityUser"
```

Only `roles/iam.workloadIdentityUser` is granted; do not grant
`roles/iam.serviceAccountTokenCreator`, which also allows signing arbitrary
blobs and JWTs. The issuer and audience must use the Vercel team slug exactly.
The condition must use the Vercel project ID, not its display name. No JSON key
is created or uploaded.

## 5. Configure the Vercel project

1. Import this repository with the **Next.js** preset and repository root as the
   project root.
2. Enable Vercel OIDC federation for the team issuer.
3. Add these variables to **Production** only. Use the HTTPS Cloud Run service
   origin for `BACKEND_URL`.

```dotenv
BACKEND_URL=https://<CLOUD_RUN_SERVICE_HOST>
BACKEND_AUTH=google-oidc
FIREBASE_PROJECT_ID=<FIREBASE_PROJECT_ID>
NEXT_PUBLIC_FIREBASE_API_KEY=<FIREBASE_WEB_API_KEY>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<FIREBASE_PROJECT_ID>.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=<FIREBASE_PROJECT_ID>
NEXT_PUBLIC_FIREBASE_APP_ID=<FIREBASE_WEB_APP_ID>
GCP_PROJECT_NUMBER=<CLOUD_RUN_PROJECT_NUMBER>
GCP_WORKLOAD_IDENTITY_POOL_ID=vercel
GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID=<VERCEL_PROVIDER_ID>
GCP_SERVICE_ACCOUNT_EMAIL=vercel-frontend@<CLOUD_RUN_PROJECT_ID>.iam.gserviceaccount.com
```

4. Add these variables to **Preview**. Previews use example data and never call
   Cloud Run (the provider condition would reject them anyway). To sign in on a
   preview, add that exact preview domain to Firebase Authorized domains.

```dotenv
BACKEND_URL=
BACKEND_AUTH=none
FIREBASE_PROJECT_ID=<FIREBASE_PROJECT_ID>
NEXT_PUBLIC_FIREBASE_API_KEY=<FIREBASE_WEB_API_KEY>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<FIREBASE_PROJECT_ID>.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=<FIREBASE_PROJECT_ID>
NEXT_PUBLIC_FIREBASE_APP_ID=<FIREBASE_WEB_APP_ID>
```

Never rename `BACKEND_URL` to a `NEXT_PUBLIC_*` variable. It and all Google WIF
settings stay server-only. Trigger a new deployment after changing any
`NEXT_PUBLIC_FIREBASE_*` value because those identifiers are compiled into the
browser bundle.

## 6. Enable per-user rate-limit identity on Cloud Run

After the Vercel service account is the only required non-owner invoker, update
the existing service environment and keep unauthenticated access disabled:

```powershell
gcloud run services update shellhacks-api --project="<CLOUD_RUN_PROJECT_ID>" --region="us-east1" --update-env-vars="RATE_LIMIT_USER_HEADER=X-Authenticated-User"
```

The Next.js server derives `X-Authenticated-User` only from a verified Firebase
token. The browser cannot choose this uid. Cloud Run also requires the Google ID
token whose audience is the `BACKEND_URL` origin.

## 7. Human smoke test

Use a real Firebase project and a disposable test address:

1. Visit `/signup`, create an account, and confirm the **Check your inbox** view
   appears. Confirm Resend counts down for 60 seconds. Check the spam folder if
   the email does not arrive.
2. Visit `/dashboard` before using the email link. It must return to
   `/verify-email` and show no workspace content.
3. Use the verification link, return to GridLens, and choose **I’ve verified**.
   The dashboard should open.
4. Choose **Sign out**, then visit `/dashboard`. It should redirect to
   `/?next=/dashboard`.
5. Tamper with the `__session` cookie in browser developer tools. A protected
   page must redirect without rendering workspace data.
6. Run local uvicorn with `BACKEND_AUTH=none` and
   `RATE_LIMIT_USER_HEADER=X-Authenticated-User`. The dashboard should say
   **Live project data**. `GET /overlaps/similarity` is not a rate-limited
   route, so it does not create a `user:<uid>` limiter entry.
7. Deploy to Production with `BACKEND_AUTH=google-oidc`. Confirm Cloud Run
   remains private and the dashboard loads live rows through the Vercel server
   identity.

Real uploads are not part of this setup. The current picker keeps files in
browser memory; signed Cloud Storage uploads come in a later step.

## Accepted risks

- The session cookie holds the Firebase ID token and stays valid for at most one
  hour after sign-out, password change, or account disable. Revocation checks
  need Firebase Admin credentials, which this deployment deliberately does not
  hold.
- Sign-up is open to anyone with a verifiable email. Per-user limits can be
  spread across many accounts, but the backend's per-instance total limit and
  `max-instances` still cap total agent spend.

## Troubleshooting

- Dashboard **example data** means `BACKEND_URL` is empty.
- Dashboard **error mode** with a server log naming `BACKEND_AUTH` or a
  `GCP_*` variable means that named setting is missing or invalid. Logs do not
  print its value.
- A server log `[auth] FIREBASE_PROJECT_ID is not configured` with an endless
  sign-in loop means that server variable is missing.
- A Cloud Run 401/403 usually means the provider audience/issuer, attribute
  condition (including `environment == 'production'`), impersonation binding,
  or Run Invoker binding does not match. The server drops its cached Google
  token after a 401/403, so the next request retries with a fresh one.
- If `generateIdToken` is denied (403 from `iamcredentials.googleapis.com`),
  additionally grant `roles/iam.serviceAccountOpenIdTokenCreator` on the service
  account to the same principal set. Still do not grant Token Creator.
- `GCP_PROJECT_NUMBER` must be the Cloud Run project's number. Using the
  Firebase project's number fails the token exchange.
- A Firebase `auth/unauthorized-domain` error means the exact browser domain is
  absent from Firebase Authorized domains.
- If sign-in works but the workspace remains locked, confirm the Firebase email
  is verified and `FIREBASE_PROJECT_ID` matches the Firebase project of the Web
  app.
