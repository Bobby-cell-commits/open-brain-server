# Agent Prompt Templates

Generate one agent prompt per cluster. Each prompt follows this structure:

## Template

```
You are a research agent investigating [CLUSTER THEME].

**Context:** [USER'S PROJECT CONTEXT — what they build, what stack they use,
what problems they're solving. Pull from CLAUDE.md, Open Brain memories, and
conversation context.]

**Thoughts in this cluster:**
[LIST EACH THOUGHT — content, type, date, source. Include URLs if present.]

**Research tasks:**
1. [SPECIFIC RESEARCH QUESTION derived from the cluster]
2. [SECOND QUESTION — go deeper, not broader]
3. [THIRD QUESTION — assess relevance to user's projects]
4. [FOURTH QUESTION — identify actionable takeaways]

For each research task:
- Search the web for current information (papers, repos, blog posts, docs)
- Fetch key URLs found in the thoughts (GitHub READMEs, blog posts, etc.)
- Assess relevance to the user's known projects (score 0-10 with justification)
- Note reusable patterns, libraries, or approaches

**Output format:** Structured markdown with:
- Per-item findings (what it is, why it matters, verdict)
- Summary table (item | relevance | key takeaway | verdict)
- Top 3 actionable takeaways

IMPORTANT: This is research only. Do NOT write any code or edit any files.
Return your findings as text.
```

## Prompt Adaptation by Cluster Type

### GitHub repos to investigate
- Fetch each repo's README
- Extract: purpose, architecture, tech stack, stars, last updated
- Assess: does it solve a problem the user has?
- Verdict per repo: investigate further / bookmark / skip

### Technology/model landscape
- Research benchmarks, pricing, availability
- Compare against what the user currently uses
- Find independent validation (papers, community reports)
- Assess: should the user evaluate this as a replacement?

### Project ideas/features
- Research prior art and existing implementations
- Evaluate feasibility given user's current stack
- Identify prerequisites and dependencies
- Produce architecture sketch if relevant

### Industry signals/trends
- Find primary sources (not just Reddit summaries)
- Cross-reference claims with data (job market stats, papers)
- Identify coherent narrative vs contradictions
- Assess: what does this mean for the user's work?

### Meta-tool improvements
- Research comparable tools and their approaches
- Extract adoptable patterns
- Rank by effort vs impact
- Identify minimum viable improvement

### Domain research
- Find academic papers and production implementations
- Evaluate approaches against user's constraints
- Produce comparison table
- Recommend specific approach with justification

### EVOLVED clusters (incremental runs)

For clusters that extend themes from a previous discovery report, the agent
receives additional context. The prompt structure changes:

```
You are a research agent investigating [CLUSTER THEME] — an EVOLVED cluster
that builds on findings from the previous discovery report ([DATE]).

**Previous findings for this cluster:**
[PASTE THE PREVIOUS REPORT'S SECTION FOR THIS CLUSTER — full text, not summary.]

**TRACKER context:**
[RELEVANT TRACKER ITEMS — feature name, status, section, notes. Include
"Feeding Into" links from research threads if applicable.]

**Resolved design questions (constraints — do not re-investigate):**
[ANY RESOLVED DESIGN QUESTIONS that touch this cluster's theme. These are
settled decisions. Only flag if new evidence directly contradicts them.]

**New thoughts since last run:**
[LIST EACH NEW THOUGHT — content, type, date, source. Include URLs if present.]

**Research tasks (delta-focused):**
1. What has changed since the previous report's findings? New papers,
   releases, community developments, pricing changes?
2. Do the new thoughts confirm, refine, or contradict previous findings?
3. Are there new implementation approaches or tools relevant to the
   TRACKER items listed above?
4. Should any TRACKER item's status change based on this evidence?

For each research task:
- Search the web for developments SINCE [PREVIOUS REPORT DATE]
- Compare new findings against previous report's conclusions
- Score relevance against specific TRACKER items (0-10 with justification)
- Note what's genuinely new vs confirmation of known information

**Output format:** Structured markdown with:
- Delta summary (what changed since last report)
- Per-item findings (confirming/contradicting/extending previous)
- TRACKER implications table (item | current status | proposed action | evidence)
- Top 3 actionable takeaways (only genuinely new ones)

IMPORTANT: This is research only. Do NOT write any code or edit any files.
Return your findings as text.
```

Key differences from standard briefs:
- Agent is told what was already found — prevents redundant research
- Research tasks are delta-focused ("what changed") not broad ("research this")
- Output includes explicit TRACKER implications table
- Resolved design questions act as constraints — the agent should not propose
  revisiting them unless new evidence is strong enough to warrant it

### Revenue & Opportunities agent

The revenue zone gets a dedicated agent with a different investigation lens.
This agent receives findings from ALL tracks (not just one cluster) and
searches for monetization angles.

```
You are a research agent investigating revenue and business opportunities
across all discovery tracks.

**Context:** [USER'S PROJECT CONTEXT]

**Findings from all tracks:**
[BRIEF SUMMARY OF EACH TRACK'S KEY FINDINGS — 2-3 lines per track]

**Revenue-focused pipeline items (if any):**
[ITEMS FROM REVENUE PIPELINE SOURCES — r/SideProject, r/algotrading, etc.]

**Research tasks:**
1. For each track finding: is there a money-making angle? Product gap,
   service offering, automation play, arbitrage opportunity?
2. Are there unconventional plays? Agent-based market monitoring, automated
   arbitrage, AI-powered service businesses?
3. Who is already making money in adjacent spaces? What are they charging?
4. What's the lowest-effort highest-return opportunity across all findings?

**Output format:** Structured markdown with:
- Per-opportunity assessment (what, who pays, effort, competition)
- Conventional vs unconventional classification
- Top 3 actionable opportunities ranked by effort/return ratio

IMPORTANT: This is research only. Do NOT write any code or edit any files.
Include both conventional (SaaS, API, consulting) and unconventional
(trading, automation, arbitrage) opportunities.
```

### Zone assignment

When dispatching agents, assign each cluster to a zone:

- **Project Radar:** The cluster's theme maps to an active TRACKER item
  (status: in-progress, partial, planned, research). Tell the agent about
  the specific TRACKER items so findings reference them.
- **Off-Radar:** No TRACKER alignment. The agent investigates for general
  interest and potential future relevance.
- **Revenue:** Not a cluster — the revenue agent gets a cross-track brief.
  Dispatched after cluster agents complete.

Agent count per zone follows the tier budget:
- Headline tracks: full agent dispatch
- Watch tracks: no agent, skill synthesizes inline
