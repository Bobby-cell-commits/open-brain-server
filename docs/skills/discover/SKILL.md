---
name: discover
description: >
  Incremental discovery and research on recent Open Brain thoughts. Reads
  state from previous runs to pull only new thoughts, classifies them against
  previous clusters (EVOLVED/NEW/STALE), correlates with TRACKER.md priorities,
  and dispatches parallel research agents for full runs or synthesizes inline
  for light passes. Produces a report that builds on the previous one.

  Use when the user says "discover", "analyze my thoughts", "what have I been
  thinking about", "deep dive on my Open Brain", "research my recent thoughts",
  or invokes /discover. Also use when the user wants to find patterns, themes,
  or actionable insights across their captured thoughts.
---

# Open Brain Discovery (Incremental)

Analyze recent Open Brain thoughts incrementally — building on the previous
report, informed by TRACKER.md priorities, with tiered light/full runs.

## Prerequisites

Open Brain MCP tools must be available: `list_thoughts`, `search_thoughts`,
`thought_stats`, `analyze`, `get_connections`.
Verify before proceeding.

## Arguments

Parse from user message:
- **days**: Time window — **bypasses incremental mode**. Legacy fallback for one-off deep dives. Example: `/discover last 7 days`
- **full**: Force full run regardless of delta. Example: `/discover full`
- **light**: Force light pass regardless of delta. Example: `/discover light`
- **copy**: Extra save location. Example: `/discover copy to ~/Documents`
- **focus**: Narrow to specific topics. Example: `/discover focus on AI agents`
- **--tracker**: Path to tracker file. Example: `/discover --tracker STATUS.md`
- **--no-tracker**: Skip TRACKER sync entirely. Example: `/discover --no-tracker`

`days=N` and incremental mode are mutually exclusive. If `days` is provided,
operate in legacy mode (no state file read, no previous report continuity).
State file is still written on completion so the next run can resume
incremental mode.

## Workflow

### Phase 0: Read State

**Three inputs to read (in parallel where possible):**

1. **State file:** Read `DISCOVERIES_DIR/.discover-state.json` (where
   DISCOVERIES_DIR is the discoveries/ directory in the calling project).
   - If found: extract `last_run`, `last_report`, `thoughts_processed`,
     `run_type`, `tracker_hash`.
   - If not found: this is the first run. Set `mode = "legacy"`,
     `fallback_days = 2`.

2. **Previous report:** If state file has `last_report`, read that file from
   DISCOVERIES_DIR. Extract:
   - YAML frontmatter (cluster names, themes, run_type)
   - Executive summary (for continuity context)
   - Cluster/track names and their EVOLVED/NEW labels
   - Skip if first run.

3. **TRACKER.md:** Unless `--no-tracker` was passed, detect and read the
   tracker file (same detection order as Phase 8):
   a. `TRACKER.md` in project root
   b. `.planning/ROADMAP.md`
   c. `--tracker <path>` argument
   Extract structured context:
   - **Feature items by section** with status. Priority tiers:
     - Active priority: `in-progress`, `partial`, `new`
     - Planned priority: `planned`, `research`
     - Watchlist: `monitor`
     - Matchable: `idea`
     - Ignore: `shipped`, `deferred`
   - **Research threads** with status + "Feeding Into" column
   - **Resolved design questions** (constraints, not investigation targets)
   - Compute tracker hash: `sha256sum TRACKER.md | cut -c1-8`
   - If hash differs from state file's `tracker_hash`, note that
     active priorities may have shifted since last run.

**Determine run mode:**
- If user passed `days=N`: mode = "legacy" (use `days`, skip continuity)
- If user passed `full`: mode = "full" (use `since`, force full)
- If user passed `light`: mode = "light" (use `since`, force light)
- Otherwise: mode = "incremental" (use `since`, determine type from delta)

### Phase 1: Pull

Run all four calls in parallel:

1. `thought_stats` — with `days` param (legacy mode) or no days param
   (incremental mode, we filter by `since` on list_thoughts). Note total count.
2. `list_thoughts`:
   - **Incremental mode:** pass `since` from state file's `last_run`.
     Set `limit` to 200 (safety cap). Set `min_quality` to 0.
   - **Legacy mode:** pass `days` param. Adaptive limit (same as before):
     if total <= 200 set limit to total, else limit 200 with sampling note.
