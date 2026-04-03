// weekly_review: Synthesize a review of recent thoughts
// Fetches thoughts from a configurable time window, sends to gpt-4o for analysis,
// returns structured review (themes, open loops, connections, next steps) + thought list.

import { chatCompletion } from "../../_shared/openrouter.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

export function registerWeeklyReview(mcp: McpServer, z: Z): void {
  mcp.tool("weekly_review", {
    description:
      "Synthesize a review of recent thoughts: themes, open loops, connections, and suggested next steps",
    inputSchema: z.object({
      days: z
        .coerce.number()
        .optional()
        .default(7)
        .describe("Time window in days (default 7)"),
    }),
    handler: async (args: { days: number }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        const days = Math.min(args.days ?? 7, 365);

        const now = new Date().toISOString();
        const since = new Date(
          Date.now() - days * 86400000,
        ).toISOString();

        // Fetch recent thoughts (cap at 100 per pitfall 3)
        const { data: thoughts, error, count } = await supabaseAdmin
          .from("thoughts")
          .select("id, content, metadata, created_at", { count: "exact" })
          .eq("brain_id", brainId)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(100);

        if (error) throw error;

        if (!thoughts || thoughts.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No thoughts captured in the last ${days} days.`,
              },
            ],
          };
        }

        // Build thought list for traceability
        const thoughtList = thoughts.map((t) => ({
          id: t.id,
          first_line: t.content.split("\n")[0].slice(0, 100),
          date: t.created_at,
        }));

        // Build LLM prompt
        const systemPrompt = `You are reviewing a personal knowledge base. Analyze the following thoughts captured over the last ${days} days and produce a structured review in JSON format with:
- "themes": array of 2-5 recurring themes with brief description
- "open_loops": array of unresolved action items or questions that need follow-up
- "connections": array of connections between thoughts that the user might not have noticed
- "suggested_next_steps": array of 3-5 concrete next actions based on the patterns
- "summary": 2-3 sentence overview of the period`;

        // Build user content with all thought texts
        let userContent = thoughts
          .map(
            (t, i) =>
              `[${i + 1}] (${t.created_at})\n${t.content}`,
          )
          .join("\n\n---\n\n");

        // Note if we're showing a sample
        const totalCount = count ?? thoughts.length;
        if (totalCount > 100) {
          userContent =
            `Note: showing 100 of ${totalCount} thoughts from this period.\n\n` +
            userContent;
        }

        // Call gpt-4o (stronger model for better theme detection)
        const reviewJson = await chatCompletion(
          systemPrompt,
          userContent,
          "openai/gpt-4o",
        );

        // Parse the LLM response
        let review;
        try {
          review = JSON.parse(reviewJson);
        } catch {
          // If LLM returns non-JSON, wrap it
          review = { raw_response: reviewJson };
        }

        const result = {
          review,
          thoughts: thoughtList,
          period: {
            days,
            from: since,
            to: now,
            thought_count: thoughts.length,
            total_in_period: totalCount,
          },
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Weekly review failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
