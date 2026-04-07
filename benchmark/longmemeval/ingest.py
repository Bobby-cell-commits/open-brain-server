"""LongMemEval ingestion adapter.

Wires dataset loading → brain provisioning → bulk import → state tracking.
"""

import time
from collections import deque
from pathlib import Path

from benchmark.bulk_import import bulk_ingest, ThoughtRecord
from benchmark.config import mcp_url, supabase_url, supabase_service_role_key, DEFAULT_CONCURRENCY
from benchmark.longmemeval.config import BENCHMARK_SOURCE
from benchmark.provision import create_brain, delete_brain
from benchmark.state import BenchmarkState

STATE_PATH = Path(__file__).parent.parent / "data" / "state.json"


def provision_brains(
    state: BenchmarkState,
    question_ids: list[str],
) -> None:
    """Provision brains for each question, skipping already-provisioned ones."""
    sb_url = supabase_url()
    sb_key = supabase_service_role_key()
    total = len(question_ids)

    for i, qid in enumerate(question_ids):
        if state.is_brain_provisioned(qid):
            continue
        brain_id, api_key = create_brain(qid, sb_url, sb_key)
        state.add_brain(qid, brain_id, api_key)
        print(f"  Provisioned {qid} ({i + 1}/{total})")

    state.save()
    print(f"Provisioning complete: {len(state.brains)} brains ready")


async def run_ingestion(
    state: BenchmarkState,
    dataset: dict[str, list[ThoughtRecord]],
    concurrency: int = DEFAULT_CONCURRENCY,
) -> None:
    """Run bulk ingestion with progress reporting and state tracking."""
    url = mcp_url()
    state.phase = "ingesting"

    # Build brain plans, skipping fully completed brains
    brain_plans: dict[str, dict] = {}
    for qid, thoughts in dataset.items():
        if qid not in state.brains:
            print(f"  WARNING: {qid} not provisioned, skipping")
            continue

        state.init_brain_ingestion(qid, total=len(thoughts))

        # Filter to only non-completed thoughts
        remaining = [t for t in thoughts if not state.is_done(qid, t.source_event_id)]
        if not remaining:
            continue

        brain_plans[qid] = {
            "api_key": state.brains[qid]["api_key"],
            "thoughts": remaining,
        }

    if not brain_plans:
        print("Nothing to ingest — all thoughts already completed.")
        return

    total_thoughts = sum(len(p["thoughts"]) for p in brain_plans.values())
    global_completed = 0
    start_time = time.time()
    recent_times: deque[float] = deque(maxlen=100)

    def on_progress(qid: str, idx: int, brain_total: int, completed: int, result: dict) -> None:
        nonlocal global_completed
        now = time.time()
        recent_times.append(now)
        global_completed = completed

        # ETA from rolling average
        if len(recent_times) >= 2:
            rate = len(recent_times) / (recent_times[-1] - recent_times[0])
            remaining = total_thoughts - global_completed
            eta_seconds = remaining / rate if rate > 0 else 0
            eta_str = f"ETA: {int(eta_seconds // 60)}m"
        else:
            eta_str = "ETA: calculating..."

        pct = (global_completed / total_thoughts) * 100 if total_thoughts else 0
        status = "merged" if result.get("merged") else "ok"
        print(
            f"\r[{global_completed}/{total_thoughts}] "
            f"Brain {qid} thought {idx}/{brain_total} — "
            f"{pct:.1f}% complete ({eta_str}) [{status}]",
            end="", flush=True,
        )

    def on_brain_complete(qid: str) -> None:
        state.save()

    results = await bulk_ingest(
        mcp_url=url,
        brain_plans=brain_plans,
        concurrency=concurrency,
        source=BENCHMARK_SOURCE,
        on_progress=on_progress,
        on_brain_complete=on_brain_complete,
    )

    # Record results in state
    for qid, brain_results in results.items():
        if isinstance(brain_results, BaseException):
            # Entire brain failed (exception from asyncio.gather)
            for thought in brain_plans[qid]["thoughts"]:
                state.record_failed(qid, thought.source_event_id, str(brain_results))
            continue
        thoughts = brain_plans[qid]["thoughts"]
        for thought, result in zip(thoughts, brain_results):
            if result.get("error"):
                state.record_failed(qid, thought.source_event_id, result["error"])
            elif result.get("merged"):
                state.record_merged(qid, thought.source_event_id)
            else:
                state.record_completed(
                    qid, thought.source_event_id, thought_id=result.get("id", "unknown")
                )

    state.phase = "ingestion_complete"
    state.save()

    # Print summary
    elapsed = time.time() - start_time
    s = state.summary
    print(f"\n\n=== Bulk Import Complete ===")
    print(f"Total: {s['total_thoughts']} | Completed: {s['completed']} | "
          f"Merged: {s['merged']} | Failed: {s['failed']}")
    print(f"Duration: {int(elapsed // 60)}m {int(elapsed % 60)}s | "
          f"Avg: {int(elapsed / max(global_completed, 1) * 1000)}ms/thought")

    # List failures
    all_failed = []
    for qid, entry in state.ingestion.items():
        all_failed.extend(entry.get("failed", {}).keys())
    if all_failed:
        print(f"Failed thoughts: {', '.join(all_failed[:20])}")
        if len(all_failed) > 20:
            print(f"  ... and {len(all_failed) - 20} more")
        print("Re-run with: python -m benchmark longmemeval ingest")


def cleanup_brains(state: BenchmarkState) -> None:
    """Delete all benchmark brains."""
    sb_url = supabase_url()
    sb_key = supabase_service_role_key()
    total = len(state.brains)

    for i, (qid, brain) in enumerate(state.brains.items()):
        delete_brain(brain["brain_id"], sb_url, sb_key)
        print(f"  Deleted {qid} ({i + 1}/{total})")

    # Clear state
    state.brains.clear()
    state.ingestion.clear()
    state.summary = {
        "total_thoughts": 0, "completed": 0, "failed": 0, "merged": 0,
        "started_at": None, "last_updated": None,
    }
    state.phase = "cleaned_up"
    state.save()
    print(f"Cleanup complete: {total} brains deleted")


def print_status(state: BenchmarkState) -> None:
    """Print current benchmark status from state file."""
    s = state.summary
    print(f"Run: {state.run_id}")
    print(f"Phase: {state.phase}")
    print(f"Brains: {len(state.brains)}")
    print(f"Thoughts: {s['completed']}/{s['total_thoughts']} completed, "
          f"{s['merged']} merged, {s['failed']} failed")
    if s.get("last_updated"):
        print(f"Last updated: {s['last_updated']}")
