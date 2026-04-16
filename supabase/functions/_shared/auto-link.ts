// auto-link.ts: Semantic dedup (pre-insert) and connection storage (post-insert).
// Used by all 3 capture paths: capture-thought, ingest-thought, run-pipeline.

import { supabaseAdmin } from "./supabase-client.ts";
import { chatCompletion as _chatCompletion } from "./openrouter.ts";
import type { ConnectionResult, DedupResult, ConnectionTypingResult } from "./types.ts";

// Mutable deps object — allows tests to stub chatCompletion without violating ESM namespace rules.
export const _deps = {
  chatCompletion: _chatCompletion,
};

// --- Thresholds (tune after 1 week of data) ---
const DEDUP_THRESHOLD = 0.92;
const NEAR_MISS_LOW = 0.85;
const LINK_THRESHOLD = 0.70;
const TYPING_THRESHOLD = 0.80;
const MAX_CONNECTIONS = 3;

const VALID_LINK_TYPES = ["extends", "contradicts", "is-evidence-for", "supersedes", "related"];

// Batch prompt: classifies all connections in one LLM call (saves 0-2 round-trips vs per-connection calls)
const BATCH_CONNECTION_TYPING_PROMPT = `Given a new thought and one or more existing thoughts from a personal knowledge base, classify the relationship between the new thought and EACH existing thought.

For each existing thought, determine:
- "link_type": exactly one of "extends", "contradicts", "is-evidence-for", "supersedes", "related"
  - extends: New thought builds on or develops the existing thought's idea
  - contradicts: New thought challenges or refutes the existing thought
  - is-evidence-for: New thought provides supporting data or examples for the existing thought
  - supersedes: New thought replaces the existing thought (newer version of same idea)
  - related: semantically similar but no clear directional relationship
- "reason": one sentence explaining the relationship

Respond with a JSON array, one object per existing thought, in the SAME ORDER as presented:
[{"link_type": "...", "reason": "..."}, ...]

If there is only one existing thought, still respond with an array of one element.`;

/**
 * checkDedup: Call BEFORE inserting a new thought.
 *
 * Queries match_thoughts at threshold 0.85 to find potential duplicates and near-misses.
 * - >= 0.92: duplicate found. Increments merge_count on original, appends provenance
 *   to metadata.merged_from[], returns { merged: true }.
 * - 0.85-0.91: near-miss. Logs for threshold tuning. Returns { merged: false }.
 * - No matches: returns { merged: false }.
 */
export async function checkDedup(
  brainId: string,
  embedding: number[],
  newSource: string,
  newSourceEventId: string | null,
  newContent: string,
): Promise<DedupResult> {
  try {
    const { data: matches } = await supabaseAdmin.rpc("match_thoughts", {
      p_brain_id: brainId,
      query_embedding: embedding,
      match_threshold: NEAR_MISS_LOW,
      match_count: 5,
    });

    if (!matches || matches.length === 0) {
      return { merged: false };
    }

    // Sort by similarity descending (should already be, but be safe)
    matches.sort((a: { similarity: number }, b: { similarity: number }) =>
      b.similarity - a.similarity
    );

    const top = matches[0];

    // Near-misses: log matches in 0.85-0.91 range for threshold tuning
    for (const m of matches) {
      if (m.similarity >= NEAR_MISS_LOW && m.similarity < DEDUP_THRESHOLD) {
        console.warn("dedup-near-miss", JSON.stringify({
          source: newSource,
          similarity: m.similarity,
          original_id: m.id,
          content_preview: m.content?.slice(0, 80),
        }));
      }
    }

    // Duplicate: similarity >= 0.92
    if (top.similarity >= DEDUP_THRESHOLD) {
      // Build merged_from entry with full content for rollback
      const mergeEntry = {
        source: newSource,
        source_event_id: newSourceEventId,
        similarity: top.similarity,
        content: newContent.slice(0, 2000),
        timestamp: new Date().toISOString(),
      };

      // Atomic merge: increments merge_count and appends to metadata.merged_from in one SQL UPDATE
      await supabaseAdmin.rpc("perform_merge", {
        p_brain_id: brainId,
        p_id: top.id,
        p_merge_entry: mergeEntry,
      });

      // Fire-and-forget: audit log
      Promise.resolve(supabaseAdmin.rpc("log_merge", {
        p_brain_id: brainId,
        p_survivor_id: top.id, p_loser_id: null, p_similarity: top.similarity,
        p_merge_type: "ingest_dedup", p_loser_content: newContent,
        p_loser_source: newSource, p_loser_source_event_id: newSourceEventId,
      })).catch((e) => console.warn("checkDedup: audit log failed:", e));

      return {
        merged: true,
        originalId: top.id,
        originalContentPreview: top.content?.slice(0, 100),
        similarity: top.similarity,
      };
    }

    return { merged: false };
  } catch (err) {
    // Dedup is best-effort — never block capture
    console.error("checkDedup error (proceeding with capture):", err);
    return { merged: false };
  }
}

/**
 * batchClassifyConnections: Classify all connections in a single LLM call.
 * Returns array of ConnectionTypingResult in the same order as input matches.
 * Falls back to all "related" on any error.
 */
async function batchClassifyConnections(
  newContent: string,
  matches: Array<{ id: string; content: string; similarity: number }>,
): Promise<ConnectionTypingResult[]> {
  try {
    const thoughtList = matches
      .map((m, i) => `[Thought ${i + 1}]: ${m.content.slice(0, 500)}`)
      .join("\n\n");

    const userMessage = `New thought: ${newContent.slice(0, 500)}\n\n---\n\nExisting thoughts:\n\n${thoughtList}`;
    const result = await _deps.chatCompletion(BATCH_CONNECTION_TYPING_PROMPT, userMessage);
    const parsed = JSON.parse(result);

    // Handle both array and single-object responses (backward compat with tests)
    const items: any[] = Array.isArray(parsed) ? parsed : [parsed];

    return items.slice(0, matches.length).map((item: any) => ({
      link_type: VALID_LINK_TYPES.includes(item.link_type) ? item.link_type : "related",
      reason: typeof item.reason === "string" ? item.reason : "",
    } as ConnectionTypingResult));
  } catch {
    // Fallback: all "related"
    return matches.map(() => ({ link_type: "related" as const, reason: "" }));
  }
}

