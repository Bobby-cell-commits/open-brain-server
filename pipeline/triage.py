"""LLM triage via OpenRouter — structured classification of content.

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
             Only use "claude-code" when the post's primary subject is the tool/workflow itself; ordinary library/plugin/dataset release notes, version bumps, or announcement posts should not become "claude-code" just because they mention code, LLMs, or ship an implementation. If Claude Code is merely mentioned inside a leak, report, benchmark, or discussion about something else, classify by that substantive topic instead. Newsletter or blog coverage that is specifically about Claude Code workflow changes, source leaks, permission modes, or usage advice should stay "claude-code" even when it reads like general AI news. Practical warnings aimed at Claude Code users, such as security advisories, lockfile/supply-chain alerts, or usage-tracking questions, stay "claude-code" when the post is really about the Claude Code workflow. Direct "what should I use Claude/Claude Code for?" usage-advice posts about the tool itself also stay "claude-code" when they are asking how to apply the workflow in practice. Hands-on comparison, evaluation, or "how does this coding assistant work in practice?" posts about Claude Code or adjacent coding assistants should also stay "claude-code" when the focus is using or testing the workflow rather than the underlying model. Also keep git-native agent standards, specs, or protocol posts in "claude-code" when they are defining the coding-workflow itself rather than a generic app framework.
      → YES: "claude-code" → STOP
     → NO: continue to 2
   2. Is this specifically about your own business, product, team, customers, or operational domain?
         Use "domain" only for content tied to your actual work context, not for general AI/ML news, technical commentary, newsletters, benchmarks, research discussion, or AI industry updates like GPU pricing, vendor news, revenue/ARR/funding posts, or company launch coverage; those should usually be "learning" unless they directly affect your own business or work. Mentions of OpenAI, Anthropic, Trump administration figures, or other outside organizations do not make a post "domain" by themselves. Requests to add/configure sources, change capture or pipeline behavior, or deploy automation for this repo are "side-projects" unless they are explicitly about your real business or team operations.
       → YES: "domain" → STOP
       → NO: continue to 3
           3. Is this about building AI applications, pipelines, or automation?
           Only use "side-projects" when the main subject is a concrete build/shipping/automation effort; ordinary library/plugin/dataset release notes, version bumps, and announcement posts for existing projects also belong here if the post is about that project's release. Builder reflections, post-mortems, and shipping stories about a real implementation should also stay "side-projects" even when they read like an essay. Discussion, critique, benchmark, or "should we build this?" posts about agent frameworks, autonomy, registries, or other AI techniques should usually be "learning" when they are abstract analysis, but concrete suggestions to deploy, orchestrate, wire up, or automate a specific tool/workflow should stay "side-projects" even when they are framed as a question or learning prompt. If the post is centered on agent infrastructure, A2A registries, multi-agent orchestration, or autonomous-bot design as something to build, evaluate, or ship, classify it as "side-projects" even when the tone is exploratory or skeptical.
       → YES: "side-projects" → STOP
     → NO: continue to 4
   4. Is this ML research, an academic paper, a tutorial/walkthrough, or a technical concept?
       If it is an educational example, experiment, or code demo about a technique, model, or algorithm, classify as "learning" even if it includes code or a small project. For example, a tutorial project like estimating ISS speed from images with Python/OpenCV is still "learning", not "side-projects".
          Also classify AI/ML news stories, interviews, opinion pieces, ecosystem analyses, documentary-style videos, watch/listen posts, or anecdotal writeups as "learning" when they explain a technical mechanism, research result, benchmark, or tool behavior rather than a private-life or purely social post. Very short greetings, acknowledgments, and other non-substantive one-liners are "personal", not "learning".
       → YES: "learning" → STOP
      → NO: "personal"
- "actionability": classify using this procedure:
        1. Can this be directly applied to a current project this week?
        Before considering "high", hard-cap newsletters, roundups, release notes, version bumps, changelogs, and announcement coverage for existing tools/plugins/datasets at "medium". Keep that cap even if the post includes excitement, benchmark language, repo/demo links, or a new backend/plugin for an existing project; only lift it when the item itself is a genuinely new standalone artifact you could adopt directly this week.
        If the content is mainly a question, recommendation request, or usage advice without a concrete artifact, cap it at "medium".
            If the content is primarily a how-to, install, setup, deployment, or local-run guide for an existing tool/project, keep it at "medium" unless it introduces a genuinely new reusable artifact or capability. Learning-oriented repos, playgrounds, sandboxes, showcase posts, and README/demo walkthroughs also stay at "medium" unless they clearly ship a new reusable library, dataset, benchmark, or component you could adopt directly. In particular, repo-style posts that frame an existing technique as a "framework", "one repo", or "sandbox" for learning/exploration are still "medium" unless the post introduces a distinct reusable package or service. Launch announcements whose novelty is mainly "fully local", kernel-isolated, security-hardened, or "runs in OpenShell with llama.cpp" execution for a sandbox/runner also stay at "medium" unless they release a distinct reusable artifact. Titles that advertise the item as a way to "learn" the technique do not make it "high" unless the post actually ships a new reusable artifact. Case studies and success-story posts about using an existing tool (for example, running Claude Code locally with Ollama, installing Qwen 3.6, or building apps with Claude Code) also stay at "medium" unless they ship a new reusable artifact you could adopt directly.
           If the content is a newsletter, curated digest, roundup, changelog, version bump, or announcement that mainly summarizes someone else's release/update, keep it at "medium" unless it ships a clearly new reusable artifact (code, dataset, benchmark, or demo) you could adopt directly. This includes posts whose main novelty is a routine update to an existing project (for example, a new backend, plugin release, or version bump), which still stay at "medium" when they are just announcement coverage.
        The presence of a repo link, version number, code snippet, benchmark claim, or performance improvement does not make these posts "high"; routine releases of an existing plugin/tool/dataset stay at "medium" unless they introduce a genuinely new standalone artifact or capability you can apply directly this week. Posts whose main novelty is that an existing tool/agent/runner works fully local, inside a sandbox, or with kernel isolation also stay at "medium"; runtime-envelope details alone do not make the item a new reusable artifact. Requests to add or configure sources, or to change capture/pipeline behavior for this repo, are maintenance tasks and also stay at "medium" unless they ship a new reusable implementation or artifact.
        If the content is a leak, stolen source, or otherwise unauthorized repost, cap it at "archive" unless it includes a legitimate public release or reusable implementation. This includes source-map dumps, npm registry map-file leaks, mirrored source trees, registry leaks, and other reposts of private code even when they look technically useful or appear to expose implementation details.
        → YES: "high" → STOP
     → NO: continue to 2
   2. Worth investigating or reading within the next month?
       Operational incidents, outages, or service-degradation reports about AI tools or services are "medium" even when they are not directly reusable, because they inform reliability and vendor-risk decisions. Security incidents that involve leaked secrets, stolen credentials, or an exploited AI workflow are "high" when the post includes a concrete fix or mitigation path; do not cap those at medium just because they are incident reports.
       → YES: "medium" → STOP
      → NO: continue to 3
   3. Useful background knowledge for AI dev or ML research?
      Very short greetings, acknowledgments, and other non-substantive one-liners should be "archive" rather than "low".
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

DEFAULT_TRIAGE_MODEL = "google/gemma-4-26b-a4b-it"


def _parse_json_response(text: str) -> dict:
    """Parse JSON from LLM response, stripping markdown code fences if present."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    return json.loads(text)

