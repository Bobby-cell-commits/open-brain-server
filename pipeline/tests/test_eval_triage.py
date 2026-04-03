"""Tests for triage eval harness."""

import json
from unittest.mock import patch
from pipeline.eval_triage import score_predictions, load_labeled_data


def _make_item(category, actionability, split="train"):
    return {
        "id": "test-id",
        "content": "test content",
        "source": "reddit",
        "ground_truth": {
            "category": category,
            "actionability": actionability,
        },
        "split": split,
    }


def test_perfect_score():
    """All predictions match ground truth -> 100.0"""
    items = [_make_item("learning", "medium")]
    predictions = [{"category": "learning", "actionability": "medium"}]
    assert score_predictions(items, predictions) == 100.0


def test_zero_score():
    """No predictions match -> 0.0"""
    items = [_make_item("learning", "medium")]
    predictions = [{"category": "personal", "actionability": "high"}]
    assert score_predictions(items, predictions) == 0.0


def test_partial_score():
    """Category matches, actionability doesn't -> 50.0"""
    items = [_make_item("learning", "medium")]
    predictions = [{"category": "learning", "actionability": "high"}]
    assert score_predictions(items, predictions) == 50.0


def test_multiple_items():
    """2 items: one perfect, one zero -> 50.0"""
    items = [
        _make_item("learning", "medium"),
        _make_item("claude-code", "high"),
    ]
    predictions = [
        {"category": "learning", "actionability": "medium"},
        {"category": "personal", "actionability": "low"},
    ]
    assert score_predictions(items, predictions) == 50.0


def test_split_filtering():
    """load_labeled_data filters by split."""
    data = [
        _make_item("learning", "medium", split="train"),
        _make_item("claude-code", "high", split="holdout"),
    ]
    with patch("pipeline.eval_triage.LABELED_DATA_PATH") as mock_path:
        mock_path.read_text.return_value = json.dumps(data)
        train_items = load_labeled_data(split="train")
        assert len(train_items) == 1
        assert train_items[0]["ground_truth"]["category"] == "learning"
