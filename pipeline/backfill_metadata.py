"""Backfill metadata for existing thoughts using the improved extraction prompt.

Re-extracts type, topics, theme, and relevance via OpenRouter gpt-4o-mini.
Preserves people, action_items, and dates_mentioned from existing metadata.

Usage:
    python -m pipeline.backfill_metadata              # dry-run, show 5 samples
    python -m pipeline.backfill_metadata --dry-run 10 # dry-run, show 10 samples
    python -m pipeline.backfill_metadata --run         # process all thoughts
    python -m pipeline.backfill_metadata --run --batch 50  # custom batch size
"""

import sys
import json
import time
import argparse
import requests
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from pipeline.config import (
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    OPENROUTER_API_KEY,
)

PROGRESS_FILE = Path(__file__).parent / "data" / "backfill_progress.json"
BATCH_SIZE = 25
OPENROUTER_MODEL = "openai/gpt-4o-mini"
RATE_DELAY = 0.3  # seconds between OpenRouter calls

EXTRACTION_PROMPT = """You are a metadata extractor for a personal knowledge base owned by a developer who builds AI applications and tracks ML research. Your job is to produce labels that make thoughts findable and meaningful later — not just keywords that restate the domain.

Return JSON with:

- "type": one of:
  - "idea" — a concept, proposal, or creative direction worth exploring
  - "observation" — a trend, pattern, or notable development in the world
  - "reference" — a tool, paper, link, or resource to remember
  - "question" — something unresolved that needs investigation
  - "task" — a concrete action to take
  - "decision" — a choice that was made or is being weighed
  - "person_note" — information about a specific person
  - "meeting_note" — notes from a conversation or meeting
  - "humor" — a joke, meme, or funny observation

- "relevance": one sentence — why is this thought worth remembering? Not a summary. A reason to care.

- "theme": exactly one of: "ai-coding-tools", "ml-research", "knowledge-systems", "infrastructure", "developer-experience", "side-projects", "industry-trends", "personal"

- "topics": array of 2-3 specific topic tags, lowercase hyphenated.
  Tags should be specific enough that searching for one returns a focused set, not half the database.
  GOOD: "copilot-rate-limits", "zettelkasten-memory", "deno-edge-functions", "multi-agent-orchestration"
  BAD: "ai", "research", "tools", "automation", "productivity", "open-source", "machine-learning"

- "people": array of people mentioned by name (empty if none)
- "action_items": array of {"task", "assignee", "due"} objects (empty if none)
- "dates_mentioned": array of dates in YYYY-MM-DD format (empty if none)

Only extract what is explicitly present. Always respond in English regardless of input language.
If the content is just a URL with no context, set type to "task", relevance to "Flagged for investigation", and infer topics from any visible domain or path clues."""


# ---------------------------------------------------------------------------
# Supabase REST helpers
# ---------------------------------------------------------------------------

def supabase_headers() -> dict:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY(),
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY()}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }


def fetch_thoughts(offset: int, limit: int) -> list[dict]:
    """Fetch a batch of thoughts ordered by created_at."""
    url = f"{SUPABASE_URL()}/rest/v1/thoughts"
    params = {
        "select": "id,content,metadata",
        "order": "created_at.asc",
        "offset": offset,
        "limit": limit,
    }
    resp = requests.get(url, headers=supabase_headers(), params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


def update_metadata(thought_id: str, metadata: dict) -> None:
    """Patch a thought's metadata via Supabase REST."""
    url = f"{SUPABASE_URL()}/rest/v1/thoughts"
    params = {"id": f"eq.{thought_id}"}
    body = {"metadata": metadata}
    resp = requests.patch(
        url, headers=supabase_headers(), params=params, json=body, timeout=30,
    )
    resp.raise_for_status()


# ---------------------------------------------------------------------------
# OpenRouter extraction
# ---------------------------------------------------------------------------

def extract_metadata(content: str) -> dict | None:
    """Call OpenRouter to extract metadata with the new prompt."""
    delay = 1
    for attempt in range(3):
        try:
            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY()}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": OPENROUTER_MODEL,
                    "messages": [
                        {"role": "system", "content": EXTRACTION_PROMPT},
                        {"role": "user", "content": content[:4000]},
                    ],
                    "response_format": {"type": "json_object"},
                },
                timeout=30,
            )
            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", str(delay)))
                print(f"    Rate limited, waiting {retry_after}s...")
                time.sleep(retry_after)
                delay *= 2
                continue

            resp.raise_for_status()
            text = resp.json()["choices"][0]["message"]["content"]
            return json.loads(text)

        except (json.JSONDecodeError, KeyError, requests.RequestException) as e:
            print(f"    Extraction error (attempt {attempt + 1}): {e}")
            time.sleep(delay)
            delay *= 2

    return None


