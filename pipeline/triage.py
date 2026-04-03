"""LLM triage via OpenRouter gpt-4o-mini — structured classification of content.

Supports multimodal triage: when an image_url is provided, the image is sent to the
vision model alongside the text for richer classification of image/link posts.
"""

import json
import re
import time
import requests
from pipeline.config import OPENROUTER_API_KEY

# Customize category 2 below for your industry/domain. Replace "domain" with
# a label relevant to your work (e.g., "fintech", "biotech", "gamedev").
TRIAGE_SYSTEM_PROMPT = """You are a personal knowledge triage assistant. Given a Reddit post or newsletter article, produce a structured assessment. Return JSON with:
- "summary": 2-3 sentence summary. Focus on what is new, why it matters, what is actionable. If the post is a question, clearly state the question being asked.
- "category": classify using this procedure:
  1. Is this about AI coding tools, MCP protocol, developer tooling, LLM prompt engineering, code generation, or code review/analysis?
     → YES: "claude-code" → STOP
     → NO: continue to 2
  2. Is this about your industry or professional domain?
     → YES: "domain" → STOP
     → NO: continue to 3
  3. Is this about building AI applications, pipelines, or automation?
     → YES: "side-projects" → STOP
     → NO: continue to 4
  4. Is this ML research, an academic paper, or a technical concept?
     → YES: "learning" → STOP
     → NO: "personal"
- "actionability": classify using this procedure:
  1. Can this be directly applied to a current project this week?
     → YES: "high" → STOP
     → NO: continue to 2
  2. Worth investigating or reading within the next month?
     → YES: "medium" → STOP
     → NO: continue to 3
  3. Useful background knowledge for AI dev or ML research?
     → YES: "low" → STOP
     → NO: "archive"
- "key_topics": array of 2-4 topic tags, lowercase hyphenated
- "tools_mentioned": array of specific tools/libraries/products (empty if none)
- "urls": array of notable URLs from the content (excluding source URL)
Be concise. Do not hallucinate. If content is too short, return actionability "low".
If an image is attached, describe what it shows. For memes, explain the joke and cultural context. For infographics, charts, or guides, extract the key information as structured text."""

# Patterns for Reddit image/video hosts
IMAGE_URL_PATTERN = re.compile(
    r"https?://(?:i\.redd\.it|preview\.redd\.it|imgur\.com/\w+|i\.imgur\.com)/[^\s]+\.(?:jpg|jpeg|png|gif|webp)",
    re.IGNORECASE,
)
VIDEO_URL_PATTERN = re.compile(
    r"https?://(?:v\.redd\.it|gfycat\.com|streamable\.com)/",
    re.IGNORECASE,
)

FALLBACK_TRIAGE = {
    "summary": "",
    "category": "learning",
    "actionability": "low",
    "key_topics": [],
    "tools_mentioned": [],
    "urls": [],
}

PAPER_TRIAGE_SYSTEM_PROMPT = """You are a research paper triage assistant for a developer who builds AI applications and tracks ML research. Given a paper's metadata, produce a structured assessment. Return JSON with:
- "summary": 2-3 sentence summary focused on what is novel, why it matters, and practical implications
- "category": classify using this procedure:
  1. Is this about AI coding tools, MCP protocol, or developer tooling?
     → YES: "claude-code" → STOP
     → NO: continue to 2
  2. Is this about building AI applications, pipelines, or automation?
     → YES: "side-projects" → STOP
     → NO: continue to 3
  3. Is this ML research, an academic paper, or a technical concept?
     → YES: "learning" → STOP
     → NO: "personal"
- "actionability": classify using this procedure:
  1. Does this introduce a model, technique, or tool directly usable in current projects?
     → YES: "high" → STOP
     → NO: continue to 2
  2. Relevant research worth reading and understanding soon?
     → YES: "medium" → STOP
     → NO: continue to 3
  3. Interesting background knowledge for general awareness?
     → YES: "low" → STOP
     → NO: "archive"
- "key_topics": array of 2-4 topic tags, lowercase hyphenated
- "tools_mentioned": array of specific models/libraries/datasets released (empty if none)
- "urls": array of notable URLs (github repos, demo links) if mentioned in abstract
Be concise. Focus on practical implications for an AI application developer."""


def is_image_url(url: str) -> bool:
    """Check if a URL points to a Reddit/Imgur image."""
    return bool(IMAGE_URL_PATTERN.match(url))


