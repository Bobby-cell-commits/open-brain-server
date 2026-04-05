# Open Brain Server

Self-hostable MCP memory server for AI assistants.

Open Brain is an MCP server that gives any AI assistant persistent, searchable memory. It provides 16 tools for capturing, searching, and analyzing thoughts with hybrid search (BM25 + pgvector), automatic deduplication, entity extraction, connection graphing, salience-based ranking, and automated staleness pruning. Multi-tenant by design -- each API key maps to an isolated brain. Includes pipeline templates for automated ingestion from Reddit, RSS feeds, Hugging Face Papers, and Emergent Mind.

## Architecture

```
Capture:   Source --> Edge Function --> OpenRouter (embed + extract metadata)
                                           |
                                    Supabase insert --> auto-link similar thoughts
                                                   --> extract entities

Retrieval: MCP Client --> Edge Function --> tool execution --> JSON response
```

All state lives in Supabase (Postgres + pgvector). Edge Functions are stateless Deno/TypeScript. Embeddings and metadata extraction go through OpenRouter.

## Quick Start

### Prerequisites

- [Supabase](https://supabase.com) project (free tier works)
- [OpenRouter](https://openrouter.ai) API key
- [Supabase CLI](https://supabase.com/docs/guides/cli)
- [Deno](https://deno.land) (for local development)

### Setup

```bash
# 1. Clone
git clone https://github.com/your-username/open-brain-server.git
cd open-brain-server

# 2. Configure environment
cp .env.example supabase/.env.local
# Edit supabase/.env.local with your Supabase URL, service role key, and OpenRouter key

# 3. Link Supabase project
cd supabase
supabase link --project-ref <your-project-ref>

# 4. Apply database migrations
supabase db push --linked

# 5. Set secrets
supabase secrets set --env-file .env.local

# 6. Deploy Edge Functions
supabase functions deploy open-brain-mcp --no-verify-jwt
supabase functions deploy telegram-bot --no-verify-jwt    # optional
supabase functions deploy run-pipeline --no-verify-jwt    # optional
supabase functions deploy refresh-graph-analysis --no-verify-jwt # optional
supabase functions deploy monitor-pipeline --no-verify-jwt # optional

# 7. Seed owner API key
python3 scripts/seed_owner_key.py

# 8. Connect your MCP client
# Add the MCP server URL to your client config:
#   URL: https://<your-project-ref>.supabase.co/functions/v1/open-brain-mcp
#   Header: x-brain-key: <your-mcp-access-key>
```

## Tools

| Tool | Purpose | Key Params |
|------|---------|------------|
| `search_thoughts` | Hybrid search (vector + keyword) | `query`, `limit`, `threshold`, `min_quality` |
| `list_thoughts` | Browse with filters, salience-ordered | `type`, `topic`, `person`, `theme`, `days`, `limit` |
| `capture_thought` | Store with auto-embed, auto-link, entity extraction | `content`, `source` |
| `thought_stats` | Aggregate counts, type/theme breakdown | `days` |
| `get_connections` | Graph traversal from a thought (typed links) | `thought_id` |
| `list_entities` | Browse extracted entities by frequency | `entity_type`, `min_thoughts`, `limit` |
| `weekly_review` | LLM synthesis of recent themes and open loops | `days` |
| `analyze` | Graph analysis: hubs, density, or sources | `type`, `min_connections` |
| `dedup_review` | Duplicate candidates + zone histogram | `limit` |
| `refresh_salience` | Recompute all salience scores | -- |
| `update_thought` | Rewrite content (re-embeds, re-extracts metadata) | `id`, `content` |
| `delete_thought` | Permanent delete (cascades connections) | `id` |
| `migration_guide` | Import runbook for external platforms | `platform` |
| `serendipity_digest` | Surface unexpected cross-topic connections | `days`, `limit` |
| `pipeline` | Pipeline monitoring: health, runs, merges | `type`, `days`, `source` |
| `review_stale` | Review flagged stale thoughts for archival | `action`, `thought_id` |

## Pipeline Sources

Open Brain includes pipeline templates for automated thought ingestion from external sources.

**Edge Function + GitHub Actions** (recommended for production):
- **RSS feeds** -- configurable feed list, runs on schedule
- **Hugging Face Papers** -- daily trending ML papers
- **Emergent Mind** -- arXiv trending papers via JSON API

**Python scripts** (for local development):
- **Reddit** -- monitors subreddits via public JSON endpoints
- **Briefing** -- generates morning briefings from recent thoughts

To add your own source, implement a fetcher that calls `capture_thought` via the MCP endpoint. See `pipeline/rss/` for a minimal example. Each source should use a unique `source` identifier and a stable `source_event_id` for idempotency.

## Self-Hosting Notes

- Runs entirely on Supabase free tier (500MB database, Edge Functions included)
- OpenRouter embedding costs ~$0.001 per thought (text-embedding-3-small)
- All Edge Functions are stateless -- no servers to manage
- Pipeline scheduling via GitHub Actions cron (free for public repos)
- GitHub Actions workflows need two repo secrets: `SUPABASE_FUNCTIONS_URL` (e.g. `https://<ref>.supabase.co/functions/v1`) and `MCP_ACCESS_KEY`
- Embedding dimension is 1536 (OpenAI text-embedding-3-small via OpenRouter)

## Security

- **Row Level Security** enabled on all tables. Direct database access via anon key is blocked.
- **API keys** are SHA-256 hashed before storage. Plaintext keys are never persisted.
- **Tenant isolation** enforced at both application layer (every tool handler checks `brain_id`) and database layer (RLS policies).
- **No JWT verification** on Edge Functions -- authentication is handled in-function via `x-brain-key` header.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [docs/security-audit.md](docs/security-audit.md) for the full security audit covering authentication, tenant isolation, database security, and the export process.

## Key Thresholds

| Threshold | Behavior |
|-----------|----------|
| 0.92+ | Auto-merge (dedup) |
| 0.85-0.92 | Near-miss logging |
| 0.80+ | Typed connections (extends/contradicts/etc.) |
| 0.75+ | Connection linking |
| 0.70 | Default search floor |
| 0.40 | Default quality gate (pipeline sources only) |
| 0.85+ staleness | Auto-archive (LLM confirms) |
| 0.70-0.85 staleness | Context-confirmed archival |
| 0.40-0.70 staleness | Flagged for human review |

## Project Structure

```
supabase/
  functions/
    open-brain-mcp/        # MCP server (16 tools)
    telegram-bot/          # Telegram webhook capture
    run-pipeline/          # RSS, HF Papers, Emergent Mind ingestion + dream decay
    refresh-graph-analysis/ # Precomputed graph analysis cache (daily)
    monitor-pipeline/      # Pipeline health + Telegram alerts
    _shared/               # Shared modules (Supabase client, OpenRouter, types)
  migrations/          # SQL migrations (applied with supabase db push)
pipeline/              # Python pipeline scripts (Reddit, briefing)
scripts/               # Bootstrap, deploy, validate scripts
tests/integration/     # Multi-tenant integration tests
```

## Contributing

Contributions are welcome. Open an issue to discuss larger changes before submitting a PR.

- Edge Functions are Deno + TypeScript with `npm:` specifiers (no package.json)
- Pipeline scripts are Python 3.13+ with dependencies in `pipeline/requirements.txt`
- All OpenRouter calls go through `_shared/openrouter.ts` -- never call the API directly
- Run pipeline scripts as modules from repo root: `python -m pipeline.run_all`

## Acknowledgments

This project started from [OB1 / Open Brain](https://github.com/NateBJones-Projects/OB1) by Nate B. Jones. His original design for a Supabase + pgvector MCP memory server was the foundation that made this possible. Over time the implementation diverged significantly -- hybrid search, knowledge graph, auto-dedup, multi-tenant isolation, automated pipelines -- but the core idea of giving AI assistants persistent, searchable memory is his. This project isn't meant to compete with OB1; it's meant to enrich the open-source ecosystem with a different take on the same vision. Thank you, Nate.

## License

[MIT](LICENSE)
