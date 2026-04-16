// search_thoughts: Hybrid search (vector + keyword via RRF) over stored thoughts.
// Optionally expands results via 1-hop connection graph traversal.
// Includes knowledge gap detection (low_confidence flag).

import { generateEmbedding } from "../../_shared/openrouter.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { CO_OCCURRENCE_WEIGHTS } from "../../_shared/types.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

export function registerSearchThoughts(mcp: McpServer, z: Z): void {
  mcp.tool("search_thoughts", {
    description:
      "Search thoughts by semantic similarity and keyword matching (hybrid search). Set expand=true to include graph-adjacent thoughts via 1-hop connection traversal. Returns {results, low_confidence} — low_confidence=true means no strong matches exist.",
    inputSchema: z.object({
      query: z.string().describe("Natural language search query"),
      limit: z.coerce.number().optional().default(10).describe("Max results (default 10)"),
      threshold: z
        .coerce.number()
        .optional()
        .default(0.7)
        .describe("Similarity threshold 0-1 (default 0.7)"),
      expand: z
        .boolean()
        .optional()
        .default(false)
        .describe("Expand results via 1-hop connection graph (default false)"),
      min_quality: z
        .coerce.number()
        .optional()
        .default(0.4)
        .describe("Minimum quality score 0-1 (default 0.4). Set to 0 to disable quality gating."),
      source: z
        .string()
        .optional()
        .describe("Filter by source (telegram, mcp, rss, hf_papers, emergent_mind, reddit, dream). Omit for all sources."),
    }),
    handler: async (args: { query: string; limit: number; threshold: number; expand: boolean; min_quality: number; source?: string }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        if (args.query.length > 2_000) {
          return { content: [{ type: "text" as const, text: `Query exceeds maximum length of 2,000 characters (received: ${args.query.length})` }], isError: true };
        }

        const limit = Math.min(args.limit ?? 10, 100);

        const embedding = await generateEmbedding(args.query);

        const rpcName = args.expand
          ? "graph_expanded_search"
          : "hybrid_search_thoughts";

        const { data, error } = await supabaseAdmin.rpc(rpcName, {
          p_brain_id: brainId,
          query_text: args.query,
          query_embedding: embedding,
          match_count: limit,
          match_threshold: args.threshold,
          min_quality: args.min_quality,
          p_source: args.source ?? null,
        });

        if (error) throw error;

        // Results already ranked by blended_score (RRF × salience) in SQL
        const results = data as any[];

        // Knowledge gap detection: flag when no strong matches exist
        // Only check direct results (not graph-expanded) for the confidence signal
        const directResults = results.filter((r: any) => !r.graph_expanded);
        const maxSimilarity = directResults.length > 0
          ? Math.max(...directResults.map((r: any) => r.similarity ?? 0))
          : 0;
        const hasFtsMatch = directResults.some((r: any) => (r.fts_rank ?? 0) > 0);
        const lowConfidence = results.length === 0 || (maxSimilarity < 0.75 && !hasFtsMatch);

        // Fire-and-forget: track access for returned thoughts
        const ids = results.map((r: any) => r.id);
        if (ids.length > 0) {
          Promise.resolve(supabaseAdmin.rpc("increment_access_count", { p_brain_id: brainId, thought_ids: ids })).catch(() => {});
        }

        // Fire-and-forget: log retrieval session + update co-occurrence edges
        const topIds = ids.slice(0, 10);
        const brainContext = (ctx?.authInfo?.extra?.brainContext as string) ?? "manual";
        const contextWeight = CO_OCCURRENCE_WEIGHTS["search_thoughts"] ?? 1.0;

        Promise.resolve(supabaseAdmin.rpc("log_retrieval_session", {
          p_brain_id: brainId,
          p_tool_name: "search_thoughts",
          p_context: brainContext,
          p_query_text: args.query,
          p_thought_ids: topIds,
        })).catch(() => {});

        if (topIds.length >= 2) {
          Promise.resolve(supabaseAdmin.rpc("update_co_occurrence", {
            p_brain_id: brainId,
            p_thought_ids: topIds,
            p_context_weight: contextWeight,
          })).catch(() => {});
        }

        const response: Record<string, unknown> = {
          results,
          low_confidence: lowConfidence,
        };
        if (lowConfidence) {
          response.gap_hint = "No strong matches found. Consider capturing knowledge about this topic.";
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Search failed: ${message}` }],
          isError: true,
        };
      }
    },
  });
}
