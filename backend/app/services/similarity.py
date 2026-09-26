"""Semantic similarity services."""

from __future__ import annotations

from functools import lru_cache
from threading import Lock
from typing import Protocol

import numpy as np

from backend.app.core.config import get_settings


class Encoder(Protocol):
    def encode(self, texts: list[str]) -> np.ndarray: ...


def collapse_whitespace(text: str) -> str:
    return " ".join(text.split())


class SentenceTransformerEncoder:
    """Adapter which keeps sentence-transformers out of import-time startup."""

    def __init__(self, model_id: str, revision: str, device: str, batch_size: int) -> None:
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(model_id, revision=revision, device=device)
        self._batch_size = batch_size

    def encode(self, texts: list[str]) -> np.ndarray:
        return np.asarray(self._model.encode(texts, normalize_embeddings=True, batch_size=self._batch_size))


_encoder_lock = Lock()


@lru_cache(maxsize=1)
def _get_cached_encoder() -> SentenceTransformerEncoder:
    settings = get_settings()
    return SentenceTransformerEncoder(
        settings.model_id, settings.model_revision, settings.device, settings.batch_size
    )


def get_encoder() -> SentenceTransformerEncoder:
    """Return the process singleton, constructing it once even under concurrent first use."""
    with _encoder_lock:
        return _get_cached_encoder()


def _clear_encoder_cache() -> None:
    with _encoder_lock:
        _get_cached_encoder.cache_clear()


# Retain cache controls for focused tests and operational cache reset tooling.
get_encoder.cache_clear = _clear_encoder_cache  # type: ignore[attr-defined]
get_encoder.cache_info = _get_cached_encoder.cache_info  # type: ignore[attr-defined]


def score_pairs(pairs: list[tuple[str, str]], encoder: Encoder) -> list[float]:
    if not pairs:
        return []
    normalized_pairs = [(collapse_whitespace(a), collapse_whitespace(b)) for a, b in pairs]
    unique_texts = list(dict.fromkeys(text for pair in normalized_pairs for text in pair))
    embeddings = encoder.encode(unique_texts)
    by_text = dict(zip(unique_texts, embeddings, strict=True))
    return [float(np.clip(np.dot(by_text[a], by_text[b]), -1.0, 1.0)) for a, b in normalized_pairs]


def score_pair(text_a: str, text_b: str, encoder: Encoder) -> float:
    return score_pairs([(text_a, text_b)], encoder)[0]
