#!/usr/bin/env bash
# Deploy the API only through its dedicated gcloud configuration.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/cloudrun.env"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

# Explicit flags below are authoritative. Do not inherit a machine's default
# configuration, project, or account as a deployment target.
for identity_override in \
  CLOUDSDK_AUTH_ACCESS_TOKEN \
  CLOUDSDK_AUTH_ACCESS_TOKEN_FILE \
  CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE \
  CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT; do
  [[ -z "${!identity_override:-}" ]] || {
    printf 'Error: %s must be unset for a dedicated human gcloud login.\n' "${identity_override}" >&2
    exit 1
  }
done
unset CLOUDSDK_ACTIVE_CONFIG_NAME CLOUDSDK_CORE_PROJECT CLOUDSDK_CORE_ACCOUNT

GCP_REGION="${GCP_REGION:-us-east1}"
SERVICE_NAME="${SERVICE_NAME:-shellhacks-api}"
AR_REPO="${AR_REPO:-shellhacks}"
GCLOUD_CONFIG="${GCLOUD_CONFIG:-shellhacks}"

# Windows commonly exports PUBLIC as its public-folder path. CLOUDRUN_PUBLIC is
# the unambiguous toggle; PUBLIC=0/1 remains supported for compatibility.
if [[ -n "${CLOUDRUN_PUBLIC:-}" ]]; then
  DEPLOY_PUBLIC="${CLOUDRUN_PUBLIC}"
elif [[ -z "${PUBLIC:-}" ]] || [[ "${PUBLIC}" =~ ^[A-Za-z]:[\\/]Users[\\/]Public[\\/]?$ ]] || [[ "${PUBLIC}" =~ ^/([a-zA-Z])/Users/Public/?$ ]]; then
  DEPLOY_PUBLIC=1
else
  DEPLOY_PUBLIC="${PUBLIC}"
fi
DRY_RUN=0
GCLOUD_ACCOUNT=""

