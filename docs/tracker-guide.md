# Project Tracker Guide

A project tracker is a single-authority file that records what's built, what's
planned, and what's been decided. Open Brain's AI skills (like `/discover` and
`/pulse`) read this file to prioritize findings and correlate system health
with shipped work.

## Why a Tracker?

Your Open Brain instance captures ideas, articles, and research as thoughts.
The tracker is the complement: it records your **intent** — what you're building,
what matters, and what's settled. Together they form a feedback loop:

- **Thoughts** = raw knowledge (what you've read, captured, explored)
- **Tracker** = system intent (what you're building, why, what's next)
- **Skills** = the bridge (analyze thoughts through the lens of your priorities)

When `/discover` runs, it clusters your recent thoughts and ranks them against
your tracker's active items. A thought about embeddings ranks higher if your
tracker shows an active embedding upgrade feature. When `/pulse` runs, it
checks whether a health finding (e.g., high orphan ratio) was already addressed
by a recently shipped feature.

Without a tracker, skills still work — but they can't prioritize by project
relevance or distinguish "known issue" from "new problem."

## Structure

Create a `TRACKER.md` in your project root. The structure below is a starting
point — adapt sections to your needs.

### Starter Template

```markdown
# Project Tracker
> Last updated: YYYY-MM-DD | Status: [one-line summary]

## What's Built

[Architecture overview — 2-3 sentences describing your system]

### Shipped Milestones

| Date | What | Components |
|------|------|------------|
| YYYY-MM-DD | Feature name | What was built |

### Pipeline Sources

| Source | Runtime | Schedule |
|--------|---------|----------|
| Source A | Python / Edge Function | Manual / Cron |

## Feature Status

### [Subsystem Name]
| Feature | Status | Notes |
|---------|--------|-------|
| Feature A | shipped | — |
| Feature B | in-progress | Details |
| Feature C | planned | Depends on B |

## Active Research Threads

| Thread | Status | Feeding Into |
|--------|--------|-------------|
| Topic X | active | Feature C |
| Topic Y | parked | — |

## Resolved Design Questions

| Question | Decision | Evidence |
|----------|----------|----------|
| Should we do X? | Yes, because... | Link or reasoning |

## Deferred / Out of Scope

- Thing A — reason it's deferred
- Thing B — why it's out of scope

## Tech Debt

- [ ] Non-blocking issue 1
- [ ] Non-blocking issue 2
```

## Status Taxonomy

Use consistent status labels across features and threads:

| Status | Meaning |
|--------|---------|
| `idea` | Captured but not yet evaluated |
| `research` | Actively investigating approach |
| `planned` | Approach decided, not yet started |
| `in-progress` | Currently being built |
| `shipped` | Done and deployed |
| `parked` | Deprioritized, may revisit |
| `deferred` | Intentionally postponed |

## How Skills Use It

### /discover
- Reads feature items by status to rank thought clusters
- Active/in-progress items get priority; shipped/deferred are ignored
- Research threads inform which clusters warrant deeper investigation
- Resolved design questions act as constraints (don't re-investigate settled decisions)
- Proposes tracker updates when findings warrant status changes

### /pulse
- Reads shipped milestones from the last 14 days
- Correlates health findings with recent work (distinguishes "addressed by
  recent ship" from "open problem")
- Won't change rubric scores — it changes the **interpretation** of scores

### /tracker-health
- Audits the tracker itself for structural issues (bloat, stale items, zombie
  rows, shipped items clogging active sections)

## Update Convention

- Update when feature status changes, not on a schedule
- Add `[Discovery](discoveries/YYYY-MM-DD.md)` links when skills find relevant evidence
- Keep shipped items in the milestones table but move them out of active feature sections
- Prefer short notes over long descriptions — details belong in linked docs
