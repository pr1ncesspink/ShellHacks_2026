"""Offline checks for the Cloud Run deployment framework."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "backend" / "deploy" / "cloudrun.sh"


def _bash() -> str | None:
    git_bash = Path(os.environ.get("ProgramFiles", r"C:\\Program Files")) / "Git/usr/bin/bash.exe"
    if git_bash.exists():
        return str(git_bash)
    candidate = shutil.which("bash")
    if candidate and "system32" not in candidate.lower():
        return candidate
    return None


def _run_script(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    bash = _bash()
    if bash is None:
        pytest.skip("a usable Bash interpreter is unavailable")
    command = 'exec /usr/bin/bash backend/deploy/cloudrun.sh "$@"'
    # Keep a developer's local cloudrun.env from leaking into these checks.
    env = dict(os.environ if env is None else env)
    env["CLOUDRUN_ENV_FILE"] = "/nonexistent/cloudrun.env"
    return subprocess.run(
        [bash, "-c", command, "--", *args],
        cwd=REPO_ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )


RUNTIME_ENV_NAMES = {"GEMINI_BACKEND", "DIAGNOSIS_MODEL", "CLOUDRUN_SERVICE_ACCOUNT"}
RUNTIME_ENV_PREFIXES = ("SNOWFLAKE_", "GRIDLOCK_", "GOOGLE_")


def _base_env() -> dict[str, str]:
    """Copy os.environ without runtime or secret settings from a developer shell."""
    env = os.environ.copy()
    for key in list(env):
        if key.startswith(RUNTIME_ENV_PREFIXES) or key in RUNTIME_ENV_NAMES:
            env.pop(key)
    return env


def _fake_tools(tmp_path: Path) -> dict[str, str]:
    gcloud = tmp_path / "gcloud"
    gcloud.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' \"$*\" >> \"$FAKE_GCLOUD_LOG\"
case \"$*\" in
  *"config configurations describe"*"value(name)"*)
    [[ \"${FAKE_CONFIG_STATE:-present}\" != missing ]] || exit 1
    printf '%s\\n' shellhacks ;;
  *"properties.core.project"*) printf '%s\\n' \"${FAKE_PROJECT:-demo-project}\" ;;
  *"properties.core.account"*) printf '%s\\n' \"${FAKE_CONFIG_ACCOUNT:-deployer@example.com}\" ;;
  *"properties.auth.impersonate_service_account"*) printf '%s\\n' \"${FAKE_IMPERSONATION:-}\" ;;
  *"auth list"*) printf '%s\\n' \"${FAKE_ACCOUNT-deployer@example.com}\" ;;
  *"run services describe"*) printf '%s\\n' https://shellhacks.example ;;
  *"auth print-identity-token"*) printf '%s\\n' test-identity-token ;;
esac
""",
        encoding="utf-8",
        newline="\n",
    )
    curl = tmp_path / "curl"
    curl.write_text(
        "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$FAKE_CURL_LOG\"\n",
        encoding="utf-8",
        newline="\n",
    )
    gcloud.chmod(0o755)
    curl.chmod(0o755)
    env = _base_env()
    for key in list(env):
        if key.startswith("CLOUDSDK_") or key in {
            "GCP_PROJECT_ID",
            "GCP_REGION",
            "SERVICE_NAME",
            "AR_REPO",
            "GCLOUD_CONFIG",
            "CLOUDRUN_PUBLIC",
            "PUBLIC",
            "TAG",
        }:
            env.pop(key)
    env.update(
        {
            "GCP_PROJECT_ID": "demo-project",
            "FAKE_GCLOUD_LOG": str(tmp_path / "gcloud.log"),
            "FAKE_CURL_LOG": str(tmp_path / "curl.log"),
            "PATH": f"{tmp_path}{os.pathsep}{env.get('PATH', '')}",
        }
    )
    return env


def test_missing_project_fails_before_gcloud() -> None:
    env = _base_env()
    env.pop("GCP_PROJECT_ID", None)
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode != 0
    assert "GCP_PROJECT_ID is required" in result.stderr
    assert "gcloud" not in result.stdout + result.stderr


def test_default_configuration_is_refused() -> None:
    env = _base_env()
    env.update({"GCP_PROJECT_ID": "demo-project", "GCLOUD_CONFIG": "default"})
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode != 0
    assert "must not be default" in result.stderr


