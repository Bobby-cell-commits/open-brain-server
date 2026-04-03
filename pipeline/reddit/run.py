"""CLI entry point: python -m pipeline.reddit.run"""

import argparse
from pipeline.reddit.subreddits import process_subreddits
from pipeline.reddit.import_export import import_saved_posts


def main():
    parser = argparse.ArgumentParser(description="Open Brain Reddit Pipeline")
    parser.add_argument("--subreddits", action="store_true", help="Process hot posts from monitored subreddits")
    parser.add_argument("--import-saved", type=str, metavar="PATH", help="Import saved posts from Reddit data export CSV")
    parser.add_argument("--filter", type=str, metavar="PATH", help="Subreddit filter CSV (columns: subreddit, count, action)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be captured without capturing")
    parser.add_argument("--limit", type=int, default=None, help="Max items to process")

    args = parser.parse_args()

    if args.import_saved:
        print("=== Reddit Saved Posts Import ===\n")
        stats = import_saved_posts(args.import_saved, dry_run=args.dry_run,
                                   limit=args.limit, filter_csv=args.filter)
        print(f"\nResults: {stats['captured']} captured, "
              f"{stats['skipped']} skipped, {stats['failed']} failed, "
              f"{stats['not_found']} not found "
              f"(of {stats['total']} total)")
        return

    # Default to subreddits
    print("=== Reddit Subreddit Monitoring ===")
    stats = process_subreddits(dry_run=args.dry_run)
    print(f"\nResults: {stats['captured']} captured, "
          f"{stats['skipped']} skipped, {stats['failed']} failed "
          f"(of {stats['fetched']} fetched)")


if __name__ == "__main__":
    main()
