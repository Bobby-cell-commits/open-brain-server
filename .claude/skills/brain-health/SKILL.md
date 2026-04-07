---
name: brain-health
description: >
  Rubric-scored knowledge graph health report — checks theme attention,
  graph density, hub health, co-occurrence alignment, dedup pressure,
  stale queue, synthesis health, entity landscape, and cross-metric
  patterns via 12 MCP tool calls. Rubric-scored with cross-run memory
  (findings tracking, auto-downgrade, BASELINE.md overrides). Persists to
  research/brain-health/YYYY-MM-DD-brain-health.md.

  Scope: knowledge graph structure and quality. Calls MCP tools (analyze,
  thought_stats, dedup_review, review_stale, list_thoughts, list_entities,
  serendipity_digest) to assess graph health.

  NOT for: pipeline capture health — that's /pulse.
  NOT for: TRACKER.md document quality — that's /tracker-health.
  NOT for: deep research on recent thoughts — that's /discover.

  Use when the user says "brain health", "graph health", "how's my
  knowledge graph", "attention map", "theme check", or invokes
  /brain-health. Accepts optional days argument (default 7).
---

# /brain-health — Knowledge Graph Health Report

Produce a rubric-scored health report for Open Brain's knowledge graph:
theme attention, graph structure, maintenance health, entity landscape,
and serendipity picks. Cross-run memory for longitudinal tracking.

## Arguments

Parse from user message:
- **days**: Integer, default 7. The reporting period in days. Usage: `/brain-health` or `/brain-health 14`.

Set `N` = days value for all tool calls below.
Set `TODAY` = current date in YYYY-MM-DD format.

## Phase 1: Data Gathering

Call all 12 MCP tools in parallel. There are no dependencies between them.

**Parallel calls:**

1. `analyze(type="themes")` — theme attention map: velocity, lifecycle, centroid drift
2. `thought_stats(days=N)` — current period breakdown (type, theme, topics, people)
3. `thought_stats(days=N*2)` — double-window stats (subtract current to derive prior period)
4. `analyze(type="density")` — graph connectivity at 0.70/0.75/0.80/0.85 thresholds
5. `analyze(type="hubs", min_connections=5)` — cluster nuclei
6. `analyze(type="co_occurrence")` — usage-driven edges, session stats, decay
7. `dedup_review(limit=30)` — near-dupe zone histogram + candidate pairs
8. `review_stale(action="list")` — pending Tier 3 archival candidates
9. `list_entities(entity_type="tool", min_thoughts=3)` — tool frequency landscape
10. `list_entities(entity_type="person", min_thoughts=3)` — people frequency landscape
11. `serendipity_digest()` — forgotten high-quality thoughts
12. `list_thoughts(type="synthesis", days=N*2, min_quality=0, limit=50)` — Dream Phase C synthesis thoughts for health assessment

13. Glob `research/brain-health/*.md`, sort filenames descending, skip any
    file matching TODAY's date, take the first match. Read its YAML
    frontmatter and extract the `findings` array. If no prior report exists
    or the prior report has no `findings` array, set `prior_findings` to
    an empty list.

14. Read `research/brain-health/BASELINE.md` (if it exists). Parse YAML to
    extract `suppress` and `force` lists. If the file does not exist, set
    both lists to empty.

Items 13-14 have no dependencies on MCP tool calls — run them in parallel
with everything else.

Record all results. These feed into every subsequent phase.

**Deriving the prior period:**

`thought_stats(days=N*2)` returns counts for the full 2N-day window.
To get the prior period (the N days before the current period):
- `prior_total = double_window_total - current_period_total`
- Apply per-theme: `prior_theme_X = double_theme_X - current_theme_X`
- Delta percentage: `((current - prior) / prior) * 100` (use "N/A" if prior is 0)

**Theme velocity note:** Theme velocity comes directly from
`analyze(type="themes")` — it's EMA-smoothed by the weekly dream-themes
batch. Do not recompute velocity from thought_stats deltas.

