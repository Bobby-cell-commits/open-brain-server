// dedup_review: Dedup candidates with content previews + zone breakdown.
// Reads from graph_analysis_cache by default (populated daily).
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

async function runLiveDedup(brainId: string, type: "dedup_candidates" | "dedup_zones"): Promise<unknown> {
  const postgres = (await import("npm:postgres@3")).default;
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) throw new Error("SUPABASE_DB_URL not configured");

  const sql = postgres(dbUrl, { prepare: false });
  try {
    if (type === "dedup_candidates") {
      return await sql`SELECT * FROM analysis_dedup_candidates(${brainId}::uuid)`;
    } else {
      return await sql`SELECT * FROM analysis_dedup_zones(${brainId}::uuid)`;
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

export function registerDedupReview(mcp: McpServer, z: Z): void {
  mcp.tool("dedup_review", {
    description:
      "Review potential duplicate thoughts. Shows high-similarity pairs with content previews and a zone breakdown by similarity band (0.85-0.88, 0.88-0.92, 0.92-0.95, 0.95+). Results are cached daily — use force=true for live computation.",
    inputSchema: z.object({
      limit: z
        .coerce.number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe(
          "Max candidates to return (default 20, max 50 — RPC ceiling)",
        ),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe("Force live computation instead of reading from cache. Slow — may take 1-2 minutes."),
    }),
    handler: async (args: { limit: number; force: boolean }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        const limit = Math.min(args.limit ?? 20, 50);

        if (!args.force) {
          // Read from cache
          const [cachedCandidates, cachedZones] = await Promise.all([
            readCache(brainId, "dedup_candidates"),
            readCache(brainId, "dedup_zones"),
          ]);

          if (cachedCandidates && cachedZones) {
            const candidates = Array.isArray(cachedCandidates.result)
              ? cachedCandidates.result.slice(0, limit)
              : cachedCandidates.result;

            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  candidates,
                  zones: cachedZones.result,
                  cached_at: cachedCandidates.computed_at,
                }),
              }],
            };
          }

          // No cache
          return {
            content: [{
              type: "text" as const,
              text: "No cached dedup data available. Run with force=true for live computation, or wait for the daily refresh.",
            }],
            isError: true,
          };
        }

        // Force live computation — run both sequentially to limit DB load
        const startCandidates = Date.now();
        const candidatesData = await runLiveDedup(brainId, "dedup_candidates");
        const candidatesDuration = Date.now() - startCandidates;

        const startZones = Date.now();
        const zonesData = await runLiveDedup(brainId, "dedup_zones");
        const zonesDuration = Date.now() - startZones;

        // Upsert both into cache
        await Promise.all([
          upsertCache(brainId, "dedup_candidates", candidatesData, candidatesDuration),
          upsertCache(brainId, "dedup_zones", zonesData, zonesDuration),
        ]);

        const candidates = Array.isArray(candidatesData)
          ? candidatesData.slice(0, limit)
          : candidatesData;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              candidates,
              zones: zonesData,
              computed_at: new Date().toISOString(),
            }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Dedup review failed: ${message}` }],
          isError: true,
        };
      }
    },
  });
}