PAPER_TRIAGE_SYSTEM_PROMPT = """You are a research paper triage assistant for a developer who builds AI applications and tracks ML research. Given a paper's metadata, produce a structured assessment. Return JSON with:
- "summary": 2-3 sentence summary focused on what is novel, why it matters, and practical implications
- "category": classify using this procedure:
   1. Is this about AI coding tools, MCP protocol, or developer tooling? (e.g., papers on code generation, LLM-based IDEs, prompt engineering tools)
      Only use "claude-code" when the main contribution is a coding assistant or coding workflow itself; general-purpose libraries, plugins, datasets, and release/update notes stay "side-projects" even if they include code, benchmarks, demos, or a repo link. If the item is a source leak, report, or deep-dive specifically about Claude Code itself, keep "claude-code"; only classify by another topic when Claude Code is incidental.
      → YES: "claude-code" → STOP
      → NO: continue to 2
  2. Is this about building AI applications, pipelines, or automation? (e.g., workflow orchestration, end-to-end app frameworks, productionization)
     → YES: "side-projects" → STOP
     → NO: continue to 3
  3. Is this ML research, an academic paper, or a technical concept? (e.g., new models, training methods, theoretical advances)
     → YES: "learning" → STOP
     → NO: "personal"
    Only use "claude-code" when the paper/article's primary subject is the tool, workflow, or implementation itself. If the tool is merely mentioned inside a leak, report, benchmark, analysis, or discussion about a different topic, classify by that substantive topic instead; do not demote pieces that are explicitly about Claude Code itself.
   For survey, review, or meta-analysis papers, always classify as "learning".
- "actionability": classify using this procedure:
        1. Does this introduce a model, technique, tool, or dataset that could be directly used or adapted in current projects? If the item is mainly announcement coverage of an existing project's release/update, keep it at "medium" even when it mentions code snippets, benchmark claims, repo links, or demo links. Only prefer "high" when the paper/article itself is the reusable artifact you would adopt this week. If the paper provides open-source code, a public implementation, a Colab/demo link, or if the abstract explicitly states practical usage, deployment, or real-world application, prefer "high". Also prefer "high" when the article is centered on a new mode, workflow, or capability for an existing tool that is directly usable right away (for example, a new automation or permission mode); in that case, the novelty is the capability itself rather than a routine release note. Release notes, update posts, and announcements about existing tools should stay "medium" unless they include a new reusable implementation or artifact.
     → YES: "high" → STOP
     → NO: continue to 2
  2. Is this research likely to influence your work or decisions within the next month?
     → YES: "medium" → STOP
     → NO: continue to 3
  3. Is this useful background knowledge for AI application development or ML research?
     → YES: "low" → STOP
     → NO: "archive"
- "key_topics": array of 2-4 topic tags, lowercase hyphenated
- "tools_mentioned": array of specific models/libraries/datasets released (empty if none)
- "urls": array of notable URLs (github repos, demo links) if mentioned in abstract
If the paper introduces a new dataset, always mention it in tools_mentioned and key_topics, and prefer category "learning" unless the dataset is specifically for a new tool or application. For borderline cases between "side-projects" and "learning", prefer "learning". For survey, review, or meta-analysis papers, always classify as "learning". Be concise. Focus on practical implications for an AI application developer.

For borderline cases, use this example for guidance:
Example: A paper introduces a new dataset for benchmarking LLMs and also provides a tool for dataset analysis. If the main contribution is the dataset, classify as "learning"; if the main contribution is the tool, classify as "side-projects".

Example: A paper presents a new LLM evaluation benchmark and releases both the dataset and a web demo. If the dataset is the main contribution, classify as "learning" and mention both in tools_mentioned; if the web demo/tool is the main focus, classify as "side-projects".

Example: A paper presents a new training method, releases a dataset, and provides an implementation. If the training method is the main contribution, classify as "learning" and mention both the dataset and implementation in tools_mentioned."""

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


