// entities.ts: Entity resolution — normalize, match/create, link to thought.
// Called post-insert by all capture paths. Best-effort: errors logged, never blocks.

import { supabaseAdmin } from "./supabase-client.ts";
import type { EntityMention } from "./types.ts";

/**
 * resolveEntities: Resolve extracted entity mentions into the entities table
 * and link them to a thought via thought_entities.
 *
 * Delegates to the resolve_entities RPC which handles:
 * - Name normalization (trim, collapse whitespace)
 * - Exact match on (name, entity_type)
 * - Alias lookup (case-insensitive)
 * - New entity creation if no match
 * - Alias accumulation when raw name differs from canonical
 * - Junction table insert (thought_entities)
 *
 * Best-effort: all errors caught and logged, never blocks capture.
 */
export async function resolveEntities(
  brainId: string,
  entities: EntityMention[],
  thoughtId: string,
): Promise<void> {
  if (!entities || entities.length === 0) return;

  try {
    const { error } = await supabaseAdmin.rpc("resolve_entities", {
      p_brain_id: brainId,
      p_entities: entities,
      p_thought_id: thoughtId,
    });

    if (error) {
      console.error("resolveEntities RPC error (non-blocking):", error.message);
    }
  } catch (err) {
    console.error("resolveEntities error (non-blocking):", err);
  }
}