usage() {
  printf '%s\n' "Usage: $0 [--dry-run] {login|setup|deploy|url}" >&2
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_target() {
  [[ -n "${GCP_PROJECT_ID:-}" ]] || fail "GCP_PROJECT_ID is required; copy backend/deploy/cloudrun.env.example to cloudrun.env."
  [[ "${GCLOUD_CONFIG}" != "default" ]] || fail "GCLOUD_CONFIG must not be default; use a dedicated shellhacks configuration."
  [[ "${DEPLOY_PUBLIC}" == "0" || "${DEPLOY_PUBLIC}" == "1" ]] || fail "CLOUDRUN_PUBLIC (or PUBLIC) must be 0 or 1."
}

gcloud_cmd() {
  gcloud --configuration="${GCLOUD_CONFIG}" --project="${GCP_PROJECT_ID}" "$@"
}

print_command() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

run() {
  print_command "$@"
  if (( ! DRY_RUN )); then
    "$@"
  fi
}

run_gcloud() {
  local args=(gcloud --configuration="${GCLOUD_CONFIG}" --project="${GCP_PROJECT_ID}")
  [[ -z "${GCLOUD_ACCOUNT}" ]] || args+=(--account="${GCLOUD_ACCOUNT}")
  run "${args[@]}" "$@"
}

capture() {
  print_command "$@" >&2
  if (( DRY_RUN )); then
    return 0
  fi
  "$@"
}

capture_gcloud() {
  local args=(gcloud --configuration="${GCLOUD_CONFIG}" --project="${GCP_PROJECT_ID}")
  [[ -z "${GCLOUD_ACCOUNT}" ]] || args+=(--account="${GCLOUD_ACCOUNT}")
  capture "${args[@]}" "$@"
}

configuration_exists() {
  gcloud_cmd config configurations describe "${GCLOUD_CONFIG}" --format='value(name)' >/dev/null 2>&1
}

config_property() {
  local property="$1" value
  if ! value="$(gcloud_cmd config configurations describe "${GCLOUD_CONFIG}" --format="value(properties.${property})" 2>/dev/null)"; then
    fail "could not inspect ${property} in gcloud configuration '${GCLOUD_CONFIG}'."
  fi
  printf '%s' "${value}"
}

verify_configuration() {
  configuration_exists || fail "gcloud configuration '${GCLOUD_CONFIG}' does not exist; run '$0 login'."

  local configured_project configured_account account impersonated_account credential_override
  configured_project="$(config_property core.project)"
  [[ "${configured_project}" == "${GCP_PROJECT_ID}" ]] || fail "gcloud configuration '${GCLOUD_CONFIG}' targets '${configured_project:-unset}', not GCP_PROJECT_ID '${GCP_PROJECT_ID}'; run '$0 login'."

  configured_account="$(config_property core.account)"
  impersonated_account="$(config_property auth.impersonate_service_account)"
  [[ -z "${impersonated_account}" ]] || fail "gcloud configuration '${GCLOUD_CONFIG}' uses service-account impersonation; use a dedicated human login."

  for credential_override in auth.credential_file_override auth.access_token_file auth.access_token; do
    local credential_value
    credential_value="$(config_property "${credential_override}")"
    [[ -z "${credential_value}" ]] || fail "gcloud configuration '${GCLOUD_CONFIG}' has ${credential_override} set; use a dedicated human login."
  done

  if ! account="$(gcloud_cmd auth list --filter='status:ACTIVE' --format='value(account)' 2>/dev/null)"; then
    fail "could not inspect the active account in gcloud configuration '${GCLOUD_CONFIG}'."
  fi
  [[ -n "${account}" ]] || fail "gcloud configuration '${GCLOUD_CONFIG}' has no active account; run '$0 login'."
  [[ "${configured_account}" == "${account}" ]] || fail "gcloud configuration '${GCLOUD_CONFIG}' account '${configured_account:-unset}' does not match active account '${account}'; run '$0 login'."
  GCLOUD_ACCOUNT="${account}"
}

image_tag() {
  if [[ -n "${TAG:-}" ]]; then
    printf '%s' "${TAG}"
  elif git -C "${REPO_ROOT}" rev-parse --short HEAD >/dev/null 2>&1; then
    git -C "${REPO_ROOT}" rev-parse --short HEAD
  else
    printf '%s' manual
  fi
}

main() {
  if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=1
    shift
  fi
  [[ $# -eq 1 ]] || { usage; exit 2; }
  local command="$1"
  require_target
  cd "${REPO_ROOT}"

  case "${command}" in
    login)
      if (( ! DRY_RUN )) && ! configuration_exists; then
        run gcloud --configuration="${GCLOUD_CONFIG}" --project="${GCP_PROJECT_ID}" config configurations create "${GCLOUD_CONFIG}" --no-activate
      elif (( DRY_RUN )); then
        # The command is idempotent only when the configuration is absent.
        print_command gcloud --configuration="${GCLOUD_CONFIG}" --project="${GCP_PROJECT_ID}" config configurations create "${GCLOUD_CONFIG}" --no-activate
      fi
      run_gcloud auth login
      run_gcloud config set project "${GCP_PROJECT_ID}"
      ;;
    setup)
      if (( DRY_RUN )); then
        run_gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
        run_gcloud artifacts repositories describe "${AR_REPO}" --location="${GCP_REGION}"
        run_gcloud artifacts repositories create "${AR_REPO}" --repository-format=docker --location="${GCP_REGION}"
      else
        verify_configuration
        run_gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
        if ! gcloud_cmd artifacts repositories describe "${AR_REPO}" --location="${GCP_REGION}" >/dev/null 2>&1; then
          run_gcloud artifacts repositories create "${AR_REPO}" --repository-format=docker --location="${GCP_REGION}"
        fi
      fi
      ;;
    deploy)
      if (( ! DRY_RUN )); then
        verify_configuration
      fi
      local tag image service_url
      tag="$(image_tag)"
      image="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:${tag}"
      run_gcloud builds submit . --config=backend/cloudbuild.yaml --substitutions="_IMAGE=${image}"
      local deploy_args=(run deploy "${SERVICE_NAME}" --image="${image}" --region="${GCP_REGION}" --memory=2Gi --cpu=1 --cpu-boost --min-instances=0 --max-instances=2 --timeout=300 --port=8080)
      if [[ "${DEPLOY_PUBLIC}" == "0" ]]; then
        deploy_args+=(--no-allow-unauthenticated)
      else
        deploy_args+=(--allow-unauthenticated)
      fi
      run_gcloud "${deploy_args[@]}"
      service_url="$(capture_gcloud run services describe "${SERVICE_NAME}" --region="${GCP_REGION}" --format='value(status.url)')"
      if (( ! DRY_RUN )); then
        printf '%s\n' "${service_url}"
        if [[ "${DEPLOY_PUBLIC}" == "0" ]]; then
          local identity_token
          identity_token="$(capture_gcloud auth print-identity-token)"
          printf '+ curl --fail --show-error --silent -H Authorization: Bearer [redacted] %q\n' "${service_url}/health" >&2
          curl --fail --show-error --silent -H "Authorization: Bearer ${identity_token}" "${service_url}/health"
        else
          run curl --fail --show-error --silent "${service_url}/health"
        fi
        printf '\n'
      fi
      ;;
    url)
      if (( ! DRY_RUN )); then
        verify_configuration
      fi
      capture_gcloud run services describe "${SERVICE_NAME}" --region="${GCP_REGION}" --format='value(status.url)'
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
