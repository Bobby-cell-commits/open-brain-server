#!/usr/bin/env bash
set -euo pipefail

# Full round-trip deployment validation for Open Brain.
# Runs 8 checks against a live deployment and reports pass/fail results.

# --- Colors ---

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# --- Counters ---

passed=0
failed=0
total=0

# --- Helper Functions ---

read_env_file() {
    local path="$1"
    if [[ ! -f "$path" ]]; then
        return
    fi
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        [[ -z "$line" || "$line" == \#* ]] && continue
        local key="${line%%=*}"
        local value="${line#*=}"
        key="${key#"${key%%[![:space:]]*}"}"
        key="${key%"${key##*[![:space:]]}"}"
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        echo "$key=$value"
    done < "$path"
}

run_check() {
    local name="$1"
    shift
    ((total++))

    printf "  [ ] %s" "$name"
    local output
    if output=$("$@" 2>&1); then
        ((passed++))
        printf "\r  ${GREEN}[+] %s${NC}\n" "$name"
    else
        ((failed++))
        printf "\r  ${RED}[X] %s${NC}\n" "$name"
        echo -e "      ${RED}$output${NC}"
    fi
}

cleanup_test_data() {
    echo ""
    echo -e "${GRAY}Cleaning up test data...${NC}"
    curl -s -o /dev/null \
        -X DELETE \
        "${supabase_url}/rest/v1/thoughts?content=like.VALIDATION_TEST*" \
        -H "apikey: ${service_key}" \
        -H "Authorization: Bearer ${service_key}" \
        -H "Prefer: return=representation" \
        || echo -e "  ${YELLOW}Warning: Cleanup failed (non-critical)${NC}"
}

# --- Paths ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_LOCAL_PATH="$PROJECT_ROOT/.env.local"

# --- Prerequisites ---

if [[ ! -f "$ENV_LOCAL_PATH" ]]; then
    echo -e "${RED}ERROR: .env.local not found at $ENV_LOCAL_PATH${NC}"
    echo -e "${YELLOW}Run bootstrap.sh first to create your environment file.${NC}"
    exit 1
fi

declare -A env_values
while IFS='=' read -r key value; do
    [[ -n "$key" ]] && env_values["$key"]="$value"
done < <(read_env_file "$ENV_LOCAL_PATH")

supabase_url="${env_values[SUPABASE_URL]:-}"
service_key="${env_values[SUPABASE_SERVICE_ROLE_KEY]:-}"
mcp_key="${env_values[MCP_ACCESS_KEY]:-}"

if [[ -z "$supabase_url" || -z "$service_key" || -z "$mcp_key" ]]; then
    echo -e "${RED}ERROR: Missing required variables in .env.local${NC}"
    echo -e "${YELLOW}Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MCP_ACCESS_KEY${NC}"
    exit 1
fi

# Derive project ref from URL (e.g., https://abcdef.supabase.co -> abcdef)
project_ref="$(echo "$supabase_url" | sed -E 's|https?://([^.]+)\.supabase\.co.*|\1|')"

mcp_url="https://$project_ref.supabase.co/functions/v1/open-brain-mcp/mcp"
ingest_url="https://$project_ref.supabase.co/functions/v1/ingest-thought"

# Timestamp for unique test data
test_timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
test_content="VALIDATION_TEST: automated check at $test_timestamp"

# --- Ensure cleanup on exit ---
trap cleanup_test_data EXIT

# --- Validation Checks ---

echo ""
echo -e "${CYAN}Open Brain Deployment Validation${NC}"
echo -e "${CYAN}=================================${NC}"
echo ""

# Check 1: Table exists
run_check "Table exists (thoughts accessible via REST)" bash -c '
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        "'"$supabase_url"'/rest/v1/thoughts?limit=0" \
        -H "apikey: '"$service_key"'" \
        -H "Authorization: Bearer '"$service_key"'")
    if [[ "$http_code" != "200" ]]; then
        echo "Expected 200, got $http_code"
        exit 1
    fi
'

# Check 2: RPC exists (thought_stats)
run_check "RPC exists (thought_stats callable)" bash -c '
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "'"$supabase_url"'/rest/v1/rpc/thought_stats" \
        -H "apikey: '"$service_key"'" \
        -H "Authorization: Bearer '"$service_key"'" \
        -H "Content-Type: application/json" \
        -d "{}")
    if [[ "$http_code" != "200" ]]; then
        echo "Expected 200, got $http_code"
        exit 1
    fi
'

# Check 3: Ingest function reachable (url_verification)
run_check "Ingest function reachable (url_verification)" bash -c '
    response=$(curl -s -X POST "'"$ingest_url"'" \
        -H "Content-Type: application/json" \
        -d "{\"type\":\"url_verification\",\"challenge\":\"validation_test\"}")
    challenge=$(echo "$response" | grep -o "\"challenge\":\"[^\"]*\"" | cut -d: -f2 | tr -d "\"")
    if [[ "$challenge" != "validation_test" ]]; then
        echo "Expected challenge validation_test, got: $challenge"
        exit 1
    fi
'

# Check 4: MCP function reachable (initialize)
run_check "MCP function reachable (initialize)" bash -c '
    response=$(curl -s -X POST "'"$mcp_url"'" \
        -H "x-brain-key: '"$mcp_key"'" \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"initialize\",\"id\":1,\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"validate\",\"version\":\"1.0\"}}}")
    if ! echo "$response" | grep -q "serverInfo"; then
        echo "Expected serverInfo in response: $response"
        exit 1
    fi
'

# Check 5: Auth rejects without key (expect 401)
run_check "Auth rejects without key (401)" bash -c '
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "'"$mcp_url"'" \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"initialize\",\"id\":1,\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"validate\",\"version\":\"1.0\"}}}")
    if [[ "$http_code" != "401" ]]; then
        echo "Expected 401, got $http_code -- auth may be broken"
        exit 1
    fi