def test_windows_public_folder_environment_uses_private_default_toggle() -> None:
    env = _base_env()
    env.pop("CLOUDRUN_PUBLIC", None)
    env.update({"GCP_PROJECT_ID": "demo-project", "PUBLIC": r"C:\Users\Public"})
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode == 0, result.stderr
    assert "--no-allow-unauthenticated" in result.stdout
    assert "--allow-unauthenticated" not in result.stdout


@pytest.mark.parametrize("updates", [{}, {"PUBLIC": ""}, {"CLOUDRUN_PUBLIC": ""}])
def test_missing_or_empty_public_toggle_defaults_to_private(updates: dict[str, str]) -> None:
    env = _base_env()
    env.update({"GCP_PROJECT_ID": "demo-project"})
    env.pop("CLOUDRUN_PUBLIC", None)
    env.pop("PUBLIC", None)
    env.update(updates)
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode == 0, result.stderr
    assert "--no-allow-unauthenticated" in result.stdout
    assert "--allow-unauthenticated" not in result.stdout


@pytest.mark.parametrize("updates", [{"CLOUDRUN_PUBLIC": "1"}, {"PUBLIC": "1"}])
def test_explicit_public_toggle_allows_unauthenticated_access(updates: dict[str, str]) -> None:
    env = _base_env()
    env.update({"GCP_PROJECT_ID": "demo-project"})
    env.pop("CLOUDRUN_PUBLIC", None)
    env.pop("PUBLIC", None)
    env.update(updates)
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode == 0, result.stderr
    assert "--allow-unauthenticated" in result.stdout
    assert "--no-allow-unauthenticated" not in result.stdout


def test_invalid_explicit_public_toggle_is_refused() -> None:
    env = _base_env()
    env.update({"GCP_PROJECT_ID": "demo-project", "PUBLIC": "maybe"})
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode != 0
    assert "must be 0 or 1" in result.stderr


def test_dry_run_prints_scoped_deploy_commands_without_executing_gcloud(tmp_path: Path) -> None:
    env = _fake_tools(tmp_path)
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode == 0, result.stderr
    gcloud_lines = [line for line in (result.stdout + result.stderr).splitlines() if line.startswith("+ gcloud ")]
    assert gcloud_lines
    assert all("--configuration=shellhacks" in line and "--project=demo-project" in line for line in gcloud_lines)
    output = result.stdout + result.stderr
    assert "--config=backend/cloudbuild.yaml" in output
    assert "--max-instances=3" in output
    assert "--memory=2Gi" in output
    assert not Path(env["FAKE_GCLOUD_LOG"]).exists()


@pytest.mark.parametrize(
    ("updates", "message"),
    [
        ({"FAKE_CONFIG_STATE": "missing"}, "does not exist"),
        ({"FAKE_PROJECT": "wrong-project"}, "targets 'wrong-project'"),
        ({"FAKE_ACCOUNT": ""}, "has no active account"),
        ({"FAKE_CONFIG_ACCOUNT": "other@example.com"}, "does not match active account"),
    ],
)
def test_live_deploy_guards_reject_bad_dedicated_configuration(
    tmp_path: Path, updates: dict[str, str], message: str
) -> None:
    env = _fake_tools(tmp_path)
    env.update(updates)
    result = _run_script("deploy", env=env)
    assert result.returncode != 0
    assert message in result.stderr


def test_live_deploy_scopes_every_gcloud_invocation(tmp_path: Path) -> None:
    env = _fake_tools(tmp_path)
    result = _run_script("deploy", env=env)
    assert result.returncode == 0, result.stderr
    calls = Path(env["FAKE_GCLOUD_LOG"]).read_text(encoding="utf-8").splitlines()
    assert calls
    assert all("--configuration=shellhacks" in call and "--project=demo-project" in call for call in calls)
    assert Path(env["FAKE_CURL_LOG"]).exists()
    assert "--no-allow-unauthenticated" in "\n".join(calls)
    assert "Authorization: Bearer [redacted]" in result.stderr
    assert "test-identity-token" not in result.stdout + result.stderr


SENTINEL_TOKEN = "sentinel-snowflake-pat-DO-NOT-LEAK"
SENTINEL_API_KEY = "sentinel-google-api-key-DO-NOT-LEAK"
SNOWFLAKE_RUNTIME = {
    "SNOWFLAKE_ACCOUNT": "org-acct",
    "SNOWFLAKE_USER": "svc_user",
    "SNOWFLAKE_WAREHOUSE": "COMPUTE_WH",
    "SNOWFLAKE_ROLE": "SYSADMIN",
    "SNOWFLAKE_TOKEN_SECRET": "snowflake-pat",
}
DEFAULT_DEPLOY_LINE = (
    "+ gcloud --configuration=shellhacks --project=demo-project run deploy shellhacks-api"
    " --image=us-east1-docker.pkg.dev/demo-project/shellhacks/shellhacks-api:t"
    " --region=us-east1 --memory=2Gi --cpu=1 --cpu-boost --min-instances=0 --max-instances=3"
    " --timeout=300 --port=8080 --no-allow-unauthenticated"
)


