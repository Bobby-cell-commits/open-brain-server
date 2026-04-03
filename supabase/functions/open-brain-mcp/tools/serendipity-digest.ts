// serendipity_digest: Surface diverse forgotten/underrepresented thoughts.
// Wraps serendipity_digest() RPC — returns 4 slots: rediscovery, orphan,
// underrepresented theme, and echo of recent capture.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

interface DigestRow {
  slot: string;
  id: string;
  content: string;
  source: string;
  theme: string | null;
  quality: number | null;
  created_at: string;
  reason: string;
}

export function registerSerendipityDigest(mcp: McpServer, z: Z): void {
  mcp.tool("serendipity_digest", {
    description:
      "Get a diverse mix of 4 resurfaced thoughts: a forgotten high-quality gem, an orphan with no connections, a thought from an underrepresented theme, and one that echoes a recent capture. Use for daily inspiration or to find overlooked knowledge.",
    inputSchema: z.object({}),
    handler: async (_args: Record<string, never>, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        const { data, error } = await supabaseAdmin.rpc("serendipity_digest", { p_brain_id: brainId });
        if (error) throw error;

        const rows = data as DigestRow[];

        if (!rows || rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No thoughts available for serendipity digest.",
              },
            ],
          };
        }

        const sections = rows.map((r) => {
          const date = new Date(r.created_at).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
          return [
            `**${r.slot.toUpperCase()}** — ${r.reason}`,
            `[${r.source}] ${date} | theme: ${r.theme ?? "none"} | quality: ${r.quality ?? "?"}`,
            r.content,
            `id: ${r.id}`,
          ].join("\n");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: sections.join("\n\n---\n\n"),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Serendipity digest failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