def is_video_url(url: str) -> bool:
    """Check if a URL points to a Reddit/Gfycat video (not processable)."""
    return bool(VIDEO_URL_PATTERN.match(url))


def is_deleted_content(selftext: str) -> bool:
    """Check if post content is deleted or removed."""
    if not selftext:
        return False
    stripped = selftext.strip().lower()
    return stripped in ("[deleted]", "[removed]", "[ removed by reddit ]", "")


def triage(content: str, image_url: str | None = None, max_retries: int = 3) -> dict:
    """Run LLM triage on content. Optionally includes an image for vision analysis.

    Args:
        content: Text content to triage.
        image_url: Optional direct URL to an image for multimodal triage.
        max_retries: Number of retry attempts on failure.

    Returns structured classification dict.
    """
    delay = 1
    last_error = None

    # Build message content — multimodal if image provided
    if image_url:
        user_content = [
            {"type": "text", "text": content[:4000]},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]
    else:
        user_content = content[:4000]

    for attempt in range(max_retries):
        try:
            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY()}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "openai/gpt-4o-mini",
                    "messages": [
                        {"role": "system", "content": TRIAGE_SYSTEM_PROMPT},
                        {"role": "user", "content": user_content},
                    ],
                    "response_format": {"type": "json_object"},
                },
                timeout=60 if image_url else 30,
            )

            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", str(delay)))
                time.sleep(retry_after)
                delay *= 2
                last_error = f"Rate limited (429)"
                continue

            # 400 with image likely means the model couldn't fetch it — retry text-only
            if resp.status_code == 400 and image_url:
                print(f"  [triage] Image URL rejected (400), retrying text-only...")
                user_content = content[:4000]
                image_url = None  # Prevent re-adding image on subsequent retries
                continue

            resp.raise_for_status()
            result = resp.json()
            text = result["choices"][0]["message"]["content"]
            parsed = json.loads(text)

            # Validate required fields
            for key in ("summary", "category", "actionability", "key_topics"):
                if key not in parsed:
                    parsed[key] = FALLBACK_TRIAGE[key]

            return parsed

        except (json.JSONDecodeError, KeyError) as e:
            # Malformed JSON from LLM — use fallback
            fallback = dict(FALLBACK_TRIAGE)
            fallback["summary"] = content[:200]
            return fallback

        except requests.RequestException as e:
            last_error = str(e)
            time.sleep(delay)
            delay *= 2

    # All retries exhausted
    fallback = dict(FALLBACK_TRIAGE)
    fallback["summary"] = content[:200]
    print(f"  [triage] All retries failed: {last_error}. Using fallback.")
    return fallback


def triage_paper(title: str, abstract: str, authors: str,
                 paper_url: str, max_retries: int = 3) -> dict:
    """Run LLM triage on an academic paper.

    Args:
        title: Paper title.
        abstract: Paper abstract.
        authors: Author list string.
        paper_url: HuggingFace paper URL.
        max_retries: Number of retry attempts on failure.

    Returns structured classification dict.
    """
    content = f"Title: {title}\nAuthors: {authors}\nURL: {paper_url}\n\nAbstract:\n{abstract}"
    content = content[:4000]

    delay = 1
    last_error = None

    for attempt in range(max_retries):
        try:
            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY()}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "openai/gpt-4o-mini",
                    "messages": [
                        {"role": "system", "content": PAPER_TRIAGE_SYSTEM_PROMPT},
                        {"role": "user", "content": content},
                    ],
                    "response_format": {"type": "json_object"},
                },
                timeout=30,
            )

            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", str(delay)))
                time.sleep(retry_after)
                delay *= 2
                last_error = "Rate limited (429)"
                continue

            resp.raise_for_status()
            result = resp.json()
            text = result["choices"][0]["message"]["content"]
            parsed = json.loads(text)

            for key in ("summary", "category", "actionability", "key_topics"):
                if key not in parsed:
                    parsed[key] = FALLBACK_TRIAGE[key]

            return parsed

        except (json.JSONDecodeError, KeyError):
            fallback = dict(FALLBACK_TRIAGE)
            fallback["summary"] = f"{title}: {abstract[:200]}"
            return fallback

        except requests.RequestException as e:
            last_error = str(e)
            time.sleep(delay)
            delay *= 2

    fallback = dict(FALLBACK_TRIAGE)
    fallback["summary"] = f"{title}: {abstract[:200]}"
    print(f"  [triage_paper] All retries failed: {last_error}. Using fallback.")
    return fallback