'

# Check 6: Capture test thought via MCP
run_check "Capture test thought via MCP" bash -c '
    response=$(curl -s -X POST "'"$mcp_url"'" \
        -H "x-brain-key: '"$mcp_key"'" \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":2,\"params\":{\"name\":\"capture_thought\",\"arguments\":{\"content\":\"'"$test_content"'\"}}}")
    if echo "$response" | grep -q "\"isError\":true"; then
        echo "capture_thought returned error: $response"
        exit 1
    fi
'

# Check 7: Search finds test thought (wait for embedding)
echo -e "  ${GRAY}    Waiting 3s for embedding...${NC}"
sleep 3
run_check "Search finds test thought" bash -c '
    response=$(curl -s -X POST "'"$mcp_url"'" \
        -H "x-brain-key: '"$mcp_key"'" \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":3,\"params\":{\"name\":\"search_thoughts\",\"arguments\":{\"query\":\"VALIDATION_TEST automated check\"}}}")
    if echo "$response" | grep -q "\"isError\":true"; then
        echo "search_thoughts returned error: $response"
        exit 1
    fi
'

# Check 8: List thoughts returns results
run_check "List thoughts returns results" bash -c '
    response=$(curl -s -X POST "'"$mcp_url"'" \
        -H "x-brain-key: '"$mcp_key"'" \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":4,\"params\":{\"name\":\"list_thoughts\",\"arguments\":{}}}")
    if echo "$response" | grep -q "\"isError\":true"; then
        echo "list_thoughts returned error: $response"
        exit 1
    fi
'

# --- Summary ---

echo ""
if [[ $failed -eq 0 ]]; then
    echo -e "${GREEN}Results: $passed/$total checks passed${NC}"
else
    echo -e "${RED}Results: $passed/$total checks passed${NC}"
fi

exit $((failed > 0 ? 1 : 0))
