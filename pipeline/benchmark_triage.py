"""Triage model benchmark — compare LLM candidates on classification accuracy, cost, and latency.

Runs each candidate model against the labeled triage dataset and produces a
comparative report. Supports checkpointing for resumable runs.

Usage:
    python -m pipeline.benchmark_triage                          # all models, train split
    python -m pipeline.benchmark_triage --models gemma-a4b,gpt-4o-mini
    python -m pipeline.benchmark_triage --split holdout
    python -m pipeline.benchmark_triage --dry-run                # 5 items only
    python -m pipeline.benchmark_triage --resume                 # continue interrupted run
    python -m pipeline.benchmark_triage --report                 # report from existing JSONL only
"""

import argparse
import json
import time
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path

import requests

from pipeline.config import OPENROUTER_API_KEY
from pipeline.eval_triage import load_labeled_data, score_predictions
from pipeline.triage import (
    DEFAULT_TRIAGE_MODEL,
    FALLBACK_TRIAGE,
    triage_paper_with_meta,
    triage_with_meta,
)

BENCHMARK_DIR = Path(__file__).parent / "data" / "benchmark"


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class ModelConfig:
    openrouter_id: str
    display_name: str
    cost_per_m_input: float     # USD per 1M tokens
    cost_per_m_output: float    # USD per 1M tokens
    supports_json_format: bool = True


@dataclass
class ItemResult:
    item_id: str
    prediction: dict
    latency_ms: float
    prompt_tokens: int
    completion_tokens: int
    error: str | None = None


@dataclass
class ModelSummary:
    model_slug: str
    model_id: str
    display_name: str
    score: float
    category_accuracy: float
    actionability_accuracy: float
    total_items: int
    errors: int
    mean_latency_ms: float
    p50_latency_ms: float
    p95_latency_ms: float
    total_prompt_tokens: int
    total_completion_tokens: int
    estimated_cost_usd: float
    cost_per_item_usd: float


# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------

CANDIDATE_MODELS: dict[str, ModelConfig] = {
    "gemma-a4b": ModelConfig("google/gemma-4-26b-a4b-it", "Gemma 4 A4B", 0.13, 0.26),
    "gemma-31b": ModelConfig("google/gemma-4-31b-it", "Gemma 4 31B", 0.14, 0.40),
    "gpt-4o-mini": ModelConfig("openai/gpt-4o-mini", "GPT-4o Mini", 0.15, 0.60),
    "gpt-oss-20b": ModelConfig("openai/gpt-oss-20b", "GPT-OSS 20B", 0.03, 0.11),
    "gpt-oss-120b": ModelConfig("openai/gpt-oss-120b", "GPT-OSS 120B", 0.039, 0.19),
    "qwen3.5-35b": ModelConfig("qwen/qwen3.5-35b-a3b", "Qwen 3.5 35B-A3B", 0.16, 1.30),
}


# ---------------------------------------------------------------------------
# Model verification
# ---------------------------------------------------------------------------

def verify_model(model_id: str) -> bool:
    """Send a minimal chat completion to verify the model is reachable."""
    try:
        resp = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY()}",
                "Content-Type": "application/json",
            },
            json={
                "model": model_id,
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 1,
            },
            timeout=15,
        )
        if resp.status_code == 200:
            return True
        print(f"  [verify] {model_id} returned {resp.status_code}: {resp.text[:200]}")
        return False
    except requests.RequestException as e:
        print(f"  [verify] {model_id} failed: {e}")
        return False


# ---------------------------------------------------------------------------
# Checkpoint I/O
# ---------------------------------------------------------------------------

def load_checkpoint(model_slug: str) -> dict[str, ItemResult]:
    """Load completed results from JSONL checkpoint. Returns dict keyed by item_id."""
    path = BENCHMARK_DIR / f"{model_slug}.jsonl"
    results: dict[str, ItemResult] = {}
    if not path.exists():
        return results
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            results[data["item_id"]] = ItemResult(**data)
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            print(f"  [checkpoint] Skipping corrupted line {lineno} in {path.name}: {e}")
    return results


def save_checkpoint_line(model_slug: str, result: ItemResult) -> None:
    """Append one JSON line to the JSONL checkpoint file."""
    BENCHMARK_DIR.mkdir(parents=True, exist_ok=True)
    path = BENCHMARK_DIR / f"{model_slug}.jsonl"
    with open(path, "a") as f:
        f.write(json.dumps(asdict(result)) + "\n")


