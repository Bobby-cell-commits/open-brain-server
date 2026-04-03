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
    # Tier 1 — Keep (high signal, project-relevant)
    "Python",
    "ClaudeAI",
    "LocalLLaMA",
    "AgentsOfAI",
    "MachineLearning",
    "programming",
    # Tier 1 — New (developer-focused)
    "ClaudeCode",
    "clawdbot",
    "LLMDevs",
    "AI_Agents",
    # MCP ecosystem
    "mcp",
    # Knowledge, NLP, infrastructure
    "Rag",
    "PKMS",
    "ExperiencedDevs",
    "LanguageTechnology",
    "Supabase",
    "opensource",
    # Keep (override from original drop list)
    "singularity",
    "accelerate",
]

# Per-sub overrides (limit = max posts to fetch; default is 10)
SUBREDDIT_CONFIG = {
    "Rag": {"limit": 5},
    "PKMS": {"limit": 5},
    "ExperiencedDevs": {"limit": 5},
    "LanguageTechnology": {"limit": 5},
    "Supabase": {"limit": 3},
    "opensource": {"limit": 3},
}

# Subs where image-only posts are allowed (others skip image-only posts)
VISION_ALLOWED_SUBS = {
    "ClaudeAI", "ClaudeCode", "LocalLLaMA", "MachineLearning",
    "clawdbot", "AI_Agents", "LLMDevs", "Python", "AgentsOfAI",
}

# ── Customize: RSS Feeds ──
# Replace with feeds you follow. These are examples from AI/ML newsletters.
RSS_FEEDS = {
    "Simon Willison": "https://simonwillison.net/atom/everything/",
    "Latent Space": "https://www.latent.space/feed",
    "The Rundown AI": "https://rss.beehiiv.com/feeds/2R3C6Bt5wj.xml",
    "Ahead of AI": "https://magazine.sebastianraschka.com/feed",
    "Interconnects": "https://www.interconnects.ai/feed",
    "Decoding AI": "https://www.decodingai.com/feed",
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
}

HF_UPVOTE_CATCH_ALL = 40

# Emergent Mind — trending arXiv papers by social signals
EMERGENT_MIND_API_URL = "https://www.emergentmind.com/papers.json"
EMERGENT_MIND_TEMP_THRESHOLD = 50

# Dedup data directory
DATA_DIR = Path(__file__).parent / "data"

# Rate limiting
ITEM_DELAY_SECONDS = 0.5
