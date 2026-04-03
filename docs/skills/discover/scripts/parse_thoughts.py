"""Parse Open Brain thought results from JSON files.

Handles the nested JSON format: [{type: "text", text: "[...actual data...]"}]
and produces a readable summary table.

Usage:
    python parse_thoughts.py <json-file-path>
    python parse_thoughts.py <json-file-path> --full  # no content truncation
"""

import json
import sys


def parse_thoughts(file_path: str) -> list[dict]:
    """Parse Open Brain JSON and return simplified thought records."""
    with open(file_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    # Handle nested wrapper format
    if isinstance(raw, list) and raw and isinstance(raw[0], dict) and "text" in raw[0]:
        thoughts = json.loads(raw[0]["text"])
    elif isinstance(raw, list) and raw and isinstance(raw[0], dict) and "content" in raw[0]:
        thoughts = raw
    else:
        print(f"ERROR: Unrecognized JSON format in {file_path}", file=sys.stderr)
        sys.exit(1)

    return thoughts


def format_thought(i: int, t: dict, truncate: int) -> str:
    """Format a single thought as a readable string."""
    content = t.get("content", "").replace("\n", " ")
    if truncate and len(content) > truncate:
        content = content[:truncate] + "..."

    meta = t.get("metadata", {})
    ttype = meta.get("type", "?")
    topics = ", ".join(meta.get("topics", []))
    people = ", ".join(meta.get("people", []))
    created = t.get("created_at", "")[:10]
    source = t.get("source", "?")
    sim = t.get("similarity")
    merge_count = t.get("merge_count", 0)

    parts = [f"{i + 1:3}. [{ttype:12}] [{created}] [{source:7}] {content}"]
    if topics:
        parts.append(f"     Topics: {topics}")
    if people:
        parts.append(f"     People: {people}")
    if merge_count and merge_count > 0:
        parts.append(f"     Merges: {merge_count} (convergence hotspot)")
    if sim is not None:
        parts.append(f"     Similarity: {sim:.3f}")
    return "\n".join(parts)


def main():
    if len(sys.argv) < 2:
        print("Usage: python parse_thoughts.py <json-file> [--full]", file=sys.stderr)
        sys.exit(1)

    file_path = sys.argv[1]
    truncate = 0 if "--full" in sys.argv else 160

    thoughts = parse_thoughts(file_path)
    print(f"Total thoughts: {len(thoughts)}\n")

    for i, t in enumerate(thoughts):
        print(format_thought(i, t, truncate))
        print()


if __name__ == "__main__":
    main()