## Phase 2: Assemble Report Sections

Build each section from the Phase 1 data. Apply rubrics to assign status
indicators.

**Status indicators:**
- `[GREEN]` — healthy, no action needed
- `[YELLOW]` — warning, worth monitoring
- `[RED]` — critical, action needed

### Pre-Section: Findings Diff & Classification

Before assembling sections, prepare the cross-run context:

1. Parse `prior_findings` (from Phase 1, step 12) into a map keyed by `key`.
2. Parse BASELINE.md `suppress` and `force` lists (from Phase 1, step 13).
3. Initialize an empty `current_findings` list and an empty `resolved_findings` list.

As you assemble each section below, generate finding entries for every RED
or YELLOW condition. Each finding gets:
- `key`: deterministic identifier (see Finding Key Reference below)
- `section`: which section produced it
- `severity`: RED or YELLOW
- `value`: the metric value as a string
- `summary`: human-readable one-liner

After generating each finding, classify it by diffing against `prior_findings`:

| Current finding | In prior_findings? | Same severity? | Label | Occurrences |
|----------------|-------------------|---------------|-------|-------------|
| Yes | No | — | `new` | 1 |
| Yes | Yes | Yes | `stable` | prior.occurrences + 1 |
| Yes | Yes | Current < Prior | `improved` | 1 |
| Yes | Yes | Current > Prior | `worsened` | 1 |

**Value stability check:** For `stable` findings, compare values numerically
where possible. If the value changed by more than 5% relative, reset to
label=`new`, occurrences=1 instead. This prevents a worsening metric from
hiding behind a "stable" label.

After all sections are assembled, compute `resolved_findings`: any key in
`prior_findings` that is not in `current_findings`. Record each with its
prior severity.

**Apply BASELINE overrides** (in this order):
1. For each finding whose key is in the `force` list: mark as `forced` —
   it stays in Suggested Actions regardless of occurrences.
2. For each finding whose key is in the `suppress` list AND NOT in `force`:
   mark as `known` — it goes to Known Conditions regardless of occurrences.
3. For remaining findings: if `occurrences >= 3`, mark as `known`
   (auto-downgraded). Otherwise, it stays active.

**Partition findings:**
- **Active findings** (label is `new`, `stable` with occurrences < 3,
  `worsened`, `improved`, or `forced`) → feed into Suggested Actions.
- **Known findings** (label is `known` via suppress or auto-downgrade) →
  feed into Known Conditions section.

**Finding Key Reference:**

| Finding type | Key pattern | Example |
|-------------|-------------|---------|
| Theme declining | `theme-declining-{name}` | `theme-declining-infrastructure` |
| Theme dormant | `theme-dormant-{name}` | `theme-dormant-side-projects` |
| Theme emerging (informational) | `theme-emerging-{name}` | `theme-emerging-ml-research` |
| Theme drift | `theme-drift-{name}` | `theme-drift-ml-research` |
| Graph orphan ratio | `graph-orphan-ratio` | `graph-orphan-ratio` |
| Graph sparse | `graph-sparse` | `graph-sparse` |
| Low hub count | `graph-low-hubs` | `graph-low-hubs` |
| Co-occurrence no edges | `cooccurrence-no-edges` | `cooccurrence-no-edges` |
| Co-occurrence stale sessions | `cooccurrence-stale-sessions` | `cooccurrence-stale-sessions` |
| Dedup zone 0.95+ | `dedup-zone-95plus` | `dedup-zone-95plus` |
| Dedup high pressure | `dedup-high-pressure` | `dedup-high-pressure` |
| Stale queue backlog | `stale-queue-backlog` | `stale-queue-backlog` |
| Synthesis inactive | `synthesis-inactive` | `synthesis-inactive` |
| Synthesis stale | `synthesis-stale` | `synthesis-stale` |
| Synthesis low coverage | `synthesis-low-coverage` | `synthesis-low-coverage` |
| Entity concentration | `pattern-entity-concentration-{name}` | `pattern-entity-concentration-openai` |
| Attention narrowing | `pattern-attention-narrowing` | `pattern-attention-narrowing` |
| Capture-connection gap | `pattern-capture-connection-gap` | `pattern-capture-connection-gap` |
| Velocity-quality divergence | `pattern-velocity-quality-divergence` | `pattern-velocity-quality-divergence` |
| Stale theme accumulation | `pattern-stale-theme-accumulation` | `pattern-stale-theme-accumulation` |

