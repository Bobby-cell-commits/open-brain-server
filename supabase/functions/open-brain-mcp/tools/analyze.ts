// analyze: Consolidated graph analysis tool.
// Reads from graph_analysis_cache by default (populated daily by refresh-graph-analysis).
// force=true bypasses cache via direct Postgres connection.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

async function readCache(brainId: string, analysisType: string) {
  const { data, error } = await supabaseAdmin
    .from("graph_analysis_cache")
    .select("result, computed_at, duration_ms")
    .eq("brain_id", brainId)
    .eq("analysis_type", analysisType)
    .single();
  if (error || !data) return null;
  return data;
}

async function runLiveAnalysis(brainId: string, type: string): Promise<unknown> {
  const postgres = (await import("npm:postgres@3")).default;
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) throw new Error("SUPABASE_DB_URL not configured");

  const sql = postgres(dbUrl, { prepare: false });
  try {
    switch (type) {
      case "density":
        return await sql`SELECT * FROM analysis_connection_density(${brainId}::uuid)`;
      case "hubs":
        return await sql`SELECT * FROM analysis_rich_thoughts(${brainId}::uuid, 5)`;
      case "source_pairs":
        return await sql`SELECT * FROM analysis_source_pairs(${brainId}::uuid)`;
      default:
        throw new Error(`Unknown analysis type: ${type}`);
    }
  } finally {
    await sql.end();
  }
}

async function upsertCache(brainId: string, type: string, result: unknown, durationMs: number) {
  const { error } = await supabaseAdmin
    .from("graph_analysis_cache")
    .upsert(
      {
        brain_id: brainId,
        analysis_type: type,
        result: JSON.parse(JSON.stringify(result)),
        computed_at: new Date().toISOString(),
        duration_ms: durationMs,
      },
      { onConflict: "brain_id,analysis_type" },
    );
  if (error) console.error(`Cache upsert failed [${type}]: ${error.message}`);
}

export function registerAnalyze(mcp: McpServer, z: Z): void {
  mcp.tool("analyze", {
    description:
      "Analyze the knowledge graph. type=hubs finds high-connectivity thoughts, type=density shows connection stats at similarity thresholds, type=sources shows per-source counts and cross-source overlap, type=co_occurrence shows co-occurrence edge health and session stats, type=themes shows theme lifecycle, velocity, and temporal data. Results are cached daily — use force=true for live computation (co_occurrence and themes are always live).",
    inputSchema: z.object({
      type: z
        .enum(["hubs", "density", "sources", "co_occurrence", "themes"])
        .describe("Which analysis to run: hubs, density, sources, co_occurrence, or themes"),
      min_connections: z
        .coerce.number()
        .int()
        .min(5)
        .optional()
        .default(5)
        .describe(
          "Minimum connection count for hubs mode (default 5, RPC floor is 5). Ignored by other modes.",
        ),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe("Force live computation instead of reading from cache. Slow — may take 1-2 minutes."),
      theme: z
        .string()
        .optional()
        .describe("For type=themes: specific theme name for timeline data. Omit for summary of all themes."),
    }),
    handler: async (args: { type: string; min_connections: number; force: boolean; theme?: string }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        // --- Sources: baseline is always live, source_pairs from cache ---
        if (args.type === "sources") {
          const [baselineResult, cached] = await Promise.all([
            supabaseAdmin.rpc("analysis_baseline", { p_brain_id: brainId }),
            args.force ? null : readCache(brainId, "source_pairs"),
          ]);

          if (baselineResult.error) throw baselineResult.error;

          let crossSourceData: unknown;
          let computedAt: string | null = null;

          // Sources: cold cache falls through to live (baseline is cheap,
          // only cross_source is O(n²) — acceptable for infrequent cold starts)
          if (args.force || !cached) {
            const start = Date.now();
            const liveResult = await runLiveAnalysis(brainId, "source_pairs");
            const durationMs = Date.now() - start;
            crossSourceData = liveResult;
            computedAt = new Date().toISOString();
            await upsertCache(brainId, "source_pairs", liveResult, durationMs);
          } else {
            crossSourceData = cached.result;
            computedAt = cached.computed_at;
          }

          const result = {
            sources: baselineResult.data,
            cross_source: crossSourceData,
            cached_at: computedAt,
          };

          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }

        // --- Co-occurrence: always live (lightweight query, no cache needed) ---
        if (args.type === "co_occurrence") {
          const { data, error } = await supabaseAdmin.rpc("analyze_co_occurrence", {
            p_brain_id: brainId,
          });
          if (error) throw error;
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data) }],
          };
        }

        // --- Themes: always live (trivial query) ---
        if (args.type === "themes") {
          if (args.theme) {
            // Timeline for a specific theme
            const { data, error } = await supabaseAdmin.rpc("get_theme_timeline", {
              p_brain_id: brainId,
              p_theme_name: args.theme,
              p_days: 90,
            });
            if (error) throw error;
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ theme: args.theme, timeline: data }) }],
            };
          } else {
            // Summary of all themes
            const { data, error } = await supabaseAdmin.rpc("get_theme_stats", {
              p_brain_id: brainId,
            });
            if (error) throw error;
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ themes: data }) }],
            };
          }
        }

        // --- Density / Hubs: read from cache or force live ---
        const cacheKey = args.type; // "density" or "hubs"

        if (!args.force) {
          const cached = await readCache(brainId, cacheKey);
          if (cached) {
            let result = cached.result;

            // Apply min_connections filter for hubs
            if (args.type === "hubs" && args.min_connections > 5 && Array.isArray(result)) {
              result = result.filter(
                (r: { strong_matches: number }) => r.strong_matches >= args.min_connections,
              );
            }

            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ data: result, cached_at: cached.computed_at }),
              }],
            };
          }

          // No cache — inform user
          return {
            content: [{
              type: "text" as const,
              text: "No cached analysis available. Run with force=true for live computation, or wait for the daily refresh.",
            }],
            isError: true,
          };
        }

        // Force live computation
        const start = Date.now();
        let data = await runLiveAnalysis(brainId, cacheKey);
        const durationMs = Date.now() - start;

        await upsertCache(brainId, cacheKey, data, durationMs);

        // Apply min_connections filter for hubs
        if (args.type === "hubs" && args.min_connections > 5 && Array.isArray(data)) {
          data = (data as { strong_matches: number }[]).filter(
            (r) => r.strong_matches >= args.min_connections,
          );
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ data, computed_at: new Date().toISOString() }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error
          ? err.message
          : (err as any)?.message ?? JSON.stringify(err);
        return {
          content: [{ type: "text" as const, text: `Analysis failed: ${message}` }],
          isError: true,
        };
      }
    },
  });
}
