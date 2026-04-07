"""Evaluation module for LongMemEval benchmark.

Three stages:
1. Reader  — generate answer from retrieved context (gpt-4o-mini via OpenRouter)
2. Judge   — score correctness with category-specific prompts (gpt-4o via OpenAI)
3. Scorer  — aggregate per-category and overall scores
"""

import asyncio

import aiohttp
from openai import AsyncOpenAI

from benchmark.config import MAX_RETRIES, BACKOFF_BASE_SECONDS
from benchmark.longmemeval.config import READER_MODEL, JUDGE_MODEL

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

READER_PROMPT_TEMPLATE = """\
Given these memories retrieved from a conversation history, answer the question.
If the information needed to answer is not present in the memories, say "I don't know."

Memories (ordered by relevance):
{memories}

Question: {question}

Think step by step, then provide your answer."""

JUDGE_PROMPTS = {
    "default": """\
You are evaluating whether a generated answer correctly addresses a question based on conversation memory.

Gold answer: {gold_answer}
Generated answer: {generated_answer}
Question: {question}

Does the generated answer contain the key information from the gold answer?
Answer with ONLY "yes" or "no" on the first line, then explain your reasoning.""",

    "temporal-reasoning": """\
You are evaluating a temporal reasoning answer from conversation memory.

Gold answer: {gold_answer}
Generated answer: {generated_answer}
Question: {question}

The answer is correct if it contains the key temporal information. Off-by-one errors in dates are acceptable.
Answer with ONLY "yes" or "no" on the first line, then explain your reasoning.""",

    "knowledge-update": """\
You are evaluating a knowledge update answer from conversation memory.

Gold answer: {gold_answer}
Generated answer: {generated_answer}
Question: {question}

The answer is correct if it reflects the MOST RECENT information. Mentioning old information alongside the new is acceptable as long as the current state is clear.
Answer with ONLY "yes" or "no" on the first line, then explain your reasoning.""",

    "abstention": """\
You are evaluating whether the system correctly abstained from answering an unanswerable question.

Gold answer: {gold_answer}
Generated answer: {generated_answer}
Question: {question}

The answer is correct if the system indicates it cannot answer, doesn't know, or the information is not available. Any form of refusal or uncertainty is acceptable.
Answer with ONLY "yes" or "no" on the first line, then explain your reasoning.""",
}

# Map category names to judge prompt keys
_CATEGORY_TO_PROMPT: dict[str, str] = {
    "temporal-reasoning": "temporal-reasoning",
    "knowledge-update": "knowledge-update",
    "abstention": "abstention",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def format_memories(thoughts: list[dict]) -> str:
    """Format retrieved thoughts for the reader prompt.

    Each thought dict must have at minimum 'content'. 'created_at' is optional.
    Returns a numbered list with optional timestamps.
    """
    if not thoughts:
        return "(no memories retrieved)"

    lines: list[str] = []
    for i, thought in enumerate(thoughts, start=1):
        ts = thought.get("created_at", "")
        content = thought.get("content", "").strip()
        if ts:
            lines.append(f"{i}. [{ts}] {content}")
        else:
            lines.append(f"{i}. {content}")
    return "\n".join(lines)


def _judge_prompt_key(category: str) -> str:
    """Return the judge prompt key for a given category."""
    return _CATEGORY_TO_PROMPT.get(category, "default")


# ---------------------------------------------------------------------------
# Reader
# ---------------------------------------------------------------------------


async def generate_answer(
    query: str,
    thoughts: list[dict],
    api_key: str,
    model: str = READER_MODEL,
    max_retries: int = MAX_RETRIES,
    backoff_base: float = BACKOFF_BASE_SECONDS,
    session: aiohttp.ClientSession | None = None,
) -> str:
    """Generate an answer from retrieved context using the reader LLM via OpenRouter.

    Args:
        query: The benchmark question.
        thoughts: Retrieved thought dicts (each with 'content' and optionally 'created_at').
        api_key: OpenRouter API key.
        model: OpenRouter model identifier (default: gpt-4o-mini).
        max_retries: Number of retry attempts on transient errors.
        backoff_base: Base seconds for exponential backoff.
        session: Optional shared aiohttp session.

    Returns:
        Generated answer string.
    """
    memories = format_memories(thoughts)
    prompt = READER_PROMPT_TEMPLATE.format(memories=memories, question=query)

    own_session = session is None
    if own_session:
        session = aiohttp.ClientSession()

    try:
        for attempt in range(max_retries):
            try:
                async with session.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    json={
                        "model": model,
                        "messages": [{"role": "user", "content": prompt}],
                    },
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                ) as resp:
                    if resp.status == 429 or resp.status >= 500:
                        if attempt < max_retries - 1:
                            retry_after = resp.headers.get("Retry-After")
                            wait = float(retry_after) if retry_after else backoff_base * (2 ** attempt)
                            await asyncio.sleep(wait)
                            continue
                        raise RuntimeError(
                            f"generate_answer failed after {max_retries} retries: HTTP {resp.status}"
                        )
                    if resp.status != 200:
                        text = await resp.text()
                        raise RuntimeError(
                            f"generate_answer error: HTTP {resp.status}: {text[:300]}"
                        )
                    data = await resp.json()
                    return data["choices"][0]["message"]["content"]
            except aiohttp.ClientError as e:
                if attempt < max_retries - 1:
                    await asyncio.sleep(backoff_base * (2 ** attempt))
                    continue
                raise RuntimeError(
                    f"generate_answer failed after {max_retries} retries: {e}"
                ) from e

        raise RuntimeError(f"generate_answer failed after {max_retries} retries")
    finally:
        if own_session:
            await session.close()


