"""Tests for async retrieval module."""

import json
import pytest
from aioresponses import aioresponses
from benchmark.longmemeval.retrieve import search_thoughts_async, retrieve_all

MCP_URL = "https://test.supabase.co/functions/v1/open-brain-mcp"
API_KEY = "ob_bench_test_key"


def _search_response(thoughts: list[dict] | None = None):
    """Build a standard MCP search_thoughts response."""
    if thoughts is None:
        thoughts = [
            {
                "id": "uuid-1",
                "content": "Alice bought a coffee maker last Tuesday.",
                "similarity": 0.87,
                "created_at": "2024-01-15T10:00:00Z",
            }
        ]
    content = json.dumps(thoughts)
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {"content": [{"type": "text", "text": content}]},
    }


def _empty_search_response():
    return _search_response(thoughts=[])


@pytest.mark.asyncio
async def test_search_thoughts_success():
    """Returns parsed list of thought dicts on a successful call."""
    with aioresponses() as m:
        m.post(MCP_URL, payload=_search_response())
        results = await search_thoughts_async(
            mcp_url=MCP_URL,
            api_key=API_KEY,
            query="What did Alice buy?",
        )
        assert len(results) == 1
        assert results[0]["id"] == "uuid-1"
        assert "content" in results[0]
        assert "created_at" in results[0]


@pytest.mark.asyncio
async def test_search_thoughts_retries_on_429():
    """Retries on 429 and succeeds on the next attempt."""
    with aioresponses() as m:
        m.post(MCP_URL, status=429, headers={"Retry-After": "0"})
        m.post(MCP_URL, payload=_search_response())
        results = await search_thoughts_async(
            mcp_url=MCP_URL,
            api_key=API_KEY,
            query="What did Alice buy?",
            max_retries=3,
            backoff_base=0.01,
        )
        assert len(results) == 1
        assert results[0]["id"] == "uuid-1"


@pytest.mark.asyncio
async def test_search_thoughts_empty_results():
    """Returns empty list when no thoughts match."""
    with aioresponses() as m:
        m.post(MCP_URL, payload=_empty_search_response())
        results = await search_thoughts_async(
            mcp_url=MCP_URL,
            api_key=API_KEY,
            query="something completely unknown",
        )
        assert results == []


@pytest.mark.asyncio
async def test_search_thoughts_raises_after_max_retries():
    """Raises RuntimeError after exhausting retries on 500."""
    with aioresponses() as m:
        for _ in range(3):
            m.post(MCP_URL, status=500)
        with pytest.raises(RuntimeError, match="failed after 3 retries"):
            await search_thoughts_async(
                mcp_url=MCP_URL,
                api_key=API_KEY,
                query="test query",
                max_retries=3,
                backoff_base=0.01,
            )


@pytest.mark.asyncio
async def test_search_thoughts_no_retry_on_400():
    """Does not retry on 4xx (non-429) errors."""
    with aioresponses() as m:
        m.post(MCP_URL, status=400)
        with pytest.raises(RuntimeError, match="400"):
            await search_thoughts_async(
                mcp_url=MCP_URL,
                api_key=API_KEY,
                query="test query",
                max_retries=3,
                backoff_base=0.01,
            )


@pytest.mark.asyncio
async def test_retrieve_all_parallel():
    """All questions get results; each uses its own api_key."""
    brain_questions = {
        "q001": {"api_key": "key-q001", "question": "What did Alice buy?"},
        "q002": {"api_key": "key-q002", "question": "Where did Bob go?"},
        "q003": {"api_key": "key-q003", "question": "When is the meeting?"},
    }

    thoughts_q001 = [{"id": "t1", "content": "Alice bought coffee", "created_at": "2024-01-15T10:00:00Z"}]
    thoughts_q002 = [{"id": "t2", "content": "Bob went to Paris", "created_at": "2024-01-16T10:00:00Z"}]
    thoughts_q003 = []  # no results for q003

    with aioresponses() as m:
        m.post(MCP_URL, payload=_search_response(thoughts_q001))
        m.post(MCP_URL, payload=_search_response(thoughts_q002))
        m.post(MCP_URL, payload=_search_response(thoughts_q003))

        results = await retrieve_all(
            mcp_url=MCP_URL,
            brain_questions=brain_questions,
            concurrency=3,
        )

    assert set(results.keys()) == {"q001", "q002", "q003"}
    # All three questions should have been processed
    assert all(isinstance(v, list) for v in results.values())
    # Total retrieved thoughts across all questions
    total = sum(len(v) for v in results.values())
    assert total == 2  # q001 + q002 each returned 1, q003 returned 0


@pytest.mark.asyncio
async def test_retrieve_all_progress_callback():
    """on_progress is called once per question."""
    brain_questions = {
        "q001": {"api_key": "key-q001", "question": "What did Alice buy?"},
        "q002": {"api_key": "key-q002", "question": "Where did Bob go?"},
    }
    progress_calls = []

    with aioresponses() as m:
        m.post(MCP_URL, payload=_search_response())
        m.post(MCP_URL, payload=_search_response())

        await retrieve_all(
            mcp_url=MCP_URL,
            brain_questions=brain_questions,
            concurrency=2,
            on_progress=lambda qid, results: progress_calls.append(qid),
        )

    assert sorted(progress_calls) == ["q001", "q002"]


@pytest.mark.asyncio
async def test_retrieve_all_error_isolation():
    """A failure on one question doesn't prevent others from completing."""
    brain_questions = {
        "q001": {"api_key": "key-q001", "question": "What did Alice buy?"},
        "q002": {"api_key": "key-q002", "question": "Where did Bob go?"},
    }

    with aioresponses() as m:
        # q001 will always fail (3 retries each exhausted)
        for _ in range(3):
            m.post(MCP_URL, status=500)
        # q002 succeeds
        m.post(MCP_URL, payload=_search_response([
            {"id": "t2", "content": "Bob went to Paris", "created_at": "2024-01-16T10:00:00Z"}
        ]))

        results = await retrieve_all(
            mcp_url=MCP_URL,
            brain_questions=brain_questions,
            concurrency=1,  # sequential to control order
        )

    assert "q001" in results
    assert "q002" in results
    # q001 failed — should have error entry
    assert len(results["q001"]) == 1
    assert "error" in results["q001"][0]
    # q002 succeeded
    assert results["q002"][0]["id"] == "t2"
