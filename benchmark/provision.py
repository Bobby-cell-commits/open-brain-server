"""Brain provisioning and cleanup via Supabase REST API.

Creates brains and API keys for benchmark runs. Uses direct PostgREST
calls with service_role key — no MCP endpoint needed.
"""

import hashlib
import secrets

import requests


def generate_api_key(question_id: str) -> str:
    suffix = secrets.token_hex(4)  # 8 hex chars
    return f"ob_bench_{question_id}_{suffix}"


def hash_key(key: str) -> str:
    """SHA-256 hash matching the Deno implementation in auth.ts."""
    return hashlib.sha256(key.encode()).hexdigest()


def _headers(service_role_key: str) -> dict:
    return {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def create_brain(
    question_id: str,
    supabase_url: str,
    service_role_key: str,
) -> tuple[str, str]:
    """Create a brain + API key for a benchmark question.

    Returns (brain_id, plaintext_api_key).
    """
    headers = _headers(service_role_key)

    # 1. Insert brain
    resp = requests.post(
        f"{supabase_url}/rest/v1/brains",
        headers=headers,
        json={"name": f"longmemeval-{question_id}"},
    )
    resp.raise_for_status()
    brain_id = resp.json()[0]["id"]

    # 2. Generate and insert API key
    api_key = generate_api_key(question_id)
    resp = requests.post(
        f"{supabase_url}/rest/v1/brain_api_keys",
        headers=headers,
        json={
            "brain_id": brain_id,
            "key_hash": hash_key(api_key),
            "key_prefix": api_key[:8],
            "label": f"longmemeval-{question_id}",
            "scope": "read_write",
        },
    )
    resp.raise_for_status()

    return brain_id, api_key


def delete_brain(
    brain_id: str,
    supabase_url: str,
    service_role_key: str,
) -> None:
    """Delete a brain and all associated data (CASCADE)."""
    resp = requests.delete(
        f"{supabase_url}/rest/v1/brains?id=eq.{brain_id}",
        headers=_headers(service_role_key),
    )
    resp.raise_for_status()
