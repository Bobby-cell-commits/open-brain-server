"""Backfill script: re-triage image-only Reddit posts with vision.

Finds old thoughts by permalink match in Supabase, deletes them,
and re-captures with vision triage + proper source_event_id.

Usage:
    python -m pipeline.reddit.backfill_vision [--dry-run] [--limit N]
"""

import sys

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]

import json
import time
import argparse
import requests

from pipeline.config import (
    DATA_DIR, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ITEM_DELAY_SECONDS,
)
from pipeline.triage import triage, is_deleted_content, is_video_url
from pipeline.openbrain_client import capture_thought
from pipeline.reddit.subreddits import _detect_image_url, format_enriched_content


# --- Supabase REST helpers ---

def _supabase_headers() -> dict:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY(),
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY()}",
        "Content-Type": "application/json",
    }


def find_thought_by_permalink(permalink: str) -> dict | None:
    """Find an existing thought whose content contains the given permalink."""
    # PostgREST ilike filter — search for permalink in content
    search_pattern = f"%reddit.com{permalink}%"
    resp = requests.get(
        f"{SUPABASE_URL()}/rest/v1/thoughts",
        headers=_supabase_headers(),
        params={
            "content": f"ilike.{search_pattern}",
            "select": "id,created_at",
            "limit": "1",
        },
        timeout=15,
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


def delete_thought(thought_id: str) -> bool:
    """Delete a thought by ID."""
    resp = requests.delete(
        f"{SUPABASE_URL()}/rest/v1/thoughts",
        headers=_supabase_headers(),
        params={"id": f"eq.{thought_id}"},
        timeout=15,
    )
    resp.raise_for_status()
    return True


# --- Backfill logic ---

def find_backfill_candidates(cache: dict) -> list[tuple[str, dict]]:
    """Find posts in cache that are image-only and eligible for vision backfill."""
    candidates = []
    for post_id, post_data in cache.items():
        if post_data is None:
            continue

        selftext = post_data.get("selftext", "")
        url = post_data.get("url", "")

        # Skip posts that already have text — they don't need vision
        if selftext and not is_deleted_content(selftext):
            continue

        # Skip deleted/removed
        if is_deleted_content(selftext):
            continue

        # Skip videos
        if is_video_url(url):
            continue

        # Must have a processable image URL
        image_url = _detect_image_url(post_data)
        if not image_url:
            continue

        candidates.append((post_id, post_data))

    return candidates


def run_backfill(dry_run: bool = False, limit: int | None = None):
    """Main backfill: find image-only posts, replace old thoughts with vision-triaged ones."""
    cache_path = DATA_DIR / "saved_posts_cache.json"
    if not cache_path.exists():
        print("No saved_posts_cache.json found. Run import first.")
        return

    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    candidates = find_backfill_candidates(cache)

    if limit:
        candidates = candidates[:limit]

    print(f"Found {len(candidates)} image-only posts eligible for vision backfill\n")

    stats = {"replaced": 0, "new": 0, "skipped_no_old": 0, "failed": 0, "vision_failed": 0}

    for i, (post_id, post_data) in enumerate(candidates):
        fullname = f"t3_{post_id}"
        title = post_data.get("title", "Untitled")[:60]
        permalink = post_data.get("permalink", "")
        image_url = _detect_image_url(post_data)
        sub = post_data.get("subreddit", "unknown")

        print(f"[{i+1}/{len(candidates)}] {title}")
        print(f"  Image: {image_url}")

        if dry_run:
            # Just check if old thought exists
            try:
                old = find_thought_by_permalink(permalink)
                status = "would replace" if old else "would create (no old thought)"
                print(f"  [{status}]")
            except Exception as e:
                print(f"  [dry-run error: {e}]")
            continue

        try:
            # Step 1: Find old thought
            old_thought = find_thought_by_permalink(permalink) if permalink else None

            # Step 2: Vision triage
            triage_input = f"r/{sub}: {post_data.get('title', '')}\n\n[Image post — see attached image]"
            triage_result = triage(triage_input, image_url=image_url)

            if not triage_result.get("summary"):
                print(f"  Vision triage returned empty summary, skipping")
                stats["vision_failed"] += 1
                continue

            # Step 3: Delete old thought if found
            if old_thought:
                delete_thought(old_thought["id"])
                print(f"  Deleted old thought {old_thought['id'][:8]}...")
                stats["replaced"] += 1
            else:
                stats["new"] += 1

            # Step 4: Capture new thought with vision content
            enriched = format_enriched_content(post_data, triage_result)
            capture_thought(enriched, source="reddit", source_event_id=fullname)
            print(f"  Captured (vision): {triage_result.get('summary', '')[:80]}...")

        except Exception as e:
            stats["failed"] += 1
            print(f"  FAILED: {e}")

        time.sleep(ITEM_DELAY_SECONDS)

    print(f"\nBackfill complete:")
    print(f"  Replaced: {stats['replaced']}")
    print(f"  New:      {stats['new']}")
    print(f"  Failed:   {stats['failed']}")
    print(f"  Vision failed: {stats['vision_failed']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill image-only Reddit posts with vision triage")
    parser.add_argument("--dry-run", action="store_true", help="Preview without modifying")
    parser.add_argument("--limit", type=int, default=None, help="Max posts to process")
    args = parser.parse_args()
    run_backfill(dry_run=args.dry_run, limit=args.limit)