### Section 1: Theme Attention Map

**Data source:** `analyze(type="themes")` result + `thought_stats(days=N)` derived delta.

**Format as a table:**

| Theme | Lifecycle | Velocity | Thoughts | Period Delta | Centroid Drift |
|-------|-----------|----------|----------|-------------|---------------|

One row per theme from the themes data. Sort by thought_count descending.
Velocity is thoughts/week (EMA-smoothed by dream batch). Period delta is
derived from `thought_stats` current vs prior period for the `by_theme`
breakdown.

**Overall section rubric:**
- `[GREEN]`: All themes are active, emerging, or mature
- `[YELLOW]`: 1-2 themes are declining
- `[RED]`: 3+ themes declining OR any theme dormant

**Finding annotations:** For each declining theme, generate a finding with
key `theme-declining-{name}`. For each dormant theme, generate a finding
with key `theme-dormant-{name}`. For each emerging theme, generate an
informational finding (YELLOW) with key `theme-emerging-{name}` — this is
a positive signal, not a warning; annotate it as "(informational)".

Annotate each finding in the output with its label: `(new)`, `(stable,
Nth run)`, `(worsened)`, `(improved)`, or `(known)`.

### Section 2: Theme Drift

**Data source:** `analyze(type="themes")` — centroid_drift field.

List any themes with centroid_drift > 0, sorted descending. Show the drift
value and a brief interpretation:
- < 0.03: stable meaning
- 0.03-0.05: meaning shifting
- > 0.05: significant drift — theme may be splitting

**Bootstrap gate:** If the `latest_snapshot_date` field shows only one
snapshot exists (all themes have the same date and it matches the first
backfill), output: "Insufficient snapshots for drift analysis — drift
requires 2+ weekly dream batch runs." Score as `[GREEN]` and skip
finding generation.

**Rubric (when sufficient data):**
- `[GREEN]`: All centroid_drift < 0.03
- `[YELLOW]`: Any drift 0.03-0.05
- `[RED]`: Any drift > 0.05

**Finding key:** `theme-drift-{name}` for each theme exceeding 0.03.

### Section 3: Graph Density

**Data source:** `analyze(type="density")` result.

**Format as a table:**

| Threshold | Avg Connections | Median | Zero-Link (Orphans) | 10+ Links |
|-----------|----------------|--------|--------------------:|----------:|

One row per threshold from the density data (typically 0.70, 0.75, 0.80,
0.85).

Compute orphan ratio from the 0.70 threshold row:
`orphan_ratio = zero_link_count / (zero_link_count + non_zero_count)`

If orphan ratio is not directly available, compute from total thoughts
(from `thought_stats`) minus non-orphan count.

**Rubric:**
- `[GREEN]`: Orphan ratio <15% at 0.70 AND avg connections >= 2.0 at 0.70
- `[YELLOW]`: Orphans 15-30% OR avg connections 1.0-2.0
- `[RED]`: Orphans >30% OR avg connections < 1.0

**Finding keys:**
- `graph-orphan-ratio` if orphan ratio >= 15%
- `graph-sparse` if avg connections < 2.0 at 0.70

### Section 4: Hub Health

**Data source:** `analyze(type="hubs", min_connections=5)` result.

Count total hubs returned. Show the top 5 hubs with:

| # | Preview | Source | Connections |
|---|---------|--------|------------:|

**Rubric:**
- `[GREEN]`: 5+ hubs
- `[YELLOW]`: 2-4 hubs
- `[RED]`: 0-1 hubs

