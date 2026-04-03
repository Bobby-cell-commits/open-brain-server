"""Import saved posts from a Reddit data export CSV.

The export only has id + permalink, so we fetch full content via public .json endpoints.
Designed for reliability: incremental saves, progress logging, rate limit handling.
Supports subreddit filtering via a CSV blocklist.
"""

import sys
if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]

import csv
import json
import time
import requests
from pathlib import Path

from pipeline.config import REDDIT_USER_AGENT, ITEM_DELAY_SECONDS, DATA_DIR
from pipeline.dedup import DedupTracker
from pipeline.triage import triage, is_deleted_content, is_video_url
from pipeline.openbrain_client import capture_thought
from pipeline.reddit.subreddits import _detect_image_url

# Reddit unauthenticated limit: 100 req/min. Use 4s delay (~15 req/min) for safety.
FETCH_DELAY = 4.0
MAX_RETRIES = 3
PROGRESS_INTERVAL = 25  # Log progress every N items


def _load_subreddit_filter(filter_csv: str | None) -> set[str] | None:
    """Load blocked subreddits from filter CSV. Returns set of lowercase sub names to block."""
    if not filter_csv:
        return None
    path = Path(filter_csv)
    if not path.exists():
        print(f"Warning: filter CSV not found: {filter_csv}, skipping filter")
        return None
    blocked = set()
    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("action", "").strip().upper() == "BLOCK":
                sub = row.get("subreddit", "").strip()
                # Strip r/ prefix if present
                if sub.startswith("r/"):
                    sub = sub[2:]
                blocked.add(sub.lower())
    return blocked


def _extract_subreddit(permalink: str) -> str:
    """Extract subreddit name from a permalink URL."""
    if "reddit.com/r/" in permalink:
        return permalink.split("/r/")[1].split("/")[0]
    if permalink.startswith("/r/"):
        return permalink.split("/")[2]
    return ""


def _fetch_post_json(permalink: str) -> dict | None:
    """Fetch post data from Reddit public .json endpoint with retry."""
    url = f"https://www.reddit.com{permalink}.json"

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.get(
                url,
                headers={"User-Agent": REDDIT_USER_AGENT},
                params={"raw_json": 1},
                timeout=15,
            )

            if resp.status_code == 429:
                # Use x-ratelimit-reset (seconds until window resets) if available
                reset = resp.headers.get("x-ratelimit-reset")
                retry_after = int(float(reset)) + 2 if reset else int(resp.headers.get("Retry-After", "30"))
                print(f"    Rate limited. Sleeping {retry_after}s...")
                time.sleep(retry_after)
                continue

            if resp.status_code == 404:
                return None  # Deleted post

            if resp.status_code == 403:
                return None  # Private/quarantined subreddit

            resp.raise_for_status()
            data = resp.json()

            # Reddit .json returns [listing, comments]
            if isinstance(data, list) and len(data) > 0:
                children = data[0].get("data", {}).get("children", [])
                if children and children[0].get("kind") == "t3":
                    return children[0]["data"]

            return None

        except requests.exceptions.Timeout:
            print(f"    Timeout (attempt {attempt + 1}/{MAX_RETRIES})")
            time.sleep(FETCH_DELAY * (attempt + 1))
        except requests.RequestException as e:
            print(f"    Fetch error (attempt {attempt + 1}/{MAX_RETRIES}): {e}")
            time.sleep(FETCH_DELAY * (attempt + 1))

    return None



def format_enriched_content(post: dict, triage_result: dict, comments: list[str]) -> str:
    """Format enriched content for Open Brain capture."""
    subreddit = post.get("subreddit", "unknown")
    title = post.get("title", "Untitled")
    selftext = post.get("selftext", "")
    url = post.get("url", "")
    permalink = post.get("permalink", "")

    body = selftext[:1000] if selftext else f"[Link post: {url}]"

    topics = ", ".join(triage_result.get("key_topics", []))
    tools = ", ".join(triage_result.get("tools_mentioned", []))

    lines = [
        f"[Reddit r/{subreddit}] {title}",
        "",
        f"Summary: {triage_result.get('summary', '')}",
        "",
        f"Category: {triage_result.get('category', 'unknown')}",
        f"Actionability: {triage_result.get('actionability', 'low')}",
        f"Topics: {topics}",
    ]
    if tools:
        lines.append(f"Tools: {tools}")

    lines += ["", "Original content:", body]

    if comments:
        lines += ["", "Notable comments:"]
        for c in comments:
            lines.append(f"- {c}")

    if permalink:
        source = permalink if permalink.startswith("http") else f"https://reddit.com{permalink}"
        lines += ["", f"Source: {source}"]

    lines.append(f"Captured: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")

    return "\n".join(lines)[:4000]


