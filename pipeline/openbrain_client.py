"""JSON-RPC client for Open Brain MCP server."""

import time
import requests
from pipeline.config import OPENBRAIN_MCP_URL, OPENBRAIN_KEY

_request_id = 0

TIMEOUT = 60
MAX_RETRIES = 3


def _next_id() -> int:
    global _request_id
    _request_id += 1
    return _request_id


def call_tool(tool_name: str, arguments: dict) -> dict:
    """Call an Open Brain MCP tool via JSON-RPC with retry on timeout."""
    payload = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "id": _next_id(),
        "params": {
            "name": tool_name,
            "arguments": arguments,
        },
    }
    headers = {
        "Content-Type": "application/json",
        "x-brain-key": OPENBRAIN_KEY(),
    }

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(
                OPENBRAIN_MCP_URL(),
                headers=headers,
                json=payload,
                timeout=TIMEOUT,
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"MCP call failed ({resp.status_code}): {resp.text[:500]}"
                )
            result = resp.json()
            if "error" in result:
                raise RuntimeError(f"MCP error: {result['error']}")
            return result
        except requests.exceptions.Timeout:
            if attempt < MAX_RETRIES - 1:
                wait = 5 * (attempt + 1)
                print(f"    MCP timeout, retrying in {wait}s ({attempt + 1}/{MAX_RETRIES})...")
                time.sleep(wait)
            else:
                raise
    raise RuntimeError("Unreachable")


def capture_thought(content: str, source: str | None = None,
                    source_event_id: str | None = None) -> dict:
    """Capture a thought via Open Brain.

    Args:
        content: The thought text.
        source: Source identifier (e.g. 'reddit', 'rss', 'slack'). Defaults to 'mcp'.
        source_event_id: Unique ID for idempotency (e.g. 't3_abc123').
    """
    args: dict = {"content": content}
    if source:
        args["source"] = source
    if source_event_id:
        args["source_event_id"] = source_event_id
    return call_tool("capture_thought", args)


def list_thoughts(days: int | None = None, limit: int = 20, thought_type: str | None = None) -> dict:
    """List recent thoughts."""
    args: dict = {"limit": limit}
    if days is not None:
        args["days"] = days
    if thought_type is not None:
        args["type"] = thought_type
    return call_tool("list_thoughts", args)


def search_thoughts(query: str, limit: int = 10) -> dict:
    """Semantic search for thoughts."""
    return call_tool("search_thoughts", {"query": query, "limit": limit})


def thought_stats(days: int | None = None) -> dict:
    """Get aggregate statistics from Open Brain. Pass days to limit to last N days."""
    args = {"days": days} if days is not None else {}
    return call_tool("thought_stats", args)


def report_pipeline_run(
    source: str,
    captured: int,
    failed: int,
    skipped: int,
    execution_ms: int,
    error_message: str | None = None,
) -> None:
    """Report a pipeline run to the monitoring system. Fire-and-forget."""
    try:
        monitor_url = OPENBRAIN_MCP_URL().replace("/open-brain-mcp", "/monitor-pipeline")
        requests.post(
            monitor_url,
            headers={
                "x-brain-key": OPENBRAIN_KEY(),
                "Content-Type": "application/json",
            },
            json={
                "log_run": {
                    "source": source,
                    "trigger": "local_python",
                    "status": (
                        "failure" if error_message
                        else "partial_failure" if failed > 0
                        else "success"
                    ),
                    "captured": captured,
                    "failed": failed,
                    "skipped": skipped,
                    "execution_ms": execution_ms,
                    "error_message": error_message,
                }
            },
            timeout=10,
        )
    except Exception:
        pass  # Monitoring should never break the pipeline
