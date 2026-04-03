#!/usr/bin/env bash
set -euo pipefail

# Deploy Open Brain to Supabase (migrations, secrets, Edge Functions).
# Applies SQL migrations via db push, sets remote secrets from .env.local,
# and deploys Edge Functions. Stops on first failure with resume guidance.

# --- Colors ---

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NC='\033[0m'

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

run_step() {
    local step_num="$1"
    local step_name="$2"
    shift 2

    printf "  [ ] %s" "$step_name"
    local output
    if output=$("$@" 2>&1); then
        printf "\r  ${GREEN}[+] %s${NC}\n" "$step_name"
        return 0
    else
        printf "\r  ${RED}[X] %s${NC}\n" "$step_name"
        echo -e "    ${RED}Error: $output${NC}"
        return 1
    fi
}

# --- Paths ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_LOCAL_PATH="$PROJECT_ROOT/.env.local"
ENV_EXAMPLE_PATH="$PROJECT_ROOT/.env.example"
SUPABASE_TEMP_DIR="$PROJECT_ROOT/supabase/.temp"
PROJECT_REF_PATH="$SUPABASE_TEMP_DIR/project-ref"

# --- Header ---

echo ""
echo -e "${CYAN}=== Open Brain Deploy ===${NC}"
echo ""

# --- Prerequisites ---

echo -e "${CYAN}Checking prerequisites...${NC}"

# 1. .env.local must exist
if [[ ! -f "$ENV_LOCAL_PATH" ]]; then
    echo -e "  ${RED}[X] .env.local not found${NC}"
    echo ""
    echo -e "${YELLOW}Run bootstrap.sh first to configure your secrets.${NC}"
    echo ""
    exit 1
fi
echo -e "  ${GREEN}[+] .env.local found${NC}"

# 2. Verify required keys have values
declare -A env_values
while IFS='=' read -r key value; do
    [[ -n "$key" ]] && env_values["$key"]="$value"
done < <(read_env_file "$ENV_LOCAL_PATH")

REQUIRED_KEYS=(
    "SUPABASE_URL"
    "SUPABASE_SERVICE_ROLE_KEY"
    "OPENROUTER_API_KEY"
    "TELEGRAM_BOT_TOKEN"
    "TELEGRAM_SECRET_TOKEN"
    "TELEGRAM_ALLOWED_CHAT_ID"
    "MCP_ACCESS_KEY"
)

missing_keys=()
for key in "${REQUIRED_KEYS[@]}"; do
    if [[ -z "${env_values[$key]:-}" ]]; then
        missing_keys+=("$key")
    fi
done

