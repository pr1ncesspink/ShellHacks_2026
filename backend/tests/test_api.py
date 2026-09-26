import subprocess
import sys

from fastapi.testclient import TestClient

from backend.app.api.deps import get_encoder_dep
from backend.app.api.routes.overlaps import _load_cached, _score_cached
from backend.app.main import create_app


def test_import_does_not_construct_model():
    code = """
import sys
import types

fake_sentence_transformers = types.ModuleType('sentence_transformers')
def fail_if_constructed(*args, **kwargs):
    raise AssertionError('SentenceTransformer was constructed during import')
fake_sentence_transformers.SentenceTransformer = fail_if_constructed
sys.modules['sentence_transformers'] = fake_sentence_transformers

import backend.app.main
assert backend.app.main.app.title == 'ShellHacks 2026 API'
"""
    result = subprocess.run(
        [sys.executable, "-c", code], text=True, capture_output=True, check=False
    )
    assert result.returncode == 0, result.stderr


def make_client(fake_encoder):
    app = create_app()
    app.dependency_overrides[get_encoder_dep] = lambda: fake_encoder
    return TestClient(app)


def test_health_does_not_need_encoder(fake_encoder):
    response = make_client(fake_encoder).get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert "model" in response.json() and "revision" in response.json()


def test_similarity_validation_and_score(fake_encoder):
    client = make_client(fake_encoder)
    assert client.post("/similarity", json={"text_a": "", "text_b": "ok"}).status_code == 422
    assert client.post("/similarity", json={"text_a": "x" * 513, "text_b": "ok"}).status_code == 422
    response = client.post("/similarity", json={"text_a": "same", "text_b": "same"})
    assert response.status_code == 200
    assert response.json()["score"] == 1.0


def test_scored_overlaps_endpoint(fake_encoder):
    _load_cached.cache_clear()
    _score_cached.cache_clear()
    client = make_client(fake_encoder)
    response = client.get("/overlaps/similarity")
    assert response.status_code == 200
    payload = response.json()
    assert len(payload) == 6
    assert payload[0]["overlap_id"] == "OVL_1"
    assert "name_similarity" in payload[0]
    assert payload[0]["name_similarity"] == round(payload[0]["name_similarity"], 4)
    client.get("/overlaps/similarity")
    assert len(fake_encoder.calls) == 1
