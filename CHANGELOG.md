# Changelog

All notable changes to Open Brain Server are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

When upgrading, apply new migrations with `supabase db push --linked` from the `supabase/` directory.

## [Unreleased]

## 2026-04-07d

### Added
- **`/brain-health` skill.** Knowledge graph health report -- 12 parallel MCP calls covering theme attention, graph density, hub health, co-occurrence alignment, dedup pressure, stale queue, synthesis output, entity landscape, and serendipity. Rubric-scored (GREEN/YELLOW/RED) with cross-run memory and 5 cross-metric pattern detectors.

### Changed
- **Skills are now functional.** Discover, pulse, and brain-health skills moved from `docs/skills/` (read-only showcase) to `.claude/skills/` (auto-discovered by Claude Code). Cloning the repo gives you working `/discover`, `/pulse`, and `/brain-health` slash commands immediately.
- **README rewritten** to reflect current feature surface. Adds: deployment options (Supabase vs Docker), knowledge graph explanation, skills section, automated maintenance table (8 scheduled jobs), updated tools table (16 tools), and corrected project structure.

## 2026-04-07c

### Added
- **Docker Compose self-hosting.** One-command deployment: `./start.sh` boots Postgres + pgvector, PostgREST, Edge Runtime, Caddy reverse proxy, and a cron container for scheduled maintenance. Auto-generates all secrets (Postgres password, JWT, MCP access key).
- `docker/docker-compose.yml` -- 6 services with healthcheck dependency chains.
- `docker/init/init.sh` -- applies all SQL migrations, seeds secrets, creates owner brain + API key.
- `docker/main/index.ts` -- Edge Runtime main router dispatching to all Edge Functions.
- `docker/Caddyfile` -- reverse proxy with Supabase-compatible URL paths (`/functions/v1/*`, `/rest/v1/*`).
- `docker/crontab` -- scheduled jobs for graph analysis, pipeline ingestion, dream dedup/decay/themes/synthesis, and monitoring.
- `docker/start.sh` -- entrypoint that generates missing secrets, writes `.env`, and boots the stack.
- `docker/README.md` -- setup guide with MCP client configuration, Telegram setup, service table, backup instructions, and troubleshooting.

### No migrations required
Docker ships with all existing migrations applied at init time. No new database changes.

## 2026-04-07b

### Added
- **Dream Phase C -- insight synthesis.** Automatically generates meta-thoughts from thought clusters. The system finds groups of related thoughts (by theme + entity co-occurrence), synthesizes them into a single insight using LLM, validates with probe QA (no information loss), and inserts as `source='dream'` thoughts linked to evidence via `synthesizes` connections. Additive only -- source thoughts are never compacted or deleted.
- `find_synthesis_candidates` RPC -- clusters thoughts using shared theme + entity co-occurrence, excludes recently synthesized and previously merged thoughts.
- `dreamSynthesis()` batch module -- wired into `run-pipeline` via `dream_synthesis: true` body param.
- `run-dream-synthesis` workflow reference (Sunday 9 AM UTC).
- `dream-synthesis_test.ts` -- 351 lines of unit tests covering clustering, LLM synthesis, probe QA, insert, and error handling.

### Changed
- `pipeline(type="health")` now includes synthesis status in health output.
- Cookbook updated with synthesis composition recipe reference.
- Tool count unchanged at 16.

### Migrations
2 new migrations to apply:
- `20260407000001_dream_synthesis.sql` -- adds `find_synthesis_candidates` RPC, `synthesizes` connection type, Phase A dedup exclusion for synthesis thoughts
- `20260407000002_fix_synthesis_recursive_cte.sql` -- fixes recursive CTE for candidate clustering, JSON synthesis prompt, and cluster limit

## 2026-04-07

### Added
- **Dream Phase B -- theme tracking.** Themes are now first-class entities with temporal evolution tracking. Weekly batch computes theme membership, velocity (thoughts/week), lifecycle state (emerging/active/mature/declining/dormant), and centroid drift. Pure SQL computation, no LLM calls.
- `themes`, `theme_thoughts`, `theme_snapshots` tables with RLS.
- `analyze(type="themes")` -- theme lifecycle timeline, velocity, centroid drift. Optionally pass `theme` param for single-theme deep dive.
- `thought_stats` enriched with per-theme velocity and lifecycle data.
- `dream-themes.ts` batch module -- wired into `run-pipeline` via `dream_themes: true` body param.
- `run-dream-themes` workflow reference (Sunday 8:30 UTC).
- 3 new test files: dream-themes unit tests, analyze themes tests, thought-stats enrichment tests.

### Changed
- Triage prompts refined for category and actionability classification. Key improvements: newsletters/announcements correctly capped at "medium" actionability, better "domain" vs "learning" boundary, leak/unauthorized content detection. Merged from autoresearch Run 4 (+3.4pp train accuracy, +5.1pp category accuracy).
- Cookbook updated with theme tracking patterns and composition recipes.
- Tool count unchanged at 16.

### Removed
- `get-thought-embeddings_test.ts` integration test (functionality covered by unit tests).

### Migrations
3 new migrations to apply:
- `20260406000004_theme_tables.sql` -- adds `themes`, `theme_thoughts`, `theme_snapshots` tables with RLS
- `20260406000005_theme_backfill.sql` -- seeds 8 theme rows, backfills junction table from JSONB metadata, computes initial centroids and snapshot
- `20260406000006_theme_rpcs.sql` -- 6 RPCs: theme queries, velocity computation, lifecycle classification, centroid management

## 2026-04-06

### Added
- **Co-occurrence edge strengthening.** Usage-driven graph layer: retrieval sessions are logged, co-occurring thoughts get weighted edges that strengthen with repeated co-retrieval. Ebbinghaus forgetting curve decay + Turrigiano homeostatic normalization prevent runaway hub growth.
- `retrieval_sessions` audit table -- append-only log of all search/list retrievals.
- `co_occurrence_edges` table -- materialized edges with weight, raw count, half-life, decay.
- `analyze(type="co_occurrence")` -- graph health observability: edge stats, weight distribution, top edges, hub report, session counts.
- `graph_expanded_search` v2 -- co-occurrence expansion pass adds usage-correlated thoughts to search results.
- `run-co-occurrence-decay` workflow reference -- weekly decay maintenance (Sunday 4 AM UTC).

### Changed
- `search_thoughts` and `list_thoughts` now fire-and-forget log retrieval sessions and update co-occurrence edges.
- `run-pipeline` Edge Function handles co-occurrence decay as a maintenance task.
- `x-brain-context` header extracted for context-weighted session logging.
- GitHub Actions workflows moved from `.github/workflows/` to `docs/workflows/` -- reference examples only, no longer auto-trigger on forks.
- Tool count unchanged at 16.

### Fixed
- `source_health` view security invoker policy added.

### Migrations
4 new migrations to apply:
- `20260405000006_source_health_security_invoker.sql`
- `20260406000001_co_occurrence_tables.sql` -- adds `retrieval_sessions` + `co_occurrence_edges` tables with RLS
- `20260406000002_co_occurrence_rpcs.sql` -- 4 RPCs: session logging, edge UPSERT, decay, analysis
- `20260406000003_graph_expanded_search_v2.sql` -- co-occurrence expansion CTE in graph search

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
- **GitHub Actions workflow references** (in `docs/workflows/`) for all scheduled tasks: RSS, HF Papers, Emergent Mind, dream dedup, dream decay, graph analysis refresh, pipeline monitoring.
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
