import { supabaseAdmin } from "./supabase-client.ts";

export interface InsertThoughtParams {
  brainId: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  source: string;
  sourceEventId: string | null;
}

export interface InsertThoughtResult {
  id: string;
  created_at: string;
}

export async function insertThought(
  params: InsertThoughtParams,
): Promise<InsertThoughtResult> {
  const { data, error } = await supabaseAdmin
    .from("thoughts")
    .insert({
      brain_id: params.brainId,
      content: params.content,
      embedding: JSON.stringify(params.embedding),
      metadata: params.metadata,
      source: params.source,
      source_event_id: params.sourceEventId,
    })
    .select("id, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return { id: "duplicate", created_at: new Date().toISOString() };
    }
    throw error;
  }

  return data as InsertThoughtResult;
}
