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


def get_settings() -> Settings:
    return Settings(
        model_id=getenv("HF_MODEL_ID", DEFAULT_MODEL_ID),
        model_revision=getenv("HF_MODEL_REVISION", DEFAULT_MODEL_REVISION),
        device=getenv("SIMILARITY_DEVICE", "cpu"),
        data_path=Path(getenv("OVERLAPS_DATA_PATH", REPO_ROOT / "backend/data/projects_overlaps.csv")),
        output_path=Path(getenv("OVERLAPS_OUTPUT_PATH", REPO_ROOT / "backend/output/overlap_similarity.csv")),
    )
