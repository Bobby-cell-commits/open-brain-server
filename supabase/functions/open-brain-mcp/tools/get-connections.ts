// get_connections: Graph traversal for a thought's pre-computed connections.
// Wraps get_thought_connections(p_thought_id) RPC — bidirectional lookup.
// Returns connected thoughts with similarity scores, link types, and typing reasons.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

export function registerGetConnections(mcp: McpServer, z: Z): void {
  mcp.tool("get_connections", {
    description:
      "Get pre-computed connections for a thought (bidirectional graph traversal). Returns connected thoughts with similarity scores, relationship types, and reasoning.",
    inputSchema: z.object({
      thought_id: z
        .string()
        .uuid()
        .describe("The thought UUID to find connections for"),
    }),
    handler: async (args: { thought_id: string }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        const { data, error } = await supabaseAdmin.rpc(
          "get_thought_connections",
          { p_brain_id: brainId, p_thought_id: args.thought_id },
        );
        if (error) throw error;

        // Flatten connection_metadata into top-level fields for readability
        const enriched = (data as any[]).map((c) => ({
          connected_thought_id: c.connected_thought_id,
          content: c.content,
          similarity: c.similarity,
          link_type: c.link_type,
          reason: c.connection_metadata?.reason ?? null,
          created_at: c.created_at,
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(enriched) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Connection lookup failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
