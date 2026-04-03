---
name: pulse
description: >
  Pipeline and data health report — checks capture sources, graph density,
  dedup pressure, content mix, and cross-metric patterns via 9 MCP tool calls.
  Rubric-scored with cross-run memory (findings tracking, auto-downgrade,
  BASELINE.md overrides). Persists to research/pulse/YYYY-MM-DD-pulse.md.

  Scope: pipeline infrastructure and thought data quality. Calls MCP tools
  (pipeline, thought_stats, analyze, dedup_review) to assess live system state.

  NOT for: TRACKER.md document quality — that's /tracker-health.

  Use when the user says "pulse", "pipeline health", "how's the brain doing",
  "run a health check" (on the system/pipeline), or invokes /pulse.
  Accepts optional days argument (default 7).
---

# /pulse — Pipeline & Data Health Report

Produce a comprehensive health and metrics report for Open Brain's pipeline
infrastructure and data quality. Rubric-scored assessments, cross-metric
pattern detection, cross-run memory, and concrete suggested actions.

## Arguments

Parse from user message:
- **days**: Integer, default 7. The reporting period in days. Usage: `/pulse` or `/pulse 14`.

Set `N` = days value for all tool calls below.
Set `TODAY` = current date in YYYY-MM-DD format.

## Phase 1: Data Gathering

Call all 9 MCP tools in parallel. There are no dependencies between them.

**Parallel calls:**

1. `pipeline(type="health")` — source status + active alerts
2. `pipeline(type="runs", days=N)` — run history for the period
3. `thought_stats(days=N)` — current period type/theme/source/topic breakdown
4. `thought_stats(days=N*2)` — double-window stats (subtract current period to derive prior period)
5. `analyze(type="density")` — graph connectivity at 4 thresholds (0.70, 0.75, 0.80, 0.85)
6. `analyze(type="hubs", min_connections=5)` — cluster nuclei
7. `dedup_review(limit=30)` — duplicate candidates + zone histogram
8. `pipeline(type="merges", days=N)` — recent merge operations
9. `analyze(type="sources")` — per-source counts + cross-source similarity pairs

10. Read `TRACKER.md` — extract the **shipped milestones table** (date + what
    was built) and **Feature Status** sections (feature name + status). Focus on
    items shipped within the last 14 days. This context feeds into Section 6.5.

11. Glob `research/pulse/*.md`, sort filenames descending, skip any file
    matching TODAY's date, take the first match. Read its YAML frontmatter
    and extract the `findings` array. If no prior report exists or the prior
    report has no `findings` array, set `prior_findings` to an empty list.

12. Read `research/pulse/BASELINE.md` (if it exists). Parse YAML to extract
    `suppress` and `force` lists. If the file does not exist, set both lists
    to empty.

Items 11-12 have no dependencies on MCP tool calls — run them in parallel
with everything else.

Record all results. These feed into every subsequent phase.

**Deriving the prior period:**

`thought_stats(days=N*2)` returns counts for the full 2N-day window.
To get the prior period (the N days before the current period):
- `prior_total = double_window_total - current_period_total`
- Apply per-source, per-theme, per-type: `prior_X = double_X - current_X`
- Delta percentage: `((current - prior) / prior) * 100` (use "N/A" if prior is 0)

## Phase 2: Assemble Report Sections

Build each section from the Phase 1 data. Apply rubrics to assign status indicators.

**Status indicators:**
- `[GREEN]` — healthy, no action needed
- `[YELLOW]` — warning, worth monitoring
- `[RED]` — critical, action needed

### Pre-Section: Findings Diff & Classification

Before assembling sections, prepare the cross-run context:

1. Parse `prior_findings` (from Phase 1, step 11) into a map keyed by `key`.
2. Parse BASELINE.md `suppress` and `force` lists (from Phase 1, step 12).
3. Initialize an empty `current_findings` list and an empty `resolved_findings` list.

As you assemble each section below, generate finding entries for every RED or
YELLOW condition. Each finding gets:
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
| Graph orphan ratio | `graph-orphan-ratio` | `graph-orphan-ratio` |
| Sparse graph | `sparse-graph` | `sparse-graph` |
| No cluster nuclei | `no-cluster-nuclei` | `no-cluster-nuclei` |
| Theme decline >25% | `theme-decline-{theme}` | `theme-decline-ml-research` |
| Theme over-indexed | `theme-overindexed-{theme}` | `theme-overindexed-ml-research` |
| Theme coverage gap | `theme-coverage-gap-{theme}` | `theme-coverage-gap-community-guidelines` |
| Source zero captures | `source-zero-captures-{source}` | `source-zero-captures-hf_papers` |
| Source volume spike | `source-volume-spike-{source}` | `source-volume-spike-reddit` |
| Source volume drop | `source-volume-drop-{source}` | `source-volume-drop-rss` |
| Pipeline alert | `pipeline-alert-{source}` | `pipeline-alert-mcp` |
| Dedup zone 0.95+ | `dedup-zone-95plus` | `dedup-zone-95plus` |
| Dedup high convergence | `dedup-high-convergence` | `dedup-high-convergence` |
| Cross-source overlap | `cross-source-{src1}-{src2}` | `cross-source-reddit-mcp` |
| Cross-metric pattern | `pattern-{name}` | `pattern-volume-quality-tradeoff` |

