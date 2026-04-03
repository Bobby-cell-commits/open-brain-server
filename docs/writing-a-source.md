# Writing a Pipeline Source

Add your own capture source to the Open Brain pipeline. Every source follows
the same four-step pattern: **fetch → dedup → triage → capture**.

## The Pattern

```
External API/feed
       ↓
    fetch()          Retrieve items from the source
       ↓
  DedupTracker       Skip items already processed
       ↓
    triage()         LLM classification (summary, category, actionability)
       ↓
capture_thought()    Store in Open Brain via MCP
```

## Minimal Skeleton

```python
"""Fetch and process items from [Your Source]."""

import time
from pipeline.config import ITEM_DELAY_SECONDS
from pipeline.dedup import DedupTracker
from pipeline.triage import triage
from pipeline.openbrain_client import capture_thought


def fetch_items() -> list[dict]:
    """Fetch items from your source. Returns a list of dicts."""
    # Call your API, parse your feed, scrape your page, etc.
    # Return a list of items with at least: id, title, content
    raise NotImplementedError


def format_enriched_content(item: dict, triage_result: dict) -> str:
    """Format enriched content for Open Brain capture."""
    topics = ", ".join(triage_result.get("key_topics", []))
    lines = [
        f"[Your Source] {item['title']}",
        "",
        f"Summary: {triage_result.get('summary', '')}",
        "",
        f"Category: {triage_result.get('category', 'unknown')}",
        f"Actionability: {triage_result.get('actionability', 'low')}",
        f"Topics: {topics}",
        "",
        "Content:",
        item["content"][:1500],
        "",
        f"Source: {item.get('url', '')}",
    ]
    return "\n".join(lines)[:4000]


def process_items(dry_run: bool = False) -> dict:
    """Fetch, triage, and capture items. Returns stats dict."""
    tracker = DedupTracker("your_source_processed.json")
    stats = {"fetched": 0, "skipped": 0, "captured": 0, "failed": 0}

    items = fetch_items()
    stats["fetched"] = len(items)

    for item in items:
        event_id = f"your_source_{item['id']}"

        if tracker.is_processed(event_id):
            stats["skipped"] += 1
            continue

        if dry_run:
            stats["captured"] += 1
            continue

        try:
            triage_result = triage(f"{item['title']}\n\n{item['content'][:1500]}")
            enriched = format_enriched_content(item, triage_result)
            capture_thought(enriched, source="your_source", source_event_id=event_id)
            tracker.mark_processed(event_id, "your_source")
            stats["captured"] += 1
        except Exception as e:
            stats["failed"] += 1
            print(f"  FAILED: {e}")

        time.sleep(ITEM_DELAY_SECONDS)

    return stats
```

## Key Components

### DedupTracker (`pipeline/dedup.py`)
JSON-file-based tracker that prevents reprocessing. Each source gets its own
tracker file in `pipeline/data/`.

```python
tracker = DedupTracker("my_source_processed.json")
tracker.is_processed("item_123")     # -> bool
tracker.mark_processed("item_123", "my_source")
tracker.cleanup(max_age_days=90)     # prune old entries
```

### triage() (`pipeline/triage.py`)
LLM classification via OpenRouter. Returns structured JSON with `summary`,
`category`, `actionability`, `key_topics`, `tools_mentioned`.

For academic papers, use `triage_paper()` instead — it has a research-focused
prompt. For images, pass `image_url` for multimodal triage.

### capture_thought() (`pipeline/openbrain_client.py`)
Sends content to Open Brain via JSON-RPC. Pass `source` (identifies your
pipeline) and `source_event_id` (unique per item, enables idempotency).

### Stats dict convention
Every `process_*` function returns `{"fetched", "skipped", "captured", "failed"}`.
The orchestrator (`run_all.py`) accumulates these across sources.

## Integrating with run_all.py

1. Add your source to `pipeline/run_all.py`:

```python
from pipeline.your_source.fetcher import process_items as process_your_source

# In main(), add a new block:
if run_all or args.your_source_only:
    print("\n" + "=" * 60)
    print("YOUR SOURCE: Description")
    print("=" * 60)
    stats = _run_source("your_source", lambda: process_your_source(dry_run=args.dry_run), args.dry_run)
    _accumulate(totals, stats)
```

2. Add the CLI flag: `parser.add_argument("--your-source-only", action="store_true")`

3. Add any config to `pipeline/config.py` (API URLs, filter terms, etc.)

## Reference Implementation

See `pipeline/rss/fetcher.py` — it's the cleanest example at ~180 lines.
It demonstrates feed parsing, first-run handling, HTML stripping, and the
full fetch→dedup→triage→capture flow.
