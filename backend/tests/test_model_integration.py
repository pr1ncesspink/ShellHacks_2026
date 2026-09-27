import os

import pytest

from backend.app.core.config import get_settings
from backend.app.services.overlaps import load_overlaps
from backend.app.services.similarity import get_encoder, score_pair


pytestmark = pytest.mark.model


@pytest.mark.skipif(os.getenv("RUN_MODEL_TESTS") != "1", reason="set RUN_MODEL_TESTS=1 to run model integration")
def test_pinned_model_similarity():
    get_encoder.cache_clear()
    encoder = get_encoder()
    embeddings = encoder.encode(["same", "another"])
    assert embeddings.shape == (2, 384)
    assert score_pair("identical project", "identical project", encoder) >= 0.99
    first = load_overlaps(get_settings().data_path)[0]
    assert score_pair(first.project_name_a, first.project_name_b, encoder) > score_pair(
        "Okatie-Bluffton 115 kV: Rebuild", "quarterly marketing budget", encoder
    )
