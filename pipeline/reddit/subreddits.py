"""Fetch and process hot posts from monitored subreddits via public .json endpoints."""

import time
import requests

from pipeline.config import (
    MONITORED_SUBREDDITS, REDDIT_USER_AGENT, ITEM_DELAY_SECONDS,
    SUBREDDIT_CONFIG, VISION_ALLOWED_SUBS, TRIAGE_GATED_SUBS,
    COMMENT_ENABLED_SUBS, COMMENT_SCORE_THRESHOLD,
    COMMENT_MAX_PER_POST, COMMENT_MIN_POST_COMMENTS,
)
from pipeline.dedup import DedupTracker
from pipeline.triage import triage, is_image_url, is_video_url, is_deleted_content
from pipeline.openbrain_client import capture_thought


def fetch_hot(subreddit: str, limit: int = 10) -> list[dict]:
    """Fetch hot posts from a subreddit using public .json endpoint."""
    resp = requests.get(
        f"https://www.reddit.com/r/{subreddit}/hot.json",
        headers={"User-Agent": REDDIT_USER_AGENT},
        params={"limit": limit, "raw_json": 1},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    return [
        child["data"]
        for child in data["data"]["children"]
        if child["kind"] == "t3" and not child["data"].get("stickied")
    ]


def fetch_top_comments(post_id: str, subreddit: str,
                       score_threshold: int = COMMENT_SCORE_THRESHOLD,
                       max_comments: int = COMMENT_MAX_PER_POST) -> list[dict]:
    """Fetch top comments for a post, filtered by score and content.

    Returns list of dicts with 'body' and 'score' keys, sorted by score descending.
    Returns empty list on any error (non-blocking).
    """
    try:
        resp = requests.get(
            f"https://www.reddit.com/r/{subreddit}/comments/{post_id}.json",
            headers={"User-Agent": REDDIT_USER_AGENT},
            params={"sort": "top", "limit": 20, "raw_json": 1},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return []

    if not isinstance(data, list) or len(data) < 2:
        return []

    raw_comments = data[1].get("data", {}).get("children", [])
    filtered = []
    for c in raw_comments:
        if c.get("kind") != "t1":
            continue
        body = c["data"].get("body", "")
        score = c["data"].get("score", 0)
        if score < score_threshold:
            continue
        if body in ("[removed]", "[deleted]"):
            continue
        if "I am a bot" in body:
            continue
        filtered.append({"body": body[:500], "score": score})

    filtered.sort(key=lambda x: x["score"], reverse=True)
    return filtered[:max_comments]


def _detect_image_url(post: dict) -> str | None:
    """Extract a direct image URL from a Reddit post, if available."""
    url = post.get("url", "")
    if is_image_url(url):
        return url
    # Reddit gallery — grab first image from media_metadata
    media_metadata = post.get("media_metadata")
    if media_metadata and isinstance(media_metadata, dict):
        for item in media_metadata.values():
            if item.get("status") == "valid" and item.get("e") == "Image":
                source = item.get("s", {}).get("u", "")
                if source:
                    return source.replace("&amp;", "&")
    return None


def _should_skip_post(post: dict, subreddit: str) -> str | None:
    """Return a skip reason if this post has no usable content, or None to proceed."""
    selftext = post.get("selftext", "")
    url = post.get("url", "")

    # Deleted or removed content
    if is_deleted_content(selftext):
        return "deleted/removed"

    # Video posts — can't process
    if is_video_url(url):
        return "video post"

    # Vision-only filter: image post with no text
    if not selftext and _detect_image_url(post):
        if subreddit not in VISION_ALLOWED_SUBS:
            return "vision-only, sub not in vision whitelist"
        # Sub is in vision whitelist — allow through for triage
        return None

    # No text AND no processable image — pure link to non-image external site
    if not selftext and not _detect_image_url(post):
        return "empty link post (no text, no image)"

    return None


def format_enriched_content(post: dict, triage_result: dict,
                            comments: list[dict] | None = None) -> str:
    """Format enriched content string for Open Brain capture."""
    subreddit = post["subreddit"]
    title = post["title"]
    selftext = post.get("selftext", "")
    url = post.get("url", "")
    permalink = post.get("permalink", "")

    body = selftext[:1000] if selftext else f"[Image post: {url}]"

    topics = ", ".join(triage_result.get("key_topics", []))
    tools = ", ".join(triage_result.get("tools_mentioned", []))

    lines = [
        f"[Reddit r/{subreddit}] {title}",
        "",
        f"Summary: {triage_result.get('summary', '')}",
        "",
        f"Category: {triage_result.get('category', 'unknown')}",
        f"Actionability: {triage_result.get('actionability', 'low')}",
        f"Topics: {topics}",
    ]
    if tools:
        lines.append(f"Tools: {tools}")

    lines += ["", "Original content:", body]

    if comments:
        lines += ["", "Notable comments:"]
        for c in comments:
            lines.append(f"- [score={c['score']}] {c['body']}")

    lines += [
        "",
        f"Source: https://reddit.com{permalink}",
        f"Captured: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
    ]

    result = "\n".join(lines)
    return result[:4000]


def process_subreddits(limit_per_sub: int = 10, dry_run: bool = False) -> dict:
    """Process hot posts from all monitored subreddits."""
    tracker = DedupTracker("reddit_processed.json")
    stats = {"fetched": 0, "skipped": 0, "captured": 0, "failed": 0, "filtered": 0}

    for sub in MONITORED_SUBREDDITS:
        # Per-sub limit override
        sub_limit = SUBREDDIT_CONFIG.get(sub, {}).get("limit", limit_per_sub)
        print(f"\nr/{sub} (limit={sub_limit}):")
        try:
            posts = fetch_hot(sub, sub_limit)
        except Exception as e:
            print(f"  Error fetching: {e}")
            continue

        stats["fetched"] += len(posts)

        for post in posts:
            fullname = f"t3_{post['id']}"
            title = post["title"][:60]

            if tracker.is_processed(fullname):
                stats["skipped"] += 1
                continue

            # Content filter — skip posts with no usable content
            skip_reason = _should_skip_post(post, sub)
            if skip_reason:
                print(f"  Skipping: {title} ({skip_reason})")
                tracker.mark_processed(fullname, f"reddit-{sub}-filtered")
                stats["filtered"] += 1
                continue

            print(f"  Processing: {title}...")

            if dry_run:
                print(f"    [dry-run] Would triage and capture")
                stats["captured"] += 1
                continue

            try:
                # Detect image for vision triage
                image_url = _detect_image_url(post)
                selftext = post.get("selftext", "")

                triage_input = f"r/{sub}: {post['title']}\n\n{selftext[:1500]}"
                if image_url and not selftext:
                    triage_input = f"r/{sub}: {post['title']}\n\n[Image post — see attached image]"

                triage_result = triage(triage_input, image_url=image_url)

                # Triage gate: filter noise based on actionability
                actionability = triage_result.get("actionability", "low")
                if actionability == "archive" or (
                    actionability == "low" and sub in TRIAGE_GATED_SUBS
                ):
                    tracker.mark_processed(fullname, f"reddit-{sub}-filtered")
                    stats["filtered"] += 1
                    print(f"    Filtered ({actionability})")
                    continue

                # Fetch top comments for comment-enabled subs
                comments = []
                if (sub in COMMENT_ENABLED_SUBS
                        and post.get("num_comments", 0) >= COMMENT_MIN_POST_COMMENTS):
                    comments = fetch_top_comments(post["id"], sub)

                enriched = format_enriched_content(post, triage_result, comments)
                capture_thought(enriched, source="reddit", source_event_id=fullname)
                tracker.mark_processed(fullname, f"reddit-{sub}")
                stats["captured"] += 1
                label = "vision" if image_url else actionability
                if comments:
                    label += f"+{len(comments)}c"
                print(f"    Captured ({label})")

            except Exception as e:
                stats["failed"] += 1
                print(f"    FAILED: {e}")

            time.sleep(ITEM_DELAY_SECONDS)

    return stats
