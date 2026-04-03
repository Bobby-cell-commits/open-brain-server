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


def evaluate(split: str | None = None, verbose: bool = False) -> dict:
    """Run full evaluation. Returns score and diagnostics."""
    items = load_labeled_data(split=split)
    if not items:
        print(f"No items found for split={split}")
        return {"score": 0.0, "count": 0}

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

    return result


def main():
    parser = argparse.ArgumentParser(description="Triage eval harness")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--holdout", action="store_true", help="Evaluate holdout split only")
    group.add_argument("--all", action="store_true", help="Evaluate all splits")
    parser.add_argument("--baseline", action="store_true", help="Record current score as baseline")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    if args.holdout:
        split = "holdout"
    elif args.all:
        split = None
    else:
        split = "train"

    print(f"Evaluating split={split or 'all'}...")
    result = evaluate(split=split, verbose=args.verbose)

    print(f"\n{'='*40}")
    print(f"Score: {result['score']}/100")
    print(f"Items: {result['count']} | Errors: {result['errors']}")
    print(f"Category accuracy: {result['category_accuracy']}%")
    print(f"Actionability accuracy: {result['actionability_accuracy']}%")
    print(f"Predicted dist: {result['predicted_distribution']}")
    print(f"Ground truth dist: {result['ground_truth_distribution']}")

    if args.baseline:
        BASELINE_PATH.write_text(json.dumps(result, indent=2))
        print(f"\nBaseline saved to {BASELINE_PATH}")

    # Exit with non-zero if score is 0 (likely broken)
    sys.exit(0 if result["score"] > 0 else 1)


if __name__ == "__main__":
    main()