**Finding key:** `graph-low-hubs` if hub count < 5.

### Section 5: Co-occurrence Alignment

**Data source:** `analyze(type="co_occurrence")` result.

Report:
- Total co-occurrence edges
- Recent retrieval sessions (count in last 7 days)
- Decay stats (if available): edges decayed, edges removed
- Top 3 co-occurring pairs by weight (if any)

**Bootstrap gate:** If total edges < 20, output: "Co-occurrence layer is
bootstrapping ([N] edges). Shipped 2026-04-06 — building up from retrieval
sessions." Score as `[GREEN]` and skip finding generation.

**Rubric (when sufficient data):**
- `[GREEN]`: Edges exist and sessions recorded in last 7 days
- `[YELLOW]`: Low edge count (<10 after bootstrap) OR no sessions in 3+ days
- `[RED]`: Zero edges (after bootstrap period) OR no sessions in 7+ days

**Finding keys:**
- `cooccurrence-no-edges` if zero edges after bootstrap
- `cooccurrence-stale-sessions` if no sessions in 3+ days

### Section 6: Dedup Pressure

**Data source:** `dedup_review(limit=30)` result.

**Format the zone histogram:**

| Zone | Pairs | Meaning |
|------|------:|---------|
| 0.95+ | N | Should have auto-merged (Dream Phase A) |
| 0.92-0.95 | N | LLM confirmation zone |
| 0.88-0.92 | N | Near-miss territory |
| 0.85-0.88 | N | Normal similarity |

Below the histogram, show the top 3 candidate pairs from the 0.95+ zone
(if any) with similarity score and content previews.

**Rubric:**
- `[GREEN]`: 0.95+ zone has < 3 pairs
- `[YELLOW]`: 0.95+ zone has 3-10 pairs
- `[RED]`: 0.95+ zone has > 10 pairs (auto-merge may be broken)

**Finding keys:**
- `dedup-zone-95plus` if 0.95+ zone >= 3 pairs
- `dedup-high-pressure` if total candidates across all zones > 20

### Section 7: Stale Queue

**Data source:** `review_stale(action="list")` result.

Report:
- Count of pending Tier 3 thoughts awaiting review
- Top 3 candidates with content preview and staleness score

**Rubric:**
- `[GREEN]`: 0 pending
- `[YELLOW]`: 1-5 pending
- `[RED]`: 6+ pending

**Finding key:** `stale-queue-backlog` if pending > 0.

### Section 8: Synthesis Health

**Data source:** `list_thoughts(type="synthesis", days=N*2, min_quality=0)` result
+ `thought_stats(days=N)` and `thought_stats(days=N*2)` type breakdowns.

Derive counts from `thought_stats` `by_type` field:
- `current_syntheses` = `by_type.synthesis` from `thought_stats(days=N)` (0 if absent)
- `double_syntheses` = `by_type.synthesis` from `thought_stats(days=N*2)` (0 if absent)
- `prior_syntheses` = `double_syntheses - current_syntheses`

From `list_thoughts` result, compute:
- `avg_coverage` = mean of `metadata.coverage_score` across returned thoughts
- `avg_cluster_size` = mean of `metadata.cluster_size` across returned thoughts
- `total_syntheses` = count of returned thoughts (all syntheses in 2N window)

**Format as a table:**

| Metric | Value |
|--------|-------|
| Syntheses this period | N (delta vs prior: +/-X) |
| Avg coverage score | 0.XX |
| Avg cluster size | N.N |
| Total (last 2N days) | N |

If syntheses exist in the period, show the top 3 most recent with:

| # | Theme | Coverage | Cluster Size | Created |
|---|-------|----------|-------------|---------|
| 1 | theme | 0.XX | N | YYYY-MM-DD |

**Bootstrap gate:** If `total_syntheses` = 0, output: "Dream Phase C has
not produced insights yet — first results expected after the next weekly
run (Sunday 09:00 UTC)." Score as `[GREEN]` and skip finding generation.

