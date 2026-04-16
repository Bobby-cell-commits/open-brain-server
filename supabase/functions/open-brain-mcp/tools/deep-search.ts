// deep_search: Multi-hop retrieval with graph traversal + LLM gap-filling.
// 5-stage pipeline: search → graph hop → LLM refine → sub-searches → merge.
// Spec: docs/superpowers/specs/2026-04-13-deep-search-design.md

import { generateEmbedding, chatCompletion } from "../../_shared/openrouter.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { CO_OCCURRENCE_WEIGHTS } from "../../_shared/types.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

const TOKEN_BUDGET_CHARS = 32_000; // ~8K tokens

interface DirectResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  fts_rank: number;
  blended_score: number;
  salience: number;
  pinned: boolean;
  merge_count: number;
  source: string;
  created_at: string;
  graph_expanded?: boolean;
}

interface GraphResult {
  thought_id: string;
  content: string;
  metadata: Record<string, unknown>;
  source: string;
  created_at: string;
  hop_depth: number;
  path_score: number;
  salience: number;
}

interface MergedResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  blended_score: number;
  source_stage: "direct" | "graph" | "refined";
  hop_depth: number;
  created_at: string;
  final_score: number;
}

export function registerDeepSearch(mcp: McpServer, z: Z): void {
  mcp.tool("deep_search", {
    description:
      "Multi-hop deep search: combines graph traversal with LLM-generated gap-filling sub-queries to bridge across topics. Use when search_thoughts returns low_confidence, or when bridging across sessions/topics. Slower (~2-3s) but finds connections that direct search misses.",
    inputSchema: z.object({
      query: z.string().describe("Natural language search query"),
      limit: z.coerce.number().optional().default(20).describe("Max results (default 20, max 50)"),
      threshold: z
        .coerce.number()
        .optional()
        .default(0.6)
        .describe("Similarity threshold 0-1 (default 0.6)"),
      min_quality: z
        .coerce.number()
        .optional()
        .default(0.4)
        .describe("Minimum quality score 0-1 (default 0.4). Set to 0 to disable."),
      max_hops: z
        .coerce.number()
        .optional()
        .default(2)
        .describe("Graph traversal depth (default 2, max 3)"),
      source: z
        .string()
        .optional()
        .describe("Filter by source (telegram, mcp, rss, hf_papers, emergent_mind, reddit, dream). Omit for all sources."),
    }),
    handler: async (
      args: { query: string; limit: number; threshold: number; min_quality: number; max_hops: number; source?: string },
      ctx: any,
    ) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) {
          return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };
        }

        if (args.query.length > 2_000) {
          return {
            content: [{ type: "text" as const, text: `Query exceeds maximum length of 2,000 characters (received: ${args.query.length})` }],
            isError: true,
          };
        }

        const limit = Math.min(args.limit ?? 20, 50);
        const maxHops = Math.min(args.max_hops ?? 2, 3);

        // ── Stage 1: Initial hybrid search ──────────────────────────
        const embedding = await generateEmbedding(args.query);

        const { data: rawDirect, error: searchErr } = await supabaseAdmin.rpc("hybrid_search_thoughts", {
          p_brain_id: brainId,
          query_text: args.query,
          query_embedding: embedding,
          match_count: 20,
          match_threshold: args.threshold,
          min_quality: args.min_quality,
          p_source: args.source ?? null,
        });
        if (searchErr) throw searchErr;

        const directResults = (rawDirect ?? []) as DirectResult[];

        if (directResults.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                results: [],
                search_meta: { sub_queries: [], stages: { direct: { count: 0 }, graph: { count: 0, max_hop: 0 }, refined: { count: 0 } }, truncated: false },
                low_confidence: true,
                gap_hint: "No matches found. Consider capturing knowledge about this topic.",
              }),
            }],
          };
        }

        // ── Stage 2: Multi-hop graph traversal ──────────────────────
        const seedIds = directResults.slice(0, 10).map((r) => r.id);

        const { data: rawGraph, error: graphErr } = await supabaseAdmin.rpc("deep_graph_traversal", {
          p_brain_id: brainId,
          p_seed_ids: seedIds,
          p_max_hops: maxHops,
          p_min_similarity: args.threshold,
        });
        if (graphErr) {
          console.warn("deep_graph_traversal failed, continuing without graph results:", graphErr.message);
        }

        const graphResults = (rawGraph ?? []) as GraphResult[];

        // ── Stage 3: LLM gap-filling ────────────────────────────────
        // Build snippets from direct + graph results for the LLM
        const maxDirectBlended = directResults[0]?.blended_score ?? 1;

        const allSoFar: Array<{ content: string; score: number }> = [
          ...directResults.map((r) => ({ content: r.content, score: r.blended_score })),
          ...graphResults.map((r) => ({ content: r.content, score: maxDirectBlended * r.path_score })),
        ];
        allSoFar.sort((a, b) => b.score - a.score);

        const snippets = allSoFar
          .slice(0, 20)
          .map((r) => r.content.slice(0, 150))
          .join("\n---\n");

        let subQueries: string[] = [];

        try {
          const refinementPrompt = `You are a search refinement assistant for a personal knowledge base.

Given a user's original query and the top results found so far, generate 2-3 follow-up search queries that target GAPS — information that would help answer the original query but is NOT covered by the existing results.

Rules:
- Each sub-query should target a different gap
- Be specific and concrete, not vague reformulations
- If the results already cover the query well, return an empty array
- Return JSON: {"sub_queries": ["query1", "query2"]}

Original query: ${args.query}

Top results found so far:
${snippets}`;

          const llmResponse = await chatCompletion(
            refinementPrompt,
            "Generate gap-filling sub-queries.",
            "openai/gpt-4o-mini",
          );
          const parsed = JSON.parse(llmResponse);
          if (Array.isArray(parsed.sub_queries)) {
            subQueries = parsed.sub_queries.filter((s: unknown) => typeof s === "string").slice(0, 3);
          }
        } catch (llmErr) {
          console.warn("LLM gap-fill failed, continuing without refinement:", llmErr);
        }

        // ── Stage 4: Parallel sub-searches ──────────────────────────
        let refinedResults: DirectResult[] = [];

        if (subQueries.length > 0) {
          const subSearchPromises = subQueries.map(async (sq: string) => {
            const sqEmbedding = await generateEmbedding(sq);
            const { data, error } = await supabaseAdmin.rpc("hybrid_search_thoughts", {
              p_brain_id: brainId,
              query_text: sq,
              query_embedding: sqEmbedding,
              match_count: 10,
              match_threshold: args.threshold,
              min_quality: args.min_quality,
              p_source: args.source ?? null,
            });
            if (error) {
              console.warn(`Sub-search failed for "${sq}":`, error.message);
              return [];
            }
            return (data ?? []) as DirectResult[];
          });

          const subResults = await Promise.all(subSearchPromises);
          refinedResults = subResults.flat();
        }

        // ── Stage 5: Deduplicate, rank, truncate ────────────────────
        const merged = new Map<string, MergedResult>();

        // Add direct results
        for (const r of directResults) {
          merged.set(r.id, {
            id: r.id,
            content: r.content,
            metadata: r.metadata,
            similarity: r.similarity,
            blended_score: r.blended_score,
            source_stage: "direct",
            hop_depth: 0,
            created_at: r.created_at,
            final_score: r.blended_score,
          });
        }

        // Add graph results (only if higher score than existing)
        for (const r of graphResults) {
          const finalScore = maxDirectBlended * r.path_score;
          const existing = merged.get(r.thought_id);
          if (!existing || finalScore > existing.final_score) {
            merged.set(r.thought_id, {
              id: r.thought_id,
              content: r.content,
              metadata: r.metadata,
              similarity: 0,
              blended_score: finalScore,
              source_stage: "graph",
              hop_depth: r.hop_depth,
              created_at: r.created_at,
              final_score: finalScore,
            });
          }
        }

        // Add refined results (only if higher score than existing)
        for (const r of refinedResults) {
          const finalScore = r.blended_score * 0.9;
          const existing = merged.get(r.id);
          if (!existing || finalScore > existing.final_score) {
            merged.set(r.id, {
              id: r.id,
              content: r.content,
              metadata: r.metadata,
              similarity: r.similarity,
              blended_score: r.blended_score,
              source_stage: "refined",
              hop_depth: 0,
              created_at: r.created_at,
              final_score: finalScore,
            });
          }
        }

        // Sort by final_score, apply token budget + limit
        const sorted = [...merged.values()].sort((a, b) => b.final_score - a.final_score);

        const results: MergedResult[] = [];
        let charBudget = 0;
        let truncated = false;

        for (const r of sorted) {
          if (results.length >= limit) {
            truncated = true;
            break;
          }
          charBudget += r.content.length;
          if (charBudget > TOKEN_BUDGET_CHARS && results.length > 0) {
            truncated = true;
            break;
          }
          results.push(r);
        }

        // Low confidence detection (direct results only)
        const maxSimilarity = directResults.length > 0
          ? Math.max(...directResults.map((r) => r.similarity ?? 0))
          : 0;
        const hasFtsMatch = directResults.some((r) => (r.fts_rank ?? 0) > 0);
        const lowConfidence = maxSimilarity < 0.75 && !hasFtsMatch;

        // Stage counts
        const graphMaxHop = graphResults.length > 0
          ? Math.max(...graphResults.map((r) => r.hop_depth))
          : 0;

        const stageCountDirect = results.filter((r) => r.source_stage === "direct").length;
        const stageCountGraph = results.filter((r) => r.source_stage === "graph").length;
        const stageCountRefined = results.filter((r) => r.source_stage === "refined").length;

        // ── Side effects (fire-and-forget) ──────────────────────────
        const resultIds = results.map((r) => r.id);
        if (resultIds.length > 0) {
          Promise.resolve(supabaseAdmin.rpc("increment_access_count", {
            p_brain_id: brainId,
            thought_ids: resultIds,
          })).catch(() => {});
        }

        const topIds = resultIds.slice(0, 10);
        const brainContext = (ctx?.authInfo?.extra?.brainContext as string) ?? "manual";
        const contextWeight = CO_OCCURRENCE_WEIGHTS["deep_search"] ?? 1.0;

        Promise.resolve(supabaseAdmin.rpc("log_retrieval_session", {
          p_brain_id: brainId,
          p_tool_name: "deep_search",
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

        // ── Build response ──────────────────────────────────────────
        const response: Record<string, unknown> = {
          results: results.map((r) => ({
            id: r.id,
            content: r.content,
            metadata: r.metadata,
            similarity: r.similarity,
            blended_score: r.blended_score,
            source_stage: r.source_stage,
            hop_depth: r.hop_depth,
            created_at: r.created_at,
          })),
          search_meta: {
            sub_queries: subQueries,
            stages: {
              direct: { count: stageCountDirect },
              graph: { count: stageCountGraph, max_hop: graphMaxHop },
              refined: { count: stageCountRefined },
            },
            truncated,
          },
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
          content: [{ type: "text" as const, text: `Deep search failed: ${message}` }],
          isError: true,
        };
      }
    },
  });
}
