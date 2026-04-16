// refresh-graph-analysis: Runs O(n²) analysis RPCs via direct Postgres
// connection (bypasses PostgREST timeout) and caches results.
//
// POST /refresh-graph-analysis
//   Body: { "type": "all" | "density" | "hubs" | "source_pairs" | "dedup_candidates" | "dedup_zones" | "synthesis_candidates" | "entity_bridges" }
//   Auth: x-brain-key header
//
// Called by: GitHub Actions daily at 05:30 UTC, or manually.

import { supabaseAdmin } from "../_shared/supabase-client.ts";
import { errorResponse, corsHeaders } from "../_shared/errors.ts";
import postgres from "npm:postgres@3";

const OWNER_BRAIN_ID = Deno.env.get("OWNER_BRAIN_ID") ??
  "00000000-0000-4000-a000-000000000001";

const ANALYSIS_TYPES = [
  "density",
  "hubs",
  "source_pairs",
  "dedup_candidates",
  "dedup_zones",
  "synthesis_candidates",
  "entity_bridges",
] as const;

type AnalysisType = typeof ANALYSIS_TYPES[number];

interface AnalysisResult {
  type: AnalysisType;
  status: "success" | "error";
  duration_ms: number;
  error?: string;
}

// Map analysis type to RPC call
async function runAnalysis(
  sql: postgres.Sql,
  brainId: string,
  type: AnalysisType,
): Promise<unknown> {
  switch (type) {
    case "density":
      return await sql`SELECT * FROM analysis_connection_density(${brainId}::uuid)`;
    case "hubs":
      return await sql`SELECT * FROM analysis_rich_thoughts(${brainId}::uuid, 5)`;
    case "source_pairs":
      return await sql`SELECT * FROM analysis_source_pairs(${brainId}::uuid)`;
    case "dedup_candidates":
      return await sql`SELECT * FROM analysis_dedup_candidates(${brainId}::uuid)`;
    case "dedup_zones":
      return await sql`SELECT * FROM analysis_dedup_zones(${brainId}::uuid)`;
    case "synthesis_candidates":
      return await sql`SELECT * FROM find_synthesis_candidates(${brainId}::uuid, 3, 12, 0.75, 20)`;
    case "entity_bridges":
      return await sql`SELECT * FROM refresh_entity_bridges(${brainId}::uuid)`;
  }
}

async function upsertCache(
  brainId: string,
  type: AnalysisType,
  result: unknown,
  durationMs: number,
): Promise<void> {
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
  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  // Auth: x-brain-key (MCP/cron callers) or service_role JWT (dashboard/supabase-js)
  const brainKey = req.headers.get("x-brain-key");
  if (brainKey !== Deno.env.get("MCP_ACCESS_KEY")) {
    // Check for service_role JWT in apikey or Authorization header
    const apiKey = req.headers.get("apikey") || "";
    const authHeader = req.headers.get("authorization") || "";
    const token = apiKey || authHeader.replace(/^Bearer\s+/i, "");
    let isServiceRole = false;
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      isServiceRole = payload.role === "service_role";
    } catch { /* not a valid JWT */ }
    if (!isServiceRole) {
      return errorResponse("Unauthorized", 401);
    }
  }

  // Parse requested type (default: all)
  let requestedType: AnalysisType | "all" = "all";
  try {
    const body = await req.json();
    if (body.type && typeof body.type === "string") {
      if (body.type === "all" || ANALYSIS_TYPES.includes(body.type as AnalysisType)) {
        requestedType = body.type as AnalysisType | "all";
      } else {
        return errorResponse(
          `Invalid type: "${body.type}". Valid: all, ${ANALYSIS_TYPES.join(", ")}`,
          400,
        );
      }
    }
  } catch {
    // Empty body — default to "all"
  }

  const typesToRun: AnalysisType[] =
    requestedType === "all" ? [...ANALYSIS_TYPES] : [requestedType];

  // Connect directly to Postgres (bypasses PostgREST timeout)
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) {
    return errorResponse("SUPABASE_DB_URL not configured", 500);
  }

  const sql = postgres(dbUrl, { prepare: false });

  try {
    // Only refresh the owner brain — benchmark/test brains don't need cached analysis
    const brainId = OWNER_BRAIN_ID;
    const brainResults: AnalysisResult[] = [];

    // Run analyses sequentially to avoid overloading DB
    for (const type of typesToRun) {
      const start = Date.now();
      try {
        const data = await runAnalysis(sql, brainId, type);
        const durationMs = Date.now() - start;
        await upsertCache(brainId, type, data, durationMs);
        brainResults.push({ type, status: "success", duration_ms: durationMs });
      } catch (err) {
        const durationMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${brainId}] ${type} failed (${durationMs}ms): ${message}`);
        brainResults.push({ type, status: "error", duration_ms: durationMs, error: message });
      }
    }

    const allResults = [{ brain_id: brainId, results: brainResults }];

    return new Response(JSON.stringify({ results: allResults }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } finally {
    await sql.end();
  }
});
