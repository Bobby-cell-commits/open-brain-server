"""Tests for dynamic focus terms in morning briefing."""
from unittest.mock import patch
import json
from pipeline.briefing.morning import generate_briefing


def _make_stats_response(topics: list[str]) -> dict:
    top_topics = [{"topic": t, "count": i + 1} for i, t in enumerate(reversed(topics))]
    payload = {"top_topics": top_topics, "total_thoughts": 10, "by_type": {}, "top_people": []}
    return {"result": {"content": [{"type": "text", "text": json.dumps(payload)}]}}


def test_dynamic_focus_terms_used_when_available():
    dynamic_topics = ["mcp-tools", "python-automation", "claude-api", "supabase", "local-llm"]
    with patch("pipeline.briefing.morning.thought_stats") as mock_stats, \
         patch("pipeline.briefing.morning.list_thoughts") as mock_list, \
         patch("pipeline.briefing.morning.search_thoughts") as mock_search:
        mock_stats.return_value = _make_stats_response(dynamic_topics)
        mock_list.return_value = {"result": {"content": [{"type": "text", "text": "[]"}]}}
        mock_search.return_value = {"result": {"content": [{"type": "text", "text": "[]"}]}}
        result = generate_briefing()
        for topic in dynamic_topics[:5]:
            assert f'"{topic}"' in result
        assert "Claude Code MCP tools" not in result
        assert "knowledge management" not in result


def test_fallback_to_focus_terms_on_stats_failure():
    with patch("pipeline.briefing.morning.thought_stats") as mock_stats, \
         patch("pipeline.briefing.morning.list_thoughts") as mock_list, \
         patch("pipeline.briefing.morning.search_thoughts") as mock_search:
        mock_stats.side_effect = RuntimeError("stats unavailable")
        mock_list.return_value = {"result": {"content": [{"type": "text", "text": "[]"}]}}
        mock_search.return_value = {"result": {"content": [{"type": "text", "text": "[]"}]}}
        result = generate_briefing()
        assert "Claude Code MCP tools" in result


def test_fallback_to_focus_terms_on_empty_topics():
    with patch("pipeline.briefing.morning.thought_stats") as mock_stats, \
         patch("pipeline.briefing.morning.list_thoughts") as mock_list, \
         patch("pipeline.briefing.morning.search_thoughts") as mock_search:
        mock_stats.return_value = _make_stats_response([])
        mock_list.return_value = {"result": {"content": [{"type": "text", "text": "[]"}]}}
        mock_search.return_value = {"result": {"content": [{"type": "text", "text": "[]"}]}}
        result = generate_briefing()
        assert "Claude Code MCP tools" in result
