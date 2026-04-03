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

## Using These Skills

### With Claude Code

Place skill directories under `.claude/skills/` in your project (project-scoped)
or `~/.claude/skills/` (global). Claude Code discovers them automatically.

```bash
# Project-scoped
cp -r docs/skills/discover .claude/skills/
cp -r docs/skills/pulse .claude/skills/

# Global (available across all projects)
cp -r docs/skills/discover ~/.claude/skills/
cp -r docs/skills/pulse ~/.claude/skills/
```

Then invoke with `/discover` or `/pulse` in Claude Code.

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
