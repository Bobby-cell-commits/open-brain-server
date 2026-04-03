"""Fetch and process daily papers from HuggingFace Hub API."""

import sys
import time
import requests

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]

from pipeline.config import (
    HF_SCREEN_TITLE_TERMS, HF_KEYWORD_ALLOWLIST,
    HF_UPVOTE_CATCH_ALL, ITEM_DELAY_SECONDS,
)
from pipeline.dedup import DedupTracker
from pipeline.triage import triage_paper
from pipeline.openbrain_client import capture_thought

HF_DAILY_PAPERS_URL = "https://huggingface.co/api/daily_papers"


def fetch_daily_papers() -> list[dict]:
    """Fetch today's daily papers from HuggingFace Hub API."""
    try:
        resp = requests.get(HF_DAILY_PAPERS_URL, timeout=15)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"  Error fetching HF daily papers: {e}")
        return []


def passes_keyword_screen(paper: dict) -> bool:
    """Check if a paper passes the keyword screen.

    A paper passes if ANY of:
    1. Title contains a screen term (case-insensitive substring match)
    2. Any ai_keyword is in the keyword allowlist (exact match)
    3. Upvotes >= HF_UPVOTE_CATCH_ALL
    """
    # Upvote catch-all
    if paper.get("upvotes", 0) >= HF_UPVOTE_CATCH_ALL:
        return True

    # Title screen
    title_lower = paper.get("title", "").lower()
    for term in HF_SCREEN_TITLE_TERMS:
        if term in title_lower:
            return True

    # Keyword allowlist
    ai_keywords = paper.get("paper", {}).get("ai_keywords", [])
    for kw in ai_keywords:
        if kw.lower() in HF_KEYWORD_ALLOWLIST:
            return True

    return False


def format_enriched_content(paper: dict, triage_result: dict) -> str:
    """Format enriched content string for Open Brain capture."""
    title = paper.get("title", "")
    paper_data = paper.get("paper", {})
    paper_id = paper_data.get("id", "")
    authors = ", ".join(a.get("name", "") for a in paper_data.get("authors", [])[:5])
    if len(paper_data.get("authors", [])) > 5:
        authors += " et al."
    abstract = paper_data.get("summary", "")[:1000]

    topics = ", ".join(triage_result.get("key_topics", []))
    tools = ", ".join(triage_result.get("tools_mentioned", []))

    lines = [
        f"[HF Paper] {title}",
        f"Authors: {authors}",
        "",
        f"Summary: {triage_result.get('summary', '')}",
        "",
        f"Category: {triage_result.get('category', 'learning')}",
        f"Actionability: {triage_result.get('actionability', 'low')}",
        f"Topics: {topics}",
    ]
    if tools:
        lines.append(f"Tools/Models: {tools}")

    lines += [
        "",
        "Abstract:",
        abstract,
        "",
        f"Source: https://huggingface.co/papers/{paper_id}",
        f"Captured: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
    ]

    result = "\n".join(lines)
    return result[:4000]


def process_papers(dry_run: bool = False) -> dict:
    """Fetch, screen, triage, and capture HF daily papers.

    Returns stats dict with keys: fetched, skipped, captured, failed, filtered.
    """
    tracker = DedupTracker("hf_papers_processed.json")
    stats = {"fetched": 0, "skipped": 0, "captured": 0, "failed": 0, "filtered": 0}

    papers = fetch_daily_papers()
    stats["fetched"] = len(papers)
    print(f"\nFetched {len(papers)} daily papers from HuggingFace")

    for paper in papers:
        paper_data = paper.get("paper", {})
        paper_id = paper_data.get("id", "")
        title = paper.get("title", "")[:60]
        event_id = f"hf_paper_{paper_id}"

        # Dedup — skip previously processed
        if tracker.is_processed(event_id):
            stats["skipped"] += 1
            continue

        # Keyword screen
        if not passes_keyword_screen(paper):
            tracker.mark_processed(event_id, "hf_papers-filtered")
            stats["filtered"] += 1
            continue

        print(f"  Processing: {title}...")

        if dry_run:
            print(f"    [dry-run] Would triage and capture")
            stats["captured"] += 1
            continue

        try:
            authors = ", ".join(a.get("name", "") for a in paper_data.get("authors", [])[:5])
            triage_result = triage_paper(
                title=paper.get("title", ""),
                abstract=paper_data.get("summary", ""),
                authors=authors,
                paper_url=f"https://huggingface.co/papers/{paper_id}",
            )

            # Only capture medium+ actionability
            if triage_result.get("actionability") in ("high", "medium"):
                enriched = format_enriched_content(paper, triage_result)
                capture_thought(enriched, source="hf_papers", source_event_id=event_id)
                tracker.mark_processed(event_id, "hf_papers")
                stats["captured"] += 1
                print(f"    Captured ({triage_result.get('actionability', '?')})")
            else:
                tracker.mark_processed(event_id, "hf_papers-low")
                stats["filtered"] += 1
                print(f"    Skipped ({triage_result.get('actionability', '?')})")

        except Exception as e:
            stats["failed"] += 1
            print(f"    FAILED: {e}")

        time.sleep(ITEM_DELAY_SECONDS)

    return stats
