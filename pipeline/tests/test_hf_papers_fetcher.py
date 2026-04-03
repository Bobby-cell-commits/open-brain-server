"""Tests for HF papers fetcher — fetch, screen, and process pipeline."""

import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
from pipeline.hf_papers.fetcher import (
    fetch_daily_papers,
    passes_keyword_screen,
    format_enriched_content,
    process_papers,
)

DEDUP_FILE = Path(__file__).parent.parent / "data" / "hf_papers_processed.json"


@pytest.fixture(autouse=True)
def clean_dedup():
    """Remove dedup tracker file before each test to avoid cross-test interference."""
    DEDUP_FILE.unlink(missing_ok=True)
    yield
    DEDUP_FILE.unlink(missing_ok=True)


def _make_paper(paper_id="2503.12345", title="Test Paper", upvotes=5,
                ai_keywords=None, summary="An abstract."):
    """Create a paper dict matching HF API structure."""
    return {
        "paper": {
            "id": paper_id,
            "authors": [{"name": "Alice"}, {"name": "Bob"}],
            "summary": summary,
            "ai_keywords": ai_keywords or [],
        },
        "title": title,
        "upvotes": upvotes,
    }


# --- passes_keyword_screen tests ---

def test_screen_matches_title_term():
    paper = _make_paper(title="A New Language Model for Code")
    assert passes_keyword_screen(paper) is True


def test_screen_matches_title_case_insensitive():
    paper = _make_paper(title="Efficient LLM Inference")
    assert passes_keyword_screen(paper) is True


def test_screen_matches_keyword_allowlist():
    paper = _make_paper(
        title="Some Opaque Title",
        ai_keywords=["retrieval-augmented generation"],
    )
    assert passes_keyword_screen(paper) is True


def test_screen_rejects_unrelated_paper():
    paper = _make_paper(
        title="3D Gaussian Splatting for Autonomous Driving",
        ai_keywords=["3d reconstruction", "autonomous driving"],
    )
    assert passes_keyword_screen(paper) is False


def test_screen_passes_high_upvote_paper():
    paper = _make_paper(
        title="Novel Video Generation Architecture",
        ai_keywords=["video generation"],
        upvotes=45,
    )
    assert passes_keyword_screen(paper) is True


def test_screen_rejects_low_upvote_unrelated_paper():
    paper = _make_paper(
        title="Novel Video Generation Architecture",
        ai_keywords=["video generation"],
        upvotes=10,
    )
    assert passes_keyword_screen(paper) is False


# --- format_enriched_content tests ---

def test_format_enriched_content_structure():
    paper = _make_paper(title="Cool Paper", summary="A great abstract.")
    triage_result = {
        "summary": "Does cool things.",
        "category": "learning",
        "actionability": "medium",
        "key_topics": ["embeddings", "multilingual"],
        "tools_mentioned": ["faiss"],
    }
    content = format_enriched_content(paper, triage_result)
    assert "[HF Paper] Cool Paper" in content
    assert "Alice, Bob" in content
    assert "Does cool things." in content
    assert "medium" in content
    assert len(content) <= 4000


# --- fetch_daily_papers tests ---

@patch("pipeline.hf_papers.fetcher.requests.get")
def test_fetch_daily_papers_returns_list(mock_get):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = [
        _make_paper("2503.00001", "Paper A"),
        _make_paper("2503.00002", "Paper B"),
    ]
    mock_get.return_value = mock_resp

    papers = fetch_daily_papers()
    assert len(papers) == 2
    assert papers[0]["paper"]["id"] == "2503.00001"


@patch("pipeline.hf_papers.fetcher.requests.get")
def test_fetch_daily_papers_returns_empty_on_error(mock_get):
    mock_get.side_effect = Exception("Network error")
    papers = fetch_daily_papers()
    assert papers == []


# --- process_papers integration test (mocked) ---

@patch("pipeline.hf_papers.fetcher.capture_thought")
@patch("pipeline.hf_papers.fetcher.triage_paper")
@patch("pipeline.hf_papers.fetcher.fetch_daily_papers")
def test_process_papers_captures_matching_paper(mock_fetch, mock_triage, mock_capture):
    mock_fetch.return_value = [
        _make_paper("2503.99999", "A Novel Language Model", upvotes=10,
                    ai_keywords=["large language models"]),
    ]
    mock_triage.return_value = {
        "summary": "Novel LM.",
        "category": "learning",
        "actionability": "medium",
        "key_topics": ["language-models"],
        "tools_mentioned": [],
        "urls": [],
    }

    stats = process_papers(dry_run=False)

    assert stats["captured"] == 1
    assert stats["filtered"] == 0
    mock_capture.assert_called_once()


@patch("pipeline.hf_papers.fetcher.capture_thought")
@patch("pipeline.hf_papers.fetcher.triage_paper")
@patch("pipeline.hf_papers.fetcher.fetch_daily_papers")
def test_process_papers_filters_unrelated_paper(mock_fetch, mock_triage, mock_capture):
    mock_fetch.return_value = [
        _make_paper("2503.88888", "3D Gaussian Splatting Revisited", upvotes=5,
                    ai_keywords=["3d reconstruction"]),
    ]

    stats = process_papers(dry_run=False)

    assert stats["filtered"] == 1
    assert stats["captured"] == 0
    mock_triage.assert_not_called()
    mock_capture.assert_not_called()


@patch("pipeline.hf_papers.fetcher.capture_thought")
@patch("pipeline.hf_papers.fetcher.triage_paper")
@patch("pipeline.hf_papers.fetcher.fetch_daily_papers")
def test_process_papers_skips_low_actionability(mock_fetch, mock_triage, mock_capture):
    mock_fetch.return_value = [
        _make_paper("2503.77777", "Some LLM Paper", upvotes=10,
                    ai_keywords=["large language models"]),
    ]
    mock_triage.return_value = {
        "summary": "Marginal.",
        "category": "learning",
        "actionability": "archive",
        "key_topics": ["misc"],
        "tools_mentioned": [],
        "urls": [],
    }

    stats = process_papers(dry_run=False)

    assert stats["captured"] == 0
    assert stats["filtered"] == 1
    mock_capture.assert_not_called()


@patch("pipeline.hf_papers.fetcher.capture_thought")
@patch("pipeline.hf_papers.fetcher.triage_paper")
@patch("pipeline.hf_papers.fetcher.fetch_daily_papers")
def test_process_papers_dry_run_skips_capture(mock_fetch, mock_triage, mock_capture):
    mock_fetch.return_value = [
        _make_paper("2503.66666", "LLM Reasoning Paper",
                    ai_keywords=["large language models"]),
    ]

    stats = process_papers(dry_run=True)

    assert stats["captured"] == 1
    mock_triage.assert_not_called()
    mock_capture.assert_not_called()
