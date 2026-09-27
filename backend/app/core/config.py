"""Runtime configuration."""

from dataclasses import dataclass
from os import getenv
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_MODEL_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"


@dataclass(frozen=True)
class Settings:
    model_id: str
    model_revision: str
    device: str
    data_path: Path
    output_path: Path
    batch_size: int = 32
    agent_model: str = "gemini-flash-latest"
    enable_a2a: bool = False
    a2a_public_url: str = "http://localhost:8000/a2a"
    diagnosis_model: str = "gemini-flash-latest"
    diagnosis_seed: int = 2026
    diagnosis_transport: str = "inprocess"
    diagnosis_a2a_url: str = "http://localhost:8000/a2a/diagnosis"
    diagnosis_a2a_public_url: str = "http://localhost:8000/a2a/diagnosis"
    collision_source: str = "csv"
    collision_export_dir: Path = REPO_ROOT / "backend/documentparsing/outputs"
    diag_max_distance_mi: float = 15.0
    diag_max_gap_days: int = 1095
    diag_co_schedule_min_sim: float = 0.45
    agent_rate_limit_per_client: int = 45
    agent_rate_limit_total: int = 25
    rate_limit_trusted_proxy_hops: int = 1
    rate_limit_user_header: str = ""


def _nonneg_int(name: str, default: int) -> int:
    try:
        value = int(getenv(name, str(default)))
    except ValueError as exc:
        raise ValueError(f"{name} must be a nonnegative integer") from exc
    if value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


def get_settings() -> Settings:
    agent_model = getenv("ADK_MODEL", "gemini-flash-latest")
    return Settings(
        model_id=getenv("HF_MODEL_ID", DEFAULT_MODEL_ID),
        model_revision=getenv("HF_MODEL_REVISION", DEFAULT_MODEL_REVISION),
        device=getenv("SIMILARITY_DEVICE", "cpu"),
        data_path=Path(getenv("OVERLAPS_DATA_PATH", REPO_ROOT / "backend/data/projects_overlaps.csv")),
        output_path=Path(getenv("OVERLAPS_OUTPUT_PATH", REPO_ROOT / "backend/output/overlap_similarity.csv")),
        agent_model=agent_model,
        enable_a2a=getenv("ENABLE_A2A") == "1",
        a2a_public_url=getenv("A2A_PUBLIC_URL", "http://localhost:8000/a2a"),
        diagnosis_model=getenv("DIAGNOSIS_MODEL", agent_model),
        diagnosis_seed=int(getenv("DIAGNOSIS_SEED", "2026")),
        diagnosis_transport=getenv("DIAGNOSIS_TRANSPORT", "inprocess"),
        diagnosis_a2a_url=getenv("DIAGNOSIS_A2A_URL", "http://localhost:8000/a2a/diagnosis"),
        diagnosis_a2a_public_url=getenv("DIAGNOSIS_A2A_PUBLIC_URL", "http://localhost:8000/a2a/diagnosis"),
        collision_source=getenv("COLLISION_SOURCE", "csv"),
        collision_export_dir=Path(getenv("COLLISION_EXPORT_DIR", REPO_ROOT / "backend/documentparsing/outputs")),
        diag_max_distance_mi=float(getenv("DIAG_MAX_DISTANCE_MI", "15.0")),
        diag_max_gap_days=int(getenv("DIAG_MAX_GAP_DAYS", "1095")),
        diag_co_schedule_min_sim=float(getenv("DIAG_CO_SCHEDULE_MIN_SIM", "0.45")),
        agent_rate_limit_per_client=_nonneg_int("AGENT_RATE_LIMIT_PER_CLIENT", 45),
        agent_rate_limit_total=_nonneg_int("AGENT_RATE_LIMIT_TOTAL", 25),
        rate_limit_trusted_proxy_hops=_nonneg_int("RATE_LIMIT_TRUSTED_PROXY_HOPS", 1),
        rate_limit_user_header=getenv("RATE_LIMIT_USER_HEADER", "").strip(),
    )