# ---------------------------------------------------------------------------
# Merge logic — preserve good existing fields, overlay new ones
# ---------------------------------------------------------------------------

def merge_metadata(existing: dict, extracted: dict) -> dict:
    """Merge extracted metadata into existing, preserving stable fields."""
    merged = dict(existing)

    # Always overwrite these — the whole point of backfill
    merged["type"] = extracted.get("type", existing.get("type", "observation"))
    merged["topics"] = extracted.get("topics", existing.get("topics", []))
    merged["theme"] = extracted.get("theme")
    merged["relevance"] = extracted.get("relevance")

    # Preserve existing if non-empty, otherwise take extracted
    if not existing.get("people") and extracted.get("people"):
        merged["people"] = extracted["people"]
    if not existing.get("action_items") and extracted.get("action_items"):
        merged["action_items"] = extracted["action_items"]
    if not existing.get("dates_mentioned") and extracted.get("dates_mentioned"):
        merged["dates_mentioned"] = extracted["dates_mentioned"]

    return merged


# ---------------------------------------------------------------------------
# Progress tracking (resume support)
# ---------------------------------------------------------------------------

def load_progress() -> set:
    if PROGRESS_FILE.exists():
        return set(json.loads(PROGRESS_FILE.read_text(encoding="utf-8")))
    return set()


def save_progress(processed_ids: set) -> None:
    PROGRESS_FILE.write_text(
        json.dumps(sorted(processed_ids), indent=2), encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_dry(sample_count: int = 5) -> None:
    """Show before/after for a sample of thoughts without writing anything."""
    print(f"=== DRY RUN — sampling {sample_count} thoughts ===\n")
    thoughts = fetch_thoughts(0, sample_count)

    for t in thoughts:
        content_preview = t["content"][:100].replace("\n", " ")
        old_meta = t["metadata"] or {}
        print(f"ID: {t['id']}")
        print(f"Content: {content_preview}...")
        print(f"OLD type={old_meta.get('type')}  topics={old_meta.get('topics')}")

        extracted = extract_metadata(t["content"])
        if extracted:
            merged = merge_metadata(old_meta, extracted)
            print(f"NEW type={merged.get('type')}  topics={merged.get('topics')}")
            print(f"    theme={merged.get('theme')}")
            print(f"    relevance={merged.get('relevance')}")
        else:
            print("    EXTRACTION FAILED")
        print("---")
        time.sleep(RATE_DELAY)


def run_backfill(batch_size: int = BATCH_SIZE) -> None:
    """Process all thoughts, updating metadata in place."""
    processed = load_progress()
    print(f"=== BACKFILL — resuming with {len(processed)} already done ===\n")

    offset = 0
    total_updated = 0
    total_skipped = 0
    total_failed = 0

    while True:
        thoughts = fetch_thoughts(offset, batch_size)
        if not thoughts:
            break

        for t in thoughts:
            tid = t["id"]
            if tid in processed:
                total_skipped += 1
                continue

            extracted = extract_metadata(t["content"])
            if not extracted:
                print(f"  FAIL {tid}")
                total_failed += 1
                continue

            old_meta = t["metadata"] or {}
            merged = merge_metadata(old_meta, extracted)

            try:
                update_metadata(tid, merged)
                processed.add(tid)
                total_updated += 1
            except requests.RequestException as e:
                print(f"  UPDATE FAIL {tid}: {e}")
                total_failed += 1
                continue

            time.sleep(RATE_DELAY)

        # Save progress after each batch
        save_progress(processed)
        offset += batch_size
        print(f"  Batch done — updated={total_updated} skipped={total_skipped} failed={total_failed}")

    save_progress(processed)
    print(f"\n=== COMPLETE — updated={total_updated} skipped={total_skipped} failed={total_failed} ===")


def main():
    parser = argparse.ArgumentParser(description="Backfill thought metadata")
    parser.add_argument("--run", action="store_true", help="Actually update thoughts (default is dry-run)")
    parser.add_argument("--dry-run", type=int, nargs="?", const=5, default=None,
                        help="Show N samples without writing (default 5)")
    parser.add_argument("--batch", type=int, default=BATCH_SIZE, help=f"Batch size (default {BATCH_SIZE})")
    args = parser.parse_args()

    if args.run:
        run_backfill(args.batch)
    else:
        count = args.dry_run if args.dry_run is not None else 5
        run_dry(count)


if __name__ == "__main__":
    main()
