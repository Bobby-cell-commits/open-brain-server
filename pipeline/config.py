"""Pipeline configuration — env loading, subreddit list, feed URLs."""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load pipeline/.env, then openbrain/.env.local as fallback for Supabase vars
_env_path = Path(__file__).parent / ".env"
load_dotenv(_env_path)
_env_local = Path(__file__).parent.parent / "openbrain" / ".env.local"
load_dotenv(_env_local, override=False)  # Don't override pipeline/.env values


def _require(name: str) -> str:
    val = os.getenv(name)
    if not val:
        raise RuntimeError(f"Missing required env var: {name}")
    return val


# Open Brain MCP
OPENBRAIN_MCP_URL = lambda: _require("OPENBRAIN_MCP_URL")
OPENBRAIN_KEY = lambda: _require("OPENBRAIN_KEY")

# OpenRouter
OPENROUTER_API_KEY = lambda: _require("OPENROUTER_API_KEY")

# Supabase (direct access for backfill/admin operations)
SUPABASE_URL = lambda: _require("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = lambda: _require("SUPABASE_SERVICE_ROLE_KEY")

# Reddit .json endpoints (no auth needed)
REDDIT_USER_AGENT = "python:open-brain-pipeline:v1.0"

# ── Customize: Subreddits ──
# Replace with subreddits relevant to your interests. These are examples
# from AI/ML/developer communities. Uses public .json endpoints (no auth).
MONITORED_SUBREDDITS = [
    # Tier 1 — High signal (10 posts/run)
    "Python",
    "ClaudeCode",
    "LocalLLaMA",
    "MachineLearning",
    "programming",
    "AI_Agents",
    "ExperiencedDevs",
    "SelfHosted",       # NEW — infra, security, self-hosting (737K subs)
    "ObsidianMD",       # NEW — PKM, knowledge retention (305K subs, replaces PKMS)
    # Tier 2 — Moderate signal (5 posts/run)
    "Rag",
    "ClaudeAI",
    "AgentsOfAI",
    "dataengineering",  # NEW — pipeline architecture, tool comparisons (445K subs)
    "devops",           # NEW — CI/CD, infrastructure, career (480K subs)
    # Tier 3 — Low signal (3 posts/run)
    "singularity",
    "accelerate",
]

# Per-sub overrides (limit = max posts to fetch; default is 10)
SUBREDDIT_CONFIG = {
    "Rag": {"limit": 5},
    "ClaudeAI": {"limit": 5},
    "AgentsOfAI": {"limit": 5},
    "dataengineering": {"limit": 5},
    "devops": {"limit": 5},
    "singularity": {"limit": 3},
    "accelerate": {"limit": 3},
}

# Subs with triage actionability gate — filter "low" + "archive" to reduce noise.
# AI-focused subs are NOT gated (opinions are signal for cluster detection).
# All subs filter "archive" regardless.
TRIAGE_GATED_SUBS = {
    "ExperiencedDevs", "SelfHosted", "ObsidianMD",
    "dataengineering", "devops",
}

# Subs where image-only posts are allowed (others skip image-only posts)
VISION_ALLOWED_SUBS = {
    "ClaudeAI", "ClaudeCode", "LocalLLaMA", "MachineLearning",
    "AI_Agents", "Python", "AgentsOfAI", "SelfHosted", "ObsidianMD",
}

# Subs where top comments are fetched and included in captured thoughts
COMMENT_ENABLED_SUBS = {
    "ExperiencedDevs", "LocalLLaMA", "MachineLearning", "Python",
    "SelfHosted", "ObsidianMD",
}
COMMENT_SCORE_THRESHOLD = 5
COMMENT_MAX_PER_POST = 3
COMMENT_MIN_POST_COMMENTS = 3

# ── Customize: RSS Feeds ──
# Replace with feeds you follow. These are examples from AI/ML newsletters.
RSS_FEEDS = {
    "Simon Willison": "https://simonwillison.net/atom/everything/",
    "Latent Space": "https://www.latent.space/feed",
    "The Rundown AI": "https://rss.beehiiv.com/feeds/2R3C6Bt5wj.xml",
    "Ahead of AI": "https://magazine.sebastianraschka.com/feed",
    "Interconnects": "https://www.interconnects.ai/feed",
    "Decoding AI": "https://www.decodingai.com/feed",
    "The AI Engineer": "https://theaiengineer.substack.com/feed",
    "Turing Post": "https://turingpost.substack.com/feed",
}

# ── Customize: Focus Terms ──
# Semantic search queries for the morning briefing. Replace with your own
# projects, interests, and active work areas.
FOCUS_TERMS = [
    "Claude Code MCP tools",
    "knowledge management tools",
    "Python automation pipeline",
]

# HF Papers — keyword screen for daily papers feed
HF_SCREEN_TITLE_TERMS = [
    'language model', 'llm',
    'agent',
    'reasoning',
    'embedding',
    'retriev',
    'code model', 'code foundation',
    'benchmark',
    'efficient',
    'hallucin',
    # 2026-04-09: widened to capture architecture, optimization, and evaluation papers
    'transformer', 'attention', 'pruning', 'knowledge', 'reward',
    'autoregressive', 'test-time', 'alignment', 'code repair', 'program repair',
]

HF_KEYWORD_ALLOWLIST = {
    'large language models', 'large language model agents',
    'retrieval-augmented generation',
    'hallucinations',
    'tool learning', 'tool-use proficiency', 'tool-using agents', 'tool interaction',
    'code foundation model', 'software engineering',
    'kv-cache', 'mathematical reasoning',
    'mixture-of-experts', 'knowledge distillation',
    'multilingual embedding models',
    'reinforcement learning from human feedback',
    'multimodal large language models',
    'language models',
    # 2026-04-09: expanded to catch papers via ai_keywords when title terms miss
    'reinforcement learning', 'instruction tuning', 'in-context learning',
    'knowledge graph', 'knowledge graphs', 'semantic search',
    'question answering', 'information extraction', 'named entity recognition',
    'chain-of-thought', 'prompt engineering', 'vision-language models',
}

HF_UPVOTE_CATCH_ALL = 40

# Emergent Mind — trending arXiv papers by social signals
EMERGENT_MIND_API_URL = "https://www.emergentmind.com/papers.json"
EMERGENT_MIND_TEMP_THRESHOLD = 50

# Dedup data directory
DATA_DIR = Path(__file__).parent / "data"

# Rate limiting
ITEM_DELAY_SECONDS = 0.5
