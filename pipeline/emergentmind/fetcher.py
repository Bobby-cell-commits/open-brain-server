"""Fetch and process trending papers from Emergent Mind."""

import sys
import time
import requests

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]

from pipeline.config import (
    EMERGENT_MIND_API_URL, EMERGENT_MIND_TEMP_THRESHOLD, ITEM_DELAY_SECONDS,
)
from pipeline.dedup import DedupTracker
from pipeline.triage import triage_paper
from pipeline.openbrain_client import capture_thought

# All arXiv category IDs — requests all subjects so we don't miss cross-listed papers
_ALL_CATEGORY_IDS = ",".join(str(i) for i in range(1, 156))


def fetch_trending_papers() -> list[dict]:
    """Fetch trending papers from Emergent Mind JSON API."""
    try:
        resp = requests.get(
            EMERGENT_MIND_API_URL,
            params={"timeframe": "7d", "category_ids": _ALL_CATEGORY_IDS},
            headers={"User-Agent": "open-brain-pipeline/1.0"},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        papers = data.get("papers", [])
        if not isinstance(papers, list):
            print(f"  Warning: API response 'papers' is not a list (got {type(papers).__name__})")
            return []
        return papers
    except Exception as e:
        print(f"  Error fetching Emergent Mind API: {e}")
        return []


def format_enriched_content(paper: dict, triage_result: dict) -> str:
    """Format enriched content string for Open Brain capture."""
    title = paper.get("title", "")
    arxiv_id = paper.get("arxiv_paper_id", "")
    abstract = paper.get("abstract", "")[:1000]
    temperature = paper.get("temperature", 0)

    topics = ", ".join(triage_result.get("key_topics", []))
    tools = ", ".join(triage_result.get("tools_mentioned", []))

    # Social metrics
    tw = paper.get("twitter_likes_count", 0)
    rd = paper.get("reddit_points_count", 0)
    hn = paper.get("hacker_news_points_count", 0)
    gh = paper.get("github_stars_count", 0)

    lines = [
        f"[Emergent Mind] {title}",
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
        f"Social signals: {tw} Twitter, {rd} Reddit, {hn} HN, {gh} GitHub stars",
        f"Temperature: {temperature}",
        "",
        "Abstract:",
        abstract,
        "",
        f"Source: https://www.emergentmind.com/papers/{arxiv_id}",
        f"arXiv: https://arxiv.org/abs/{arxiv_id}",
        f"Captured: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
    ]

    result = "\n".join(lines)
    return result[:4000]


def process_papers(dry_run: bool = False) -> dict:
    """Fetch, filter, triage, and capture Emergent Mind trending papers.

    Returns stats dict with keys: fetched, skipped, captured, failed, filtered.
    """
    # No cross-dedup with HF Papers — Edge Function handles that for production.
    # Python is for manual testing/debugging only.
    tracker = DedupTracker("emergentmind_processed.json")
    stats = {"fetched": 0, "skipped": 0, "captured": 0, "failed": 0, "filtered": 0}

    papers = fetch_trending_papers()
    stats["fetched"] = len(papers)
    print(f"\nFetched {len(papers)} trending papers from Emergent Mind")

    for paper in papers:
        arxiv_id = paper.get("arxiv_paper_id", "")
        title = paper.get("title", "")[:60]
        temperature = paper.get("temperature", 0)
        event_id = f"emergentmind_{arxiv_id}"

        # Dedup — skip previously processed
        if tracker.is_processed(event_id):
            stats["skipped"] += 1
            continue

        # Temperature filter
        if temperature < EMERGENT_MIND_TEMP_THRESHOLD:
            tracker.mark_processed(event_id, "emergentmind-low-temp")
            stats["filtered"] += 1
            continue

        print(f"  Processing: {title}... (temp={temperature})")

        if dry_run:
            print(f"    [dry-run] Would triage and capture")
            stats["captured"] += 1
            continue

        try:
            abstract = paper.get("abstract", "")
            triage_result = triage_paper(
                title=paper.get("title", ""),
                abstract=abstract,
                authors="",  # Emergent Mind data does not include authors
                paper_url=f"https://www.emergentmind.com/papers/{arxiv_id}",
            )

            # Only capture medium+ actionability
            if triage_result.get("actionability") in ("high", "medium"):
                enriched = format_enriched_content(paper, triage_result)
                capture_thought(enriched, source="emergent_mind", source_event_id=event_id)
                tracker.mark_processed(event_id, "emergent_mind")
                stats["captured"] += 1
                print(f"    Captured ({triage_result.get('actionability', '?')})")
            else:
                tracker.mark_processed(event_id, "emergentmind-low")
                stats["filtered"] += 1
                print(f"    Skipped ({triage_result.get('actionability', '?')})")

        except Exception as e:
            stats["failed"] += 1
            print(f"    FAILED: {e}")

        time.sleep(ITEM_DELAY_SECONDS)

    return stats
