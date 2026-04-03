// dream-dedup.ts: Automated post-pipeline dedup & merge (Dream Cycle Phase A).
// Uses find_dedup_candidates RPC to find high-similarity pairs in one DB call.
// Auto-merges >= 0.95, LLM-confirms 0.92-0.95, skips below 0.92.

import { supabaseAdmin } from "./supabase-client.ts";
import { chatCompletion } from "./openrouter.ts";
import type { DreamDedupResult } from "./types.ts";

const AUTO_MERGE_THRESHOLD = 0.95;
const CONFIRM_THRESHOLD = 0.92;
const DEFAULT_scanDays = 7; // Daily cron — 7-day window for safety margin
const MATCH_COUNT = 5;

const DEDUP_JUDGE_PROMPT = `You are a dedup judge for a personal knowledge base.
Two thoughts have high semantic similarity. Determine if they express
the same core idea/event/claim, or are genuinely distinct thoughts
that happen to be about a similar topic.

Respond with JSON: { "same_idea": true/false, "reason": "one sentence" }`;

interface CandidatePair {
  thoughtA: { id: string; content: string; source: string; source_event_id: string | null; merge_count: number; created_at: string };
  thoughtB: { id: string; content: string; source: string; source_event_id: string | null; merge_count: number; created_at: string };
  similarity: number;
}

type PairMember = CandidatePair["thoughtA"];

function selectSurvivor(
  a: PairMember,
  b: PairMember,
): { survivor: PairMember; loser: PairMember } {
  if (a.merge_count !== b.merge_count) {
    return a.merge_count > b.merge_count
      ? { survivor: a, loser: b }
      : { survivor: b, loser: a };
  }
  // Tiebreaker: older thought survives
  return a.created_at <= b.created_at
    ? { survivor: a, loser: b }
    : { survivor: b, loser: a };
}

async function llmConfirm(contentA: string, contentB: string): Promise<{ same_idea: boolean; reason: string } | null> {
  try {
    const userMessage = `Thought A:\n${contentA.slice(0, 2000)}\n\nThought B:\n${contentB.slice(0, 2000)}`;
    const response = await chatCompletion(DEDUP_JUDGE_PROMPT, userMessage);
    const parsed = JSON.parse(response);
    if (typeof parsed.same_idea !== "boolean") return null;
    return { same_idea: parsed.same_idea, reason: parsed.reason ?? "" };
  } catch (err) {
    console.warn("dream-dedup: LLM confirmation failed:", err);
    return null;
  }
}

async function executeMerge(
  brainId: string,
  survivorId: string,
  loser: { id: string; content: string; source: string; source_event_id: string | null },
  similarity: number,
): Promise<boolean> {
  try {
    const mergeEntry = {
      source: loser.source,
      source_event_id: loser.source_event_id,
      similarity,
      content: loser.content.slice(0, 2000),
      timestamp: new Date().toISOString(),
      dream: true,
    };

    await supabaseAdmin.rpc("perform_merge", {
      p_brain_id: brainId,
      p_id: survivorId,
      p_merge_entry: mergeEntry,
    });

    const { error } = await supabaseAdmin
      .from("thoughts")
      .delete()
      .eq("id", loser.id)
      .eq("brain_id", brainId);

    if (error) {
      console.error(`dream-dedup: delete failed for ${loser.id}:`, error);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`dream-dedup: merge failed for survivor=${survivorId}, loser=${loser.id}:`, err);
    return false;
  }
}

