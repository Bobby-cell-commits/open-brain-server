"""Tests for openbrain_client helpers."""
from unittest.mock import patch
from pipeline.openbrain_client import thought_stats


def test_thought_stats_no_days():
    """thought_stats() with no days calls tool with empty args."""
    with patch("pipeline.openbrain_client.call_tool") as mock_call:
        mock_call.return_value = {"result": {"content": [{"type": "text", "text": "{}"}]}}
        thought_stats()
        mock_call.assert_called_once_with("thought_stats", {})


def test_thought_stats_with_days():
    """thought_stats(days=7) passes days to call_tool."""
    with patch("pipeline.openbrain_client.call_tool") as mock_call:
        mock_call.return_value = {"result": {"content": [{"type": "text", "text": "{}"}]}}
        thought_stats(days=7)
        mock_call.assert_called_once_with("thought_stats", {"days": 7})
