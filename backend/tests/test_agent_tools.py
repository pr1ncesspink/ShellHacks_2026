from __future__ import annotations

import json

from backend.app.agents.overlap_agent import tools


def test_score_project_names_is_directly_callable(fake_encoder):
    tools.set_encoder_provider(lambda: fake_encoder)

    result = tools.score_project_names("a b", "a b")

    assert result == {"status": "success", "score": 1.0}
    json.dumps(result)


def test_tools_return_errors_instead_of_raising(fake_encoder):
    tools.set_encoder_provider(lambda: fake_encoder)

    assert tools.score_project_names("", "x")["status"] == "error"
    assert tools.score_project_names("x" * 513, "x")["status"] == "error"
    assert tools.get_overlap("NOPE")["status"] == "error"


def test_get_overlap_returns_a_serializable_scored_row(fake_encoder):
    tools.set_encoder_provider(lambda: fake_encoder)

    result = tools.get_overlap("OVL_1")

    assert result["status"] == "success"
    assert result["overlap"]["overlap_id"] == "OVL_1"
    assert result["overlap"]["name_similarity"] == round(result["overlap"]["name_similarity"], 4)
    json.dumps(result)


def test_list_overlaps_filters_and_sorts_descending(fake_encoder):
    tools.set_encoder_provider(lambda: fake_encoder)

    result = tools.list_overlaps()

    assert result["status"] == "success"
    assert len(result["overlaps"]) == 6
    scores = [row["name_similarity"] for row in result["overlaps"]]
    assert scores == sorted(scores, reverse=True)
    assert tools.list_overlaps(min_similarity=max(scores) + 0.0001) == {
        "status": "success",
        "overlaps": [],
    }
    json.dumps(result)
