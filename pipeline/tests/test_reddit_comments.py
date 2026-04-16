"""Tests for Reddit comment fetching and filtering."""

import pytest
from pipeline.reddit.subreddits import fetch_top_comments


def _make_comment(body: str, score: int, kind: str = "t1") -> dict:
    """Helper to create a Reddit comment structure."""
    return {"kind": kind, "data": {"body": body, "score": score}}


def _make_reddit_response(comments: list[dict]) -> list[dict]:
    """Wrap comments in Reddit's [post_listing, comment_listing] structure."""
    return [
        {"data": {"children": []}},  # post listing (unused)
        {"data": {"children": comments}},
    ]


class TestFetchTopComments:
    """Tests for fetch_top_comments()."""

    def test_returns_top_comments_by_score(self, monkeypatch):
        comments = [
            _make_comment("great post", 100),
            _make_comment("meh", 2),
            _make_comment("very useful", 50),
            _make_comment("agreed", 10),
        ]
        resp_json = _make_reddit_response(comments)

        import requests
        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return resp_json

        monkeypatch.setattr(requests, "get", lambda *a, **kw: FakeResp())

        result = fetch_top_comments("abc123", "test", score_threshold=5, max_comments=3)
        assert len(result) == 3
        assert result[0]["score"] == 100
        assert result[1]["score"] == 50
        assert result[2]["score"] == 10

    def test_filters_below_score_threshold(self, monkeypatch):
        comments = [
            _make_comment("low score", 2),
            _make_comment("also low", 4),
        ]
        resp_json = _make_reddit_response(comments)

        import requests
        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return resp_json

        monkeypatch.setattr(requests, "get", lambda *a, **kw: FakeResp())

        result = fetch_top_comments("abc123", "test", score_threshold=5, max_comments=3)
        assert result == []

    def test_filters_bot_comments(self, monkeypatch):
        comments = [
            _make_comment("I am a bot, and this action was performed automatically.", 100),
            _make_comment("real comment", 10),
        ]
        resp_json = _make_reddit_response(comments)

        import requests
        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return resp_json

        monkeypatch.setattr(requests, "get", lambda *a, **kw: FakeResp())

        result = fetch_top_comments("abc123", "test", score_threshold=5, max_comments=3)
        assert len(result) == 1
        assert result[0]["body"] == "real comment"

    def test_filters_deleted_and_removed(self, monkeypatch):
        comments = [
            _make_comment("[removed]", 50),
            _make_comment("[deleted]", 40),
            _make_comment("real", 10),
        ]
        resp_json = _make_reddit_response(comments)

        import requests
        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return resp_json

        monkeypatch.setattr(requests, "get", lambda *a, **kw: FakeResp())

        result = fetch_top_comments("abc123", "test", score_threshold=5, max_comments=3)
        assert len(result) == 1
        assert result[0]["body"] == "real"

    def test_skips_non_comment_kinds(self, monkeypatch):
        comments = [
            _make_comment("real", 50, kind="t1"),
            {"kind": "more", "data": {"body": "load more", "score": 999}},
        ]
        resp_json = _make_reddit_response(comments)

        import requests
        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return resp_json

        monkeypatch.setattr(requests, "get", lambda *a, **kw: FakeResp())

        result = fetch_top_comments("abc123", "test", score_threshold=5, max_comments=3)
        assert len(result) == 1

    def test_returns_empty_on_http_error(self, monkeypatch):
        import requests
        def raise_err(*a, **kw):
            raise requests.RequestException("timeout")

        monkeypatch.setattr(requests, "get", raise_err)

        result = fetch_top_comments("abc123", "test", score_threshold=5, max_comments=3)
        assert result == []

    def test_truncates_long_comment_bodies(self, monkeypatch):
        long_body = "x" * 600
        comments = [_make_comment(long_body, 50)]
        resp_json = _make_reddit_response(comments)

        import requests
        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return resp_json

        monkeypatch.setattr(requests, "get", lambda *a, **kw: FakeResp())

        result = fetch_top_comments("abc123", "test", score_threshold=5, max_comments=3)
        assert len(result[0]["body"]) <= 500


from pipeline.reddit.subreddits import format_enriched_content


class TestFormatEnrichedContent:
    """Tests for comment rendering in enriched content."""

    def _make_post(self, subreddit="ExperiencedDevs"):
        return {
            "subreddit": subreddit,
            "title": "Test Post",
            "selftext": "Some content",
            "url": "",
            "permalink": f"/r/{subreddit}/comments/abc/test/",
        }

    def _make_triage(self):
        return {
            "summary": "A test summary",
            "category": "learning",
            "actionability": "medium",
            "key_topics": ["testing"],
            "tools_mentioned": [],
        }

    def test_includes_comments_when_provided(self):
        comments = [
            {"body": "Great insight here", "score": 193},
            {"body": "Disagree because...", "score": 42},
        ]
        result = format_enriched_content(self._make_post(), self._make_triage(), comments)
        assert "Notable comments:" in result
        assert "[score=193]" in result
        assert "Great insight here" in result
        assert "[score=42]" in result

    def test_omits_comments_section_when_empty(self):
        result = format_enriched_content(self._make_post(), self._make_triage(), [])
        assert "Notable comments:" not in result

    def test_backward_compatible_without_comments_arg(self):
        result = format_enriched_content(self._make_post(), self._make_triage())
        assert "Notable comments:" not in result
        assert "[Reddit r/ExperiencedDevs]" in result


