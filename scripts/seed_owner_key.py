"""Seed the owner's MCP_ACCESS_KEY into brain_api_keys for the default brain.

Reads MCP_ACCESS_KEY from openbrain/.env.local, SHA-256 hashes it,
and inserts into brain_api_keys for brain 00000000-0000-4000-a000-000000000001.
"""
import hashlib
import os
import sys

import requests
from dotenv import dotenv_values

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(SCRIPT_DIR, "..", ".env.local")

OWNER_BRAIN_ID = "00000000-0000-4000-a000-000000000001"

def main():
    env = dotenv_values(ENV_PATH)
    SUPABASE_URL = env.get("SUPABASE_URL")
    if not SUPABASE_URL:
        print(f"ERROR: SUPABASE_URL not found in {ENV_PATH}", file=sys.stderr)
        sys.exit(1)
    mcp_key = env.get("MCP_ACCESS_KEY")
    service_key = env.get("SUPABASE_SERVICE_ROLE_KEY")

    if not mcp_key:
        print(f"ERROR: MCP_ACCESS_KEY not found in {ENV_PATH}", file=sys.stderr)
        sys.exit(1)
    if not service_key:
        print(f"ERROR: SUPABASE_SERVICE_ROLE_KEY not found in {ENV_PATH}", file=sys.stderr)
        sys.exit(1)

    key_hash = hashlib.sha256(mcp_key.encode()).hexdigest()
    key_prefix = mcp_key[:8]

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }

    payload = {
        "brain_id": OWNER_BRAIN_ID,
        "key_hash": key_hash,
        "key_prefix": key_prefix,
        "label": "owner-migrated",
    }

    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/brain_api_keys",
        headers=headers,
        json=payload,
        timeout=30,
    )

    if r.status_code in (200, 201):
        print(f"OK: Owner key seeded (prefix: {key_prefix})")
    elif r.status_code == 409:
        print(f"SKIP: Key already exists (prefix: {key_prefix})")
    else:
        print(f"ERROR: {r.status_code} {r.text}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
