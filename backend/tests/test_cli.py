from pathlib import Path

from backend.app import cli
from backend.app.core.config import get_settings


def test_cli_writes_scored_csv(tmp_path: Path, fake_encoder, monkeypatch):
    monkeypatch.setattr(cli, "get_encoder", lambda: fake_encoder)
    output = tmp_path / "scores.csv"
    assert cli.main(["score", "--output", str(output)]) == 0
    lines = output.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 7
    assert lines[0].endswith(",name_similarity")
    assert lines[1].startswith("OVL_1,")


def test_cli_returns_nonzero_for_malformed_csv(tmp_path: Path, fake_encoder, monkeypatch):
    monkeypatch.setattr(cli, "get_encoder", lambda: fake_encoder)
    bad = tmp_path / "bad.csv"
    bad.write_text("overlap_id\nOVL_1\n", encoding="utf-8")
    assert cli.main(["score", "--input", str(bad)]) == 1