# ---------------------------------------------------------------------------
# Triage dispatch
# ---------------------------------------------------------------------------

def _dispatch_triage_with_meta(
    item: dict, model: str, supports_json_format: bool
) -> tuple[dict, dict]:
    """Dispatch to the correct triage function based on item source and content."""
    content = item["content"]
    source = item["source"]

    # Papers: structured content starting with Title:
    if source in ("hf_papers", "emergent_mind") and content.startswith("Title:"):
        lines = content.split("\n")
        title = lines[0].replace("Title: ", "")
        authors = ""
        abstract = ""
        for line in lines:
            if line.startswith("Authors:"):
                authors = line.replace("Authors: ", "")
            if line.startswith("Abstract:"):
                abstract = "\n".join(lines[lines.index(line) + 1:])
        return triage_paper_with_meta(
            title, abstract, authors, "",
            model=model, supports_json_format=supports_json_format,
        )

    return triage_with_meta(
        content, model=model, supports_json_format=supports_json_format,
    )


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------

def run_benchmark_for_model(
    model_slug: str,
    config: ModelConfig,
    items: list[dict],
    resume: bool = False,
) -> list[ItemResult]:
    """Run the benchmark for a single model across all items."""
    completed: dict[str, ItemResult] = {}
    if resume:
        completed = load_checkpoint(model_slug)
        if completed:
            print(f"  Resuming {model_slug}: {len(completed)}/{len(items)} already done")

    # If not resuming, clear any existing checkpoint
    if not resume:
        checkpoint_path = BENCHMARK_DIR / f"{model_slug}.jsonl"
        if checkpoint_path.exists():
            checkpoint_path.unlink()

    new_results: list[ItemResult] = []
    all_predictions: list[dict] = []
    total = len(items)

    for i, item in enumerate(items):
        item_id = item.get("id", str(i))

        # Skip already-completed items
        if item_id in completed:
            all_predictions.append(completed[item_id].prediction)
            continue

        try:
            prediction, meta = _dispatch_triage_with_meta(
                item, config.openrouter_id, config.supports_json_format,
            )
            result = ItemResult(
                item_id=item_id,
                prediction=prediction,
                latency_ms=meta.get("latency_ms", 0.0),
                prompt_tokens=meta.get("prompt_tokens", 0),
                completion_tokens=meta.get("completion_tokens", 0),
            )
        except Exception as e:
            result = ItemResult(
                item_id=item_id,
                prediction=dict(FALLBACK_TRIAGE),
                latency_ms=0.0,
                prompt_tokens=0,
                completion_tokens=0,
                error=str(e),
            )

        save_checkpoint_line(model_slug, result)
        new_results.append(result)
        all_predictions.append(result.prediction)

        # Progress every 10 items
        done_count = len(completed) + len(new_results)
        if done_count % 10 == 0 or done_count == total:
            partial_score = score_predictions(items[:done_count], all_predictions[:done_count])
            print(f"  [{done_count}/{total}] {model_slug}: {partial_score:.1f}/100 so far")

        # Rate limiting
        time.sleep(0.5)

    # Combine checkpoint results + new results, ordered by item
    all_results: list[ItemResult] = []
    for i, item in enumerate(items):
        item_id = item.get("id", str(i))
        if item_id in completed:
            all_results.append(completed[item_id])
        else:
            # Find in new_results
            for r in new_results:
                if r.item_id == item_id:
                    all_results.append(r)
                    break

    return all_results


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def aggregate_results(
    model_slug: str,
    config: ModelConfig,
    items: list[dict],
    results: list[ItemResult],
) -> ModelSummary:
    """Aggregate per-item results into a model summary."""
    # Build predictions aligned to items
    result_map = {r.item_id: r for r in results}
    predictions: list[dict] = []
    for i, item in enumerate(items):
        item_id = item.get("id", str(i))
        if item_id in result_map:
            predictions.append(result_map[item_id].prediction)
        else:
            predictions.append(dict(FALLBACK_TRIAGE))

    score = score_predictions(items, predictions)

    # Per-field accuracy
    total = len(items)
    cat_correct = sum(
        1 for item, pred in zip(items, predictions)
        if pred.get("category") == item["ground_truth"]["category"]
    )
    act_correct = sum(
        1 for item, pred in zip(items, predictions)
        if pred.get("actionability") == item["ground_truth"]["actionability"]
    )
    category_accuracy = (cat_correct / total * 100) if total else 0.0
    actionability_accuracy = (act_correct / total * 100) if total else 0.0

    # Latency stats
    latencies = [r.latency_ms for r in results if r.error is None and r.latency_ms > 0]
    if latencies:
        sorted_lat = sorted(latencies)
        mean_lat = sum(sorted_lat) / len(sorted_lat)
        p50_lat = sorted_lat[int(len(sorted_lat) * 0.5)]
        p95_lat = sorted_lat[int(len(sorted_lat) * 0.95)]
    else:
        mean_lat = p50_lat = p95_lat = 0.0

    # Token totals
    total_prompt = sum(r.prompt_tokens for r in results)
    total_completion = sum(r.completion_tokens for r in results)

    # Cost estimate
    estimated_cost = (
        (total_prompt / 1_000_000) * config.cost_per_m_input
        + (total_completion / 1_000_000) * config.cost_per_m_output
    )
    cost_per_item = estimated_cost / total if total else 0.0

    errors = sum(1 for r in results if r.error is not None)

    return ModelSummary(
        model_slug=model_slug,
        model_id=config.openrouter_id,
        display_name=config.display_name,
        score=round(score, 1),
        category_accuracy=round(category_accuracy, 1),
        actionability_accuracy=round(actionability_accuracy, 1),
        total_items=total,
        errors=errors,
        mean_latency_ms=round(mean_lat, 0),
        p50_latency_ms=round(p50_lat, 0),
        p95_latency_ms=round(p95_lat, 0),
        total_prompt_tokens=total_prompt,
        total_completion_tokens=total_completion,
        estimated_cost_usd=round(estimated_cost, 6),
        cost_per_item_usd=round(cost_per_item, 8),
    )


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def _fmt_latency(ms: float) -> str:
    """Format milliseconds as human-readable seconds."""
    return f"{ms / 1000:.1f}s"


