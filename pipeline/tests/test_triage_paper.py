"""Tests for paper-specific triage function."""

import json
from unittest.mock import patch, MagicMock
from pipeline.triage import triage_paper


def _mock_openrouter_response(result_dict):
    """Create a mock response matching OpenRouter's format."""
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": json.dumps(result_dict)}}]
    }
    return mock_resp


@patch("pipeline.triage.requests.post")
def test_triage_paper_returns_structured_result(mock_post):
    mock_post.return_value = _mock_openrouter_response({
        "summary": "New embedding model for 200+ languages.",
        "category": "learning",
        "actionability": "high",
        "key_topics": ["embeddings", "multilingual"],
        "tools_mentioned": ["sentence-transformers"],
        "urls": [],
    })

    result = triage_paper(
        title="F2LLM-v2: Multilingual Embedding Models",
        abstract="We present a family of embedding models supporting 200+ languages.",
        authors="Smith et al.",
        paper_url="https://huggingface.co/papers/2503.12345",
    )

    assert result["actionability"] == "high"
    assert result["category"] == "learning"
    assert "key_topics" in result

    # Verify the system prompt mentions papers, not Reddit
    call_args = mock_post.call_args
    messages = call_args.kwargs["json"]["messages"]
    system_prompt = messages[0]["content"]
    assert "paper" in system_prompt.lower()
    assert "Reddit" not in system_prompt


@patch("pipeline.triage.requests.post")
def test_triage_paper_truncates_long_abstract(mock_post):
    mock_post.return_value = _mock_openrouter_response({
        "summary": "Long paper.",
        "category": "learning",
        "actionability": "low",
        "key_topics": ["test"],
        "tools_mentioned": [],
        "urls": [],
    })

    long_abstract = "word " * 2000  # ~10000 chars
    triage_paper(
        title="Test",
        abstract=long_abstract,
        authors="Test",
        paper_url="https://example.com",
    )

    call_args = mock_post.call_args
    user_content = call_args.kwargs["json"]["messages"][1]["content"]
    assert len(user_content) <= 5000


@patch("pipeline.triage.requests.post")
def test_triage_paper_fallback_on_json_error(mock_post):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": "not valid json"}}]
    }
    mock_post.return_value = mock_resp

    result = triage_paper(
        title="Test Paper",
        abstract="Abstract",
        authors="Author",
        paper_url="https://example.com",
    )

    assert result["actionability"] == "low"
    assert result["category"] == "learning"
