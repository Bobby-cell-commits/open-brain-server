"""Morning briefing — queries Open Brain and formats a daily report."""

import json
import time
from pipeline.openbrain_client import list_thoughts, search_thoughts, thought_stats
from pipeline.config import FOCUS_TERMS


def _extract_text(result: dict) -> list[dict]:
    """Extract thought data from MCP JSON-RPC response."""
    try:
        content = result.get("result", {}).get("content", [])
        for item in content:
            if item.get("type") == "text":
                parsed = json.loads(item["text"])
                if isinstance(parsed, list):
                    return parsed
                if isinstance(parsed, dict) and "thoughts" in parsed:
                    return parsed["thoughts"]
                return [parsed] if parsed else []
    except (json.JSONDecodeError, KeyError, TypeError):
        pass
    return []


def _format_thought_line(thought: dict, index: int) -> str:
    """Format a single thought as a briefing line."""
    content = thought.get("content", "")
    # Extract first line (usually the header like [Reddit r/...] or [Newsletter: ...])
    first_line = content.split("\n")[0][:80] if content else "No content"

    # Try to extract actionability and category from content
    actionability = ""
    category = ""
    for line in content.split("\n"):
        if line.startswith("Actionability:"):
            actionability = line.split(":", 1)[1].strip()
        elif line.startswith("Category:"):
            category = line.split(":", 1)[1].strip()

    meta_parts = []
    if actionability:
        meta_parts.append(f"Actionability: {actionability}")
    if category:
        meta_parts.append(f"Category: {category}")

    meta = " | ".join(meta_parts)
    meta_str = f"\n   {meta}" if meta else ""

    return f"{index}. {first_line}{meta_str}"


def _get_focus_terms() -> list[str]:
    """Get dynamic focus terms from recent brain activity. Falls back to FOCUS_TERMS."""
    try:
        result = thought_stats(days=7)
        text = result["result"]["content"][0]["text"]
        parsed = json.loads(text)
        topics = [item["topic"] for item in parsed.get("top_topics", [])[:5]]
        if topics:
            return topics
    except Exception:
        pass
    return list(FOCUS_TERMS)


def generate_briefing() -> str:
    """Generate the morning briefing report."""
    today = time.strftime("%Y-%m-%d")
    sections = []

    sections.append(f"=== Open Brain Morning Briefing ({today}) ===\n")

    # Section 1: Yesterday's captures
    try:
        result = list_thoughts(days=1, limit=20)
        thoughts = _extract_text(result)
        sections.append(f"--- Yesterday's Captures ({len(thoughts)} items) ---")
        if thoughts:
            for i, t in enumerate(thoughts, 1):
                sections.append(_format_thought_line(t, i))
        else:
            sections.append("  No captures yesterday.")
        sections.append("")
    except Exception as e:
        sections.append(f"--- Yesterday's Captures ---\n  Error: {e}\n")

    # Section 2: Top-salience items this week
    try:
        result = list_thoughts(days=7, limit=10)
        thoughts = _extract_text(result)
        sections.append(f"--- Top Items This Week ({len(thoughts)}) ---")
        if thoughts:
            for i, t in enumerate(thoughts, 1):
                sections.append(_format_thought_line(t, i))
                content = t.get("content", "")
                for line in content.split("\n"):
                    if line.startswith("Summary:"):
                        summary = line.split(":", 1)[1].strip()[:120]
                        sections.append(f"   Summary: {summary}")
                        break
        else:
            sections.append("  No items this week.")
        sections.append("")
    except Exception as e:
        sections.append(f"--- Top Items This Week ---\n  Error: {e}\n")

    # Section 3: Relevant to current work (semantic search with dynamic terms)
    focus_terms = _get_focus_terms()
    for term in focus_terms:
        try:
            result = search_thoughts(query=term, limit=3)
            thoughts = _extract_text(result)
            sections.append(f"--- Relevant: \"{term}\" ({len(thoughts)} matches) ---")
            if thoughts:
                for i, t in enumerate(thoughts, 1):
                    sections.append(_format_thought_line(t, i))
            else:
                sections.append("  No matches.")
            sections.append("")
        except Exception as e:
            sections.append(f"--- Relevant: \"{term}\" ---\n  Error: {e}\n")

    return "\n".join(sections)