def _deploy_line(output: str) -> str:
    lines = [line for line in output.splitlines() if " run deploy " in line]
    assert len(lines) == 1, output
    return lines[0]


def test_runtime_config_is_opt_in_and_default_deploy_line_is_unchanged(tmp_path: Path) -> None:
    env = _fake_tools(tmp_path)
    env["TAG"] = "t"
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode == 0, result.stderr
    assert _deploy_line(result.stdout) == DEFAULT_DEPLOY_LINE

    setup = _run_script("--dry-run", "setup", env=env)
    assert setup.returncode == 0, setup.stderr
    assert "secretmanager.googleapis.com" not in setup.stdout
    assert "aiplatform.googleapis.com" not in setup.stdout


def test_snowflake_env_and_secret_reference_are_forwarded_without_token(tmp_path: Path) -> None:
    env = _fake_tools(tmp_path)
    env.update(SNOWFLAKE_RUNTIME)
    env.update({"TAG": "t", "SNOWFLAKE_TOKEN": SENTINEL_TOKEN, "GOOGLE_API_KEY": SENTINEL_API_KEY})
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode == 0, result.stderr
    line = _deploy_line(result.stdout)
    assert line.startswith(DEFAULT_DEPLOY_LINE + " ")
    assert (
        "--update-env-vars=SNOWFLAKE_ACCOUNT=org-acct,SNOWFLAKE_USER=svc_user,"
        "SNOWFLAKE_WAREHOUSE=COMPUTE_WH,SNOWFLAKE_ROLE=SYSADMIN"
    ) in line
    assert "--update-secrets=SNOWFLAKE_TOKEN=snowflake-pat:latest" in line
    assert "--set-env-vars" not in line and "--set-secrets" not in line
    assert "--allow-unauthenticated" not in line.replace("--no-allow-unauthenticated", "")
    output = result.stdout + result.stderr
    assert SENTINEL_TOKEN not in output
    assert SENTINEL_API_KEY not in output
    assert "GOOGLE_API_KEY" not in output
    assert not Path(env["FAKE_GCLOUD_LOG"]).exists()


def test_live_deploy_sends_only_secret_reference_to_gcloud(tmp_path: Path) -> None:
    env = _fake_tools(tmp_path)
    env.update(SNOWFLAKE_RUNTIME)
    env.update(
        {
            "SNOWFLAKE_TOKEN": SENTINEL_TOKEN,
            "GOOGLE_API_KEY": SENTINEL_API_KEY,
            "SNOWFLAKE_TOKEN_SECRET_VERSION": "3",
        }
    )
    result = _run_script("deploy", env=env)
    assert result.returncode == 0, result.stderr
    log = Path(env["FAKE_GCLOUD_LOG"]).read_text(encoding="utf-8")
    calls = log.splitlines()
    assert all("--configuration=shellhacks" in call and "--project=demo-project" in call for call in calls)
    deploy_calls = [call for call in calls if " run deploy " in call]
    assert len(deploy_calls) == 1
    assert "--update-secrets=SNOWFLAKE_TOKEN=snowflake-pat:3" in deploy_calls[0]
    assert "--account=deployer@example.com" in deploy_calls[0]
    assert "--no-allow-unauthenticated" in deploy_calls[0]
    for text in (log, result.stdout, result.stderr):
        assert SENTINEL_TOKEN not in text
        assert SENTINEL_API_KEY not in text


def test_vertex_backend_emits_vertex_env(tmp_path: Path) -> None:
    env = _fake_tools(tmp_path)
    env.update(
        {
            "GEMINI_BACKEND": "vertex",
            "GOOGLE_CLOUD_LOCATION": "global",
            "DIAGNOSIS_MODEL": "gemini-3.1-flash-lite",
        }
    )
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode == 0, result.stderr
    line = _deploy_line(result.stdout)
    assert (
        "--update-env-vars=DIAGNOSIS_MODEL=gemini-3.1-flash-lite,GOOGLE_GENAI_USE_VERTEXAI=TRUE,"
        "GOOGLE_CLOUD_PROJECT=demo-project,GOOGLE_CLOUD_LOCATION=global"
    ) in line
    assert "--update-secrets" not in line

    setup = _run_script("--dry-run", "setup", env=env)
    assert setup.returncode == 0, setup.stderr
    assert "aiplatform.googleapis.com" in setup.stdout
    assert "secretmanager.googleapis.com" not in setup.stdout


