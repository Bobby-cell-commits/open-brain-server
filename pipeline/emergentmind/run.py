"""CLI entry point: python -m pipeline.emergentmind.run"""

import argparse
from pipeline.emergentmind.fetcher import process_papers


def main():
    parser = argparse.ArgumentParser(description="Open Brain Emergent Mind Pipeline")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be captured without capturing")

    args = parser.parse_args()

    print("=== Emergent Mind: Trending Research Papers ===")
    stats = process_papers(dry_run=args.dry_run)
    print(f"\nResults: {stats['captured']} captured, "
          f"{stats['skipped']} skipped, {stats['filtered']} filtered, "
          f"{stats['failed']} failed "
          f"(of {stats['fetched']} fetched)")


if __name__ == "__main__":
    main()