3. `analyze(type="hubs")` — cluster nuclei
4. `analyze(type="density")` — graph health context

**Threshold check (incremental mode only):**
Count the delta (number of thoughts returned by `list_thoughts`).
- If user forced `full` or `light`: use that.
- If delta < 30:
  - Check state file: was previous run also `light`?
  - If yes AND (previous `thoughts_processed` + current delta) >= 30:
    auto-promote to full. Note in report: "Promoted from light due to
    accumulated delta."
  - Otherwise: route to **light pass**.
- If delta >= 30: route to **full run**.
- If delta == 0: report "No new thoughts since last run." Write state
  file (to update timestamp). Exit.

### Phase 2: Parse

Same as before. Run the parse script on the raw JSON:
```bash
python ~/.claude/skills/discover/scripts/parse_thoughts.py <temp-file>
```

If result is inline (not saved to temp file), write to a temp file first.

Produces a scannable summary table. Flag thoughts with `merge_count > 0`
as convergence hotspots.

### Phase 3: Cluster

**Incremental mode (previous report available):**
- For each new thought, compare against previous report's cluster/track
  themes using topic/theme metadata overlap + content similarity (your
  own judgment — no MCP call needed).
- Assign each thought:
  - **EVOLVED**: maps to an existing cluster from previous report
  - **NEW**: doesn't fit any previous cluster
  - **Noise**: low-signal, doesn't cluster with anything
- Group NEW thoughts: if 3+ form a coherent theme, create a new cluster.
  Fewer than 3 go into "Unmatched."
- Check previous clusters that got zero new thoughts: mark **STALE**.
- **TRACKER-weighted ranking:** Clusters aligned with active/partial/new
  TRACKER items rank first. Then planned/research. Then unmatched.
  TRACKER alignment is also a tiebreaker: a thought fitting two clusters
  goes to the one with active TRACKER work.
- Thoughts touching **resolved design questions**: flag as "settled —
  new evidence only." Do not re-investigate unless new evidence directly
  contradicts the decision.

**Legacy mode (no previous report):**
Use `analyze(type="hubs")` results as cluster nuclei (same as original
skill). Build clusters outward from hubs by thematic proximity. Apply
TRACKER ranking if TRACKER was read.

Name each cluster and list its member thoughts.

### Phase 4: Deepen

**Full run:**
Two complementary strategies:

1. **Graph traversal:** For each cluster hub thought, call
   `get_connections(thought_id)`. Follow edges to discover related thoughts
   outside the delta. In incremental mode, focus on connections between
   new clusters and active TRACKER items.

2. **Semantic search:** Run 3-5 `search_thoughts` queries with
   `threshold: 0.5`. Good queries:
   - Bridge terms combining two different clusters
   - Active TRACKER item names/keywords
   - Actionable patterns (tasks, decisions, ideas)

Parse results same as Phase 2. Update clusters.

**Light pass:**
Skip graph traversal entirely. Run 1-2 targeted `search_thoughts` queries
**only** if a NEW cluster with 3+ thoughts emerged. Otherwise skip Phase 4.

### Phase 5: Investigate

**Full run — dispatch one background Agent per non-STALE cluster:**

- **EVOLVED clusters:** Agent receives:
  - Previous report's findings for this cluster (full text)
  - New thoughts in the delta
  - Relevant TRACKER items (name, status, section, notes)
  - Resolved design questions as constraints
  - Brief: "What changed? What's confirmed? What's contradicted?"
  - See `references/agent-prompts.md` "EVOLVED clusters" section.

- **NEW clusters:** Agent receives standard research brief +
  TRACKER items for context. See `references/agent-prompts.md` base template.

- **STALE clusters:** No agent dispatched. One-line note in report.

Key rules:
- All agents run in parallel (`run_in_background: true`)
- Each agent is told "This is research only. Do NOT write code or edit files."
- Each agent gets the user's project context for relevance scoring
- Wait for ALL agents to complete before proceeding

**Light pass — no agent dispatch:**
The skill synthesizes inline. For each EVOLVED cluster, write a 2-3
sentence summary of what the new thoughts add. For NEW clusters (if any),
write a brief assessment. Score relevance using:
1. **TRACKER alignment** — direct match to active item = 7+,
   tangential = 5-6, no match = 3-4
2. **Cluster strength** — thought extending an existing cluster with
   active TRACKER alignment scores higher than isolated thoughts