def test_setup_enables_secret_manager_only_with_snowflake_secret(tmp_path: Path) -> None:
    env = _fake_tools(tmp_path)
    env.update(SNOWFLAKE_RUNTIME)
    setup = _run_script("--dry-run", "setup", env=env)
    assert setup.returncode == 0, setup.stderr
    assert "secretmanager.googleapis.com" in setup.stdout
    assert "aiplatform.googleapis.com" not in setup.stdout


def test_runtime_service_account_flag(tmp_path: Path) -> None:
    env = _fake_tools(tmp_path)
    env["CLOUDRUN_SERVICE_ACCOUNT"] = "shellhacks-api-runtime@shellhacks-2026.iam.gserviceaccount.com"
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode == 0, result.stderr
    line = _deploy_line(result.stdout)
    assert line.endswith(
        "--no-allow-unauthenticated"
        " --service-account=shellhacks-api-runtime@shellhacks-2026.iam.gserviceaccount.com"
    )


@pytest.mark.parametrize(
    ("updates", "message"),
    [
        ({"SNOWFLAKE_ACCOUNT": "org-acct"}, "incomplete Snowflake configuration"),
        ({**SNOWFLAKE_RUNTIME, "SNOWFLAKE_TOKEN_SECRET": ""}, "SNOWFLAKE_TOKEN_SECRET is required"),
        ({"SNOWFLAKE_TOKEN_SECRET": "snowflake-pat"}, "incomplete Snowflake configuration"),
        ({**SNOWFLAKE_RUNTIME, "SNOWFLAKE_TOKEN_SECRET": "bad/name"}, "must be a Secret Manager secret name"),
        ({**SNOWFLAKE_RUNTIME, "SNOWFLAKE_TOKEN_SECRET_VERSION": "v1"}, "must be 'latest' or a version number"),
        ({**SNOWFLAKE_RUNTIME, "SNOWFLAKE_ROLE": "SYSADMIN,EXTRA=1"}, "must not contain a comma"),
        ({"DIAGNOSIS_MODEL": "gemini\nEVIL=1"}, "must not contain a newline"),
        ({"GEMINI_BACKEND": "apikey"}, "GEMINI_BACKEND must be empty or 'vertex'"),
        ({"GEMINI_BACKEND": "vertex"}, "GOOGLE_CLOUD_LOCATION is required"),
        (
            {
                "GEMINI_BACKEND": "vertex",
                "GOOGLE_CLOUD_LOCATION": "global",
                "GOOGLE_CLOUD_PROJECT": "shellhacks26-c78d4",
            },
            "GOOGLE_CLOUD_PROJECT must equal GCP_PROJECT_ID",
        ),
        ({"CLOUDRUN_SERVICE_ACCOUNT": "someone@gmail.com"}, "CLOUDRUN_SERVICE_ACCOUNT must be a service-account email"),
    ],
)
def test_invalid_runtime_config_is_refused_before_gcloud(
    tmp_path: Path, updates: dict[str, str], message: str
) -> None:
    env = _fake_tools(tmp_path)
    env.update(updates)
    env["SNOWFLAKE_TOKEN"] = SENTINEL_TOKEN
    for args in (("--dry-run", "deploy"), ("deploy",), ("setup",)):
        result = _run_script(*args, env=env)
        assert result.returncode != 0
        assert message in result.stderr
        assert "gcloud" not in result.stdout + result.stderr
        assert SENTINEL_TOKEN not in result.stdout + result.stderr
        assert not Path(env["FAKE_GCLOUD_LOG"]).exists()

def test_deploy_static_contracts() -> None:
    dockerfile = (REPO_ROOT / "backend" / "Dockerfile").read_text(encoding="utf-8")
    assert "pip install --require-hashes" in dockerfile
    assert "HF_HUB_OFFLINE=1" in dockerfile
    assert "1110a243fdf4706b3f48f1d95db1a4f5529b4d41" in dockerfile
    assert "USER appuser" in dockerfile
    assert "backend.app.main:app" in dockerfile

    script_bytes = SCRIPT.read_bytes()
    assert b"\r" not in script_bytes

    gcloudignore = (REPO_ROOT / ".gcloudignore").read_text(encoding="utf-8")
    assert ".venv/" in gcloudignore
    assert "backend/deploy/cloudrun.env" in gcloudignore
