"""Orchestrator: Reddit + RSS + HF Papers + Morning Briefing.

Usage: python -m pipeline.run_all [--reddit-only] [--rss-only] [--hf-papers-only] [--briefing-only] [--dry-run]
"""

import argparse
import time

from pipeline.reddit.subreddits import process_subreddits
from pipeline.rss.fetcher import process_all_feeds
from pipeline.briefing.morning import generate_briefing
from pipeline.hf_papers.fetcher import process_papers as process_hf_papers
from pipeline.emergentmind.fetcher import process_papers as process_emergentmind
from pipeline.openbrain_client import report_pipeline_run


def main():
    parser = argparse.ArgumentParser(description="Open Brain Full Pipeline")
    parser.add_argument("--reddit-only", action="store_true")
    parser.add_argument("--rss-only", action="store_true")
    parser.add_argument("--hf-papers-only", action="store_true")
    parser.add_argument("--briefing-only", action="store_true")
    parser.add_argument("--emergentmind-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()

    run_all = not (args.reddit_only or args.rss_only or args.briefing_only or args.hf_papers_only or args.emergentmind_only)
    totals = {"captured": 0, "skipped": 0, "failed": 0}
    start = time.time()

    if run_all or args.reddit_only:
        print("=" * 60)
        print("REDDIT: Subreddit Monitoring")
        print("=" * 60)
        stats = _run_source("reddit", lambda: process_subreddits(dry_run=args.dry_run), args.dry_run)
        _accumulate(totals, stats)

    if run_all or args.rss_only:
        print("\n" + "=" * 60)
        print("RSS: Newsletter Feeds")
        print("=" * 60)
        stats = _run_source("rss", lambda: process_all_feeds(dry_run=args.dry_run), args.dry_run)
        _accumulate(totals, stats)

    if run_all or args.hf_papers_only:
        print("\n" + "=" * 60)
        print("HF PAPERS: HuggingFace Research Papers")
        print("=" * 60)
        stats = _run_source("hf_papers", lambda: process_hf_papers(dry_run=args.dry_run), args.dry_run)
        _accumulate(totals, stats)

    if run_all or args.emergentmind_only:
        print("\n" + "=" * 60)
        print("EMERGENT MIND: Trending Research Papers")
        print("=" * 60)
        stats = _run_source("emergent_mind", lambda: process_emergentmind(dry_run=args.dry_run), args.dry_run)
        _accumulate(totals, stats)

    if run_all or args.reddit_only or args.rss_only or args.hf_papers_only or args.emergentmind_only:
        elapsed = time.time() - start
        print("\n" + "=" * 60)
        print(f"PIPELINE SUMMARY ({elapsed:.0f}s)")
        print(f"  Captured: {totals['captured']}")
        print(f"  Skipped:  {totals['skipped']}")
        print(f"  Failed:   {totals['failed']}")
        print("=" * 60)

    if run_all or args.briefing_only:
        print("\n")
        print(generate_briefing())


def _run_source(source_name: str, runner, dry_run: bool) -> dict:
    """Run a pipeline source, report timing and stats to monitoring."""
    source_start = time.time()
    error_msg = None
    try:
        stats = runner()
    except Exception as e:
        error_msg = str(e)
        stats = {"captured": 0, "skipped": 0, "failed": 1}
        print(f"  ERROR: {e}")

    elapsed_ms = int((time.time() - source_start) * 1000)

    if not dry_run:
        report_pipeline_run(
            source=source_name,
            captured=stats.get("captured", 0),
            failed=stats.get("failed", 0),
            skipped=stats.get("skipped", 0),
            execution_ms=elapsed_ms,
            error_message=error_msg,
        )

    return stats


def _accumulate(totals: dict, stats: dict):
    for k in ("captured", "skipped", "failed"):
        totals[k] += stats.get(k, 0)


if __name__ == "__main__":
    main()
