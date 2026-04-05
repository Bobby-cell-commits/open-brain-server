// dream-decay.ts: Automated staleness detection & archival (Dream Cycle Phase D).
// Two-stage: SQL formula scores all thoughts, LLM confirms before archival.
// Tiered: auto-archive (≥0.85), context-aware (0.70-0.85), flag-for-review (0.40-0.70).

import { supabaseAdmin } from "./supabase-client.ts";
import { chatCompletion } from "./openrouter.ts";
import type { DreamDecayResult } from "./types.ts";

const TIER1_MAX = 50;
const TIER2_MAX = 30;
const TIER3_MAX = 20;

interface StaleCandidate {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  source: string;
  created_at: string;
  access_count: number;
  merge_count: number;
  staleness_score: number;
  connection_count: number;
  theme_recent_captures: number;
  top_connections: Array<{
    content: string;
    link_type: string;
    similarity: number;
    salience: number;
    access_count: number;
  }> | null;
  entity_names: string[];
}

interface LlmVerdict {
  verdict: "archive" | "keep";
  confidence: "high" | "medium" | "low";
  reason: string;
}

const STALENESS_JUDGE_PROMPT = `You are a staleness judge for a personal knowledge base about AI, ML, and software engineering.

A thought has been flagged as potentially stale based on age, low access, few connections, and/or declining theme activity. You receive the thought plus context about its connections, theme vitality, and entities.

Evaluate whether this thought is:
1. SUPERSEDED — its information is captured better by connected or similar thoughts
2. OBSOLETE — its claims are outdated or no longer accurate
3. REDUNDANT — it adds nothing beyond what other thoughts in the same theme cover
4. STILL VALUABLE — despite low activity, it contains unique insight worth preserving

Respond with JSON: { "verdict": "archive" or "keep", "confidence": "high" or "medium" or "low", "reason": "one sentence" }`;

function buildContextPacket(c: StaleCandidate): string {
  const ageDays = Math.round(
    (Date.now() - new Date(c.created_at).getTime()) / 86400000,
  );
  const tierLabel =
    c.staleness_score >= 0.85
      ? "Tier 1: auto-archive candidate"
      : c.staleness_score >= 0.7
        ? "Tier 2: context-aware candidate"
        : "Tier 3: flagged for review";

  const lines = [
    `## Candidate Thought`,
    `Content: ${c.content.slice(0, 1500)}`,
    `Type: ${c.metadata.type ?? "unknown"} | Theme: ${c.metadata.theme ?? "unknown"} | Quality: ${c.metadata.quality ?? "unknown"}`,
    `Created: ${c.created_at.slice(0, 10)} (${ageDays} days ago) | Access: ${c.access_count} | Connections: ${c.connection_count}`,
    `Staleness score: ${c.staleness_score.toFixed(2)} (${tierLabel})`,
    `Source: ${c.source} | Merge count: ${c.merge_count}`,
  ];

  if (c.top_connections && c.top_connections.length > 0) {
    lines.push("", `## Connections (${c.connection_count})`);
    for (const conn of c.top_connections.slice(0, 5)) {
      lines.push(
        `- "${conn.content}" [${conn.link_type}] Salience: ${conn.salience?.toFixed(2) ?? "?"} | Access: ${conn.access_count}`,
      );
    }
  }

  lines.push(
    "",
    `## Theme Vitality`,
    `Theme "${c.metadata.theme ?? "unknown"}": ${c.theme_recent_captures} captures in last 30 days`,
  );

  if (c.entity_names.length > 0) {
    lines.push("", `## Entities`, c.entity_names.join(", "));
  }

  return lines.join("\n");
}

async function llmJudge(contextPacket: string): Promise<LlmVerdict | null> {
  try {
    const response = await chatCompletion(
      STALENESS_JUDGE_PROMPT,
      contextPacket,
    );
    const parsed = JSON.parse(response);
    if (
      parsed.verdict !== "archive" && parsed.verdict !== "keep"
    ) {
      return null;
    }
    return {
      verdict: parsed.verdict,
      confidence: parsed.confidence ?? "medium",
      reason: parsed.reason ?? "",
    };
  } catch (err) {
    console.warn("dream-decay: LLM judge failed:", err);
    return null;
  }
}

