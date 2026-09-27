import pytest
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from time import sleep

import backend.app.services.similarity as similarity
from backend.app.services.similarity import score_pair, score_pairs


def test_identical_pair_scores_one(fake_encoder):
    assert score_pair("same name", "same name", fake_encoder) == pytest.approx(1.0)


def test_scores_are_bounded_and_whitespace_is_collapsed(fake_encoder):
    baseline = score_pair("Jasper  Okatie", "Georgia Power", fake_encoder)
    spaced = score_pair("  Jasper\nOkatie ", "Georgia   Power ", fake_encoder)
    assert baseline == spaced
    assert -1 <= baseline <= 1


def test_encodes_unique_strings_once(fake_encoder):
    score_pairs([("a", "shared"), ("b", "shared")], fake_encoder)
    assert fake_encoder.calls == [["a", "shared", "b"]]


def test_get_encoder_constructs_once_under_concurrent_first_use(monkeypatch):
    created = []
    created_lock = Lock()

    class SlowEncoder:
        def __init__(self, *args):
            sleep(0.05)
            with created_lock:
                created.append(args)

    monkeypatch.setattr(similarity, "SentenceTransformerEncoder", SlowEncoder)
    similarity.get_encoder.cache_clear()
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            encoders = list(pool.map(lambda _: similarity.get_encoder(), range(8)))
        assert len(created) == 1
        assert len({id(encoder) for encoder in encoders}) == 1
    finally:
        similarity.get_encoder.cache_clear()
