"""Backfill connections for thoughts that have no outgoing connections.

Uses stored embeddings — no re-embedding or LLM calls.
Inserts top-3 similar connections as link_type 'related' at >=0.75 threshold.

Usage:
    python -m pipeline.backfill_connections              # dry-run (show counts)
    python -m pipeline.backfill_connections --run         # process all
    python -m pipeline.backfill_connections --run --batch 100  # custom batch
"""

import sys
import time
import argparse
import requests

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from pipeline.config import SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

BATCH_SIZE = 50


def supabase_headers() -> dict:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY(),
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY()}",
        "Content-Type": "application/json",
    }


def call_backfill_batch(batch_size: int) -> dict:
    """Call the backfill_connections_batch RPC."""
    resp = requests.post(
        f"{SUPABASE_URL()}/rest/v1/rpc/backfill_connections_batch",
        headers=supabase_headers(),
        json={"p_limit": batch_size},
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()


def run_dry() -> None:
    """Show how many thoughts need backfilling without doing anything."""
    print("=== DRY RUN — checking unlinked thought count ===\n")
    result = call_backfill_batch(0)
    remaining = result.get("remaining", "?")
    print(f"Thoughts without outgoing connections: {remaining}")
    print(f"\nRun with --run to backfill. Estimated connections: ~{remaining * 3}")


def run_backfill(batch_size: int) -> None:
    """Process all unlinked thoughts in batches."""
    total_thoughts = 0
    total_connections = 0
    batch_num = 0

    print(f"=== BACKFILL CONNECTIONS (batch_size={batch_size}) ===\n")

    prev_remaining = None
    stall_count = 0

    while True:
        batch_num += 1
        result = call_backfill_batch(batch_size)

        processed = result.get("thoughts_processed", 0)
        inserted = result.get("connections_inserted", 0)
        remaining = result.get("remaining", 0)

        total_thoughts += processed
        total_connections += inserted

        print(f"  Batch {batch_num}: {processed} thoughts → {inserted} connections  (remaining: {remaining})")

        if processed == 0 or remaining == 0:
            break

        # Stop if remaining isn't decreasing (orphans with no matches above threshold)
        if remaining == prev_remaining:
            stall_count += 1
            if stall_count >= 2:
                print(f"\n  Stopping: {remaining} thoughts have no matches above 0.75 threshold (true orphans)")
                break
        else:
            stall_count = 0
        prev_remaining = remaining

        time.sleep(0.5)

    print(f"\n=== COMPLETE — {total_thoughts} thoughts processed, {total_connections} connections created ===")


def main():
    parser = argparse.ArgumentParser(description="Backfill thought connections")
    parser.add_argument("--run", action="store_true", help="Actually run (default is dry-run)")
    parser.add_argument("--batch", type=int, default=BATCH_SIZE, help=f"Batch size (default {BATCH_SIZE})")
    args = parser.parse_args()

    if args.run:
        run_backfill(args.batch)
    else:
        run_dry()


if __name__ == "__main__":
    main()
