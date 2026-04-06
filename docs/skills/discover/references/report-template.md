# Report Template

Use this structure for the final discovery report. Adapt sections based on
what the clusters actually contain -- not every report needs all sections.

## Frontmatter (required)

Every report MUST start with YAML frontmatter. This enables meta-analysis
across reports without parsing the full document.

```yaml
---
date: YYYY-MM-DD
run_type: full              # "full" or "light"
since: "ISO-timestamp"      # null for legacy/fallback runs
thoughts_delta: N           # new thoughts since last run
thoughts_analyzed: N
thoughts_total: N
clusters: N
cluster_continuity:         # only present for incremental runs
  evolved: N
  new: N
  stale: N
top_themes:
  - Theme Name 1 (EVOLVED)
  - Theme Name 2 (NEW)
previous_report: "YYYY-MM-DD.md"  # null if first run
sources: [emergent_mind, rss, hf_papers, telegram, mcp]
called_from: project-name
focus: null  # or the focus filter if one was used
zones:
  project_radar: [track names]
  off_radar: [track names]
  revenue: "summary line"
weak_signals: N
fresh_recluster: false  # or trigger reason string
lifecycle_changes: []  # e.g., ["Track X: active → declining", "Track Y: emerged"]
---
```

- `run_type`: "full" (agents dispatched) or "light" (inline synthesis)
- `since`: ISO timestamp of the previous run's completion. null for legacy `days=` runs.
- `thoughts_delta`: count of new thoughts pulled via `since`. Equals `thoughts_analyzed` for incremental runs.
- `cluster_continuity`: how clusters relate to the previous report. Omitted for first run or legacy runs.
- `previous_report`: filename of the report this one builds on. null if no state file existed.
- `top_themes`: the 3-5 most prominent cluster names (use short, consistent labels)
- `sources`: which Open Brain source types appeared in the analyzed thoughts
- `called_from`: the project directory name (e.g., `my-project`, `open_brain`)

## Report Body

````markdown
# Open Brain Discovery — YYYY-MM-DD
**Scope:** N new thoughts (N total) | **Since:** ... | **Tracks:** N

---

## Executive Summary

[3-5 bullet points covering the highest-signal findings across all zones.
Each bullet: finding + why it matters + what to do about it.]

---

## Project Radar

Tracks aligned with active TRACKER items. "What you need to know for
what you're building."

### [Track Name] (headline — EVOLVED/NEW)

[Full section from the research agent's findings. Include:]
- Key discoveries with evidence
- Relevance scoring (0-10)
- Verdicts and recommendations

### [Track Name] (watch — EVOLVED)

[2-3 sentence delta summary. Relevance: N/10. What changed since last run.]

---

## Off-Radar

Emergent signals and interests not aligned with current TRACKER work.

### [Track Name] (headline)
[Full section]

### [Track Name] (watch)
[Summary]

---

## Revenue & Opportunities

Monetization angles from all tracks plus revenue-focused pipeline sources.
Conventional and unconventional plays. Each finding includes: what the
opportunity is, who's paying, what's underserved, effort estimate.

---

## Weak Signals

Items scoring 7+ on the weak-signal rubric that don't fit any track.
These are definitionally things that don't fit existing structure.

| Item | Score | Key Dimensions | Source | Brief |
|------|-------|---------------|--------|-------|
| ... | 8/10 | Novel(2), Consensus(2), Cross-domain(2) | r/Python | ... |

---

## Cross-Zone Connections

[Patterns across zones — highest-value insights. Which Project Radar findings
connect to Off-Radar signals? Do Revenue opportunities link to active work?]

---

## TRACKER Implications

[Same structure as before]

---

## Recommended Next Actions

[Same structure as before]
````

## Light Pass Template

Use this template when `run_type` is "light" (< 30 new thoughts, no agents).

### Frontmatter

```yaml
---
date: YYYY-MM-DD
run_type: light
since: "ISO-timestamp"
thoughts_delta: N
thoughts_analyzed: N
thoughts_total: N
clusters_updated: N
clusters_new: N
previous_report: "YYYY-MM-DD.md"
sources: [source1, source2]
called_from: project-name
focus: null
---
```

### Body

```markdown
# Open Brain Discovery -- YYYY-MM-DD (Light)
**Scope:** N new thoughts since HH:MM UTC | **Run type:** Light | **Clusters updated:** N

---

## What's New

### [Cluster Name] (EVOLVED -- N new thoughts)
[2-3 sentence summary of what the new thoughts add. No web research.]
- **TRACKER alignment:** [mapped item + status]. Relevance: N/10.

### [Cluster Name] (EVOLVED -- N new thoughts)
[Summary]
- **TRACKER alignment:** [mapped item]. Relevance: N/10.

### Unmatched (N thoughts)
[Brief note on thoughts that didn't cluster. One-liners.]

---

## TRACKER Implications
[Same structure as full report. Higher threshold: 7+ for edits, 6-7 flagged
as "needs validation" rather than direct TRACKER edits.]

---

## Promote to Full?
[Yes/No recommendation with reasoning. Flag specific clusters or findings
that warrant deeper investigation. If yes, the next run should upgrade
regardless of delta count.]

---

*Light pass -- no research agents dispatched.
Based on [previous report](YYYY-MM-DD.md).*
```

## Guidelines

- Executive summary is the most important section. Write it last.
- Cross-track connections are where the real value is. Don't skip them.
- Keep per-track sections factual. Save interpretation for connections.
- The recommendations table should be actionable -- each row is a decision
  the user can make today.
- Include sources/URLs where agents found key information.
- Use consistent theme names across reports -- check previous reports in the
  discoveries folder for naming precedent before introducing new theme labels.