from unittest.mock import patch, MagicMock
from pipeline.reddit.subreddits import process_subreddits


class TestProcessSubredditsComments:
    """Tests for comment integration in process_subreddits."""

    def _mock_tracker(self):
        return MagicMock(is_processed=lambda x: False, mark_processed=lambda *a: None)

    @patch("pipeline.reddit.subreddits.fetch_top_comments")
    @patch("pipeline.reddit.subreddits.capture_thought")
    @patch("pipeline.reddit.subreddits.triage")
    @patch("pipeline.reddit.subreddits.fetch_hot")
    def test_fetches_comments_for_enabled_subs(
        self, mock_fetch_hot, mock_triage, mock_capture, mock_fetch_comments,
        monkeypatch,
    ):
        monkeypatch.setattr("pipeline.reddit.subreddits.MONITORED_SUBREDDITS", ["ExperiencedDevs"])
        monkeypatch.setattr("pipeline.reddit.subreddits.COMMENT_ENABLED_SUBS", {"ExperiencedDevs"})
        monkeypatch.setattr("pipeline.reddit.subreddits.COMMENT_MIN_POST_COMMENTS", 3)
        monkeypatch.setattr("pipeline.reddit.subreddits.ITEM_DELAY_SECONDS", 0)

        mock_fetch_hot.return_value = [{
            "id": "abc123",
            "title": "Test post",
            "selftext": "Content here",
            "url": "",
            "subreddit": "ExperiencedDevs",
            "permalink": "/r/ExperiencedDevs/comments/abc123/test/",
            "num_comments": 50,
        }]
        mock_triage.return_value = {
            "summary": "Test", "category": "learning",
            "actionability": "medium", "key_topics": ["test"], "tools_mentioned": [],
        }
        mock_fetch_comments.return_value = [
            {"body": "Insightful comment", "score": 100},
        ]
        mock_capture.return_value = {"result": "ok"}
        monkeypatch.setattr(
            "pipeline.reddit.subreddits.DedupTracker", lambda f: self._mock_tracker(),
        )

        stats = process_subreddits()
        mock_fetch_comments.assert_called_once_with("abc123", "ExperiencedDevs")
        captured_content = mock_capture.call_args[0][0]
        assert "Insightful comment" in captured_content

    @patch("pipeline.reddit.subreddits.fetch_top_comments")
    @patch("pipeline.reddit.subreddits.capture_thought")
    @patch("pipeline.reddit.subreddits.triage")
    @patch("pipeline.reddit.subreddits.fetch_hot")
    def test_skips_comments_for_non_enabled_subs(
        self, mock_fetch_hot, mock_triage, mock_capture, mock_fetch_comments,
        monkeypatch,
    ):
        monkeypatch.setattr("pipeline.reddit.subreddits.MONITORED_SUBREDDITS", ["singularity"])
        monkeypatch.setattr("pipeline.reddit.subreddits.COMMENT_ENABLED_SUBS", {"ExperiencedDevs"})
        monkeypatch.setattr("pipeline.reddit.subreddits.ITEM_DELAY_SECONDS", 0)

        mock_fetch_hot.return_value = [{
            "id": "def456",
            "title": "Hype post",
            "selftext": "AGI tomorrow",
            "url": "",
            "subreddit": "singularity",
            "permalink": "/r/singularity/comments/def456/hype/",
            "num_comments": 200,
        }]
        mock_triage.return_value = {
            "summary": "Hype", "category": "learning",
            "actionability": "low", "key_topics": ["agi"], "tools_mentioned": [],
        }
        mock_capture.return_value = {"result": "ok"}
        monkeypatch.setattr(
            "pipeline.reddit.subreddits.DedupTracker", lambda f: self._mock_tracker(),
        )

        stats = process_subreddits()
        mock_fetch_comments.assert_not_called()

    @patch("pipeline.reddit.subreddits.fetch_top_comments")
    @patch("pipeline.reddit.subreddits.capture_thought")
    @patch("pipeline.reddit.subreddits.triage")
    @patch("pipeline.reddit.subreddits.fetch_hot")
    def test_skips_comments_when_post_has_few_comments(
        self, mock_fetch_hot, mock_triage, mock_capture, mock_fetch_comments,
        monkeypatch,
    ):
        monkeypatch.setattr("pipeline.reddit.subreddits.MONITORED_SUBREDDITS", ["ExperiencedDevs"])
        monkeypatch.setattr("pipeline.reddit.subreddits.COMMENT_ENABLED_SUBS", {"ExperiencedDevs"})
        monkeypatch.setattr("pipeline.reddit.subreddits.COMMENT_MIN_POST_COMMENTS", 3)
        monkeypatch.setattr("pipeline.reddit.subreddits.ITEM_DELAY_SECONDS", 0)

        mock_fetch_hot.return_value = [{
            "id": "ghi789",
            "title": "Quiet post",
            "selftext": "Not much here",
            "url": "",
            "subreddit": "ExperiencedDevs",
            "permalink": "/r/ExperiencedDevs/comments/ghi789/quiet/",
            "num_comments": 1,
        }]
        mock_triage.return_value = {
            "summary": "Quiet", "category": "learning",
            "actionability": "low", "key_topics": ["test"], "tools_mentioned": [],
        }
        mock_capture.return_value = {"result": "ok"}
        monkeypatch.setattr(
            "pipeline.reddit.subreddits.DedupTracker", lambda f: self._mock_tracker(),
        )

        stats = process_subreddits()
        mock_fetch_comments.assert_not_called()
