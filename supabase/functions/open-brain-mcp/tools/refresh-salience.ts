// refresh_salience: Recompute salience scores for all thoughts.
// Thin wrapper around the refresh_salience() RPC.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

export function registerRefreshSalience(mcp: McpServer, z: Z): void {
  mcp.tool("refresh_salience", {
    description:
      "Recompute salience scores for all thoughts based on recency, access count, connections, merge count, and source weight",
    inputSchema: z.object({}),
    handler: async (_args: Record<string, never>, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        const { data, error } = await supabaseAdmin.rpc("refresh_salience", { p_brain_id: brainId });
        if (error) throw error;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ updated_count: data }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Refresh salience failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
