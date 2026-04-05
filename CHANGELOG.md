# Changelog

All notable changes to Open Brain Server are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

When upgrading, apply new migrations with `supabase db push --linked` from the `supabase/` directory.

## [Unreleased]

## 2026-04-05b

### Fixed
- Pipeline metadata fallback theme changed from invalid `"learning"` to `"personal"`. Previously, when LLM extraction failed to return a theme, the fallback was a non-existent theme value. Customize your themes in the extraction prompt's decision tree (`capture-thought.ts`, `run-pipeline/index.ts`).

### No migrations required
This is a code-only fix in `_shared/types.ts` and `run-pipeline/index.ts`. Redeploy Edge Functions to apply.

## 2026-04-05

### Added
- **Dream Phase D -- staleness detection & soft-archival.** Automated scoring identifies stale thoughts across 3 tiers: auto-archive (0.85+), context-confirmed (0.70-0.85), and flagged for review (0.40-0.70). LLM confirms before archival. Sole-entity protection prevents knowledge gaps. Weekly schedule via GitHub Actions.
- **`review_stale` MCP tool (#16)** -- list, approve, or reject stale thought candidates.
- **`pipeline` MCP tool** -- pipeline monitoring: health checks, run history, merge audit. Modes: `health`, `runs`, `merges`.
- **Graph analysis caching.** 5 expensive O(n^2) graph RPCs now run offline via daily `refresh-graph-analysis` Edge Function. Results cached in `graph_analysis_cache` table. MCP tools read from cache instantly; pass `force=true` for live computation.
- **Source-aware quality gating.** Intentional captures (telegram, mcp) bypass `min_quality` filtering in search and list. Quality gate now only applies to automated pipeline sources.
- **GitHub Actions workflows** for all scheduled tasks: RSS, HF Papers, Emergent Mind, dream dedup, dream decay, graph analysis refresh, pipeline monitoring.
- `get_thought_embeddings` RPC for embedding-based clustering.

### Fixed
- Graph density analysis now correctly includes orphan thoughts (zero neighbors) in stats. Previously `zero_links` always reported 0 due to a `CROSS JOIN LATERAL` regression.
- Density analysis query no longer errors on thoughts with no similar neighbors.

### Changed
- Tool count: 14 -> 16 (`pipeline`, `review_stale`).
- All thought-querying RPCs now filter `archived_at IS NULL` (archived thoughts are invisible to search, list, stats, and analysis).

### Migrations
7 new migrations to apply:
- `20260404000001_get_thought_embeddings.sql`
- `20260404000002_fix_density_orphans.sql`
- `20260405000001_dream_decay.sql` -- adds `staleness_score`, `archived_at` columns, `pruning_log` table, decay RPCs
- `20260405000002_archive_filters.sql` -- adds `archived_at IS NULL` to all existing RPCs
- `20260405000003_graph_analysis_cache.sql` -- adds `graph_analysis_cache` table, statement timeouts
- `20260405000004_intentional_source_quality_bypass.sql` -- source-aware quality gate
- `20260405000005_fix_density_orphan_regression.sql`

### GitHub Actions Setup
Workflows require two repository secrets:
- `SUPABASE_FUNCTIONS_URL` -- e.g. `https://<ref>.supabase.co/functions/v1`
- `MCP_ACCESS_KEY` -- must match the key set on your Edge Functions

## 2026-04-03

Initial public release. Published to GitHub under MIT license.

### Included
- **MCP server** with 14 tools: search, capture, list, stats, connections, entities, weekly review, analyze, dedup review, refresh salience, update, delete, migration guide, serendipity digest.
- **Hybrid search** -- BM25 full-text search + pgvector cosine similarity with Reciprocal Rank Fusion.
- **Auto-dedup** -- merge-on-write at 0.92+ similarity, LLM confirmation for borderline cases.
- **Entity extraction** -- 4 types (person, project, tool, organization) resolved at ingest.
- **Typed connections** -- 5 link types (extends, contradicts, is-evidence-for, refines, related) via LLM classification.
- **Quality scoring** -- 0-1 information density score assigned at ingest.
- **Salience ranking** -- composite score from recency, access count, connections, merges, source weight, pinned status.
- **Multi-tenant isolation** -- `brains` + `brain_api_keys` tables, all RPCs scoped by `brain_id`, RLS on all 9 tables.
- **Telegram bot** -- webhook capture with full enrichment pipeline, secret token + chat ID auth.
- **Pipeline templates** -- Reddit (Python), RSS/HF Papers/Emergent Mind (Edge Function).
- **Pipeline observability** -- `pipeline_runs` telemetry, `source_health` view, `monitor-pipeline` with Telegram alerting.
- 40 SQL migrations, 5 Edge Functions, 138 unit tests, setup scripts, security audit.