/**
 * storeConnections: Call AFTER inserting a new thought.
 *
 * Queries match_thoughts at threshold 0.75 for top 4 results (one will be self),
 * filters out the just-inserted thought, stores top 3 as edges in thought_connections.
 *
 * For connections with similarity >= 0.80, a SINGLE batched LLM call classifies
 * all relationship types (saves 0-2 round-trips vs per-connection calls).
 * Below 0.80, connections default to link_type "related".
 *
 * Best-effort: all errors caught and logged, never blocks the capture.
 */
export async function storeConnections(
  brainId: string,
  newThoughtId: string,
  embedding: number[],
  newContent?: string,
): Promise<ConnectionResult[]> {
  try {
    const { data: matches } = await supabaseAdmin.rpc("match_thoughts", {
      p_brain_id: brainId,
      query_embedding: embedding,
      match_threshold: LINK_THRESHOLD,
      match_count: MAX_CONNECTIONS + 1, // +1 to account for self in results
    });

    if (!matches || matches.length === 0) return [];

    // Filter out self, take top MAX_CONNECTIONS
    const connections = matches
      .filter((m: { id: string }) => m.id !== newThoughtId)
      .slice(0, MAX_CONNECTIONS);

    if (connections.length === 0) return [];

    // Batch classify: one LLM call for ALL connections needing typing (>= 0.80)
    const toType = newContent
      ? connections.filter((m: { similarity: number }) => m.similarity >= TYPING_THRESHOLD)
      : [];

    let typingResults: ConnectionTypingResult[] = [];
    if (toType.length > 0 && newContent) {
      typingResults = await batchClassifyConnections(newContent, toType);
    }

    // Map typing results back to connections
    let typingIdx = 0;
    const rows = connections.map(
      (m: { id: string; similarity: number; content: string }) => {
        let link_type = "related";
        let metadata: Record<string, unknown> = {};

        if (m.similarity >= TYPING_THRESHOLD && newContent && typingIdx < typingResults.length) {
          const typing = typingResults[typingIdx++];
          link_type = typing.link_type;
          if (typing.reason) {
            metadata = { reason: typing.reason };
          }
        }

        return {
          brain_id: brainId,
          source_thought_id: newThoughtId,
          target_thought_id: m.id,
          similarity: m.similarity,
          link_type,
          metadata,
        };
      },
    );

    const { error } = await supabaseAdmin
      .from("thought_connections")
      .insert(rows);

    if (error) {
      console.error("storeConnections insert error:", error);
    }

    return connections.map((m: { id: string; content: string; similarity: number }) => ({
      thought_id: m.id,
      content_preview: m.content?.slice(0, 100),
      similarity: m.similarity,
    }));
  } catch (err) {
    console.error("storeConnections error (non-blocking):", err);
    return [];
  }
}

/**
 * storeEntityBridges: Create entity-based bridge connections for a new thought.
 * Call AFTER resolveEntities has completed (so thought_entities rows exist).
 * Best-effort — errors are logged but never rethrown.
 *
 * Uses Newman's collaboration weighting: w(entity) = 1/(df-1), summed per pair,
 * normalized via 1 - exp(-α * raw). See spec for details.
 */
export async function storeEntityBridges(
  brainId: string,
  newThoughtId: string,
): Promise<void> {
  const ALPHA = 1.0;

  try {
    // Step 1: Get this thought's entities with df counts
    const { data: entities, error: entErr } = await supabaseAdmin.rpc(
      "get_thought_entity_ids",
      { p_brain_id: brainId, p_thought_id: newThoughtId },
    );

    if (entErr || !entities || entities.length === 0) {
      if (entErr) console.error("storeEntityBridges entity lookup error:", entErr.message);
      return;
    }

    // Step 2: Find all overlapping thoughts with pre-computed raw scores
    const { data: overlaps, error: overlapErr } = await supabaseAdmin.rpc(
      "find_entity_overlaps",
      { p_brain_id: brainId, p_thought_id: newThoughtId },
    );

    if (overlapErr || !overlaps || overlaps.length === 0) {
      if (overlapErr) console.error("storeEntityBridges overlap lookup error:", overlapErr.message);
      return;
    }

    // Step 3: Compute bridge rows
    const rows = overlaps.map((o: { thought_id: string; shared_entities: string[]; raw_score: number }) => {
      const similarity = 1 - Math.exp(-ALPHA * o.raw_score);
      const [sourceId, targetId] = [newThoughtId, o.thought_id].sort();
      return {
        source_thought_id: sourceId,
        target_thought_id: targetId,
        similarity,
        link_type: "entity-bridge",
        metadata: { shared_entities: o.shared_entities, alpha: ALPHA },
        brain_id: brainId,
      };
    });

    // Step 4: Batch upsert — ON CONFLICT skip if non-entity-bridge edge exists
    const { error } = await supabaseAdmin
      .from("thought_connections")
      .upsert(rows, {
        onConflict: "source_thought_id,target_thought_id",
        ignoreDuplicates: true,
      });

    if (error) {
      console.error("storeEntityBridges insert error:", error.message);
    }
  } catch (err) {
    console.error("storeEntityBridges error (non-blocking):", err);
  }
}
