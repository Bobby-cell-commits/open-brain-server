"""Tests for LongMemEval dataset loading and transformation."""

import pytest
from unittest.mock import patch, MagicMock
from benchmark.longmemeval.dataset import load_dataset_to_thoughts, session_to_content
from benchmark.bulk_import import ThoughtRecord


def _mock_question(question_id: str, num_sessions: int = 3):
    """Create a mock LongMemEval question with conversation sessions."""
    sessions = []
    for i in range(num_sessions):
        sessions.append([
            {"role": "user", "content": f"User message {i}"},
            {"role": "assistant", "content": f"Assistant response {i}"},
        ])
    return {
        "question_id": question_id,
        "question": f"What is the answer to {question_id}?",
        "answer": "42",
        "category": "single-session-user",
        "haystack_sessions": sessions,
        "haystack_dates": [f"2024-01-{i+1:02d}" for i in range(num_sessions)],
    }


def test_session_to_content():
    session = [
        {"role": "user", "content": "Hello there"},
        {"role": "assistant", "content": "Hi! How can I help?"},
        {"role": "user", "content": "What's 2+2?"},
        {"role": "assistant", "content": "It's 4."},
    ]
    result = session_to_content(session, session_index=0, date="2024-01-15")
    assert "[Session 0, 2024-01-15]" in result
    assert "User: Hello there" in result
    assert "Assistant: Hi! How can I help?" in result
    assert "User: What's 2+2?" in result
    assert "Assistant: It's 4." in result


def test_load_dataset_to_thoughts():
    questions = [
        _mock_question("q_001", num_sessions=2),
        _mock_question("q_002", num_sessions=3),
    ]

    with patch("benchmark.longmemeval.dataset._load_raw_dataset", return_value=questions):
        result = load_dataset_to_thoughts()

    assert set(result.keys()) == {"q_001", "q_002"}
    assert len(result["q_001"]) == 2
    assert len(result["q_002"]) == 3

    # Check ThoughtRecord fields
    first = result["q_001"][0]
    assert isinstance(first, ThoughtRecord)
    assert first.source_event_id == "q_001_0"
    assert "[Session 0, 2024-01-01]" in first.content


def test_load_dataset_question_subset():
    questions = [
        _mock_question("q_001", num_sessions=2),
        _mock_question("q_002", num_sessions=3),
        _mock_question("q_003", num_sessions=1),
    ]

    with patch("benchmark.longmemeval.dataset._load_raw_dataset", return_value=questions):
        result = load_dataset_to_thoughts(question_ids=["q_001", "q_003"])

    assert set(result.keys()) == {"q_001", "q_003"}


def test_session_content_respects_max_length():
    """Long sessions should be truncated to stay within OB's 10K char limit."""
    session = [
        {"role": "user", "content": "x" * 12000},
    ]
    result = session_to_content(session, session_index=0, date="2024-01-01")
    assert len(result) <= 10000