export async function dreamDedup(brainId: string, scanDays = DEFAULT_scanDays): Promise<DreamDedupResult> {
  const result: DreamDedupResult = {
    scanned: 0,
    pairs_found: 0,
    auto_merged: 0,
    llm_confirmed: 0,
    llm_rejected: 0,
    llm_failed: 0,
    deleted: 0,
  };

  // Step 1+2: Find all dedup candidate pairs in one server-side RPC call.
  // This replaces N individual match_thoughts calls with a single database round-trip.
  const pairs: CandidatePair[] = [];
  try {
    const { data, error } = await supabaseAdmin.rpc("find_dedup_candidates", {
      p_brain_id: brainId,
      days_back: scanDays,
      similarity_threshold: CONFIRM_THRESHOLD,
      max_candidates_per_thought: MATCH_COUNT,
    });
    if (error) {
      console.error("dream-dedup: find_dedup_candidates failed:", error);
      return result;
    }
    if (!data || data.length === 0) return result;

    // Count unique recent thoughts (thought_a side) as "scanned"
    const scannedIds = new Set<string>();
    for (const row of data) {
      scannedIds.add(row.thought_a_id);
      pairs.push({
        thoughtA: {
          id: row.thought_a_id,
          content: row.thought_a_content,
          source: row.thought_a_source,
          source_event_id: row.thought_a_source_event_id,
          merge_count: row.thought_a_merge_count ?? 0,
          created_at: row.thought_a_created_at,
        },
        thoughtB: {
          id: row.thought_b_id,
          content: row.thought_b_content,
          source: row.thought_b_source,
          source_event_id: row.thought_b_source_event_id,
          merge_count: row.thought_b_merge_count ?? 0,
          created_at: row.thought_b_created_at,
        },
        similarity: row.pair_similarity,
      });
    }
    result.scanned = scannedIds.size;
  } catch (err) {
    console.error("dream-dedup: RPC call failed:", err);
    return result;
  }

  result.pairs_found = pairs.length;
  if (pairs.length === 0) return result;

  // Sort by similarity descending — process highest-confidence first
  pairs.sort((a, b) => b.similarity - a.similarity);

  // Step 3: Process pairs
  const deletedIds = new Set<string>();

  for (const pair of pairs) {
    // Skip if either thought was already deleted in this run
    if (deletedIds.has(pair.thoughtA.id) || deletedIds.has(pair.thoughtB.id)) continue;

    const { survivor, loser } = selectSurvivor(pair.thoughtA, pair.thoughtB);

    if (pair.similarity >= AUTO_MERGE_THRESHOLD) {
      // Auto-merge: high confidence
      const success = await executeMerge(brainId, survivor.id, loser, pair.similarity);
      if (success) {
        result.auto_merged++;
        result.deleted++;
        deletedIds.add(loser.id);
        // Fire-and-forget: audit log
        Promise.resolve(supabaseAdmin.rpc("log_merge", {
          p_brain_id: brainId,
          p_survivor_id: survivor.id, p_loser_id: loser.id, p_similarity: pair.similarity,
          p_merge_type: "auto", p_loser_content: loser.content,
          p_loser_source: loser.source, p_loser_source_event_id: loser.source_event_id,
        })).catch((e) => console.warn("dream-dedup: audit log failed:", e));
        console.log(`dream-dedup: auto-merged ${loser.id} → ${survivor.id} (similarity: ${pair.similarity.toFixed(3)})`);
      }
    } else {
      // LLM confirmation: borderline zone (0.92 - 0.95)
      const judgment = await llmConfirm(pair.thoughtA.content, pair.thoughtB.content);

      if (judgment === null) {
        result.llm_failed++;
        console.warn(`dream-dedup: LLM failed for pair ${pair.thoughtA.id} ↔ ${pair.thoughtB.id}, skipping`);
        continue;
      }

      if (judgment.same_idea) {
        const success = await executeMerge(brainId, survivor.id, loser, pair.similarity);
        if (success) {
          result.llm_confirmed++;
          result.deleted++;
          deletedIds.add(loser.id);
          // Fire-and-forget: audit log
          Promise.resolve(supabaseAdmin.rpc("log_merge", {
            p_brain_id: brainId,
            p_survivor_id: survivor.id, p_loser_id: loser.id, p_similarity: pair.similarity,
            p_merge_type: "llm_confirmed", p_loser_content: loser.content,
            p_loser_source: loser.source, p_loser_source_event_id: loser.source_event_id,
            p_llm_reason: judgment.reason,
          })).catch((e) => console.warn("dream-dedup: audit log failed:", e));
          console.log(`dream-dedup: LLM-confirmed merge ${loser.id} → ${survivor.id} (similarity: ${pair.similarity.toFixed(3)}, reason: ${judgment.reason})`);
        }
      } else {
        result.llm_rejected++;
        console.log(`dream-dedup: LLM-rejected pair ${pair.thoughtA.id} ↔ ${pair.thoughtB.id} (reason: ${judgment.reason})`);
      }
    }
  }

  return result;
}
