// delete_thought: Permanently remove a thought by ID.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

export function registerDeleteThought(mcp: McpServer, z: Z): void {
  mcp.tool("delete_thought", {
    description: "Permanently delete a thought by ID",
    inputSchema: z.object({
      id: z.string().uuid().describe("The UUID of the thought to delete"),
    }),
    handler: async (args: { id: string }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        const { error, count } = await supabaseAdmin
          .from("thoughts")
          .delete({ count: "exact" })
          .eq("id", args.id)
          .eq("brain_id", brainId);

        if (error) throw error;

        if (count === 0) {
          return {
            content: [
              { type: "text" as const, text: `Thought not found: ${args.id}` },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ deleted: true, id: args.id }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Delete failed: ${message}` },
          ],
          isError: true,
        };
      }
    },
  });
}
