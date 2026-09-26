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
    return subprocess.run(
        [bash, "-c", command, "--", *args],
        cwd=REPO_ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )


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
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("CLOUDSDK_") or key in {
            "GCP_PROJECT_ID",
            "GCP_REGION",
            "SERVICE_NAME",
            "AR_REPO",
            "GCLOUD_CONFIG",
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
    env = os.environ.copy()
    env.pop("GCP_PROJECT_ID", None)
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode != 0
    assert "GCP_PROJECT_ID is required" in result.stderr
    assert "gcloud" not in result.stdout + result.stderr


def test_default_configuration_is_refused() -> None:
    env = os.environ.copy()
    env.update({"GCP_PROJECT_ID": "demo-project", "GCLOUD_CONFIG": "default"})
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode != 0
    assert "must not be default" in result.stderr


def test_windows_public_folder_environment_uses_default_public_toggle() -> None:
    env = os.environ.copy()
    env.update({"GCP_PROJECT_ID": "demo-project", "PUBLIC": r"C:\Users\Public"})
    result = _run_script("--dry-run", "deploy", env=env)
    assert result.returncode == 0, result.stderr
    assert "--allow-unauthenticated" in result.stdout


def test_invalid_explicit_public_toggle_is_refused() -> None:
    env = os.environ.copy()
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
    assert "--max-instances=2" in output
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