def _triage_impl(content: str, image_url: str | None = None, max_retries: int = 3,
                 model: str | None = None,
                 supports_json_format: bool = True) -> tuple[dict, dict]:
    """Internal triage implementation. Returns (prediction, meta).

    Meta contains: prompt_tokens, completion_tokens, latency_ms.
    """
    model = model or DEFAULT_TRIAGE_MODEL
    delay = 1
    last_error = None
    start_time = time.time()
    meta = {"prompt_tokens": 0, "completion_tokens": 0, "latency_ms": 0.0}

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
            payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": TRIAGE_SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                "temperature": 0,
                "seed": 42,
            }
            if supports_json_format:
                payload["response_format"] = {"type": "json_object"}

            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY()}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=60 if image_url else 30,
            )

            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", str(delay)))
                time.sleep(retry_after)
                delay *= 2
                last_error = "Rate limited (429)"
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

            if supports_json_format:
                parsed = json.loads(text)
            else:
                parsed = _parse_json_response(text)

            # Capture usage metadata
            usage = result.get("usage", {})
            meta["prompt_tokens"] = usage.get("prompt_tokens", 0)
            meta["completion_tokens"] = usage.get("completion_tokens", 0)
            meta["latency_ms"] = (time.time() - start_time) * 1000

            # Validate required fields
            for key in ("summary", "category", "actionability", "key_topics"):
                if key not in parsed:
                    parsed[key] = FALLBACK_TRIAGE[key]

            return parsed, meta

        except (json.JSONDecodeError, KeyError) as e:
            # Malformed JSON from LLM — use fallback
            fallback = dict(FALLBACK_TRIAGE)
            fallback["summary"] = content[:200]
            meta["latency_ms"] = (time.time() - start_time) * 1000
            return fallback, meta

        except requests.RequestException as e:
            last_error = str(e)
            time.sleep(delay)
            delay *= 2

    # All retries exhausted
    fallback = dict(FALLBACK_TRIAGE)
    fallback["summary"] = content[:200]
    meta["latency_ms"] = (time.time() - start_time) * 1000
    print(f"  [triage] All retries failed: {last_error}. Using fallback.")
    return fallback, meta


