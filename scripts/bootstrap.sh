#!/usr/bin/env bash
set -euo pipefail

# Interactive setup for Open Brain .env.local secrets.
# Prompts for all required environment variables, auto-generates MCP access key,
# and writes .env.local. Supports re-running to update existing values.

# --- Colors ---

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

# --- Helper Functions ---

read_env_file() {
    local path="$1"
    if [[ ! -f "$path" ]]; then
        return
    fi
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line#"${line%%[![:space:]]*}"}"  # trim leading
        line="${line%"${line##*[![:space:]]}"}"  # trim trailing
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

mask_secret() {
    local value="$1"
    local len=${#value}
    if [[ $len -le 4 ]]; then
        echo '****'
    else
        local stars=$((len - 4))
        [[ $stars -gt 20 ]] && stars=20
        printf '%s%*s\n' "${value:0:4}" "$stars" | tr ' ' '*'
    fi
}

# --- Paths ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_EXAMPLE_PATH="$PROJECT_ROOT/.env.example"
ENV_LOCAL_PATH="$PROJECT_ROOT/.env.local"
SUPABASE_TEMP_DIR="$PROJECT_ROOT/supabase/.temp"
PROJECT_REF_PATH="$SUPABASE_TEMP_DIR/project-ref"

# --- Header ---

echo ""
echo -e "${CYAN}=== Open Brain Bootstrap ===${NC}"
echo ""

# --- Prerequisites ---

echo -e "${CYAN}Checking prerequisites...${NC}"

# 1. Supabase CLI
if ! command -v supabase &>/dev/null; then
    echo -e "  ${RED}[X] Supabase CLI not found${NC}"
    echo ""
    echo -e "  ${YELLOW}Install via npm:  npm install -g supabase${NC}"
    echo ""
    exit 1
fi
echo -e "  ${GREEN}[+] Supabase CLI found${NC}"

# 2. Project linking
if [[ ! -f "$PROJECT_REF_PATH" ]]; then
    echo -e "  ${YELLOW}[ ] Project not linked to Supabase${NC}"
    echo ""
    read -rp "Enter your Supabase project ref (e.g., abcdefghijklmnop): " project_ref
    if [[ -z "$project_ref" ]]; then
        echo -e "${RED}ERROR: Project ref is required.${NC}"
        exit 1
    fi
    echo -e "${CYAN}Linking project...${NC}"
    (cd "$PROJECT_ROOT" && supabase link --project-ref "$project_ref")
    echo -e "  ${GREEN}[+] Project linked${NC}"
else
    ref="$(cat "$PROJECT_REF_PATH" | tr -d '[:space:]')"
    echo -e "  ${GREEN}[+] Project linked (ref: $ref)${NC}"
fi

echo ""

# --- Read .env.example for variable names ---

if [[ ! -f "$ENV_EXAMPLE_PATH" ]]; then
    echo -e "${RED}ERROR: .env.example not found at $ENV_EXAMPLE_PATH${NC}"
    exit 1
fi

# Variable list (Telegram-era, no Slack)
VAR_NAMES=(
    "SUPABASE_URL"
    "SUPABASE_SERVICE_ROLE_KEY"
    "OPENROUTER_API_KEY"
    "TELEGRAM_BOT_TOKEN"
    "TELEGRAM_SECRET_TOKEN"
    "TELEGRAM_ALLOWED_CHAT_ID"
    "MCP_ACCESS_KEY"
)

# --- Read existing .env.local if present ---

declare -A EXISTING_VALUES

if [[ -f "$ENV_LOCAL_PATH" ]]; then
    while IFS='=' read -r key value; do
        [[ -n "$key" ]] && EXISTING_VALUES["$key"]="$value"
    done < <(read_env_file "$ENV_LOCAL_PATH")
    echo -e "${YELLOW}Existing .env.local found. Current values will be shown (masked).${NC}"
    echo -e "${YELLOW}Press Enter to keep existing value or type new value.${NC}"
    echo ""
fi

# --- Variable descriptions ---

declare -A DESCRIPTIONS=(
    ["SUPABASE_URL"]="Your Supabase project URL (e.g., https://xxxxx.supabase.co)"
    ["SUPABASE_SERVICE_ROLE_KEY"]="Supabase service role key (Settings > API > service_role)"
    ["OPENROUTER_API_KEY"]="OpenRouter API key (openrouter.ai/keys)"
    ["TELEGRAM_BOT_TOKEN"]="Telegram bot token from @BotFather"
    ["TELEGRAM_SECRET_TOKEN"]="Secret token for webhook verification"
    ["TELEGRAM_ALLOWED_CHAT_ID"]="Your Telegram chat ID (send /start to bot, check getUpdates)"
    ["MCP_ACCESS_KEY"]="MCP access key for authenticating AI clients"
)

# --- Interactive prompting ---

echo -e "${CYAN}Configure environment variables:${NC}"
echo ""

declare -A NEW_VALUES

for var_name in "${VAR_NAMES[@]}"; do
    desc="${DESCRIPTIONS[$var_name]:-$var_name}"
    existing="${EXISTING_VALUES[$var_name]:-}"

    if [[ "$var_name" == "MCP_ACCESS_KEY" ]]; then
        # Auto-generate MCP key
        generated="$(openssl rand -hex 32)"
        echo -e "  ${WHITE}$var_name${NC}"
        echo -e "    ${GRAY}$desc${NC}"
        if [[ -n "$existing" ]]; then
            echo -e "    ${GRAY}Current: $(mask_secret "$existing")${NC}"
        fi
        echo -e "    ${GRAY}Generated: $generated${NC}"
        read -rp "    Press Enter to accept generated key, or type custom value: " input
        if [[ -z "$input" ]]; then
            NEW_VALUES["$var_name"]="$generated"
        else
            NEW_VALUES["$var_name"]="$input"
        fi
    else
        echo -e "  ${WHITE}$var_name${NC}"
        echo -e "    ${GRAY}$desc${NC}"
        if [[ -n "$existing" ]]; then
            echo -e "    ${GRAY}Current: $(mask_secret "$existing")${NC}"
            read -rp "    Value (Enter to keep current): " input
            if [[ -z "$input" ]]; then
                NEW_VALUES["$var_name"]="$existing"
            else
                NEW_VALUES["$var_name"]="$input"
            fi
        else
            read -rp "    Value: " input
            while [[ -z "$input" ]]; do
                echo -e "    ${YELLOW}This value is required.${NC}"
                read -rp "    Value: " input
            done
            NEW_VALUES["$var_name"]="$input"
        fi
    fi
    echo ""
done

# --- Write .env.local ---

{
    for var_name in "${VAR_NAMES[@]}"; do
        echo "$var_name=${NEW_VALUES[$var_name]}"
    done
} > "$ENV_LOCAL_PATH"

count=${#NEW_VALUES[@]}
echo -e "${CYAN}=== Setup Complete ===${NC}"
echo ""
echo -e "${GREEN}Created .env.local with $count secrets configured.${NC}"
echo ""
echo -e "${YELLOW}Next: Run deploy.sh to deploy Open Brain.${NC}"
echo ""