**Rubric (when data exists):**
- `[GREEN]`: `current_syntheses` >= 1 AND `avg_coverage` >= 0.75
- `[YELLOW]`: `current_syntheses` = 0 (no new clusters processed this period)
  OR `avg_coverage` between 0.70 and 0.75
- `[RED]`: `current_syntheses` = 0 AND `prior_syntheses` = 0 (no synthesis
  output for 2× the reporting period — Phase C may be broken) OR
  `avg_coverage` < 0.70

**Finding keys:**
- `synthesis-inactive` if `current_syntheses` = 0 but `total_syntheses` > 0
  (Phase C didn't produce output this period)
- `synthesis-stale` if `current_syntheses` = 0 AND `prior_syntheses` = 0
  AND `total_syntheses` > 0 (no output for 2× period — RED)
- `synthesis-low-coverage` if `avg_coverage` < 0.75

### Section 9: Cross-Metric Patterns

Detect patterns only when conditions are met. Only include patterns where
the detection condition fires — omit the rest entirely.

| Pattern | Detection Condition | Template |
|---------|-------------------|----------|
| Attention narrowing | Dominant theme >40% of total thoughts AND hubs from `analyze(type="hubs")` are concentrated (>50%) in that same theme | "[Theme] holds [X]% of thoughts and [Y]% of hubs — attention narrowing, breadth declining" |
| Capture-connection gap | Capture volume delta >20% increase (from thought_stats) BUT orphan ratio also increased vs prior run | "Capture volume up [X]% but orphan ratio worsened to [Y]% — new thoughts not connecting" |
| Velocity-quality divergence | Any theme has velocity >5 AND that theme's avg_quality (from theme_tracking in thought_stats) is declining | "[Theme] velocity [X] but avg quality dropping — volume outpacing signal" |
| Stale theme accumulation | Any declining/dormant theme's thoughts appear in stale queue candidates | "[Theme] is [lifecycle] and has [N] thoughts in stale queue — natural decay in progress" |
| Entity concentration | Any entity from list_entities has thought_count > 15% of total thoughts | "[Entity] appears in [N] thoughts ([X]% of total) — over-indexed on this [type]" |

**Finding keys:** `pattern-attention-narrowing`, `pattern-capture-connection-gap`,
`pattern-velocity-quality-divergence`, `pattern-stale-theme-accumulation`,
`pattern-entity-concentration-{name}`

For each detected pattern, generate a YELLOW finding. Annotate with
cross-run label as usual.

### Section 10: Entity Landscape

**Data source:** `list_entities(entity_type="tool")` + `list_entities(entity_type="person")` results.

**Format as two tables:**

**Top Tools:**
| Tool | Thoughts | % of Total |
|------|---------|-----------|

**Top People:**
| Person | Thoughts | % of Total |
|--------|---------|-----------|

Show top 5 of each. Compute % of total from `thought_stats` total count.
Flag any entity exceeding 15% (feeds into cross-metric pattern detection).

This section is informational — no rubric scoring.

### Serendipity Pick

**Data source:** `serendipity_digest()` result.

Show 1-2 forgotten high-quality thoughts with:
- Content preview (first 100 chars)
- Created date
- Theme
- Quality score

No rubric — this is a "you might want to revisit" nudge at the end of
the report. Frame it as: "**Forgotten gems** — high-quality thoughts that
haven't been accessed recently."

### Known Conditions

List all findings classified as `known` (via BASELINE.md suppress or
auto-downgrade at 3+ occurrences). For each:
- Finding key and summary
- Reason (from BASELINE.md if suppressed, or "auto-downgraded, stable N runs" if auto)
- Last severity

Only include this section if known findings exist.

### Suggested Actions

Generate concrete, data-backed actions from active RED and YELLOW findings
only. Findings classified as Known Conditions are excluded — they appear
in the Known Conditions section instead.

**Action generation rules:**

For each RED rubric in Sections 1-8, generate a specific action:
- Theme attention RED → "Review dormant themes — [themes] have zero velocity for [N] weeks"
- Theme drift RED → "Investigate [theme] drift ([X]) — meaning may be splitting, consider new theme"
- Graph density RED → "Run connection backfill — [N] orphaned thoughts ([X]%)"
- Hub health RED → "No cluster nuclei — graph may need denser connection thresholds"
- Co-occurrence RED → "Check retrieval session logging — zero co-occurrence edges"
- Dedup RED → "Verify Dream Phase A is running — [N] pairs in 0.95+ zone"
- Stale queue RED → "Review [N] stale candidates via `review_stale(action='list')`"
- Synthesis RED (stale) → "Check Dream Phase C workflow — no synthesis output for [2N] days. Verify `run-dream-synthesis` GitHub Action is running (Sunday 09:00 UTC)"
- Synthesis RED (low coverage) → "Synthesis quality degraded — avg coverage [X] below 0.70. Review source cluster quality or probe evaluation prompts"

For each YELLOW rubric, generate a monitoring note:
- "Monitor [theme] — declining, velocity [X]"
- "Watch orphan ratio — [X]% at 0.70 threshold"
- "Review [N] dedup candidates in 0.95+ zone"
- "Dream Phase C produced no syntheses this period — may be no eligible clusters, or schedule hasn't fired yet"

For each detected cross-metric pattern, generate a follow-up:
- Attention narrowing → "Consider diversifying captures beyond [theme]"
- Entity concentration → "Review [entity] dominance — [X]% may indicate capture bias"

**Always include if applicable:**
- If `dedup_review` 0.95+ zone > 0:
  "Review [N] dedup candidates in 0.95+ zone via `dedup_review()`"
- If stale queue > 0:
  "Process [N] stale review candidates via `review_stale()`"

## Phase 3: Assemble and Persist Report

### Terminal Output

Render the full report inline to the user with all sections. Use markdown
formatting — the terminal renders it.

Start with a one-line summary:
`Brain Health: [X] GREEN, [Y] YELLOW, [Z] RED — [top finding summary or "all clear"]`

If `resolved_findings` is non-empty, add immediately after the summary:

"Resolved since last brain-health: {key1} (was {severity1}), {key2} (was {severity2}), ..."

Omit if nothing resolved.

End with: "Report saved to `research/brain-health/[TODAY]-brain-health.md`."

### File Output

Write the report to `research/brain-health/YYYY-MM-DD-brain-health.md`
using the Write tool. If a file already exists for today, overwrite it
(latest run wins).

**File structure:**

Frontmatter:

```
---
date: YYYY-MM-DD
period_days: N
generated_by: brain-health-v2
findings:
  - key: "{finding.key}"
    section: "{finding.section}"
    severity: "{finding.severity}"
    value: "{finding.value}"
    occurrences: {finding.occurrences}
    summary: "{finding.summary}"
  # ... one entry per RED/YELLOW finding (both active and known)
---
```

Then the full report body with H2 headers for each section:

```
## Theme Attention Map
[Section 1 content]

## Theme Drift
[Section 2 content]

## Graph Density
[Section 3 content]

## Hub Health
[Section 4 content]

## Co-occurrence Alignment
[Section 5 content]

## Dedup Pressure
[Section 6 content]

## Stale Queue
[Section 7 content]

## Synthesis Health
[Section 8 content]

## Cross-Metric Patterns
[Section 9 content — only detected patterns, omit if none]

## Entity Landscape
[Section 10 content]

## Serendipity Pick
[Serendipity content]

## Known Conditions
[Only if known findings exist]

## Suggested Actions
[Only data-backed actions for active findings]
```

**Footer:**

```
---
*Generated by `/brain-health` v1 (rubric-based + cross-run memory).*
*Generated at: YYYY-MM-DD HH:MM UTC*
```

### Commit the report

Do NOT commit the generated report. It's an artifact of running the skill —
not source code. The user can commit it themselves if desired.