### Section 1: Pipeline Health

**Data source:** `pipeline(type="health")` result.

**Format as a table:**

| Source | Last Capture | Runs (N-day) | Failure Rate | Avg Captured | Status |
|--------|-------------|-------------|-------------|-------------|--------|

One row per source from the health data. Use the status icons from the tool
response directly (it already computes healthy/warning/critical).

Below the table, list any active alerts from the alert summary.

**Overall section rubric:**
- `[GREEN]`: No alerts, all sources captured within thresholds, all failure rates <10%
- `[YELLOW]`: Any warning-level alert OR any source with failure rate 10-30%
- `[RED]`: Any critical alert active

**Finding annotations:** For each active alert, generate a finding with key
`pipeline-alert-{source}`. Annotate each RED/YELLOW condition in the output
with its label: `(new)`, `(stable, Nth run)`, `(worsened)`, `(improved)`, or
`(known)`.

### Section 2: Capture Volume & Trends

**Data source:** `thought_stats(days=N)` and derived prior-period stats.

**Format as a table:**

| Source | Current Period | Prior Period | Delta | Trend |
|--------|---------------|-------------|-------|-------|

Use trend arrows: up-arrow for >10% increase, down-arrow for >10% decrease, right-arrow for within 10%.

Show totals row at bottom.

**Rubric:**
- `[GREEN]`: All sources within <=30% delta
- `[YELLOW]`: Any source >30% change in either direction
- `[RED]`: Any source dropped to zero OR >50% decline

**Flags to note:**
- Sources with >50% spike (may indicate backfill or feed burst, not sustained growth)
- Sources with >30% drop (may indicate feed issue)

**Finding annotations:** Generate findings for: sources that dropped to zero
(`source-zero-captures-{source}`), sources with >50% spike
(`source-volume-spike-{source}`), sources with >30% drop
(`source-volume-drop-{source}`). Annotate each in the output with its label.

### Section 3: Content Profile

**Data source:** `thought_stats(days=N)` current period — `by_theme`, `by_type`, `top_topics`, `top_people`. Derived prior-period theme counts.

**Format:**

Theme distribution table:

| Theme | Current | Prior | Delta | Share |
|-------|---------|-------|-------|-------|

Where Share = percentage of current period total.

Then: type distribution as a compact list.
Then: top 5 topics and top 3 people as bullet lists.

**Rubric flags:**
- Flag themes that shifted >25% in either direction (note direction and magnitude)
- Flag if any single theme >50% of total (label: "over-indexed on X")
- Flag if any theme present in prior period dropped to zero (label: "coverage gap: X")

**Finding annotations:** Generate findings for: themes shifted >25%
(`theme-decline-{theme}` or `theme-spike-{theme}`), any theme >50% of total
(`theme-overindexed-{theme}`), themes that dropped to zero
(`theme-coverage-gap-{theme}`). Annotate each in the output with its label.

### Section 4: Graph Health

**Data source:** `analyze(type="density")` (use the 0.70 threshold row — matches system
auto-link threshold), `analyze(type="hubs")`.

**Format:**

Key metrics block:
- Total thoughts (from density data)
- Avg connections at 0.70 threshold
- Orphan count and orphan ratio (orphans / total as percentage)
- Hub count (thoughts with 5+ connections)
- Also note the 0.75 threshold stats for comparison (stricter view)

**Rubric:**
- `[GREEN]`: Orphan ratio <15% at 0.70
- `[YELLOW]`: Orphan ratio 15-30% at 0.70
- `[RED]`: Orphan ratio >30% at 0.70

**Additional flags:**
- If avg connections at 0.70 is below 2.0, flag as "sparse graph"
- If hub count is 0, flag as "no cluster nuclei detected"

**Finding annotations:** Generate findings for: orphan ratio YELLOW/RED
(`graph-orphan-ratio`), avg connections < 2.0 (`sparse-graph`), hub count = 0
(`no-cluster-nuclei`). Annotate each in the output with its label.

### Section 5: Dedup Pressure

**Data source:** `dedup_review()` zones, `pipeline(type="merges", days=N)`, `analyze(type="sources")` cross-source pairs.

