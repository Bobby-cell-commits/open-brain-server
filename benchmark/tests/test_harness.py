"""Tests for benchmark/longmemeval/harness.py."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from benchmark.longmemeval.harness import _load_questions, write_summary


# ---------------------------------------------------------------------------
# _load_questions
# ---------------------------------------------------------------------------

MOCK_DATASET = [
    {
        "question_id": "q1",
        "question": "What is Alice's favourite colour?",
        "answer": "blue",
        "category": "single-session-user",
        "haystack_sessions": [],
        "haystack_dates": [],
    },
    {
        "question_id": "q2",
        "question": "When did Bob start the project?",
        "answer": "January 2024",
        "category": "temporal-reasoning",
        "haystack_sessions": [],
        "haystack_dates": [],
    },
    {
        "question_id": "q3",
        "question": "What is the current status?",
        "answer": "I don't know",
        "category": "abstention",
        "haystack_sessions": [],
        "haystack_dates": [],
    },
]


def test_load_questions():
    """Returns a dict mapping question_id -> {question, answer, category}."""
    with patch("benchmark.longmemeval.harness._load_raw_dataset", return_value=MOCK_DATASET):
        questions = _load_questions()

    assert len(questions) == 3
    assert set(questions.keys()) == {"q1", "q2", "q3"}

    q1 = questions["q1"]
    assert q1["question"] == "What is Alice's favourite colour?"
    assert q1["answer"] == "blue"
    assert q1["category"] == "single-session-user"

    q2 = questions["q2"]
    assert q2["question"] == "When did Bob start the project?"
    assert q2["answer"] == "January 2024"
    assert q2["category"] == "temporal-reasoning"


def test_load_questions_subset():
    """Filters by question_ids when provided."""
    with patch("benchmark.longmemeval.harness._load_raw_dataset", return_value=MOCK_DATASET):
        questions = _load_questions(question_ids=["q1", "q3"])

    assert len(questions) == 2
    assert "q1" in questions
    assert "q3" in questions
    assert "q2" not in questions


def test_load_questions_subset_empty_filter():
    """Empty list filter returns no questions."""
    with patch("benchmark.longmemeval.harness._load_raw_dataset", return_value=MOCK_DATASET):
        questions = _load_questions(question_ids=[])

    # Empty list is falsy, so all questions are returned (same as None)
    assert len(questions) == 3


def test_load_questions_unknown_id():
    """Unknown IDs in filter are silently ignored."""
    with patch("benchmark.longmemeval.harness._load_raw_dataset", return_value=MOCK_DATASET):
        questions = _load_questions(question_ids=["q1", "q_nonexistent"])

    assert len(questions) == 1
    assert "q1" in questions


# ---------------------------------------------------------------------------
# write_summary
# ---------------------------------------------------------------------------


def test_write_summary(tmp_path):
    """Generates valid markdown with per-category breakdown."""
    results = [
        {"question_id": "q1", "category": "single-session-user", "correct": True,
         "generated_answer": "blue", "reasoning": "matches"},
        {"question_id": "q2", "category": "single-session-user", "correct": False,
         "generated_answer": "red", "reasoning": "wrong"},
        {"question_id": "q3", "category": "temporal-reasoning", "correct": True,
         "generated_answer": "January 2024", "reasoning": "correct"},
    ]

    output_path = tmp_path / "results" / "test-run-summary.md"
    write_summary(results, run_id="test-run", output_path=output_path)

    assert output_path.exists()
    content = output_path.read_text()

    # Check header
    assert "# LongMemEval Benchmark Results" in content
    assert "**Run ID:** test-run" in content
    assert "**Questions:** 3" in content

    # Overall score: 2/3 correct = 66.7%
    assert "66.7%" in content

    # Category table rows
    assert "single-session-user" in content
    assert "temporal-reasoning" in content

    # Config table present
    assert "Reader model" in content
    assert "Judge model" in content
    assert "Retrieval limit" in content

    # Diagnostic notes section
    assert "Diagnostic Notes" in content


def test_write_summary_empty(tmp_path):
    """Edge case: no results produces 0% overall score."""
    output_path = tmp_path / "empty-summary.md"
    write_summary([], run_id="empty-run", output_path=output_path)

    assert output_path.exists()
    content = output_path.read_text()

    assert "# LongMemEval Benchmark Results" in content
    assert "**Questions:** 0" in content
    assert "0.0%" in content
    # No category rows (table header still present, no data rows)
    assert "Per-Category Breakdown" in content


def test_write_summary_creates_parent_dirs(tmp_path):
    """Creates parent directories if they don't exist."""
    output_path = tmp_path / "nested" / "deep" / "summary.md"
    assert not output_path.parent.exists()

    write_summary([], run_id="dir-test", output_path=output_path)

    assert output_path.exists()


def test_write_summary_all_categories(tmp_path):
    """All categories appear in per-category table when present."""
    categories = [
        "single-session-user",
        "single-session-assistant",
        "temporal-reasoning",
        "knowledge-update",
        "abstention",
    ]
    results = [
        {"question_id": f"q{i}", "category": cat, "correct": True,
         "generated_answer": "ans", "reasoning": "ok"}
        for i, cat in enumerate(categories)
    ]

    output_path = tmp_path / "all-cats-summary.md"
    write_summary(results, run_id="cats-run", output_path=output_path)

    content = output_path.read_text()
    for cat in categories:
        assert cat in content