**Review point (monitor for 2 weeks):** Light-pass relevance scoring is
coarser than agent-validated scores. Watch for false positives and misses.
Adjust threshold and scoring signals if issues emerge.

### Phase 6: Synthesize

Combine all results into a report. Use the appropriate template from
`references/report-template.md` (full run template or light pass template).

**Full run synthesis:**
1. Write executive summary (top 3-5 findings across all tracks)
2. Include each track's findings as a section
3. Identify cross-track connections
4. Write **TRACKER Implications** section:
   - Status change proposals (with evidence links)
   - New items (>= 7/10 relevance, with suggested TRACKER section)
   - Thread updates (parked threads with new evidence)
   - Resolved question alerts (only if contradicting evidence found)
5. Write **Recommended Next Actions** table with `TRACKER Item` column
6. Include YAML frontmatter with incremental fields (`run_type`, `since`,
   `thoughts_delta`, `cluster_continuity`, `previous_report`)

**Light pass synthesis:**
1. Write "What's New" section with per-cluster EVOLVED/NEW summaries
2. Write TRACKER Implications (7+ threshold for edits, 6-7 = "needs validation")
3. Write "Promote to Full?" recommendation
4. Include light pass YAML frontmatter

**Output location:**
- **Primary:** `DISCOVERIES_DIR/YYYY-MM-DD.md`
  - If a report already exists for today: `YYYY-MM-DD-2.md`,
    `YYYY-MM-DD-3.md`, etc.
  - Light passes: `YYYY-MM-DD-light.md` or `YYYY-MM-DD-2-light.md`
- **Extra copy:** If user specified a copy location, copy there too

### Phase 7: Update Index

Update `DISCOVERIES_DIR/DISCOVERY-INDEX.md`.

**New column format (for new entries only — existing rows stay as-is):**

```
| Date | Type | Delta / Total | Clusters | Top Themes | TRACKER Hits | File |
```

- **Type:** `full` or `light`
- **Delta / Total:** `18 new / 2385 total` for incremental.
  `200 of 299 (2d)` for legacy.
- **TRACKER Hits:** count of items proposed for TRACKER update
- Prepend new row (newest first). Keep existing header and instructions.

### Phase 8: Apply to TRACKER

Cross-reference findings against TRACKER and apply updates.

**Skip conditions:**
- No tracker found and no `--tracker` argument -> report-only fallback
- All findings below threshold for the calling project -> note "no
  tracker-relevant findings", skip edits
- User passed `--no-tracker` -> skip entirely

**Threshold by run type:**
- **Full run:** >= 6/10 relevance for TRACKER edits
- **Light run:** >= 7/10 for edits. 6-7 flagged as "needs validation"
  in the report but NOT applied to TRACKER.

**Process:**
1. Read the full tracker file (already done in Phase 0).
2. Map findings to existing items (same as original skill Phase 8).
3. Identify new directions (>= 7/10 that don't match existing items).
4. Write updates — preserve structure, add `[Discovery](discoveries/YYYY-MM-DD.md)`
   links, update timestamp.
5. Summarize in output: what was added, updated, skipped (with reason).

Same rules as original Phase 8: don't restructure, don't remove items,
don't change status unless discovery directly resolves them.

### Phase 9: Write State

**Only on successful completion of all previous phases.**

Write `DISCOVERIES_DIR/.discover-state.json`:

```json
{
  "last_run": "<current ISO timestamp>",
  "last_report": "<filename of report just written>",
  "thoughts_processed": <delta count>,
  "run_type": "<full or light>",
  "tracker_hash": "<first 8 chars of sha256sum of TRACKER.md>"
}
```

Compute tracker hash:
```bash
sha256sum TRACKER.md | cut -c1-8
```

If no TRACKER was read, set `tracker_hash` to `null`.

## Error Handling

- If Open Brain MCP is unavailable, tell user and stop
- If < 10 thoughts in legacy mode time window, suggest expanding the window
- If delta is 0 in incremental mode, report "No new thoughts" and update
  state file timestamp (so next run measures from now)
- If total thoughts exceeds 200, note in report header that results are sampled
- If an agent fails, include what succeeded and note the gap
- If results are too large for context, always use the parse script
- If state file is corrupted or unparseable, warn and fall back to
  `days=2` legacy mode. Do not crash.
- If previous report referenced in state file doesn't exist, warn and
  run without continuity (treat as first incremental run)
