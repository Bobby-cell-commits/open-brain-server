// list_entities: Browse entities extracted from thoughts.
// Wraps list_entities RPC — returns entities sorted by thought count.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

export function registerListEntities(mcp: McpServer, z: Z): void {
  mcp.tool("list_entities", {
    description:
      "List entities (people, projects, tools, organizations) extracted from thoughts, sorted by frequency. Use to discover what's referenced most across the knowledge base.",
    inputSchema: z.object({
      entity_type: z
        .string()
        .optional()
        .describe("Filter by type: person, project, tool, organization"),
      min_thoughts: z
        .coerce.number()
        .optional()
        .default(1)
        .describe("Minimum thought count to include (default 1)"),
      limit: z
        .coerce.number()
        .optional()
        .default(20)
        .describe("Max results (default 20)"),
    }),
    handler: async (args: {
      entity_type?: string;
      min_thoughts?: number;
      limit?: number;
    }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        const limit = Math.min(args.limit ?? 20, 100);

        const { data, error } = await supabaseAdmin.rpc("list_entities", {
          p_brain_id: brainId,
          p_entity_type: args.entity_type ?? null,
          p_min_thoughts: args.min_thoughts ?? 1,
          p_limit: limit,
        });

        if (error) throw error;

        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Entity list failed: ${message}` },
          ],
          isError: true,
        };
      }
    },
  });
}
