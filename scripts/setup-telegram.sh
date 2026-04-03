#!/usr/bin/env bash
set -euo pipefail

# Set up Telegram bot and register webhook for Open Brain.
# Usage: ./setup-telegram.sh BOT_TOKEN [SECRET_TOKEN] [SUPABASE_URL]

# --- Colors ---

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# --- Arguments ---

if [[ $# -lt 1 ]]; then
    echo -e "${RED}Usage: $0 BOT_TOKEN [SECRET_TOKEN] [SUPABASE_URL]${NC}"
    echo ""
    echo "  BOT_TOKEN      - Telegram bot token from @BotFather (required)"
    echo "  SECRET_TOKEN   - Webhook secret token (auto-generated if omitted)"
    echo "  SUPABASE_URL   - Supabase project URL (required)"
    exit 1
fi

BOT_TOKEN="$1"
SECRET_TOKEN="${2:-$(openssl rand -hex 16)}"
SUPABASE_URL="${3:?ERROR: SUPABASE_URL is required as third argument}"

TELEGRAM_API="https://api.telegram.org/bot${BOT_TOKEN}"

# --- Header ---

echo ""
echo -e "${CYAN}Telegram Bot Setup for Open Brain${NC}"
echo -e "${CYAN}=================================${NC}"

# --- Step 1: Verify bot token ---

echo ""
echo -e "${YELLOW}1. Verifying bot token...${NC}"

bot_response=$(curl -s "${TELEGRAM_API}/getMe")
bot_ok=$(echo "$bot_response" | grep -o '"ok":true' || true)

if [[ -z "$bot_ok" ]]; then
    echo -e "   ${RED}Invalid bot token. Create a bot via @BotFather first.${NC}"
    exit 1
fi

bot_username=$(echo "$bot_response" | grep -oP '"username":"[^"]*"' | cut -d'"' -f4)
bot_name=$(echo "$bot_response" | grep -oP '"first_name":"[^"]*"' | cut -d'"' -f4)
echo -e "   ${GREEN}Bot: @${bot_username} (${bot_name})${NC}"

# --- Step 2: Register webhook ---

echo ""
echo -e "${YELLOW}2. Registering webhook...${NC}"

webhook_url="${SUPABASE_URL}/functions/v1/telegram-bot"
webhook_body=$(cat <<EOF
{"url":"${webhook_url}","secret_token":"${SECRET_TOKEN}","allowed_updates":["message"]}
EOF
)

webhook_response=$(curl -s -X POST "${TELEGRAM_API}/setWebhook" \
    -H "Content-Type: application/json" \
    -d "$webhook_body")

webhook_ok=$(echo "$webhook_response" | grep -o '"ok":true' || true)
if [[ -n "$webhook_ok" ]]; then
    echo -e "   ${GREEN}Webhook registered: ${webhook_url}${NC}"
else
    webhook_desc=$(echo "$webhook_response" | grep -oP '"description":"[^"]*"' | cut -d'"' -f4)
    echo -e "   ${RED}Webhook registration failed: ${webhook_desc}${NC}"
    exit 1
fi

# --- Step 3: Set bot commands ---

echo ""
echo -e "${YELLOW}3. Setting bot commands...${NC}"

commands_body=$(cat <<'EOF'
{"commands":[{"command":"search","description":"Search thoughts by query"},{"command":"recent","description":"List recent thoughts"},{"command":"stats","description":"Brain statistics"},{"command":"help","description":"Show available commands"}]}
EOF
)

commands_response=$(curl -s -X POST "${TELEGRAM_API}/setMyCommands" \
    -H "Content-Type: application/json" \
    -d "$commands_body")

commands_ok=$(echo "$commands_response" | grep -o '"ok":true' || true)
if [[ -n "$commands_ok" ]]; then
    echo -e "   ${GREEN}Commands registered (autocomplete enabled)${NC}"
else
    echo -e "   ${YELLOW}Commands registration failed (non-critical)${NC}"
fi

# --- Step 4: Print env vars ---

echo ""
echo -e "${YELLOW}4. Add these to openbrain/.env.local:${NC}"
echo "   TELEGRAM_BOT_TOKEN=${BOT_TOKEN}"
echo "   TELEGRAM_SECRET_TOKEN=${SECRET_TOKEN}"

echo ""
echo -e "${YELLOW}5. Get your chat ID:${NC}"
echo "   - Send any message to @${bot_username}"
echo "   - Run: curl -s '${TELEGRAM_API}/getUpdates' | python3 -m json.tool"
echo "   - Find message.chat.id in the response"
echo "   - Add to .env.local: TELEGRAM_ALLOWED_CHAT_ID=<your_chat_id>"

echo ""
echo -e "${YELLOW}6. Deploy:${NC}"
echo "   cd openbrain && supabase functions deploy telegram-bot --no-verify-jwt"

echo ""
echo -e "${YELLOW}7. Set secrets on Supabase:${NC}"
echo "   supabase secrets set TELEGRAM_BOT_TOKEN=${BOT_TOKEN} TELEGRAM_SECRET_TOKEN=${SECRET_TOKEN} TELEGRAM_ALLOWED_CHAT_ID=<your_chat_id>"

echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