# ---------------------------------------------------------------------------
# Judge
# ---------------------------------------------------------------------------


async def judge_answer(
    question: str,
    generated_answer: str,
    gold_answer: str,
    category: str,
    api_key: str,
    model: str = JUDGE_MODEL,
    client: AsyncOpenAI | None = None,
    max_retries: int = MAX_RETRIES,
    backoff_base: float = BACKOFF_BASE_SECONDS,
) -> dict:
    """Judge the correctness of a generated answer using GPT-4o via OpenAI API.

    Args:
        question: The benchmark question.
        generated_answer: Answer produced by the reader.
        gold_answer: Ground-truth answer from the dataset.
        category: Question category (used to select category-specific prompt).
        api_key: OpenAI API key.
        model: OpenAI model (default: gpt-4o-2024-08-06).
        client: Optional shared AsyncOpenAI client (avoids creating one per call).
        max_retries: Number of retry attempts on transient errors.
        backoff_base: Base seconds for exponential backoff.

    Returns:
        {"correct": bool, "reasoning": str}
    """
    prompt_key = _judge_prompt_key(category)
    prompt_template = JUDGE_PROMPTS[prompt_key]
    prompt = prompt_template.format(
        gold_answer=gold_answer,
        generated_answer=generated_answer,
        question=question,
    )

    own_client = client is None
    if own_client:
        client = AsyncOpenAI(api_key=api_key)

    try:
        for attempt in range(max_retries):
            try:
                response = await client.chat.completions.create(
                    model=model,
                    messages=[{"role": "user", "content": prompt}],
                )
                raw = response.choices[0].message.content.strip()

                # Parse: first line is "yes" or "no", remainder is reasoning
                lines = raw.splitlines()
                verdict_line = lines[0].strip().lower() if lines else ""
                correct = verdict_line.startswith("yes")
                reasoning = "\n".join(lines[1:]).strip() if len(lines) > 1 else ""

                return {"correct": correct, "reasoning": reasoning}
            except Exception as e:
                if attempt < max_retries - 1:
                    await asyncio.sleep(backoff_base * (2 ** attempt))
                    continue
                raise RuntimeError(
                    f"judge_answer failed after {max_retries} retries: {e}"
                ) from e

        raise RuntimeError(f"judge_answer failed after {max_retries} retries")
    finally:
        if own_client:
            await client.close()


# ---------------------------------------------------------------------------
# Scorer
# ---------------------------------------------------------------------------


def score_results(results: list[dict]) -> dict:
    """Compute per-category and overall accuracy scores.

    Args:
        results: List of dicts, each with at minimum:
            - "question_id": str
            - "category": str
            - "correct": bool

    Returns:
        {
            "overall": float,          # 0.0–1.0
            "by_category": {
                "<category>": {
                    "score": float,
                    "total": int,
                    "correct": int,
                }
            }
        }
    """
    if not results:
        return {"overall": 0.0, "by_category": {}}

    by_category: dict[str, dict] = {}
    for item in results:
        cat = item["category"]
        if cat not in by_category:
            by_category[cat] = {"correct": 0, "total": 0}
        by_category[cat]["total"] += 1
        if item.get("correct"):
            by_category[cat]["correct"] += 1

    cat_scores: dict[str, dict] = {}
    for cat, counts in by_category.items():
        score = counts["correct"] / counts["total"] if counts["total"] > 0 else 0.0
        cat_scores[cat] = {
            "score": score,
            "total": counts["total"],
            "correct": counts["correct"],
        }

    total = len(results)
    total_correct = sum(1 for r in results if r.get("correct"))
    overall = total_correct / total if total > 0 else 0.0

    return {"overall": overall, "by_category": cat_scores}


# ---------------------------------------------------------------------------
# Full pipeline for one question
# ---------------------------------------------------------------------------


async def evaluate_question(
    question_id: str,
    question: str,
    gold_answer: str,
    category: str,
    thoughts: list[dict],
    openrouter_key: str,
    openai_key: str,
    judge_client: AsyncOpenAI | None = None,
) -> dict:
    """Run the full evaluation pipeline for a single question.

    1. Generate answer from retrieved thoughts (reader).
    2. Judge the generated answer against gold (judge).

    Args:
        judge_client: Optional shared AsyncOpenAI client for judge calls.

    Returns:
        {
            "question_id": str,
            "category": str,
            "generated_answer": str,
            "correct": bool,
            "reasoning": str,
        }
    """
    generated_answer = await generate_answer(
        query=question,
        thoughts=thoughts,
        api_key=openrouter_key,
    )

    judgment = await judge_answer(
        question=question,
        generated_answer=generated_answer,
        gold_answer=gold_answer,
        category=category,
        api_key=openai_key,
        client=judge_client,
    )

    return {
        "question_id": question_id,
        "category": category,
        "generated_answer": generated_answer,
        "correct": judgment["correct"],
        "reasoning": judgment["reasoning"],
    }
