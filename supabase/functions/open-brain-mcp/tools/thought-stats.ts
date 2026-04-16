// thought_stats: Aggregate statistics from the thoughts table
// Calls the thought_stats SQL RPC for efficient server-side aggregation.
// Optional days param limits stats to the last N days.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

export function registerThoughtStats(mcp: McpServer, z: Z): void {
  mcp.tool("thought_stats", {
    description:
      "Get aggregate statistics: total thoughts, type breakdown, theme breakdown, activity breakdown, top topics, top people. Pass days to limit to last N days.",
    inputSchema: z.object({
      days: z
        .coerce.number()
        .int()
        .positive()
        .optional()
        .describe("Limit stats to last N days (omit for all-time)"),
    }),
    handler: async (args: { days?: number }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        const days = args.days != null ? Math.min(args.days, 365) : null;

        const rpcArgs = { p_brain_id: brainId, days_back: days };
        const { data, error } = await supabaseAdmin.rpc("thought_stats", rpcArgs);

        if (error) throw error;

        // Enrich by_theme with velocity and lifecycle from theme tracking
        const { data: themeStats } = await supabaseAdmin.rpc("get_theme_stats", {
          p_brain_id: brainId,
        });

        if (themeStats && data) {
          const enriched: Record<string, any> = {};
          for (const ts of themeStats as Array<{ name: string; velocity: number; lifecycle_state: string; thought_count: number }>) {
            enriched[ts.name] = {
              count: ts.thought_count,
              velocity: ts.velocity,
              lifecycle: ts.lifecycle_state,
            };
          }
          (data as any).theme_tracking = enriched;
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        return {
          content: [
            { type: "text" as const, text: `Stats failed: ${message}` },
          ],
          isError: true,
        };
      }
    },
  });
}