def triage(content: str, image_url: str | None = None, max_retries: int = 3,
           model: str | None = None,
           supports_json_format: bool = True) -> dict:
    """Run LLM triage on content. Optionally includes an image for vision analysis.

    Args:
        content: Text content to triage.
        image_url: Optional direct URL to an image for multimodal triage.
        max_retries: Number of retry attempts on failure.
        model: OpenRouter model ID. Defaults to DEFAULT_TRIAGE_MODEL.
        supports_json_format: Whether the model supports response_format json_object.

    Returns structured classification dict.
    """
    prediction, _ = _triage_impl(content, image_url, max_retries, model, supports_json_format)
    return prediction


def triage_with_meta(content: str, image_url: str | None = None, max_retries: int = 3,
                     model: str | None = None,
                     supports_json_format: bool = True) -> tuple[dict, dict]:
    """Run LLM triage on content. Returns (prediction, meta).

    Meta dict contains: prompt_tokens, completion_tokens, latency_ms.
    """
    return _triage_impl(content, image_url, max_retries, model, supports_json_format)


def _triage_paper_impl(title: str, abstract: str, authors: str,
                       paper_url: str, max_retries: int = 3,
                       model: str | None = None,
                       supports_json_format: bool = True) -> tuple[dict, dict]:
    """Internal paper triage implementation. Returns (prediction, meta)."""
    model = model or DEFAULT_TRIAGE_MODEL
    content = f"Title: {title}\nAuthors: {authors}\nURL: {paper_url}\n\nAbstract:\n{abstract}"
    content = content[:4000]

    delay = 1
    last_error = None
    start_time = time.time()
    meta = {"prompt_tokens": 0, "completion_tokens": 0, "latency_ms": 0.0}

    for attempt in range(max_retries):
        try:
            payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": PAPER_TRIAGE_SYSTEM_PROMPT},
                    {"role": "user", "content": content},
                ],
                "temperature": 0,
                "seed": 42,
            }
            if supports_json_format:
                payload["response_format"] = {"type": "json_object"}

            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY()}",
                    "Content-Type": "application/json",
                },
                json=payload,
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

            if supports_json_format:
                parsed = json.loads(text)
            else:
                parsed = _parse_json_response(text)

            # Capture usage metadata
            usage = result.get("usage", {})
            meta["prompt_tokens"] = usage.get("prompt_tokens", 0)
            meta["completion_tokens"] = usage.get("completion_tokens", 0)
            meta["latency_ms"] = (time.time() - start_time) * 1000

            for key in ("summary", "category", "actionability", "key_topics"):
                if key not in parsed:
                    parsed[key] = FALLBACK_TRIAGE[key]

            return parsed, meta

        except (json.JSONDecodeError, KeyError):
            fallback = dict(FALLBACK_TRIAGE)
            fallback["summary"] = f"{title}: {abstract[:200]}"
            meta["latency_ms"] = (time.time() - start_time) * 1000
            return fallback, meta

        except requests.RequestException as e:
            last_error = str(e)
            time.sleep(delay)
            delay *= 2

    fallback = dict(FALLBACK_TRIAGE)
    fallback["summary"] = f"{title}: {abstract[:200]}"
    meta["latency_ms"] = (time.time() - start_time) * 1000
    print(f"  [triage_paper] All retries failed: {last_error}. Using fallback.")
    return fallback, meta


def triage_paper(title: str, abstract: str, authors: str,
                 paper_url: str, max_retries: int = 3,
                 model: str | None = None,
                 supports_json_format: bool = True) -> dict:
    """Run LLM triage on an academic paper. Returns structured classification dict."""
    prediction, _ = _triage_paper_impl(title, abstract, authors, paper_url,
                                       max_retries, model, supports_json_format)
    return prediction


def triage_paper_with_meta(title: str, abstract: str, authors: str,
                           paper_url: str, max_retries: int = 3,
                           model: str | None = None,
                           supports_json_format: bool = True) -> tuple[dict, dict]:
    """Run LLM triage on an academic paper. Returns (prediction, meta).

    Meta dict contains: prompt_tokens, completion_tokens, latency_ms.
    """
    return _triage_paper_impl(title, abstract, authors, paper_url,
                              max_retries, model, supports_json_format)
