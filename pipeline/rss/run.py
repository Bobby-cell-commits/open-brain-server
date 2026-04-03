"""CLI entry point: python -m pipeline.rss.run"""

import argparse
from pipeline.rss.fetcher import process_all_feeds


def main():
    parser = argparse.ArgumentParser(description="Open Brain RSS Pipeline")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be captured without capturing")
    parser.add_argument("--feed", type=str, default=None, help="Process only feeds matching this name")

    args = parser.parse_args()

    print("=== RSS Newsletter Pipeline ===")
    stats = process_all_feeds(dry_run=args.dry_run, feed_filter=args.feed)
    print(f"\nResults: {stats['captured']} captured, "
          f"{stats['skipped']} skipped, {stats['failed']} failed "
          f"(of {stats['fetched']} fetched)")


if __name__ == "__main__":
    main()
