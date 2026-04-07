"""Async MCP client for bulk thought ingestion.

Calls capture_thought via JSON-RPC POST to the open-brain-mcp Edge Function.
Handles retries, rate limiting, and concurrency control.
"""

import asyncio
import json
from dataclasses import dataclass
from typing import Callable

import aiohttp

from benchmark.config import MAX_RETRIES, BACKOFF_BASE_SECONDS, SOURCE


@dataclass
class ThoughtRecord:
    content: str
    source_event_id: str


async def capture_thought_async(
    mcp_url: str,
    api_key: str,
    content: str,
    source: str,
    source_event_id: str,
    session: aiohttp.ClientSession | None = None,
    max_retries: int = MAX_RETRIES,
    backoff_base: float = BACKOFF_BASE_SECONDS,
) -> dict:
    """Capture a single thought via the MCP endpoint with retry logic.

    Returns dict with 'id' and 'merged' keys.
    Raises RuntimeError on non-retryable errors or after max retries.
    """
    payload = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "id": 1,
        "params": {
            "name": "capture_thought",
            "arguments": {
                "content": content,
                "source": source,
                "source_event_id": source_event_id,
            },
        },
    }
    headers = {
        "Content-Type": "application/json",
        "x-brain-key": api_key,
    }

    own_session = session is None
    if own_session:
        session = aiohttp.ClientSession()

    try:
        for attempt in range(max_retries):
            try:
                async with session.post(mcp_url, json=payload, headers=headers) as resp:
                    if resp.status == 429 or resp.status >= 500:
                        if attempt < max_retries - 1:
                            retry_after = resp.headers.get("Retry-After")
                            wait = float(retry_after) if retry_after else backoff_base * (2 ** attempt)
                            await asyncio.sleep(wait)
                            continue
                        raise RuntimeError(
                            f"capture_thought failed after {max_retries} retries: HTTP {resp.status}"
                        )
                    if resp.status != 200:
                        text = await resp.text()
                        raise RuntimeError(
                            f"capture_thought error: HTTP {resp.status}: {text[:300]}"
                        )
                    result = await resp.json()
                    if "error" in result:
                        raise RuntimeError(f"JSON-RPC error: {result['error']}")

                    # Parse the MCP tool response
                    text_content = result["result"]["content"][0]["text"]
                    return json.loads(text_content)
            except aiohttp.ClientError as e:
                if attempt < max_retries - 1:
                    await asyncio.sleep(backoff_base * (2 ** attempt))
                    continue
                raise RuntimeError(
                    f"capture_thought failed after {max_retries} retries: {e}"
                ) from e

        raise RuntimeError(f"capture_thought failed after {max_retries} retries")
    finally:
        if own_session:
            await session.close()


async def ingest_brain(
    mcp_url: str,
    api_key: str,
    thoughts: list[ThoughtRecord],
    source: str = SOURCE,
    on_progress: Callable[[int, int, dict], None] | None = None,
    max_retries: int = MAX_RETRIES,
    backoff_base: float = BACKOFF_BASE_SECONDS,
) -> list[dict]:
    """Ingest thoughts sequentially into one brain.

    Returns list of capture results (one per thought, in order).
    """
    results = []
    async with aiohttp.ClientSession() as session:
        for i, thought in enumerate(thoughts):
            try:
                result = await capture_thought_async(
                    mcp_url=mcp_url,
                    api_key=api_key,
                    content=thought.content,
                    source=source,
                    source_event_id=thought.source_event_id,
                    session=session,
                    max_retries=max_retries,
                    backoff_base=backoff_base,
                )
            except Exception as e:
                result = {"error": str(e), "source_event_id": thought.source_event_id}
            results.append(result)
            if on_progress:
                on_progress(i + 1, len(thoughts), result)
    return results


async def bulk_ingest(
    mcp_url: str,
    brain_plans: dict[str, dict],  # question_id -> {"api_key": str, "thoughts": list[ThoughtRecord]}
    concurrency: int = 10,
    source: str = SOURCE,
    on_progress: Callable[[str, int, int, int, dict], None] | None = None,
    on_brain_complete: Callable[[str], None] | None = None,
    max_retries: int = MAX_RETRIES,
    backoff_base: float = BACKOFF_BASE_SECONDS,
) -> dict[str, list[dict] | BaseException]:
    """Ingest thoughts across multiple brains with concurrency control.

    Args:
        mcp_url: MCP endpoint URL
        brain_plans: mapping of question_id to {api_key, thoughts}
        concurrency: max concurrent brain ingestions
        source: source identifier for all thoughts
        on_progress: callback(question_id, thought_idx, brain_total, global_completed, result)
        on_brain_complete: callback(question_id) — called after each brain finishes

    Returns dict of question_id -> list of capture results.
    """
    semaphore = asyncio.Semaphore(concurrency)
    all_results: dict[str, list[dict] | BaseException] = {}
    global_completed = 0
    lock = asyncio.Lock()

    async def _ingest_one_brain(question_id: str, plan: dict) -> None:
        nonlocal global_completed
        async with semaphore:
            def progress_cb(idx: int, total: int, result: dict) -> None:
                nonlocal global_completed
                # Note: not perfectly atomic, but good enough for progress display
                global_completed += 1
                if on_progress:
                    on_progress(question_id, idx, total, global_completed, result)

            results = await ingest_brain(
                mcp_url=mcp_url,
                api_key=plan["api_key"],
                thoughts=plan["thoughts"],
                source=source,
                on_progress=progress_cb,
                max_retries=max_retries,
                backoff_base=backoff_base,
            )
            async with lock:
                all_results[question_id] = results
            if on_brain_complete:
                on_brain_complete(question_id)

    brain_ids = list(brain_plans.keys())
    tasks = [
        _ingest_one_brain(qid, brain_plans[qid])
        for qid in brain_ids
    ]
    gather_results = await asyncio.gather(*tasks, return_exceptions=True)
    # Store exceptions for brains that failed at the gather level
    for qid, result in zip(brain_ids, gather_results):
        if isinstance(result, BaseException) and qid not in all_results:
            all_results[qid] = result
    return all_results
