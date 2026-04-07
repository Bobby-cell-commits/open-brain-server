"""LongMemEval benchmark harness — orchestrates retrieval → scoring."""

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from benchmark.config import mcp_url, openai_api_key, openrouter_api_key, DEFAULT_CONCURRENCY
from benchmark.longmemeval.config import (
    READER_MODEL, JUDGE_MODEL, RETRIEVAL_LIMIT, RETRIEVAL_THRESHOLD,
    RETRIEVAL_EXPAND, RETRIEVAL_MIN_QUALITY,
)
from benchmark.longmemeval.dataset import _load_raw_dataset
from benchmark.longmemeval.evaluate import evaluate_question, score_results
from benchmark.longmemeval.retrieve import retrieve_all
from benchmark.state import BenchmarkState

RESULTS_DIR = Path(__file__).parent.parent / "results"


def _load_questions(question_ids: list[str] | None = None) -> dict[str, dict]:
    """Load raw dataset and return dict mapping question_id -> {question, answer, category}."""
    raw = _load_raw_dataset()
    questions = {}
    for item in raw:
        qid = item["question_id"]
        if question_ids and qid not in question_ids:
            continue
        questions[qid] = {
            "question": item["question"],
            "answer": item["answer"],
            "category": item["question_type"],
        }
    return questions


async def run_retrieval(
    state: BenchmarkState,
    questions: dict[str, dict],
    concurrency: int = DEFAULT_CONCURRENCY,
) -> dict[str, list[dict]]:
    """Retrieve context for all questions.

    Uses brain API keys from state to authenticate per-question searches.
    Returns dict[question_id -> list of thought dicts].
    """
    url = mcp_url()

    brain_questions = {}
    for qid, q in questions.items():
        if qid not in state.brains:
            print(f"  WARNING: {qid} not provisioned, skipping retrieval")
            continue
        brain_questions[qid] = {
            "api_key": state.brains[qid]["api_key"],
            "question": q["question"],
        }

    completed = 0
    total = len(brain_questions)

    def on_progress(qid, results):
        nonlocal completed
        completed += 1
        n_results = len(results)
        has_error = any("error" in r for r in results)
        status = "ERROR" if has_error else f"{n_results} thoughts"
        print(f"\r  [{completed}/{total}] {qid}: {status}", end="", flush=True)

    print(f"Retrieving context for {total} questions (concurrency={concurrency})...")
    results = await retrieve_all(url, brain_questions, concurrency, on_progress)
    print()  # newline after progress
    return results


