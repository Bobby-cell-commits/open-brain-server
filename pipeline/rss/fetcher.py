"""RSS/Atom feed poller using feedparser."""

import sys
if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]

import hashlib
import time
from html.parser import HTMLParser

import feedparser

from pipeline.config import RSS_FEEDS, ITEM_DELAY_SECONDS
from pipeline.dedup import DedupTracker
from pipeline.triage import triage
from pipeline.openbrain_client import capture_thought


class _HTMLStripper(HTMLParser):
    """Strip HTML tags, keeping text content."""

    def __init__(self):
        super().__init__()
        self._parts: list[str] = []

    def handle_data(self, data):
        self._parts.append(data)

    def get_text(self) -> str:
        return " ".join(self._parts)


def strip_html(html: str) -> str:
    s = _HTMLStripper()
    s.feed(html)
    return s.get_text()


def _entry_id(feed_url: str, entry) -> str:
    """Generate a stable ID for an RSS entry."""
    if hasattr(entry, "id") and entry.id:
        return entry.id
    raw = f"{feed_url}|{getattr(entry, 'link', '')}|{getattr(entry, 'title', '')}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _entry_content(entry) -> str:
    """Extract text content from an RSS/Atom entry."""
    # Atom: entry.content[0].value
    if hasattr(entry, "content") and entry.content:
        return strip_html(entry.content[0].value)
    # RSS: entry.summary or description
    if hasattr(entry, "summary") and entry.summary:
        return strip_html(entry.summary)
    return ""


def _entry_date(entry) -> str:
    """Get publication date string."""
    if hasattr(entry, "published") and entry.published:
        return entry.published
    if hasattr(entry, "updated") and entry.updated:
        return entry.updated
    return ""


def format_enriched_content(feed_name: str, entry, triage_result: dict) -> str:
    """Format enriched content string for Open Brain capture."""
    title = getattr(entry, "title", "Untitled")
    content = _entry_content(entry)
    link = getattr(entry, "link", "")
    pub_date = _entry_date(entry)

    topics = ", ".join(triage_result.get("key_topics", []))
    tools = ", ".join(triage_result.get("tools_mentioned", []))

    lines = [
        f"[Newsletter: {feed_name}] {title}",
        "",
        f"Summary: {triage_result.get('summary', '')}",
        "",
        f"Category: {triage_result.get('category', 'unknown')}",
        f"Actionability: {triage_result.get('actionability', 'low')}",
        f"Topics: {topics}",
    ]
    if tools:
        lines.append(f"Tools: {tools}")

    lines += [
        "",
        "Content excerpt:",
        content[:1500],
        "",
        f"Published: {pub_date}",
        f"Source: {link}",
        f"Captured: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
    ]

    result = "\n".join(lines)
    return result[:4000]


def process_feed(feed_name: str, feed_url: str, tracker: DedupTracker,
                 dry_run: bool = False, max_first_run: int = 5) -> dict:
    """Process a single RSS feed."""
    stats = {"fetched": 0, "skipped": 0, "captured": 0, "failed": 0}

    feed = feedparser.parse(feed_url)
    if feed.bozo and not feed.entries:
        print(f"  Error parsing feed: {feed.bozo_exception}")
        return stats

    entries = feed.entries
    stats["fetched"] = len(entries)

    # First run: only process most recent entries
    is_first_run = tracker.count == 0
    if is_first_run and len(entries) > max_first_run:
        # Mark older entries as seen without processing
        for entry in entries[max_first_run:]:
            eid = _entry_id(feed_url, entry)
            if not tracker.is_processed(eid):
                tracker.mark_processed(eid, f"rss-{feed_name}-skipped")
        entries = entries[:max_first_run]
        print(f"  First run: processing {max_first_run} most recent, marking {stats['fetched'] - max_first_run} older as seen")

    for entry in entries:
        eid = _entry_id(feed_url, entry)
        title = getattr(entry, "title", "Untitled")[:60]

        if tracker.is_processed(eid):
            stats["skipped"] += 1
            continue

        print(f"  Processing: {title}...")

        if dry_run:
            print(f"    [dry-run] Would triage and capture")
            stats["captured"] += 1
            continue

        try:
            content = _entry_content(entry)
            triage_input = f"{feed_name}: {getattr(entry, 'title', '')}\n\n{content[:1500]}"
            triage_result = triage(triage_input)

            enriched = format_enriched_content(feed_name, entry, triage_result)
            capture_thought(enriched)
            tracker.mark_processed(eid, f"rss-{feed_name}")
            stats["captured"] += 1
            print(f"    Captured ({triage_result.get('actionability', '?')})")

        except Exception as e:
            stats["failed"] += 1
            print(f"    FAILED: {e}")

        time.sleep(ITEM_DELAY_SECONDS)

    return stats


def process_all_feeds(dry_run: bool = False, feed_filter: str | None = None) -> dict:
    """Process all configured RSS feeds."""
    tracker = DedupTracker("rss_processed.json")
    totals = {"fetched": 0, "skipped": 0, "captured": 0, "failed": 0}

    feeds = RSS_FEEDS
    if feed_filter:
        feeds = {k: v for k, v in feeds.items() if feed_filter.lower() in k.lower()}
        if not feeds:
            print(f"No feed matching '{feed_filter}'")
            return totals

    for name, url in feeds.items():
        print(f"\n--- {name} ---")
        stats = process_feed(name, url, tracker, dry_run=dry_run)
        for k in totals:
            totals[k] += stats[k]

    return totals
