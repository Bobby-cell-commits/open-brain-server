"""Triage eval harness — immutable referee for autoresearch optimization.

Loads labeled test set, runs triage() on each item, compares to ground truth.
Returns weighted accuracy score (0-100).

THIS FILE MUST NOT BE MODIFIED BY THE OPTIMIZATION LOOP.

Usage:
    python -m pipeline.eval_triage              # score on train split
    python -m pipeline.eval_triage --holdout    # score on holdout split (morning review only)
    python -m pipeline.eval_triage --all        # score on all splits
    python -m pipeline.eval_triage --baseline   # record current score as baseline
"""

import argparse
import json
import sys
from pathlib import Path

from pipeline.triage import triage, triage_paper

LABELED_DATA_PATH = Path(__file__).parent / "data" / "triage_labeled.json"
BASELINE_PATH = Path(__file__).parent / "data" / "triage_baseline.json"


def load_labeled_data(split: str | None = None) -> list[dict]:
    """Load labeled data, optionally filtered by split."""
    data = json.loads(LABELED_DATA_PATH.read_text())
    if split:
        data = [item for item in data if item["split"] == split]
    return data


def run_triage(item: dict) -> dict:
    """Run triage on a single item, handling papers vs general content."""
    content = item["content"]
    source = item["source"]

    # Papers have structured content (Title: ... Abstract: ...)
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
        return triage_paper(title, abstract, authors, "")

    return triage(content)


def score_predictions(items: list[dict], predictions: list[dict]) -> float:
    """Score predictions against ground truth.

    Each item has 2 points available:
    - 1 point for correct category
    - 1 point for correct actionability

    Returns accuracy as 0-100.
    """
    if not items:
        return 0.0

    total_points = len(items) * 2
    earned = 0

    for item, pred in zip(items, predictions):
        gt = item["ground_truth"]
        if pred.get("category") == gt["category"]:
            earned += 1
        if pred.get("actionability") == gt["actionability"]:
            earned += 1

    return (earned / total_points) * 100


def evaluate(split: str | None = None, verbose: bool = False,
             return_raw: bool = False) -> dict | tuple[dict, list, list]:
    """Run full evaluation. Returns score and diagnostics.

    If return_raw=True, also returns (result, items, predictions) to avoid
    re-running LLM calls for downstream checks like trustworthiness.
    """
    items = load_labeled_data(split=split)
    if not items:
        print(f"No items found for split={split}")
        empty = {"score": 0.0, "count": 0}
        return (empty, [], []) if return_raw else empty

    predictions = []
    errors = 0

    for i, item in enumerate(items):
        if verbose:
            print(f"  [{i+1}/{len(items)}] {item['source']}: {item['content'][:50]}...")
        try:
            pred = run_triage(item)
            predictions.append(pred)
        except Exception as e:
            print(f"    ERROR: {e}")
            predictions.append({"category": "", "actionability": ""})
            errors += 1

    score = score_predictions(items, predictions)

    # Per-field breakdown
    cat_correct = sum(
        1 for item, pred in zip(items, predictions)
        if pred.get("category") == item["ground_truth"]["category"]
    )
    act_correct = sum(
        1 for item, pred in zip(items, predictions)
        if pred.get("actionability") == item["ground_truth"]["actionability"]
    )

    # Distribution check
    from collections import Counter
    pred_cats = Counter(p.get("category", "MISSING") for p in predictions)
    gt_cats = Counter(item["ground_truth"]["category"] for item in items)

    result = {
        "score": round(score, 1),
        "count": len(items),
        "errors": errors,
        "category_accuracy": round(cat_correct / len(items) * 100, 1),
        "actionability_accuracy": round(act_correct / len(items) * 100, 1),
        "predicted_distribution": dict(pred_cats),
        "ground_truth_distribution": dict(gt_cats),
    }

    return (result, items, predictions) if return_raw else result


def check_trustworthiness(items: list[dict], predictions: list[dict],
                         baseline: dict | None = None) -> dict:
    """Trustworthiness regression test — 3 checks that optimization hasn't
    degraded reliability. Inspired by CoT alignment paper + ARA safety break.

    1. Error acknowledgment: archive/low items must not become high actionability
    2. Distribution stability: no category >2x vs baseline
    3. Over-confidence: high actionability count must not exceed ground truth by >50%

    Returns pass/fail verdict with per-check details.
    """
    checks = {}

    # Check 1: Error acknowledgment — noise must stay low-signal
    noise_items = [
        (item, pred) for item, pred in zip(items, predictions)
        if item["ground_truth"]["actionability"] in ("archive", "low")
    ]
    promoted = [
        (item, pred) for item, pred in noise_items
        if pred.get("actionability") == "high"
    ]
    checks["error_acknowledgment"] = {
        "pass": len(promoted) == 0,
        "noise_items": len(noise_items),
        "promoted_to_high": len(promoted),
        "detail": "No archive/low items should be classified as high actionability",
    }

    # Check 2: Distribution stability vs baseline
    from collections import Counter
    pred_cats = Counter(p.get("category", "MISSING") for p in predictions)
    dist_ok = True
    dist_warnings = []
    if baseline and "predicted_distribution" in baseline:
        for cat, count in pred_cats.items():
            base_count = baseline.get("predicted_distribution", {}).get(cat, 1)
            if count > base_count * 2:
                dist_ok = False
                dist_warnings.append(f"{cat}: {count} vs baseline {base_count} (>2x)")
    checks["distribution_stability"] = {
        "pass": dist_ok,
        "predicted": dict(pred_cats),
        "warnings": dist_warnings,
        "detail": "No category should exceed 2x its baseline frequency",
    }

    # Check 3: Over-confidence — high actionability inflation
    gt_high = sum(1 for item in items if item["ground_truth"]["actionability"] == "high")
    pred_high = sum(1 for p in predictions if p.get("actionability") == "high")
    high_threshold = max(gt_high * 1.5, gt_high + 3)  # 50% or +3, whichever is greater
    checks["over_confidence"] = {
        "pass": pred_high <= high_threshold,
        "ground_truth_high": gt_high,
        "predicted_high": pred_high,
        "threshold": int(high_threshold),
        "detail": "High-actionability predictions must not exceed ground truth by >50%",
    }

    all_pass = all(c["pass"] for c in checks.values())
    return {"pass": all_pass, "checks": checks}


