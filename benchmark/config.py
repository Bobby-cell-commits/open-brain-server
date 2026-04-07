"""Benchmark configuration — env loading for MCP endpoint and Supabase."""

import os
from pathlib import Path
from dotenv import load_dotenv

_env_path = Path(__file__).parent / ".env"
load_dotenv(_env_path)

# Also load openbrain/.env.local as fallback for Supabase vars
_env_local = Path(__file__).parent.parent / "openbrain" / ".env.local"
load_dotenv(_env_local, override=False)


def _require(name: str) -> str:
    val = os.getenv(name)
    if not val:
        raise RuntimeError(f"Missing required env var: {name}")
    return val


def mcp_url() -> str:
    return _require("OPENBRAIN_MCP_URL")


def supabase_url() -> str:
    return _require("SUPABASE_URL")


def supabase_service_role_key() -> str:
    return _require("SUPABASE_SERVICE_ROLE_KEY")


def openai_api_key() -> str:
    return _require("OPENAI_API_KEY")


def openrouter_api_key() -> str:
    return _require("OPENROUTER_API_KEY")


def hf_token() -> str | None:
    return os.getenv("HF_TOKEN")


# Defaults (overridable via CLI args)
DEFAULT_CONCURRENCY = 10
MAX_RETRIES = 3
BACKOFF_BASE_SECONDS = 1.0
BACKPRESSURE_THRESHOLD = 5  # consecutive 429s before reducing concurrency
SOURCE = "benchmark"
