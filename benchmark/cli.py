"""CLI entry point for the benchmark harness.

Usage:
    python -m benchmark longmemeval run [--concurrency N]
    python -m benchmark longmemeval provision [--questions q1,q2]
    python -m benchmark longmemeval ingest [--concurrency N] [--questions q1,q2]
    python -m benchmark longmemeval evaluate [--concurrency N] [--questions q1,q2]
    python -m benchmark longmemeval status
    python -m benchmark longmemeval cleanup
"""

import argparse
import asyncio
import sys
from datetime import datetime, timezone

from benchmark.state import BenchmarkState
from benchmark.longmemeval.ingest import (
    STATE_PATH,
    provision_brains,
    run_ingestion,
    cleanup_brains,
    print_status,
)
from benchmark.longmemeval.dataset import load_dataset_to_thoughts
from benchmark.longmemeval.harness import run_harness
from benchmark.config import DEFAULT_CONCURRENCY


def _get_or_create_state(run_id: str | None = None) -> BenchmarkState:
    state = BenchmarkState.load(STATE_PATH)
    if state is None:
        rid = run_id or f"longmemeval-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        state = BenchmarkState(STATE_PATH, run_id=rid)
    return state


def cmd_provision(args: argparse.Namespace) -> None:
    print("Loading dataset...")
    question_ids = args.questions.split(",") if args.questions else None
    dataset = load_dataset_to_thoughts(question_ids=question_ids)

    state = _get_or_create_state()
    print(f"Provisioning {len(dataset)} brains...")
    provision_brains(state, list(dataset.keys()))


def cmd_ingest(args: argparse.Namespace) -> None:
    state = BenchmarkState.load(STATE_PATH)
    if state is None:
        print("ERROR: No state file found. Run 'provision' first.")
        sys.exit(1)

    print("Loading dataset...")
    question_ids = args.questions.split(",") if args.questions else None
    dataset = load_dataset_to_thoughts(question_ids=question_ids)

    print(f"Ingesting into {len(dataset)} brains (concurrency={args.concurrency})...")
    asyncio.run(run_ingestion(state, dataset, concurrency=args.concurrency))


def cmd_status(args: argparse.Namespace) -> None:
    state = BenchmarkState.load(STATE_PATH)
    if state is None:
        print("No benchmark state found.")
        sys.exit(0)
    print_status(state)


def cmd_cleanup(args: argparse.Namespace) -> None:
    state = BenchmarkState.load(STATE_PATH)
    if state is None:
        print("No benchmark state found.")
        sys.exit(0)

    count = len(state.brains)
    if count == 0:
        print("No brains to clean up.")
        return

    response = input(f"Delete {count} benchmark brains? This cannot be undone. [y/N] ")
    if response.lower() != "y":
        print("Cancelled.")
        return

    cleanup_brains(state)


def cmd_evaluate(args: argparse.Namespace) -> None:
    """Run evaluation: retrieve → score → summary."""
    state = BenchmarkState.load(STATE_PATH)
    if state is None:
        print("ERROR: No state file found. Run 'provision' and 'ingest' first.")
        sys.exit(1)

    if not state.brains:
        print("ERROR: No brains provisioned. Run 'provision' first.")
        sys.exit(1)

    question_ids = args.questions.split(",") if args.questions else None

    print(f"\n=== Running evaluation (concurrency={args.concurrency}) ===")
    asyncio.run(run_harness(state, question_ids=question_ids, concurrency=args.concurrency))


def cmd_run(args: argparse.Namespace) -> None:
    """Full run: provision → ingest → evaluate."""
    print("Loading dataset...")
    question_ids = args.questions.split(",") if args.questions else None
    dataset = load_dataset_to_thoughts(question_ids=question_ids)

    state = _get_or_create_state()

    print(f"\n=== Provisioning {len(dataset)} brains ===")
    provision_brains(state, list(dataset.keys()))

    print(f"\n=== Ingesting thoughts (concurrency={args.concurrency}) ===")
    asyncio.run(run_ingestion(state, dataset, concurrency=args.concurrency))

    print(f"\n=== Running evaluation (concurrency={args.concurrency}) ===")
    asyncio.run(run_harness(state, question_ids=question_ids, concurrency=args.concurrency))


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="benchmark",
        description="Open Brain benchmark harness",
    )
    subparsers = parser.add_subparsers(dest="suite", required=True)

    # longmemeval suite
    lme = subparsers.add_parser("longmemeval", help="LongMemEval benchmark")
    lme_sub = lme.add_subparsers(dest="command", required=True)

    # provision
    p_provision = lme_sub.add_parser("provision", help="Create benchmark brains")
    p_provision.add_argument("--questions", type=str, help="Comma-separated question IDs")
    p_provision.set_defaults(func=cmd_provision)

    # ingest
    p_ingest = lme_sub.add_parser("ingest", help="Ingest thoughts (resumable)")
    p_ingest.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    p_ingest.add_argument("--questions", type=str, help="Comma-separated question IDs")
    p_ingest.set_defaults(func=cmd_ingest)

    # status
    p_status = lme_sub.add_parser("status", help="Print benchmark progress")
    p_status.set_defaults(func=cmd_status)

    # cleanup
    p_cleanup = lme_sub.add_parser("cleanup", help="Delete benchmark brains")
    p_cleanup.set_defaults(func=cmd_cleanup)

    # evaluate
    p_evaluate = lme_sub.add_parser("evaluate", help="Run evaluation (retrieve → score)")
    p_evaluate.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    p_evaluate.add_argument("--questions", type=str, help="Comma-separated question IDs")
    p_evaluate.set_defaults(func=cmd_evaluate)

    # run (provision + ingest + evaluate)
    p_run = lme_sub.add_parser("run", help="Full run: provision → ingest → evaluate")
    p_run.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    p_run.add_argument("--questions", type=str, help="Comma-separated question IDs")
    p_run.set_defaults(func=cmd_run)

    args = parser.parse_args()
    args.func(args)
