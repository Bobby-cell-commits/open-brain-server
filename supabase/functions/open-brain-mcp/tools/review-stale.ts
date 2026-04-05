// review_stale: MCP tool #16 for reviewing flagged stale thoughts.
// Lists pending tier 3 candidates, or approves/rejects individual thoughts.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

export function registerReviewStale(mcp: McpServer, z: Z): void {
  mcp.tool("review_stale", {
    description:
      "Review stale thought candidates. action='list' shows pending flagged thoughts. action='approve' archives a thought. action='reject' keeps a thought and excludes from scoring for 30 days.",
    inputSchema: z.object({
      action: z
        .enum(["list", "approve", "reject"])
        .default("list")
        .describe("list=show pending, approve=archive, reject=keep+exclude 30d"),
      thought_id: z
        .string()
        .uuid()
        .optional()
        .describe("Required for approve/reject"),
    }),
    handler: async (
      args: { action: string; thought_id?: string },
      ctx: any,
    ) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) {
          return {
            content: [{ type: "text" as const, text: "Error: missing brain context" }],
            isError: true,
          };
        }

        if (args.action === "list") {
          // Fetch tier 3 (review) candidates + any tier 2 that were kept
          const { data, error } = await supabaseAdmin.rpc(
            "get_stale_candidates",
            { p_brain_id: brainId, p_tier: "review", p_limit: 20 },
          );
          if (error) throw error;

          if (!data || data.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ pending: 0, message: "No thoughts pending review." }),
              }],
            };
          }

          const summary = data.map((c: any) => ({
            id: c.id,
            content_preview: c.content?.slice(0, 200),
            staleness_score: c.staleness_score,
            theme: c.metadata?.theme,
            quality: c.metadata?.quality,
            access_count: c.access_count,
            connections: c.connection_count,
            entities: c.entity_names,
            age_days: Math.round(
              (Date.now() - new Date(c.created_at).getTime()) / 86400000,
            ),
          }));

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ pending: summary.length, candidates: summary }),
            }],
          };
        }

        // approve or reject
        if (!args.thought_id) {
          return {
            content: [{ type: "text" as const, text: "Error: thought_id required for approve/reject" }],
            isError: true,
          };
        }

        if (args.action === "approve") {
          const { error: archiveErr } = await supabaseAdmin.rpc(
            "archive_thought",
            { p_brain_id: brainId, p_thought_id: args.thought_id },
          );
          if (archiveErr) throw archiveErr;

          // Log to pruning_log
          await supabaseAdmin.rpc("log_pruning", {
            p_brain_id: brainId,
            p_thought_id: args.thought_id,
            p_staleness_score: 0, // not re-fetched, acceptable for manual
            p_tier: "manual",
            p_verdict: "archive",
            p_llm_reason: "Manually approved via review_stale",
          });

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ archived: true, thought_id: args.thought_id }),
            }],
          };
        }

        if (args.action === "reject") {
          // Exclude from scoring for 30 days
          const { error: updateErr } = await supabaseAdmin
            .from("thoughts")
            .update({
              staleness_scored_at: new Date(
                Date.now() + 30 * 86400000,
              ).toISOString(),
              staleness_score: null,
            })
            .eq("id", args.thought_id)
            .eq("brain_id", brainId);
          if (updateErr) throw updateErr;

          await supabaseAdmin.rpc("log_pruning", {
            p_brain_id: brainId,
            p_thought_id: args.thought_id,
            p_staleness_score: 0,
            p_tier: "manual",
            p_verdict: "keep",
            p_llm_reason: "Manually rejected via review_stale — excluded 30 days",
          });

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                kept: true,
                thought_id: args.thought_id,
                excluded_until: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
              }),
            }],
          };
        }

        return {
          content: [{ type: "text" as const, text: "Error: invalid action" }],
          isError: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `review_stale failed: ${message}` }],
          isError: true,
        };
      }
    },
  });
}
