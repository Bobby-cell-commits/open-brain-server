#!/bin/bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════
# Open Brain — Start Script
# Generates secrets (if needed), then starts the stack.
#
# Usage: ./start.sh
# ══════════════════════════════════════════════════════════════

cd "$(dirname "$0")"

# ── Ensure .env exists ───────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

# ── Helper: generate random string ───────────────────────────
rand_string() {
  head -c 256 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c "${1:-32}"
}

rand_uuid() {
  cat /proc/sys/kernel/random/uuid 2>/dev/null \
    || python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null \
    || uuidgen
}

# ── Helper: generate a Supabase-compatible JWT (HS256) ───────
generate_jwt() {
  local secret="$1"
  local header='{"alg":"HS256","typ":"JWT"}'
  local payload='{"role":"service_role","iss":"open-brain","iat":1700000000,"exp":4102444800}'

  local b64_header b64_payload signature
  b64_header=$(echo -n "$header" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  b64_payload=$(echo -n "$payload" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  signature=$(echo -n "${b64_header}.${b64_payload}" \
    | openssl dgst -sha256 -hmac "$secret" -binary \
    | openssl base64 -A | tr '+/' '-_' | tr -d '=')

  echo "${b64_header}.${b64_payload}.${signature}"
}

# ── Generate missing secrets ─────────────────────────────────
append_if_missing() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" .env 2>/dev/null; then
    echo "${key}=${value}" >> .env
    echo "  Generated ${key}"
  fi
}

echo "Checking secrets..."

append_if_missing "POSTGRES_PASSWORD" "$(rand_string 32)"
append_if_missing "JWT_SECRET" "$(rand_string 64)"

# SUPABASE_SERVICE_ROLE_KEY depends on JWT_SECRET — read it back
JWT_SECRET=$(grep "^JWT_SECRET=" .env | cut -d= -f2-)
append_if_missing "SUPABASE_SERVICE_ROLE_KEY" "$(generate_jwt "$JWT_SECRET")"
append_if_missing "MCP_ACCESS_KEY" "$(rand_uuid)"
append_if_missing "ADMIN_KEY" "$(rand_string 32)"

# ── Validate required vars ───────────────────────────────────
if grep -q "^OPENROUTER_API_KEY=your-openrouter-api-key" .env; then
  echo ""
  echo "ERROR: Set your OPENROUTER_API_KEY in .env before starting."
  echo "  Get one at https://openrouter.ai/"
  exit 1
fi

# ── Start the stack ──────────────────────────────────────────
echo ""
echo "Starting Open Brain..."
docker compose up -d

echo ""
echo "Waiting for init to complete..."
docker compose wait init 2>/dev/null || docker wait open-brain-init > /dev/null 2>&1 || true

echo ""
docker logs open-brain-init 2>&1 | tail -12