if [[ ${#missing_keys[@]} -gt 0 ]]; then
    echo -e "  ${RED}[X] .env.local has missing values:${NC}"
    for key in "${missing_keys[@]}"; do
        echo -e "      ${RED}- $key${NC}"
    done
    echo ""
    echo -e "${YELLOW}Run bootstrap.sh to fill in the missing values.${NC}"
    echo ""
    exit 1
fi
echo -e "  ${GREEN}[+] All ${#REQUIRED_KEYS[@]} secrets configured${NC}"

# 3. Supabase CLI
if ! command -v supabase &>/dev/null; then
    echo -e "  ${RED}[X] Supabase CLI not found${NC}"
    echo ""
    echo -e "  ${YELLOW}Install via npm:  npm install -g supabase${NC}"
    echo ""
    exit 1
fi
echo -e "  ${GREEN}[+] Supabase CLI found${NC}"

# 4. Project must be linked
if [[ ! -f "$PROJECT_REF_PATH" ]]; then
    echo -e "  ${RED}[X] Project not linked to Supabase${NC}"
    echo ""
    echo -e "${YELLOW}Run bootstrap.sh first (it handles project linking).${NC}"
    echo ""
    exit 1
fi
project_ref="$(cat "$PROJECT_REF_PATH" | tr -d '[:space:]')"
echo -e "  ${GREEN}[+] Project linked (ref: $project_ref)${NC}"

echo ""
echo -e "${CYAN}Deploying...${NC}"
echo ""

# --- Deployment Steps ---

total_steps=5
completed_steps=0

# Step 1: Apply SQL migrations
if ! run_step 1 "Apply SQL migrations" bash -c "cd '$PROJECT_ROOT' && supabase db push --linked"; then
    echo ""
    echo -e "${RED}Deployment failed at step 1 of $total_steps.${NC}"
    echo -e "${YELLOW}No steps completed. Fix the issue and re-run deploy.sh (steps are idempotent).${NC}"
    echo ""
    exit 1
fi
((completed_steps++))

# Step 2: Set remote secrets
if ! run_step 2 "Set remote secrets" bash -c "cd '$PROJECT_ROOT' && supabase secrets set --env-file '$ENV_LOCAL_PATH'"; then
    echo ""
    echo -e "${RED}Deployment failed at step 2 of $total_steps.${NC}"
    echo -e "${YELLOW}Steps 1-$completed_steps succeeded. Fix the issue and re-run deploy.sh (steps are idempotent).${NC}"
    echo ""
    exit 1
fi
((completed_steps++))

# Step 3: Deploy telegram-bot Edge Function
if ! run_step 3 "Deploy telegram-bot function" bash -c "cd '$PROJECT_ROOT' && supabase functions deploy telegram-bot --no-verify-jwt"; then
    echo ""
    echo -e "${RED}Deployment failed at step 3 of $total_steps.${NC}"
    echo -e "${YELLOW}Steps 1-$completed_steps succeeded. Fix the issue and re-run deploy.sh (steps are idempotent).${NC}"
    echo ""
    exit 1
fi
((completed_steps++))

# Step 4: Deploy open-brain-mcp Edge Function
if ! run_step 4 "Deploy open-brain-mcp function" bash -c "cd '$PROJECT_ROOT' && supabase functions deploy open-brain-mcp --no-verify-jwt"; then
    echo ""
    echo -e "${RED}Deployment failed at step 4 of $total_steps.${NC}"
    echo -e "${YELLOW}Steps 1-$completed_steps succeeded. Fix the issue and re-run deploy.sh (steps are idempotent).${NC}"
    echo ""
    exit 1
fi
((completed_steps++))

# Step 5: Deploy run-pipeline Edge Function
if ! run_step 5 "Deploy run-pipeline function" bash -c "cd '$PROJECT_ROOT' && supabase functions deploy run-pipeline --no-verify-jwt"; then
    echo ""
    echo -e "${RED}Deployment failed at step 5 of $total_steps.${NC}"
    echo -e "${YELLOW}Steps 1-$completed_steps succeeded. Fix the issue and re-run deploy.sh (steps are idempotent).${NC}"
    echo ""
    exit 1
fi
((completed_steps++))

# --- Success ---

echo ""
echo -e "${CYAN}=== Deployment Complete ===${NC}"
echo ""
echo -e "${GREEN}All $total_steps steps completed successfully.${NC}"
echo ""

# Build URLs
mcp_url="https://$project_ref.supabase.co/functions/v1/open-brain-mcp/mcp"
telegram_url="https://$project_ref.supabase.co/functions/v1/telegram-bot"
mcp_key="${env_values[MCP_ACCESS_KEY]}"

echo -e "${CYAN}--- Connection Info ---${NC}"
echo ""
echo -e "${WHITE}MCP Endpoint:      $mcp_url${NC}"
echo -e "${WHITE}Telegram Webhook:  $telegram_url${NC}"
echo ""
echo -e "${CYAN}--- Claude Code Setup ---${NC}"
echo ""
echo -e "${YELLOW}Run this command to connect Claude Code:${NC}"
echo ""
echo -e "  ${WHITE}claude mcp add --transport http --header \"x-brain-key: $mcp_key\" open-brain $mcp_url${NC}"
echo ""
echo -e "${YELLOW}Next: Run validate.sh to verify the deployment.${NC}"
echo ""
