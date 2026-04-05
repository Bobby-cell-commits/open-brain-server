// list_thoughts: Browse thoughts with optional filters
// Supports filtering by type, topic, person, theme, and time window.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

export function registerListThoughts(mcp: McpServer, z: Z): void {
  mcp.tool("list_thoughts", {
    description:
      "List thoughts filtered by type, topic, person, theme, or time window",
    inputSchema: z.object({
      type: z.string().optional().describe("Filter by thought type"),
      source: z.string().optional().describe("Filter by capture source (e.g. telegram, reddit, rss, mcp)"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      theme: z.string().optional().describe("Filter by theme (e.g. ml-research, ai-coding-tools, knowledge-systems)"),
      min_quality: z.coerce.number().optional().default(0.4).describe("Minimum quality score 0-1 (default 0.4). Set to 0 to disable quality gating."),
      since: z.string().optional().describe("ISO timestamp — only thoughts created after this"),
      days: z.coerce.number().optional().describe("Only thoughts from last N days"),
      limit: z
        .coerce.number()
        .optional()
        .default(20)
        .describe("Max results (default 20)"),
    }),
    handler: async (args: {
      type?: string;
      source?: string;
      topic?: string;
      person?: string;
      theme?: string;
      min_quality: number;
      since?: string;
      days?: number;
      limit: number;
    }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        const limit = Math.min(args.limit ?? 20, 100);
        const days = args.days != null ? Math.min(args.days, 365) : undefined;

        let query = supabaseAdmin
          .from("thoughts")
          .select("id, content, metadata, source, created_at, merge_count, salience, pinned, access_count, last_accessed_at")
          .eq("brain_id", brainId)
          .order("salience", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false })
          .limit(limit);

        // Type filter: JSONB text extraction with .filter() for arrow syntax
        if (args.type) {
          query = query.filter("metadata->>type", "eq", args.type);
        }

        // Source filter: direct column equality
        if (args.source) {
          query = query.eq("source", args.source);
        }

        // Topic filter: array containment on JSONB array
        if (args.topic) {
          query = query.contains(
            "metadata->topics" as string,
            JSON.stringify([args.topic]),
          );
        }

        // Person filter: array containment on JSONB array
        if (args.person) {
          query = query.contains(
            "metadata->people" as string,
            JSON.stringify([args.person]),
          );
        }

        // Theme filter: JSONB text extraction
        if (args.theme) {
          query = query.filter("metadata->>theme", "eq", args.theme);
        }

        // Quality filter: intentional sources (telegram, mcp) bypass the gate
        if (args.min_quality !== undefined && args.min_quality > 0) {
          query = query.or(
            `source.in.(telegram,mcp),metadata->>quality.gte.${args.min_quality}`
          );
        }

        // Time window filter: since takes precedence over days
        if (args.since) {
          query = query.gte("created_at", args.since);
          if (days) {
            console.warn("list_thoughts: both 'since' and 'days' provided; using 'since'");
          }
        } else if (days) {
          const since = new Date();
          since.setDate(since.getDate() - days);
          query = query.gte("created_at", since.toISOString());
        }

        const { data, error } = await query;
        if (error) throw error;

        // Fire-and-forget: track access for returned thoughts
        const ids = (data as { id: string }[])?.map((t) => t.id) ?? [];
        if (ids.length > 0) {
          Promise.resolve(supabaseAdmin.rpc("increment_access_count", { p_brain_id: brainId, thought_ids: ids })).catch(() => {});
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `List failed: ${message}` }],
          isError: true,
        };
      }
    },
  });
}
