"""Tests for async bulk import client."""

import asyncio
import json
import pytest
from aioresponses import aioresponses
from benchmark.bulk_import import capture_thought_async, ingest_brain, ThoughtRecord

MCP_URL = "https://test.supabase.co/functions/v1/open-brain-mcp"
API_KEY = "ob_bench_test_key"


def _ok_response(thought_id: str = "uuid-1", merged: bool = False):
    content = json.dumps({"id": thought_id, "merged": merged})
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {"content": [{"type": "text", "text": content}]},
    }


def _merged_response():
    content = json.dumps({"id": "uuid-orig", "merged": True})
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {"content": [{"type": "text", "text": content}]},
    }


def _error_response(status: int = 500):
    return {"error": "internal error"}


@pytest.mark.asyncio
async def test_capture_thought_success():
    with aioresponses() as m:
        m.post(MCP_URL, payload=_ok_response("uuid-abc"))
        result = await capture_thought_async(
            mcp_url=MCP_URL,
            api_key=API_KEY,
            content="test thought",
            source="benchmark",
            source_event_id="q_001_0",
        )
        assert result["id"] == "uuid-abc"
        assert result["merged"] is False


@pytest.mark.asyncio
async def test_capture_thought_merged():
    with aioresponses() as m:
        m.post(MCP_URL, payload=_merged_response())
        result = await capture_thought_async(
            mcp_url=MCP_URL,
            api_key=API_KEY,
            content="duplicate thought",
            source="benchmark",
            source_event_id="q_001_1",
        )
        assert result["merged"] is True


@pytest.mark.asyncio
async def test_capture_thought_retries_on_429():
    with aioresponses() as m:
        m.post(MCP_URL, status=429, headers={"Retry-After": "0"})
        m.post(MCP_URL, payload=_ok_response("uuid-retry"))
        result = await capture_thought_async(
            mcp_url=MCP_URL,
            api_key=API_KEY,
            content="thought",
            source="benchmark",
            source_event_id="q_001_0",
            max_retries=3,
            backoff_base=0.01,
        )
        assert result["id"] == "uuid-retry"


@pytest.mark.asyncio
async def test_capture_thought_retries_on_500():
    with aioresponses() as m:
        m.post(MCP_URL, status=500)
        m.post(MCP_URL, payload=_ok_response("uuid-recovered"))
        result = await capture_thought_async(
            mcp_url=MCP_URL,
            api_key=API_KEY,
            content="thought",
            source="benchmark",
            source_event_id="q_001_0",
            max_retries=3,
            backoff_base=0.01,
        )
        assert result["id"] == "uuid-recovered"


@pytest.mark.asyncio
async def test_capture_thought_raises_after_max_retries():
    with aioresponses() as m:
        for _ in range(3):
            m.post(MCP_URL, status=500)
        with pytest.raises(RuntimeError, match="failed after 3 retries"):
            await capture_thought_async(
                mcp_url=MCP_URL,
                api_key=API_KEY,
                content="thought",
                source="benchmark",
                source_event_id="q_001_0",
                max_retries=3,
                backoff_base=0.01,
            )


@pytest.mark.asyncio
async def test_capture_thought_no_retry_on_400():
    with aioresponses() as m:
        m.post(MCP_URL, status=400)
        with pytest.raises(RuntimeError, match="400"):
            await capture_thought_async(
                mcp_url=MCP_URL,
                api_key=API_KEY,
                content="thought",
                source="benchmark",
                source_event_id="q_001_0",
                max_retries=3,
                backoff_base=0.01,
            )


@pytest.mark.asyncio
async def test_ingest_brain_sequential():
    """Verify thoughts are ingested in order (sequential within brain)."""
    call_order = []

    with aioresponses() as m:
        for i in range(3):

            def make_callback(idx):
                async def callback(url, **kwargs):
                    call_order.append(idx)
                return callback

            m.post(
                MCP_URL,
                payload=_ok_response(f"uuid-{i}"),
                callback=make_callback(i),
            )

        thoughts = [
            ThoughtRecord(content=f"thought {i}", source_event_id=f"q_001_{i}")
            for i in range(3)
        ]
        results = await ingest_brain(
            mcp_url=MCP_URL,
            api_key=API_KEY,
            thoughts=thoughts,
            source="benchmark",
        )
        assert len(results) == 3
        assert all(r["id"].startswith("uuid-") for r in results)
        assert call_order == [0, 1, 2]


@pytest.mark.asyncio
async def test_ingest_brain_continues_after_thought_failure():
    """A failed thought should not stop the brain — error is captured in results."""
    with aioresponses() as m:
        m.post(MCP_URL, payload=_ok_response("uuid-0"))
        m.post(MCP_URL, status=500)
        m.post(MCP_URL, status=500)
        m.post(MCP_URL, status=500)  # 3 retries exhausted
        m.post(MCP_URL, payload=_ok_response("uuid-2"))

        thoughts = [
            ThoughtRecord(content=f"thought {i}", source_event_id=f"q_001_{i}")
            for i in range(3)
        ]
        results = await ingest_brain(
            mcp_url=MCP_URL,
            api_key=API_KEY,
            thoughts=thoughts,
            source="benchmark",
            max_retries=3,
            backoff_base=0.01,
        )
        assert len(results) == 3
        assert results[0]["id"] == "uuid-0"
        assert "error" in results[1]
        assert results[2]["id"] == "uuid-2"
