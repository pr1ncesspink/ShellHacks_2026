from __future__ import annotations

import hashlib

import numpy as np
import pytest


class FakeEncoder:
    """Deterministic normalized embeddings with visible encode calls."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def encode(self, texts: list[str]) -> np.ndarray:
        self.calls.append(list(texts))
        vectors = []
        for text in texts:
            vector = np.zeros(16, dtype=float)
            for token in text.lower().split():
                vector[int.from_bytes(hashlib.sha256(token.encode()).digest()[:2], "big") % 16] += 1
            norm = np.linalg.norm(vector)
            vectors.append(vector / norm if norm else vector)
        return np.asarray(vectors)


@pytest.fixture
def fake_encoder() -> FakeEncoder:
    return FakeEncoder()


@pytest.fixture(autouse=True)
def reset_agent_tool_state(request):
    """Keep the agent tool provider and row cache isolated between agent tests."""
    if not request.node.path.name.startswith(("test_agent", "test_a2a", "test_gemini")):
        yield
        return

    from backend.app.agents.overlap_agent import tools

    tools.reset_encoder_provider()
    yield
    tools.reset_encoder_provider()
