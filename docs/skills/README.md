# Open Brain Skills

These are [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill
definitions that showcase advanced AI-driven workflows built on top of Open Brain.

Skills are structured prompts that Claude Code executes as multi-phase workflows.
They call Open Brain's MCP tools, analyze the results, and produce reports or
take actions. Think of them as sophisticated runbooks that an AI assistant follows.

## Included Skills

### /discover — Incremental Discovery

Analyzes recent Open Brain thoughts to find patterns, themes, and actionable
insights. Builds on previous reports incrementally (EVOLVED/NEW/STALE cluster
classification), dispatches parallel research agents for deep dives, and
correlates findings with your project tracker.

**Files:**
- `discover/SKILL.md` — Full 9-phase workflow specification
- `discover/scripts/parse_thoughts.py` — JSON parser for thought results
- `discover/references/agent-prompts.md` — Prompt templates for research agents
- `discover/references/report-template.md` — Report structure guide

**Key features:**
- Incremental mode (only processes new thoughts since last run)
- Light pass / full run routing based on thought delta
- TRACKER.md integration for priority-weighted clustering
- Parallel agent dispatch for cluster-specific research

### /pulse — Pipeline & Data Health Report

Produces a rubric-scored health assessment of your Open Brain system —
pipeline status, capture trends, content mix, graph connectivity, dedup
pressure, and cross-metric pattern detection.

**Files:**
- `pulse/SKILL.md` — Full specification with 7 report sections

**Key features:**
- 9 parallel MCP tool calls for data gathering
- GREEN/YELLOW/RED rubric scoring per section
- Cross-run memory (findings tracked across reports with new/stable/worsened/improved labels)
- BASELINE.md for suppressing known conditions
- 6 cross-metric pattern detectors (volume/quality tradeoff, feed staleness, source redundancy, cluster deepening, graph fragmentation, dedup drift)
- TRACKER.md correlation (distinguishes "addressed by recent work" from "open problem")

### /brain-health — Knowledge Graph Health Report

Rubric-scored assessment of your knowledge graph structure and quality.
Evaluates theme attention balance, graph density, hub health, co-occurrence
alignment, dedup pressure, stale thought queue, synthesis output, entity
landscape, and cross-metric patterns.

**Files:**
- `brain-health/SKILL.md` — Full specification with 10 report sections

**Key features:**
- 12 parallel MCP tool calls for comprehensive data gathering
- GREEN/YELLOW/RED rubric scoring per section
- Cross-run memory (same system as /pulse — findings tracked with new/stable/worsened/improved labels)
- 5 cross-metric pattern detectors (attention narrowing, capture-connection gap, velocity-quality divergence, entity concentration, stale accumulation)
- Serendipity digest integration (resurfaces forgotten high-quality thoughts)

## Using These Skills

### With Claude Code

Skills are included in `.claude/skills/` and are discovered automatically
by Claude Code. Invoke with `/discover`, `/pulse`, or `/brain-health`.

### As Reference

Even without Claude Code, these skill definitions document sophisticated
patterns for building AI workflows on top of a knowledge system:

- How to design incremental analysis that builds on previous runs
- How to structure rubric-based health scoring
- How to implement cross-run memory for persistent findings
- How to correlate system metrics with project context

## Prerequisites

- Open Brain MCP server deployed and accessible
- Claude Code with MCP tools configured
- Optional: `TRACKER.md` in project root (enhances prioritization)
