// dedup_review: Dedup candidates with content previews + zone breakdown.
// Combines analysis_dedup_candidates() + analysis_dedup_zones() in parallel.
// RPC returns up to 50 candidates; limit param truncates client-side.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

export function registerDedupReview(mcp: McpServer, z: Z): void {
  mcp.tool("dedup_review", {
    description:
      "Review potential duplicate thoughts. Shows high-similarity pairs with content previews and a zone breakdown by similarity band (0.85-0.88, 0.88-0.92, 0.92-0.95, 0.95+). Useful for dedup maintenance and threshold tuning.",
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
    }),
    handler: async (args: { limit: number }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        const limit = Math.min(args.limit ?? 20, 50);

        const [candidatesResult, zonesResult] = await Promise.all([
          supabaseAdmin.rpc("analysis_dedup_candidates", { p_brain_id: brainId }),
          supabaseAdmin.rpc("analysis_dedup_zones", { p_brain_id: brainId }),
        ]);

        if (candidatesResult.error) throw candidatesResult.error;
        if (zonesResult.error) throw zonesResult.error;

        const candidates = (candidatesResult.data as unknown[]).slice(
          0,
          limit,
        );

        const result = {
          candidates,
          zones: zonesResult.data,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Dedup review failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