**Format:**

Zone histogram table (from dedup_review zones):

| Band | Pair Count | Interpretation |
|------|-----------|---------------|
| 0.95-1.00 (near-identical) | N | Should be auto-merged — if >0, may indicate missed merges |
| 0.92-0.95 (dedup threshold) | N | LLM-confirmed merge zone |
| 0.88-0.92 (borderline) | N | Worth monitoring |
| 0.85-0.88 (near-miss) | N | Normal territory |

Merge activity summary:
- Total merges in period
- Breakdown by type: auto / llm_confirmed / ingest_dedup

Cross-source overlap: list source pairs with high similarity from `analyze(type="sources")`.

**Rubric flags:**
- Flag if 0.95+ zone has >5 pairs ("auto-merge may be missing candidates")
- Flag if total merges > 20% of total captures in the period ("high convergence — sources may be too similar")
- Flag specific cross-source pairs with notably high overlap counts

**Finding annotations:** Generate findings for: 0.95+ zone >5 pairs
(`dedup-zone-95plus`), merges >20% of captures (`dedup-high-convergence`),
high cross-source overlap (`cross-source-{src1}-{src2}`). Annotate each in
the output with its label.

### Section 6: Cross-Metric Insights

Analyze data across sections to detect patterns that only emerge from combining
multiple signals. Check each pattern below. Only include patterns where the
detection condition is met — do not include patterns with no signal.

**Pattern: Volume/Quality Tradeoff**
Detection: A source's capture count increased >20% (Section 2) AND that same
source's average quality from `pipeline(type="health")` data decreased or its thoughts
in `dedup_review` candidates increased.
Finding template: "[Source] captures up [X]% but appearing more frequently in
dedup candidates — volume may be outpacing signal quality."

**Pattern: Feed Staleness Gap**
Detection: A source has zero captures in the current period (Section 2) BUT
no alert was fired for it in `pipeline(type="health")`.
Finding template: "[Source] has zero captures in the last [N] days but no
alert triggered — stale threshold may be too generous for this source."

**Pattern: Source Redundancy**
Detection: `analyze(type="sources")` shows a source pair with high cross-source
similarity count AND `pipeline(type="merges")` shows multiple merges between the same
source pair in the period.
Finding template: "[Source A] and [Source B] have [N] cross-source similar
pairs and [M] merges this period — high content overlap. Consider whether
both sources add unique value."

**Pattern: Cluster Deepening**
Detection: `analyze(type="hubs")` returns hubs AND Section 3 shows the dominant
theme's share increased >10% compared to prior period.
Finding template: "[N] hubs detected, dominant theme [X] grew [Y]% —
knowledge is deepening in [X] but may be narrowing breadth."

**Pattern: Graph Fragmentation**
Detection: Orphan ratio (Section 4) is YELLOW or RED AND avg connections
at 0.70 threshold < 2.0.
Finding template: "Orphan ratio at [X]% with avg [Y] connections — graph
is fragmenting. New thoughts may not be connecting to existing knowledge."

**Pattern: Dedup Drift**
Detection: 0.95+ zone in `dedup_review` has >3 pairs AND merge count in
`pipeline(type="merges")` is low relative to zone size (fewer merges than 0.95+ pairs).
Finding template: "[N] near-identical pairs detected but only [M] merges
in period — auto-merge may not be running after pipeline ingestion."

**Finding annotations:** For each detected pattern, generate a finding with
key `pattern-{name}` where name matches the pattern heading in kebab-case
(e.g., `pattern-volume-quality-tradeoff`, `pattern-feed-staleness-gap`,
`pattern-source-redundancy`, `pattern-cluster-deepening`,
`pattern-graph-fragmentation`, `pattern-dedup-drift`). Annotate each in the
output with its label.

### Section 6.5: Recent Work Context

**Data source:** `TRACKER.md` (read in Phase 1, step 10).

**Purpose:** Correlate pulse findings with recently shipped work to distinguish
"problem that needs fixing" from "problem we already shipped a fix for." This
section does NOT change rubric scores — scores reflect current system state.
It changes the *interpretation* of those scores.

**Process:**

1. Extract features shipped within the last 14 days from TRACKER.md's shipped
   milestones table and Feature Status sections.

2. For each RED or YELLOW finding from Sections 1-6, check if a shipped feature
   directly addresses it. Classify each finding as one of:
   - **Addressed** — a shipped feature targets this exact issue. Note the
     feature name, ship date, and what it does. Template: "[Finding] —
     addressed by [feature] shipped [date]. Verify effectiveness next pulse."
   - **Partially addressed** — a shipped feature relates but doesn't fully
     resolve the issue. Note what's covered and what's still open. Template:
     "[Finding] — partially addressed by [feature] shipped [date]. Remaining
     gap: [description]."
   - **Open** — no shipped feature covers this. Template: "[Finding] — no
     recent work addresses this."