async function processTier(
  brainId: string,
  tier: "auto" | "context" | "review",
  limit: number,
  result: DreamDecayResult,
): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("get_stale_candidates", {
    p_brain_id: brainId,
    p_tier: tier,
    p_limit: limit,
  });

  if (error) {
    console.error(`dream-decay: get_stale_candidates(${tier}) failed:`, error);
    return;
  }
  if (!data || data.length === 0) return;

  const candidates = data as StaleCandidate[];
  const tierKey = tier === "auto" ? "tier1" : tier === "context" ? "tier2" : "tier3";

  if (tierKey === "tier1") result.tier1_candidates = candidates.length;
  else if (tierKey === "tier2") result.tier2_candidates = candidates.length;
  else result.tier3_flagged = candidates.length;

  for (const candidate of candidates) {
    // Sole-entity protection check (before LLM call to save cost)
    const { data: isProtected } = await supabaseAdmin.rpc(
      "check_sole_entity_protection",
      { p_brain_id: brainId, p_thought_id: candidate.id },
    );
    if (isProtected) {
      result.sole_entity_protected++;
      console.log(
        `dream-decay: skipping ${candidate.id} (sole-entity protection)`,
      );
      continue;
    }

    // Build context and get LLM verdict
    const contextPacket = buildContextPacket(candidate);
    const verdict = await llmJudge(contextPacket);

    if (!verdict) {
      // LLM failed — log as "keep" and skip
      logPruningFireAndForget(brainId, candidate, "keep", tier === "auto" ? "auto" : tier === "context" ? "context_confirmed" : "manual", null, contextPacket);
      continue;
    }

    // Decision logic by tier
    let shouldArchive = false;
    if (tier === "auto") {
      // Tier 1: archive if LLM says archive at any confidence
      shouldArchive = verdict.verdict === "archive";
    } else if (tier === "context") {
      // Tier 2: archive only if LLM says archive with high confidence
      shouldArchive =
        verdict.verdict === "archive" && verdict.confidence === "high";
    }
    // Tier 3: never auto-archive, just log

    const tierLabel = tier === "auto" ? "auto" : tier === "context" ? "context_confirmed" : "manual";

    if (shouldArchive) {
      const { error: archiveErr } = await supabaseAdmin.rpc("archive_thought", {
        p_brain_id: brainId,
        p_thought_id: candidate.id,
      });
      if (archiveErr) {
        console.error(`dream-decay: archive failed for ${candidate.id}:`, archiveErr);
        continue;
      }

      if (tierKey === "tier1") result.tier1_archived++;
      else if (tierKey === "tier2") result.tier2_archived++;

      console.log(
        `dream-decay: archived ${candidate.id} (tier=${tier}, score=${candidate.staleness_score.toFixed(2)}, reason: ${verdict.reason})`,
      );
    } else {
      if (tierKey === "tier1") result.tier1_kept++;
      else if (tierKey === "tier2") result.tier2_kept++;
    }

    // Log decision (fire-and-forget)
    logPruningFireAndForget(
      brainId,
      candidate,
      shouldArchive ? "archive" : "keep",
      tierLabel,
      verdict.reason,
      contextPacket,
    );
  }

  // Count pending reviews from tier 3
  if (tier === "review") {
    result.pending_review = candidates.length;
  }
}

function logPruningFireAndForget(
  brainId: string,
  candidate: StaleCandidate,
  verdict: string,
  tier: string,
  reason: string | null,
  contextPacket: string,
): void {
  Promise.resolve(
    supabaseAdmin.rpc("log_pruning", {
      p_brain_id: brainId,
      p_thought_id: candidate.id,
      p_staleness_score: candidate.staleness_score,
      p_tier: tier,
      p_verdict: verdict,
      p_llm_reason: reason,
      p_context_packet: JSON.stringify({ text: contextPacket }),
    }),
  ).catch((e) => console.warn("dream-decay: audit log failed:", e));
}

export async function dreamDecay(brainId: string): Promise<DreamDecayResult> {
  const result: DreamDecayResult = {
    scored: 0,
    tier1_candidates: 0,
    tier1_archived: 0,
    tier1_kept: 0,
    tier2_candidates: 0,
    tier2_archived: 0,
    tier2_kept: 0,
    tier3_flagged: 0,
    sole_entity_protected: 0,
    pending_review: 0,
  };

  // Step 1: Score all eligible thoughts
  try {
    const { data, error } = await supabaseAdmin.rpc(
      "compute_staleness_scores",
      { p_brain_id: brainId },
    );
    if (error) {
      console.error("dream-decay: compute_staleness_scores failed:", error);
      return result;
    }
    result.scored = data ?? 0;
    console.log(`dream-decay: scored ${result.scored} thoughts`);
  } catch (err) {
    console.error("dream-decay: scoring RPC failed:", err);
    return result;
  }

  if (result.scored === 0) return result;

  // Step 2: Process tiers (highest confidence first)
  await processTier(brainId, "auto", TIER1_MAX, result);
  await processTier(brainId, "context", TIER2_MAX, result);
  await processTier(brainId, "review", TIER3_MAX, result);

  return result;
}