def evaluate_averaged(split: str | None = None, runs: int = 1,
                      verbose: bool = False) -> dict:
    """Run evaluation multiple times and average scores to reduce noise."""
    if runs <= 1:
        return evaluate(split=split, verbose=verbose)

    all_results = []
    for r in range(runs):
        print(f"  Run {r+1}/{runs}...")
        result = evaluate(split=split, verbose=verbose)
        all_results.append(result)

    avg_score = round(sum(r["score"] for r in all_results) / runs, 1)
    avg_cat = round(sum(r["category_accuracy"] for r in all_results) / runs, 1)
    avg_act = round(sum(r["actionability_accuracy"] for r in all_results) / runs, 1)
    score_spread = round(
        max(r["score"] for r in all_results) - min(r["score"] for r in all_results), 1
    )

    # Use last run's distributions (they should be similar)
    final = all_results[-1].copy()
    final["score"] = avg_score
    final["category_accuracy"] = avg_cat
    final["actionability_accuracy"] = avg_act
    final["runs"] = runs
    final["score_spread"] = score_spread
    final["individual_scores"] = [r["score"] for r in all_results]
    return final


def main():
    parser = argparse.ArgumentParser(description="Triage eval harness")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--holdout", action="store_true", help="Evaluate holdout split only")
    group.add_argument("--all", action="store_true", help="Evaluate all splits")
    parser.add_argument("--baseline", action="store_true", help="Record current score as baseline")
    parser.add_argument("--runs", type=int, default=1,
                        help="Run eval N times and average (reduces noise)")
    parser.add_argument("--trust", action="store_true",
                        help="Run trustworthiness regression checks")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    if args.holdout:
        split = "holdout"
    elif args.all:
        split = None
    else:
        split = "train"

    print(f"Evaluating split={split or 'all'}" +
          (f" ({args.runs} runs, averaged)..." if args.runs > 1 else "..."))

    # If trust check needed and single run, use return_raw to avoid double LLM calls
    if args.trust and args.runs <= 1:
        result, items, predictions = evaluate(split=split, verbose=args.verbose,
                                              return_raw=True)
    else:
        result = evaluate_averaged(split=split, runs=args.runs, verbose=args.verbose)
        items, predictions = None, None

    print(f"\n{'='*40}")
    print(f"Score: {result['score']}/100")
    if result.get("runs", 1) > 1:
        print(f"Spread: {result['score_spread']}pp across {result['runs']} runs")
        print(f"Individual: {result['individual_scores']}")
    print(f"Items: {result['count']} | Errors: {result['errors']}")
    print(f"Category accuracy: {result['category_accuracy']}%")
    print(f"Actionability accuracy: {result['actionability_accuracy']}%")
    print(f"Predicted dist: {result['predicted_distribution']}")
    print(f"Ground truth dist: {result['ground_truth_distribution']}")

    if args.baseline:
        BASELINE_PATH.write_text(json.dumps(result, indent=2))
        print(f"\nBaseline saved to {BASELINE_PATH}")

    if args.trust:
        print(f"\n{'='*40}")
        print("Trustworthiness Regression Checks")
        print(f"{'='*40}")
        # Reuse predictions from eval if available, otherwise run fresh
        if items is None or predictions is None:
            items = load_labeled_data(split=split)
            predictions = [run_triage(item) for item in items]
        baseline_data = json.loads(BASELINE_PATH.read_text()) if BASELINE_PATH.exists() else None
        trust = check_trustworthiness(items, predictions, baseline_data)
        for name, check in trust["checks"].items():
            status = "PASS" if check["pass"] else "FAIL"
            print(f"  [{status}] {name}: {check['detail']}")
            if not check["pass"]:
                for key, val in check.items():
                    if key not in ("pass", "detail"):
                        print(f"         {key}: {val}")
        print(f"\nOverall: {'PASS' if trust['pass'] else 'FAIL'}")
        if not trust["pass"]:
            sys.exit(2)

    # Exit with non-zero if score is 0 (likely broken)
    sys.exit(0 if result["score"] > 0 else 1)


if __name__ == "__main__":
    main()