def _fmt_cost(usd: float) -> str:
    """Format cost with appropriate precision."""
    if usd < 0.001:
        return f"${usd:.6f}"
    if usd < 0.01:
        return f"${usd:.4f}"
    return f"${usd:.3f}"


def generate_report(summaries: list[ModelSummary], split: str) -> str:
    """Generate a markdown benchmark report."""
    if not summaries:
        return "# Triage Model Benchmark Report\n\nNo results to report.\n"

    # Sort by score descending
    summaries = sorted(summaries, key=lambda s: s.score, reverse=True)
    total_items = summaries[0].total_items

    # Find baseline
    baseline_score: float | None = None
    for s in summaries:
        if s.model_slug == "gemma-a4b":
            baseline_score = s.score
            break

    lines = [
        "# Triage Model Benchmark Report",
        "",
        f"**Date:** {date.today().isoformat()} | **Split:** {split} | **Items:** {total_items}",
        "",
        "| Model | Score | Cat% | Act% | Avg Latency | P95 Latency | Est. Cost | $/Item | vs Baseline |",
        "|-------|-------|------|------|-------------|-------------|-----------|--------|-------------|",
    ]

    for s in summaries:
        name = s.display_name
        if s.model_slug == "gemma-a4b":
            name += " *"

        if baseline_score is not None and s.model_slug != "gemma-a4b":
            delta = s.score - baseline_score
            vs_baseline = f"+{delta:.1f}" if delta >= 0 else f"{delta:.1f}"
        else:
            vs_baseline = "—"

        row = (
            f"| {name} "
            f"| {s.score:.1f} "
            f"| {s.category_accuracy:.1f} "
            f"| {s.actionability_accuracy:.1f} "
            f"| {_fmt_latency(s.mean_latency_ms)} "
            f"| {_fmt_latency(s.p95_latency_ms)} "
            f"| {_fmt_cost(s.estimated_cost_usd)} "
            f"| {_fmt_cost(s.cost_per_item_usd)} "
            f"| {vs_baseline} |"
        )
        lines.append(row)

    lines.append("")
    lines.append("\\* Baseline model")
    lines.append("")

    # Per-model detail
    lines.append("## Details")
    lines.append("")
    for s in summaries:
        lines.append(f"### {s.display_name} (`{s.model_id}`)")
        lines.append("")
        lines.append(f"- Score: **{s.score:.1f}**/100")
        lines.append(f"- Category accuracy: {s.category_accuracy:.1f}%")
        lines.append(f"- Actionability accuracy: {s.actionability_accuracy:.1f}%")
        lines.append(f"- Errors: {s.errors}/{s.total_items}")
        lines.append(f"- Latency: mean={_fmt_latency(s.mean_latency_ms)}, "
                      f"p50={_fmt_latency(s.p50_latency_ms)}, "
                      f"p95={_fmt_latency(s.p95_latency_ms)}")
        lines.append(f"- Tokens: {s.total_prompt_tokens:,} prompt + "
                      f"{s.total_completion_tokens:,} completion")
        lines.append(f"- Estimated cost: {_fmt_cost(s.estimated_cost_usd)} "
                      f"({_fmt_cost(s.cost_per_item_usd)}/item)")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Triage model benchmark — compare LLM candidates on classification"
    )
    parser.add_argument(
        "--models", type=str, default=None,
        help="Comma-separated model slugs (default: all)",
    )
    parser.add_argument(
        "--split", type=str, default="train",
        help="Dataset split to evaluate (default: train)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Run on first 5 items only",
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="Resume interrupted run from JSONL checkpoints",
    )
    parser.add_argument(
        "--report", action="store_true",
        help="Generate report from existing JSONL checkpoints only (no LLM calls)",
    )
    args = parser.parse_args()

    # Resolve model list
    if args.models:
        slugs = [s.strip() for s in args.models.split(",")]
        unknown = [s for s in slugs if s not in CANDIDATE_MODELS]
        if unknown:
            print(f"Unknown model slugs: {unknown}")
            print(f"Available: {list(CANDIDATE_MODELS.keys())}")
            return
    else:
        slugs = list(CANDIDATE_MODELS.keys())

    # Load dataset
    items = load_labeled_data(split=args.split)
    if not items:
        print(f"No items found for split={args.split}")
        return

    if args.dry_run:
        items = items[:5]
        print(f"Dry run: using first 5 items")

    print(f"Benchmark: {len(items)} items, split={args.split}, models={slugs}")
    print()

    # Run benchmarks (unless --report only)
    if not args.report:
        for slug in slugs:
            config = CANDIDATE_MODELS[slug]
            print(f"Verifying {config.display_name} ({config.openrouter_id})...")
            if not verify_model(config.openrouter_id):
                print(f"  SKIPPED: model verification failed\n")
                continue

            print(f"Running {config.display_name}...")
            results = run_benchmark_for_model(slug, config, items, resume=args.resume)
            summary = aggregate_results(slug, config, items, results)
            print(f"  Done: {summary.score:.1f}/100 "
                  f"(cat={summary.category_accuracy:.1f}%, "
                  f"act={summary.actionability_accuracy:.1f}%, "
                  f"errors={summary.errors}, "
                  f"cost={_fmt_cost(summary.estimated_cost_usd)})")
            print()

    # Generate report from checkpoints
    summaries: list[ModelSummary] = []
    for slug in slugs:
        config = CANDIDATE_MODELS[slug]
        checkpoint = load_checkpoint(slug)
        if not checkpoint:
            print(f"  No checkpoint data for {slug}, skipping from report")
            continue
        # Filter items to only those with checkpoint data (handles partial runs)
        checkpoint_ids = set(checkpoint.keys())
        matched_items = []
        results = []
        for i, item in enumerate(items):
            item_id = item.get("id", str(i))
            if item_id in checkpoint_ids:
                matched_items.append(item)
                results.append(checkpoint[item_id])
        summary = aggregate_results(slug, config, matched_items, results)
        summaries.append(summary)

    if not summaries:
        print("No results to report.")
        return

    report = generate_report(summaries, args.split)

    # Save report
    BENCHMARK_DIR.mkdir(parents=True, exist_ok=True)
    report_path = BENCHMARK_DIR / "report.md"
    report_path.write_text(report)
    print(f"Report saved to {report_path}")

    # Save structured results
    results_path = BENCHMARK_DIR / "results.json"
    results_path.write_text(json.dumps([asdict(s) for s in summaries], indent=2))
    print(f"Results saved to {results_path}")

    print()
    print(report)


if __name__ == "__main__":
    main()
