"""Async retrieval module for LongMemEval benchmark.

Queries Open Brain's MCP endpoint to fetch context for each question.
"""

import asyncio
import json
from typing import Callable

import aiohttp

from benchmark.config import MAX_RETRIES, BACKOFF_BASE_SECONDS, DEFAULT_CONCURRENCY
from benchmark.longmemeval.config import (
    RETRIEVAL_LIMIT,
    RETRIEVAL_THRESHOLD,
    RETRIEVAL_EXPAND,
    RETRIEVAL_MIN_QUALITY,
)


async def search_thoughts_async(
    mcp_url: str,
    api_key: str,
    query: str,
    session: aiohttp.ClientSession | None = None,
    limit: int = RETRIEVAL_LIMIT,
    threshold: float = RETRIEVAL_THRESHOLD,
    expand: bool = RETRIEVAL_EXPAND,
    min_quality: int = RETRIEVAL_MIN_QUALITY,
    max_retries: int = MAX_RETRIES,
    backoff_base: float = BACKOFF_BASE_SECONDS,
) -> list[dict]:
    """Search thoughts for a single question via the MCP endpoint.

    Returns list of thought dicts (each with at minimum content and created_at).
    Raises RuntimeError on non-retryable errors or after max retries.
    """
    payload = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "id": 1,
        "params": {
            "name": "search_thoughts",
            "arguments": {
                "query": query,
                "limit": limit,
                "threshold": threshold,
                "min_quality": min_quality,
                "expand": expand,
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
                            f"search_thoughts failed after {max_retries} retries: HTTP {resp.status}"
                        )
                    if resp.status != 200:
                        text = await resp.text()
                        raise RuntimeError(
                            f"search_thoughts error: HTTP {resp.status}: {text[:300]}"
                        )
                    result = await resp.json()
                    if "error" in result:
                        raise RuntimeError(f"JSON-RPC error: {result['error']}")

                    # Parse the MCP tool response
                    text_content = result["result"]["content"][0]["text"]
                    parsed = json.loads(text_content)
                    # search_thoughts returns a list of thought objects directly
                    if isinstance(parsed, list):
                        return parsed
                    # Some responses wrap results in a "results" key
                    return parsed.get("results", [])
            except aiohttp.ClientError as e:
                if attempt < max_retries - 1:
                    await asyncio.sleep(backoff_base * (2 ** attempt))
                    continue
                raise RuntimeError(
                    f"search_thoughts failed after {max_retries} retries: {e}"
                ) from e

        raise RuntimeError(f"search_thoughts failed after {max_retries} retries")
    finally:
        if own_session:
            await session.close()


async def retrieve_all(
    mcp_url: str,
    brain_questions: dict[str, dict],  # question_id -> {"api_key": str, "question": str}
    concurrency: int = DEFAULT_CONCURRENCY,
    on_progress: Callable | None = None,
) -> dict[str, list[dict]]:
    """Retrieve context for all questions in parallel.

    Args:
        mcp_url: MCP endpoint URL
        brain_questions: mapping of question_id to {api_key, question}
        concurrency: max concurrent search requests
        on_progress: optional callback(question_id, results) called after each retrieval

    Returns dict of question_id -> list of retrieved thought dicts.
    """
    semaphore = asyncio.Semaphore(concurrency)
    all_results: dict[str, list[dict]] = {}
    lock = asyncio.Lock()

    async def _retrieve_one(question_id: str, plan: dict) -> None:
        async with semaphore:
            async with aiohttp.ClientSession() as session:
                try:
                    results = await search_thoughts_async(
                        mcp_url=mcp_url,
                        api_key=plan["api_key"],
                        query=plan["question"],
                        session=session,
                    )
                except Exception as e:
                    results = [{"error": str(e)}]

                async with lock:
                    all_results[question_id] = results

                if on_progress:
                    on_progress(question_id, results)

    tasks = [
        _retrieve_one(qid, brain_questions[qid])
        for qid in brain_questions
    ]
    await asyncio.gather(*tasks)
    return all_results
