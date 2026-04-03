// analyze: Consolidated graph analysis tool.
// Replaces analysis_hubs, analysis_density, analysis_sources.
// Dispatches to the same RPCs via a required `type` enum param.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

export function registerAnalyze(mcp: McpServer, z: Z): void {
  mcp.tool("analyze", {
    description:
      "Analyze the knowledge graph. type=hubs finds high-connectivity thoughts, type=density shows connection stats at similarity thresholds, type=sources shows per-source counts and cross-source overlap.",
    inputSchema: z.object({
      type: z
        .enum(["hubs", "density", "sources"])
        .describe("Which analysis to run: hubs, density, or sources"),
      min_connections: z
        .coerce.number()
        .int()
        .min(5)
        .optional()
        .default(5)
        .describe(
          "Minimum connection count for hubs mode (default 5, RPC floor is 5). Ignored by other modes.",
        ),
    }),
    handler: async (args: { type: string; min_connections: number }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        switch (args.type) {
          case "hubs": {
            const { data, error } = await supabaseAdmin.rpc(
              "analysis_rich_thoughts",
              { p_brain_id: brainId },
            );
            if (error) throw error;

            const filtered =
              args.min_connections > 5
                ? (data as { id: string; source: string; strong_matches: number; preview: string }[])
                    .filter((r) => r.strong_matches >= args.min_connections)
                : data;

            return {
              content: [
                { type: "text" as const, text: JSON.stringify(filtered) },
              ],
            };
          }

          case "density": {
            const { data, error } = await supabaseAdmin.rpc(
              "analysis_connection_density",
              { p_brain_id: brainId },
            );
            if (error) throw error;

            return {
              content: [{ type: "text" as const, text: JSON.stringify(data) }],
            };
          }

          case "sources": {
            const [baselineResult, pairsResult] = await Promise.all([
              supabaseAdmin.rpc("analysis_baseline", { p_brain_id: brainId }),
              supabaseAdmin.rpc("analysis_source_pairs", { p_brain_id: brainId }),
            ]);

            if (baselineResult.error) throw baselineResult.error;
            if (pairsResult.error) throw pairsResult.error;

            const result = {
              sources: baselineResult.data,
              cross_source: pairsResult.data,
            };

            return {
              content: [
                { type: "text" as const, text: JSON.stringify(result) },
              ],
            };
          }

          default:
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown analyze type: ${args.type}`,
                },
              ],
              isError: true,
            };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Analysis failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
