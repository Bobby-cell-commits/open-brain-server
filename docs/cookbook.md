---
paths:
  - "**"
---

# Open Brain MCP Cookbook

How to use the 16 MCP tools effectively — patterns, compositions, and non-obvious behaviors.

## Quick Reference

| Tool | Purpose | Key Params |
|------|---------|------------|
| `search_thoughts` | Hybrid search (vector + keyword) | `query`, `limit=10`, `threshold=0.7`, `min_quality=0.4`, `expand=false` |
| `list_thoughts` | Browse with filters, salience-ordered | `type`, `topic`, `person`, `theme`, `min_quality=0.4`, `days`, `limit=20` |
| `capture_thought` | Store with auto-embed, auto-link, entity extraction | `content`, `source="mcp"` |
| `thought_stats` | Aggregate counts, type/theme breakdown, top topics/people | `days` (optional) |
| `get_connections` | Graph traversal from a thought (typed links) | `thought_id` |
| `list_entities` | Browse extracted entities by frequency | `entity_type`, `min_thoughts=1`, `limit=20` |
| `weekly_review` | LLM synthesis of recent themes, open loops, next steps | `days=7` |
| `analyze` | Graph analysis: hubs, density, or sources | `type` (required), `min_connections=5` (hubs) |
| `dedup_review` | Duplicate candidates + zone histogram | `limit=20` |
| `refresh_salience` | Recompute all salience scores | (none) |
| `update_thought` | Rewrite content (re-embeds, re-extracts metadata) | `id`, `content` |
| `delete_thought` | Permanent delete (cascades connections) | `id` |
| `serendipity_digest` | Resurface forgotten high-quality thoughts | (none) |
| `pipeline` | Pipeline monitoring: health, runs, merges | `type` (required), `days=7`, `source`, `merge_type` |
| `migration_guide` | Import runbook for external platforms | `platform` |
| `review_stale` | Review flagged stale thoughts | `action=list/approve/reject`, `thought_id` |

## Explore Patterns

**"What's in my brain?"**
Start with `thought_stats()` for the lay of the land — total count, type/theme breakdown, top topics and people. Add `days=7` or `days=30` to scope to recent activity.

**"What am I paying attention to?"**
`thought_stats(days=7)` → look at the `by_theme` breakdown. Themes are a controlled vocabulary (8 values), so this is a reliable attention map. Compare against `thought_stats(days=30)` to spot shifts.

**"Show me everything about X"**
Chain filters on `list_thoughts`: `list_thoughts(theme="ml-research", min_quality=0.7, days=14)`. Filters are AND-combined — stack them to narrow precisely. Sort is always salience-first, then recency.

**"What tools/projects/people keep coming up?"**
`list_entities(entity_type="tool", min_thoughts=3)` → most-referenced tools across all thoughts. Swap type for `person`, `project`, or `organization`. Then `search_thoughts("entity_name")` to find everything related.

**"What's high quality?"**
`list_thoughts(min_quality=0.8, days=7)` → recent high-signal content. Quality (0-1) is an LLM-assigned information density score, distinct from salience (which factors recency, access, connections).

## Investigate Patterns

**"Go deep on a topic"**
1. `search_thoughts("topic query", threshold=0.6)` — lower threshold casts a wider net
2. Pick a high-scoring result → `get_connections(thought_id)` to walk the graph
3. Follow typed links: `extends` chains build on each other, `contradicts` reveals tensions, `is-evidence-for` grounds claims

**"Find the hub thoughts"**
`analyze(type="hubs", min_connections=5)` → cluster nuclei. These are the thoughts that connect to many others. Then `get_connections(hub_id)` to see what they link to. Hubs with high `merge_count` are convergence hotspots — the same idea captured from multiple sources.

**"How does X relate to Y?"**
1. `search_thoughts("X")` → get the thought ID
2. `get_connections(thought_id)` → see if Y appears in the graph
3. If not directly connected, search for Y and compare the connection neighborhoods — shared connections reveal indirect bridges

**"What themes are emerging?"**
`weekly_review(days=14)` → LLM-synthesized themes, open loops, connections, and suggested next steps. Uses gpt-4o (not mini) for quality. Capped at 100 thoughts — for larger windows, the sample is representative but not exhaustive.

## Capture Patterns

