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

**Scripts** (in the skill's `scripts/` directory):
- `adaptive_tracks.py` — centroid math, pre-clustering, lifecycle, state I/O
- `weak_signal_score.py` — OpenRouter-based weak-signal scoring
- `parse_thoughts.py` — existing thought parser

**Environment variables** (required for adaptive tracking):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — for embedding fetch
- `BRAIN_ID` — the brain UUID (read from MCP auth context or .env)
- `OPENROUTER_API_KEY` — for weak-signal scoring

Load these from the project's `pipeline/.env` and `openbrain/.env.local`
before calling scripts:
```bash
source pipeline/.env 2>/dev/null; source openbrain/.env.local 2>/dev/null
```

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

**Four inputs to read (in parallel where possible):**

1. **State file:** Read `DISCOVERIES_DIR/.discover-state.json`.
   - If found: extract all fields. If it contains `tracks` array with
     `centroid_b64` fields, this is the enhanced format — adaptive
     tracking is active.
   - If found but only has legacy fields (`last_run`, `last_report`,
     `thoughts_processed`, `run_type`, `tracker_hash`): this is a
     legacy state file. Adaptive tracking will bootstrap on this run.
   - If not found: first run.

2. **Previous report:** If state file has `last_report`, read that file from
   DISCOVERIES_DIR. Extract:
   - YAML frontmatter (cluster names, themes, run_type)
   - Executive summary (for continuity context)
   - Cluster/track names and their EVOLVED/NEW labels
   - Skip if first run.

3. **TRACKER.md:** Unless `--no-tracker` was passed, detect and read the
   tracker file (same detection order as Phase 9):
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

4. **Track portfolio:** If enhanced state exists, extract:
   - Active tracks with lifecycle states and zones
   - Track names and descriptions for weak-signal scoring context
   - Velocity history for tier assignment

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

### Phase 2: Pre-Clustering Pass (Adaptive Tracking)

**Skip if:** First run (no centroids in state) OR legacy mode (`days=N`).
In these cases, fall through to Phase 3 (Parse) and Phase 4 (Cluster) as
before. After clustering, run bootstrap to create initial centroids.

**Run the pre-clustering script:**

```bash
# Save thought IDs to temp file
python3 -c "import json; thoughts=json.load(open('/tmp/discover-thoughts.json')); print(json.dumps([t['id'] for t in thoughts if 'id' in t]))" > /tmp/thought-ids.json

# Pre-cluster against existing track centroids
python3 SCRIPTS_DIR/adaptive_tracks.py pre-cluster \
  --state DISCOVERIES_DIR/.discover-state.json \
  --thoughts /tmp/discover-thoughts.json \
  > /tmp/pre-cluster-results.json
```

Read the results: `assigned`, `ambiguous`, `novel` buckets with counts.

**Check re-clustering triggers:**
```bash
python3 SCRIPTS_DIR/adaptive_tracks.py check-triggers \
  --state DISCOVERIES_DIR/.discover-state.json \
  --assignments /tmp/pre-cluster-results.json
```

If triggered: note the reason. Phase 4 will do a fresh re-cluster instead
of incremental mapping. Report the trigger in the output.

**Threshold check (same as before):**
Count total delta. Route to full/light based on delta count and user flags.
The pre-clustering results inform Phase 4 but don't change the full/light
decision.

### Phase 2.5: Weak-Signal Scoring

**Skip if:** First run OR legacy mode OR light pass.

Prepare inputs for the scoring script:

1. Collect ambiguous + novel items from pre-clustering results
2. For each item, attach:
   - `best_similarity` (from pre-clustering)
   - `track_recent_count` (from state file — velocity of nearest track)
   - `content` (from the thought data)
   - `source` (from thought metadata)
3. Prepare track descriptions (names + one-line descriptions from state)
4. Prepare consensus positions (from TRACKER resolved design questions)

Write inputs to temp files and run:

```bash
python3 SCRIPTS_DIR/weak_signal_score.py \
  --items /tmp/scoring-items.json \
  --tracks /tmp/track-descriptions.json \
  --consensus /tmp/consensus.json \
  --out /tmp/weak-signal-scores.json
```

Read results. Items scoring 7+ are flagged as weak signals. Pass flags
to Phase 4 (Cluster) so they get explicit attention.

### Phase 3: Parse

Same as before. Run the parse script on the raw JSON:
```bash
python ~/.claude/skills/discover/scripts/parse_thoughts.py <temp-file>
```

If result is inline (not saved to temp file), write to a temp file first.

Produces a scannable summary table. Flag thoughts with `merge_count > 0`
as convergence hotspots.

### Phase 4: Cluster

**If adaptive tracking is active (centroids exist, no re-cluster trigger):**

Use the pre-clustering results as structured input:
- **Assigned items** are pre-mapped to tracks. Confirm or override the
  assignment based on content (the math is a guide, not final).
- **Ambiguous items** need LLM judgment — assign to the best-fit track
  or create a new cluster if they don't fit.
- **Novel items** are candidates for new tracks. If 3+ novel items form
  a coherent theme, create a new track (lifecycle: emerging).
- **Weak signals** (score 7+) get explicit mention regardless of which
  track they're assigned to.

Assign each track to a zone:
- **project_radar:** Track theme maps to active TRACKER item
- **off_radar:** No TRACKER alignment

Assign tiers based on velocity + relevance:
- **headline:** High velocity OR high relevance (6+/10) — max 5 total
- **watch:** Low velocity AND moderate relevance — max 4 total

**If fresh re-cluster triggered:**

Ignore existing track assignments. Cluster all thoughts from the last
2 weeks from scratch (same as first-run behavior). Then reconcile:
- Map fresh clusters to existing tracks by thematic overlap
- Shadow track matches existing → keep existing, note as EVOLVED
- Shadow track has no match → new track, note as EMERGED
- Existing track has no shadow match → demote or retire

Report reconciliation decisions in the output.

**If first run (no centroids) OR legacy mode:**

Cluster as before (current behavior). After clustering, bootstrap
centroids:

```bash
# Write cluster assignments as JSON: [{name, thought_ids: [...]}, ...]
# Then bootstrap:
python3 SCRIPTS_DIR/adaptive_tracks.py bootstrap \
  --state DISCOVERIES_DIR/.discover-state.json \
  --clusters /tmp/cluster-assignments.json \
  --thoughts /tmp/discover-thoughts.json
```

### Phase 5: Deepen

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

   **Bridge query escalation:** For bridge queries specifically (the ones
   combining two clusters), check `low_confidence` in the response:
   - If `low_confidence=true` AND results >= 1: re-run the same query via
     `deep_search(query, threshold=0.5)` — multi-hop graph traversal now
     crosses clusters via entity bridges.
   - If `low_confidence=true` AND results = 0: decompose the bridge into
     two single-topic `search_thoughts` queries (one per cluster) instead.
   - If `low_confidence=false`: keep the results as-is, no escalation needed.

   This adds ~2-3s per escalated query. Expect 1-2 escalations per full run
   (bridge queries are inherently cross-cluster, so low_confidence is common).
   Non-bridge queries (TRACKER items, actionable patterns) should NOT escalate.

Parse results same as Phase 3. Update clusters.

**Light pass:**
Skip graph traversal entirely. Run 1-2 targeted `search_thoughts` queries
**only** if a NEW cluster with 3+ thoughts emerged. Otherwise skip Phase 5.

### Phase 5.5: Track Lifecycle Update

After clustering and investigation, update track lifecycle states:

```bash
python3 SCRIPTS_DIR/adaptive_tracks.py update-lifecycle \
  --state DISCOVERIES_DIR/.discover-state.json \
  --assignments /tmp/pre-cluster-results.json
```

Read the output summary. Note any lifecycle transitions for the report:
- Tracks that moved to `declining` or `retired`
- Tracks that moved to `active` from `emerging`
- Any merge/split candidates detected

Include lifecycle changes in the report frontmatter.

### Phase 6: Investigate

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

### Phase 7: Synthesize

Use the three-zone report template from `references/report-template.md`:

**Zone 1 — Project Radar:** Write sections for tracks in the
`project_radar` zone. Headline tracks get full sections from agent
findings. Watch tracks get 2-3 sentence inline summaries.

**Zone 2 — Off-Radar:** Same treatment for tracks in the `off_radar` zone.

**Zone 3 — Revenue & Opportunities:** Write the revenue agent's findings
as a dedicated section. If no revenue agent was dispatched (no revenue
pipeline sources yet), synthesize any monetization angles from the other
tracks inline.

**Weak Signals:** List items scoring 7+ in a table with scores,
key dimensions, source, and a brief description.

Include in YAML frontmatter:
- `zones` with track assignments per zone
- `weak_signals` count
- `fresh_recluster` (false or trigger reason)
- `lifecycle_changes` array

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

### Phase 8: Update Index

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

### Phase 9: Apply to TRACKER

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

### Phase 10: Write State

**Only on successful completion of all previous phases.**

If adaptive tracking is active, the state file was already updated by
the lifecycle script. Add/update the run metadata fields:

```json
{
  "tracks": [],        
  "novelty_buffer": [],
  "last_fresh_recluster": "ISO timestamp",
  "last_run": "ISO timestamp",
  "last_report": "filename.md",
  "thoughts_processed": 0,
  "run_type": "full or light",
  "tracker_hash": "first 8 chars of sha256"
}
```

- `tracks` — managed by `adaptive_tracks.py` (centroids, lifecycle, velocity)
- `novelty_buffer` — items from novel bucket for recurrence check
- `last_fresh_recluster` — timestamp of last full re-cluster (null if never)

Write the novelty buffer: any novel items that didn't form new clusters
are saved for recurrence checking on the next run. If the same item's
theme appears again next run, it's a weak signal, not noise.

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