3. Also check: are there any TRACKER features with status `planned` or
   `research` that would address open findings? If so, note: "[Finding] —
   tracked as [feature name] (status: [status])."

**Format:**

Table or list of findings with their classification:

| Finding | Status | Context |
|---------|--------|---------|
| Graph orphan ratio X% | Addressed | Auto-link threshold lowered to 0.70 + backfill (shipped 2026-03-29) |
| Theme X dropped Y% | Open | No feature addresses content mix — reflects source composition |

### Section 6.75: Known Conditions

**Data source:** Known findings from the diff/classification step (Pre-Section).

**Purpose:** Surface findings that are structural or stable so the user sees
them without generating redundant action items. This section separates
"awareness" from "action needed."

**Format as a table:**

| Finding | Severity | Since | Reason |
|---------|----------|-------|--------|
| {summary} | {severity} | {occurrences} runs | {reason} |

Where `reason` is one of:
- "Suppressed: {reason from BASELINE.md}" — for manually suppressed findings
- "Auto-downgraded: stable across {N} runs" — for auto-promoted findings

If there are no known findings, omit this section entirely.

### Section 7: Suggested Actions

**Scope:** Only generate actions for **active findings** (new, worsened,
stable with occurrences < 3, improved, or forced via BASELINE.md). Findings
classified as Known Conditions are excluded — they appear in Section 6.75
instead.

Derive concrete, actionable next steps from the rubrics, patterns, and
recent work context above. Only include actions that are supported by the
data — do not generate generic maintenance suggestions.

**Action generation rules:**

For each RED rubric in Sections 1-5, generate a specific action:
- Pipeline health RED → "Investigate [source] — [alert description]"
- Capture volume RED → "Check [source] feed/API — zero captures in [N] days"
- Graph health RED → "Run connection backfill — [N] orphaned thoughts ([X]%)"

For each YELLOW rubric, generate a monitoring note:
- "Monitor [source] — failure rate at [X]%, approaching threshold"
- "Watch [theme] trend — shifted [X]% this period"

For each cross-metric insight detected, generate a follow-up:
- Source redundancy → "Evaluate whether [Source A] and [Source B] both need to remain active"
- Dedup drift → "Verify Dream Phase A is running after pipeline ingestion"
- Feed staleness gap → "Consider tightening stale threshold for [source]"

**Recent Work Context adjustments:**

When an action corresponds to a finding classified as **Addressed** in
Section 6.5, downgrade it to a verification note:
- Instead of "Run connection backfill", write: "Verify backfill effectiveness
  — [feature] shipped [date], recheck next pulse"

When **Partially addressed**, keep the action but scope it to the remaining gap:
- Instead of the full action, write: "[Remaining gap description] —
  [feature] covers [what it covers]"

When **Open**, keep the original action unchanged.

**Always include if applicable:**
- If `dedup_review` 0.95+ zone > 0:
  "Review [N] dedup candidates in 0.95+ zone via `dedup_review()`"

## Phase 3: Assemble and Persist Report

### Terminal Output

Render the full report inline to the user with all sections. Use markdown
formatting — the terminal renders it.

Start with a one-line summary: "Pulse report for [N]-day period ending [TODAY]."

If `resolved_findings` is non-empty, add immediately after the summary:

"Resolved since last pulse: {key1} (was {severity1}), {key2} (was {severity2}), ..."

Omit if nothing resolved.

End with: "Report saved to `research/pulse/[TODAY]-pulse.md`."

### File Output

Write the report to `research/pulse/YYYY-MM-DD-pulse.md` using the Write tool.
If a file already exists for today, overwrite it (latest run wins).

**File structure:**

Frontmatter:

```
---
date: YYYY-MM-DD
period_days: N
generated_by: pulse-v2
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
## Pipeline Health
[Section 1 content]

## Capture Volume & Trends
[Section 2 content]

## Content Profile
[Section 3 content]

## Graph Health
[Section 4 content]

## Dedup Pressure
[Section 5 content]

## Cross-Metric Insights
[Section 6 content — only detected patterns]

## Recent Work Context
[Section 6.5 content — finding/status/context table]

## Known Conditions
[Section 6.75 content — only if known findings exist]

## Suggested Actions
[Section 7 content — only data-backed actions for active findings]
```

**Footer:**

```
---
*Generated by `/pulse` v2 (rubric-based + cross-run memory + TRACKER correlation).*
*Generated at: YYYY-MM-DD HH:MM UTC*
```

### Commit the report

Do NOT commit the generated report. It's an artifact of running the skill —
the user decides whether to commit it.