**What happens when you capture:**
`capture_thought(content)` triggers a pipeline: embed + extract metadata (parallel) → dedup check (auto-merge at 0.92+ similarity) → insert → auto-link top 3 similar thoughts → extract and resolve entities. All post-insert steps are best-effort (won't fail the capture).

**When to capture vs. update:**
- Capture new: genuinely new idea or reference
- Update existing: refining/correcting an existing thought (re-embeds, re-extracts metadata, replaces old metadata entirely)
- Don't capture: implementation specs, task tracking, ephemeral status — Open Brain is for ideas, not project management

**Merge signals:**
If capture returns `{merged: true}`, the content was >92% similar to an existing thought. The original's `merge_count` incremented. High merge_count = convergence signal (same idea from multiple sources = high confidence).

## Maintain Patterns

**Dedup health check:**
`dedup_review(limit=30)` → shows candidate pairs by similarity band (0.85-0.88, 0.88-0.92, 0.92-0.95, 0.95+). The zone histogram reveals if thresholds need tuning. If 0.95+ zone is large, Dream Phase A may not be running; if 0.85-0.88 is large, that's normal near-miss territory.

**Graph health:**
`analyze(type="density")` → connection stats at thresholds 0.70/0.75/0.80/0.85. Watch for: high `zero_link_count` (orphaned thoughts), low avg connections (sparse graph). Healthy: most thoughts have 2+ connections at 0.75 threshold.

**Pipeline health:**
`pipeline(type="health")` → per-source status, last capture time, run stats, failure rates, and active alerts. `pipeline(type="runs", days=7)` → run history with capture/failure/filter counts per run. `analyze(type="sources")` → cross-source similarity and coverage overlap. The `monitor-pipeline` Edge Function handles automated Telegram alerting separately.

**Merge audit:**
`pipeline(type="merges", days=7)` → recent merge operations with type (auto/llm_confirmed/ingest_dedup), similarity, and content previews. Filter by type: `pipeline(type="merges", merge_type="auto")`. Use to debug unexpected merges or verify dedup is working correctly.

**Staleness health check:**
`pipeline(type="runs")` → check `dream_decay` in recent runs for archive counts. `review_stale()` → pending Tier 3 candidates awaiting human/agent review. `review_stale(action="approve", thought_id="...")` to archive, `review_stale(action="reject", thought_id="...")` to keep and exclude for 30 days.

**Salience refresh:**
`refresh_salience()` after bulk operations (backfills, merges, large ingestion runs). Salience formula: `recency_decay * ln(access+1) * (1 + 0.1*connections) * (1 + 0.2*merges) * source_weight * pinned_multiplier`. Stale salience = suboptimal list/search ordering.

## Composition Recipes

**Discovery-style deep dive (what /discover does manually):**
```
1. thought_stats(days=30) + analyze(type="hubs") + analyze(type="density")  [parallel]
2. Pick hub thoughts → get_connections(hub_id) for each            [parallel]
3. search_thoughts("bridge query", threshold=0.5) for cross-cluster links
4. Synthesize findings
```

**Entity-driven investigation:**
```
1. list_entities(entity_type="tool", min_thoughts=2)
2. Pick top entity → search_thoughts("entity_name")
3. For each result → get_connections(thought_id) to map the neighborhood
```

**Quality audit:**
```
1. thought_stats() → total count
2. list_thoughts(min_quality=0.3, limit=50) → low-quality thoughts
3. Review and delete/update as needed
4. dedup_review() → merge candidates
```

**Theme gap analysis:**
```
1. thought_stats() → by_theme breakdown
2. Identify thin themes (low count)
3. search_thoughts("thin theme topic") → what exists?
4. Compare against list_thoughts(theme="dominant_theme") → over-indexed areas
```

## Non-Obvious Behaviors

- **Access tracking is silent:** `search_thoughts` and `list_thoughts` fire-and-forget increment `access_count` for returned results. This feeds salience scoring automatically — frequently retrieved thoughts rank higher over time.
- **Salience ordering everywhere:** `list_thoughts` sorts by salience DESC then created_at DESC. `search_thoughts` blends similarity with salience in the ranking. Run `refresh_salience()` if rankings feel stale.
- **Filter stacking is AND:** All `list_thoughts` filters combine with AND logic. `list_thoughts(theme="ml-research", type="idea", days=7)` = ml-research ideas from the last week.
- **Topic/person filters are exact match** within JSONB arrays. `list_thoughts(person="Ada Lovelace")` matches if the person array contains that exact string.
- **Quality is a string comparison** under the hood (JSONB extraction). Works for 0-1 floats but edge cases possible with multi-digit precision.
- **Connection typing is threshold-gated:** Links at 0.80+ similarity get LLM-classified types (extends/contradicts/etc.). Below 0.80, connections are labeled "related" with no reason.
- **update_thought does NOT re-link:** Updating content re-embeds and re-extracts metadata but doesn't retrigger connection storage or entity resolution. Connections reflect the original content.
- **weekly_review caps at 100 thoughts:** For periods with >100 thoughts, it samples. Use smaller `days` windows for comprehensive reviews.
- **Entity types are case-sensitive:** Use lowercase: "person", "project", "tool", "organization".
- **Quality gating is on by default:** Both `search_thoughts` and `list_thoughts` filter out thoughts with quality < 0.4. Pass `min_quality=0` to disable. This prevents noise thoughts from consuming ranking slots.
- **Threshold cheat sheet:** 0.92+ = dedup merge, 0.85-0.92 = near-miss logging, 0.80+ = typed connections, 0.75+ = connection linking, 0.70 = default search floor, 0.40 = default quality gate.
- **Staleness tiers:** 0.85+ = auto-archive (LLM confirms at any confidence), 0.70-0.85 = context-confirmed (LLM must say archive with high confidence), 0.40-0.70 = flagged for review (never auto-archived). Scores below 0.40 are healthy.
- **Archived thoughts are invisible:** All search, list, stats, dedup, and analysis RPCs filter `archived_at IS NULL`. Archived thoughts still exist in the DB and can be unarchived.
- **Sole-entity protection:** If archiving a thought would leave zero active thoughts for any of its entities, it's skipped. Prevents knowledge gaps.