def _load_fetch_cache() -> dict:
    """Load cached fetched post data (survives restarts)."""
    cache_path = DATA_DIR / "saved_posts_cache.json"
    if cache_path.exists():
        try:
            return json.loads(cache_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_fetch_cache(cache: dict):
    """Save fetched post data cache."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = DATA_DIR / "saved_posts_cache.json"
    cache_path.write_text(json.dumps(cache, indent=2), encoding="utf-8")


def import_saved_posts(csv_path: str, dry_run: bool = False, limit: int | None = None,
                       filter_csv: str | None = None) -> dict:
    """Import saved posts from Reddit data export.

    Phase 1: Fetch all post content from Reddit (cached, resumable)
    Phase 2: Triage + capture to Open Brain (deduped, resumable)
    """
    path = Path(csv_path)
    if not path.exists():
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    # Load subreddit filter
    blocked_subs = _load_subreddit_filter(filter_csv)

    # Read all rows, applying subreddit filter
    rows = []
    filtered_count = 0
    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if blocked_subs:
                sub = _extract_subreddit(row.get("permalink", ""))
                if sub.lower() in blocked_subs:
                    filtered_count += 1
                    continue
            rows.append(row)

    if limit:
        rows = rows[:limit]

    total = len(rows)
    if blocked_subs:
        print(f"Found {total + filtered_count} saved posts, filtered {filtered_count} (blocked subs), {total} remaining\n")
    else:
        print(f"Found {total} saved posts in export\n")

    # === Phase 1: Fetch post content (cached + resumable) ===
    print("=" * 50)
    print("PHASE 1: Fetching post content from Reddit")
    print("=" * 50)

    cache = _load_fetch_cache()
    fetch_stats = {"cached": 0, "fetched": 0, "not_found": 0, "errors": 0}
    start_time = time.time()

    for i, row in enumerate(rows):
        post_id = row.get("id", "")
        permalink = row.get("permalink", "")

        if not permalink:
            continue

        # Strip domain if full URL
        if permalink.startswith("https://www.reddit.com"):
            permalink = permalink[len("https://www.reddit.com"):]
        elif permalink.startswith("https://reddit.com"):
            permalink = permalink[len("https://reddit.com"):]

        # Remove trailing slash for consistency
        permalink = permalink.rstrip("/")

        if post_id in cache:
            fetch_stats["cached"] += 1
            continue

        if dry_run:
            fetch_stats["fetched"] += 1
            continue

        print(f"  [{i+1}/{total}] Fetching {permalink}...")
        post_data = _fetch_post_json(permalink)

        if post_data:
            cache[post_id] = {
                "title": post_data.get("title", ""),
                "selftext": post_data.get("selftext", ""),
                "subreddit": post_data.get("subreddit", ""),
                "url": post_data.get("url", ""),
                "permalink": post_data.get("permalink", permalink),
                "score": post_data.get("score", 0),
                "media_metadata": post_data.get("media_metadata"),
                "is_video": post_data.get("is_video", False),
            }
            fetch_stats["fetched"] += 1
        else:
            cache[post_id] = None  # Mark as unfetchable
            fetch_stats["not_found"] += 1
            print(f"    Not found / deleted")

        # Save cache periodically
        if (fetch_stats["fetched"] + fetch_stats["not_found"]) % PROGRESS_INTERVAL == 0:
            _save_fetch_cache(cache)
            elapsed = time.time() - start_time
            done = fetch_stats["fetched"] + fetch_stats["not_found"] + fetch_stats["cached"]
            remaining = total - done
            rate = (fetch_stats["fetched"] + fetch_stats["not_found"]) / max(elapsed, 1)
            eta_s = remaining / max(rate, 0.01)
            print(f"\n  --- Progress: {done}/{total} | "
                  f"Fetched: {fetch_stats['fetched']} | "
                  f"Not found: {fetch_stats['not_found']} | "
                  f"ETA: {eta_s/60:.0f}m ---\n")

        time.sleep(FETCH_DELAY)

    # Final cache save
    if not dry_run:
        _save_fetch_cache(cache)

    elapsed = time.time() - start_time
    print(f"\nPhase 1 complete ({elapsed:.0f}s): "
          f"{fetch_stats['cached']} cached, "
          f"{fetch_stats['fetched']} fetched, "
          f"{fetch_stats['not_found']} not found\n")

    if dry_run:
        fetchable = total - fetch_stats["cached"]
        print(f"[dry-run] Would fetch {fetchable} posts from Reddit "
              f"(~{fetchable * FETCH_DELAY / 60:.0f}m at {FETCH_DELAY}s/req)")
        print(f"[dry-run] {fetch_stats['cached']} already cached from previous runs")
        return {"total": total, "skipped": 0, "captured": 0, "failed": 0,
                "not_found": 0, "cached": fetch_stats["cached"]}

    # === Phase 2: Triage + Capture ===
    print("=" * 50)
    print("PHASE 2: Triage + Capture to Open Brain")
    print("=" * 50)

    tracker = DedupTracker("reddit_processed.json")
    stats = {"total": total, "skipped": 0, "captured": 0, "failed": 0, "not_found": 0, "filtered": 0}
    phase2_start = time.time()

    for i, row in enumerate(rows):
        post_id = row.get("id", "")
        fullname = f"t3_{post_id}"

        if tracker.is_processed(fullname):
            stats["skipped"] += 1
            continue

        post_data = cache.get(post_id)
        if not post_data:
            stats["not_found"] += 1
            continue

        title = post_data.get("title", "Untitled")[:60]
        selftext = post_data.get("selftext", "")
        url = post_data.get("url", "")

        # Content filter — skip deleted, removed, and video posts
        if is_deleted_content(selftext):
            print(f"  [{i+1}/{total}] {title} — skipped (deleted/removed)")
            tracker.mark_processed(fullname, "reddit-export-filtered")
            stats["filtered"] += 1
            continue
        if is_video_url(url):
            print(f"  [{i+1}/{total}] {title} — skipped (video post)")
            tracker.mark_processed(fullname, "reddit-export-filtered")
            stats["filtered"] += 1
            continue

        # Detect image for vision triage
        image_url = _detect_image_url(post_data)

        # Skip posts with no text AND no image — nothing to process
        if not selftext and not image_url:
            print(f"  [{i+1}/{total}] {title} — skipped (no text, no image)")
            tracker.mark_processed(fullname, "reddit-export-filtered")
            stats["filtered"] += 1
            continue

        print(f"  [{i+1}/{total}] {title}{'  [vision]' if image_url else ''}...")

        try:
            triage_input = (f"r/{post_data.get('subreddit', 'unknown')}: {post_data.get('title', '')}"
                          f"\n\n{selftext[:1500]}")
            if image_url and not selftext:
                triage_input = (f"r/{post_data.get('subreddit', 'unknown')}: {post_data.get('title', '')}"
                              f"\n\n[Image post — see attached image]")

            triage_result = triage(triage_input, image_url=image_url)

            enriched = format_enriched_content(post_data, triage_result, [])
            capture_thought(enriched, source="reddit", source_event_id=fullname)
            tracker.mark_processed(fullname, "reddit-export")
            stats["captured"] += 1
            label = "vision" if image_url else triage_result.get("actionability", "?")
            print(f"    Captured ({label})")

        except Exception as e:
            stats["failed"] += 1
            print(f"    FAILED: {e}")

        # Progress logging
        done = stats["captured"] + stats["failed"] + stats["skipped"] + stats["not_found"]
        if done % PROGRESS_INTERVAL == 0 and done > 0:
            elapsed = time.time() - phase2_start
            remaining = total - done
            rate = done / max(elapsed, 1)
            eta_s = remaining / max(rate, 0.01)
            print(f"\n  --- Progress: {done}/{total} | "
                  f"Captured: {stats['captured']} | "
                  f"Failed: {stats['failed']} | "
                  f"ETA: {eta_s/60:.0f}m ---\n")

        time.sleep(ITEM_DELAY_SECONDS)

    elapsed = time.time() - phase2_start
    print(f"\nPhase 2 complete ({elapsed:.0f}s)")

    return stats