async def run_scoring(
    questions: dict[str, dict],
    retrieved: dict[str, list[dict]],
    results_path: Path,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> list[dict]:
    """Score all questions: generate answers and judge correctness.

    Writes each result to JSONL as it completes (for crash resilience).
    Returns list of all result dicts.
    """
    from openai import AsyncOpenAI

    or_key = openrouter_api_key()
    oai_key = openai_api_key()

    # Load any previously completed results for resumability
    completed_ids: set[str] = set()
    all_results: list[dict] = []
    if results_path.exists():
        with open(results_path) as f:
            for line in f:
                result = json.loads(line)
                all_results.append(result)
                completed_ids.add(result["question_id"])

    remaining = {qid: q for qid, q in questions.items()
                 if qid in retrieved and qid not in completed_ids}

    if not remaining:
        print("All questions already scored.")
        return all_results

    results_path.parent.mkdir(parents=True, exist_ok=True)
    semaphore = asyncio.Semaphore(concurrency)
    file_lock = asyncio.Lock()
    total = len(remaining)
    done_count = [0]  # mutable for closure

    # Shared OpenAI client for all judge calls (avoids creating 500 instances)
    judge_client = AsyncOpenAI(api_key=oai_key)

    try:
        async def _score_one(qid: str, q: dict) -> dict:
            async with semaphore:
                thoughts = retrieved.get(qid, [])
                # Filter out error entries from retrieval
                thoughts = [t for t in thoughts if "error" not in t]

                result = await evaluate_question(
                    question_id=qid,
                    question=q["question"],
                    gold_answer=q["answer"],
                    category=q["category"],
                    thoughts=thoughts,
                    openrouter_key=or_key,
                    openai_key=oai_key,
                    judge_client=judge_client,
                )

                # Write immediately for crash resilience
                async with file_lock:
                    with open(results_path, "a") as f:
                        f.write(json.dumps(result) + "\n")
                    all_results.append(result)

                done_count[0] += 1
                mark = "correct" if result["correct"] else "wrong"
                print(f"\r  [{done_count[0]}/{total}] {qid} [{q['category']}]: {mark}",
                      end="", flush=True)

                return result

        print(f"Scoring {total} questions (concurrency={concurrency})...")
        tasks = [_score_one(qid, q) for qid, q in remaining.items()]
        gather_results = await asyncio.gather(*tasks, return_exceptions=True)
        print()

        # Log any errors (results already written per-completion)
        for result in gather_results:
            if isinstance(result, BaseException):
                print(f"  ERROR: {result}")
    finally:
        await judge_client.close()

    return all_results


def write_summary(
    results: list[dict],
    run_id: str,
    output_path: Path,
) -> None:
    """Write results summary markdown with per-category breakdown and metadata."""
    scores = score_results(results)

    now = datetime.now(timezone.utc).isoformat()

    lines = [
        "# LongMemEval Benchmark Results",
        "",
        f"**Run ID:** {run_id}",
        f"**Date:** {now}",
        f"**Questions:** {len(results)}",
        f"**Overall Score:** {scores['overall']:.1%}",
        "",
        "## Configuration",
        "",
        "| Parameter | Value |",
        "|-----------|-------|",
        f"| Reader model | {READER_MODEL} |",
        f"| Judge model | {JUDGE_MODEL} |",
        f"| Retrieval limit | {RETRIEVAL_LIMIT} |",
        f"| Retrieval threshold | {RETRIEVAL_THRESHOLD} |",
        f"| Graph expansion | {RETRIEVAL_EXPAND} |",
        f"| Min quality | {RETRIEVAL_MIN_QUALITY} |",
        "",
        "## Per-Category Breakdown",
        "",
        "| Category | Score | Correct | Total |",
        "|----------|-------|---------|-------|",
    ]

    for cat, data in sorted(scores["by_category"].items()):
        lines.append(f"| {cat} | {data['score']:.1%} | {data['correct']} | {data['total']} |")

    lines.extend([
        "",
        "## Diagnostic Notes",
        "",
        "_(Review per-category scores against diagnostic table in spec)_",
    ])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines) + "\n")
    print(f"Summary written to {output_path}")


async def run_harness(
    state: BenchmarkState,
    question_ids: list[str] | None = None,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> dict:
    """Run the full benchmark pipeline: retrieve -> score -> summarize.

    Returns the scores dict.
    """
    # Load questions
    print("Loading questions...")
    questions = _load_questions(question_ids)
    print(f"  {len(questions)} questions loaded")

    # Retrieve
    retrieved = await run_retrieval(state, questions, concurrency)

    # Count successful retrievals (no error entries)
    success_count = sum(1 for r in retrieved.values() if not any("error" in t for t in r))
    print(f"  Retrieval complete: {success_count}/{len(retrieved)} successful")

    # Score
    results_path = RESULTS_DIR / f"{state.run_id}.jsonl"
    results = await run_scoring(questions, retrieved, results_path, concurrency)

    # Compute final scores
    scores = score_results(results)
    print(f"\n{'='*50}")
    print(f"OVERALL SCORE: {scores['overall']:.1%} ({len(results)} questions)")
    print(f"{'='*50}")
    for cat, data in sorted(scores["by_category"].items()):
        print(f"  {cat}: {data['score']:.1%} ({data['correct']}/{data['total']})")

    # Write summary
    summary_path = RESULTS_DIR / f"{state.run_id}-summary.md"
    write_summary(results, state.run_id, summary_path)

    return scores
