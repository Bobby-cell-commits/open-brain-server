# Self-Hosting Open Brain

Run your own Open Brain instance with Docker Compose.

## Prerequisites

- Docker 24+ with Compose V2
- An [OpenRouter](https://openrouter.ai/) API key (for embeddings + LLM calls)

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/Bobby-cell-commits/open-brain-server
cd open-brain-server/docker

# 2. Configure
cp .env.example .env
# Edit .env — paste your OPENROUTER_API_KEY

# 3. Start (generates secrets + boots the stack)
./start.sh
```

The start script generates all required secrets (Postgres password, JWT, MCP access key), writes them to `.env`, then boots the stack. Your MCP access key is printed at the end.

## Connect Your MCP Client

**Claude Code:**
```bash
claude mcp add open-brain --transport http http://localhost:80/functions/v1/open-brain-mcp \
  --header "x-brain-key: YOUR_MCP_ACCESS_KEY"
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "open-brain": {
      "type": "http",
      "url": "http://localhost:80/functions/v1/open-brain-mcp",
      "headers": {
        "x-brain-key": "YOUR_MCP_ACCESS_KEY"
      }
    }
  }
}
```

## Services

| Service | Port | Purpose |
|---------|------|---------|
| Caddy | 80, 443 | Reverse proxy (entry point) |
| Postgres | 54322 | Database (exposed for debugging) |
| PostgREST | (internal) | REST API for RPC functions |
| Edge Runtime | (internal) | MCP server, Telegram bot, pipeline |
| Cron | (internal) | Scheduled maintenance jobs |

## Telegram Setup (Optional)

Telegram capture requires a public HTTPS URL for webhooks.

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Add to your `.env`:
   ```
   TELEGRAM_BOT_TOKEN=your-bot-token
   TELEGRAM_SECRET_TOKEN=your-webhook-secret
   TELEGRAM_ALLOWED_CHAT_ID=your-chat-id
   ```
3. Point Caddy to your public domain (edit `Caddyfile`: replace `:80` with `yourdomain.com`)
4. Restart: `docker compose up -d`
5. Register webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://yourdomain.com/functions/v1/telegram-bot&secret_token=$TELEGRAM_SECRET_TOKEN"
   ```

If you don't have a public URL, you can still capture thoughts via MCP.

## Scheduled Jobs

The cron container runs maintenance jobs automatically:

| Job | Schedule | What it does |
|-----|----------|-------------|
| Graph analysis | Daily 05:30 UTC | Pre-computes analysis cache |
| RSS/HF/EM ingestion | 2x daily | Ingests from example pipeline sources |
| Dream dedup | 2x daily | Merges near-duplicate thoughts |
| Monitoring | 2x daily | Checks pipeline health |
| Co-occurrence decay | Weekly (Sun) | Decays unused co-occurrence edges |
| Dream decay | Weekly (Sun) | Archives stale thoughts |
| Dream themes | Weekly (Sun) | Updates theme tracking |
| Dream synthesis | Weekly (Sun) | Generates insight syntheses |

Edit `crontab` to change schedules. The ingestion jobs use example sources — see the main project docs for how to configure your own feeds.

## Data & Backups

Important files to back up:
- `.env` — configuration and auto-generated secrets
- `data/postgres/` — database files

**Back up both regularly.** Losing `data/postgres/` means losing your brain. Losing `.env` means you'll need to re-generate secrets (your MCP access key will change).

## Troubleshooting

**Check service health:**
```bash
docker compose ps
```

**View logs:**
```bash
docker logs open-brain-functions  # MCP server / Edge Functions
docker logs open-brain-db         # Postgres
docker logs open-brain-init       # Init script (migrations, secrets)
docker logs open-brain-cron       # Scheduled jobs
```

**Restart after config changes:**
```bash
docker compose down && docker compose up -d
```

**Reset everything (destructive):**
```bash
docker compose down -v
rm -rf data/
docker compose up -d
```
