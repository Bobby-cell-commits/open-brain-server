// update_thought: Update a thought's content with re-embedding and metadata re-extraction.
// Uses the same parallel embed + extract pattern as capture-thought.ts.

import { generateEmbedding, chatCompletion } from "../../_shared/openrouter.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";
import { validateMetadata, type ThoughtMetadata } from "../../_shared/types.ts";

type Z = typeof import("npm:zod@3");

// Intentionally duplicated from capture-thought.ts — avoids cross-file coupling.
const EXTRACTION_PROMPT = `Extract metadata from the user's captured thought. Return JSON with:
- "type": classify using this procedure:
  1. Is this a joke, meme, or funny observation?
     → YES: "humor" → STOP
     → NO: continue to 2
  2. Is this about or from a specific person (bio, profile)?
     → YES: "person_note" → STOP
     → NO: continue to 3
  3. Is this notes from a conversation or meeting?
     → YES: "meeting_note" → STOP
     → NO: continue to 4
  4. Does this describe a concrete action someone should take?
     → YES: "task" → STOP
     → NO: continue to 5
  5. Does this record a specific choice that was made or is being weighed?
     → YES: "decision" → STOP
     → NO: continue to 6
  6. Does this pose an unresolved question needing investigation?
     → YES: "question" → STOP
     → NO: continue to 7
  7. Is this primarily a pointer to a tool, paper, link, or resource to remember?
     → YES: "reference" → STOP
     → NO: continue to 8
  8. Does this propose a new concept, creative direction, or approach worth exploring?
     → YES: "idea" → STOP
     → NO: "observation"
- "topics": array of 1-3 short topic tags, lowercase and hyphenated (always at least one)
- "people": array of people mentioned (empty if none)
- "action_items": array of action item objects, each with "task" (string), "assignee" (string or null), "due" (string or null) -- empty array if none
- "dates_mentioned": array of dates in YYYY-MM-DD format (empty if none)
Only extract what's explicitly there. Always respond in English regardless of input language.`;

export function registerUpdateThought(mcp: McpServer, z: Z): void {
  mcp.tool("update_thought", {
    description:
      "Update a thought's content. Re-embeds and re-extracts metadata to keep search accurate.",
    inputSchema: z.object({
      id: z.string().uuid().describe("The UUID of the thought to update"),
      content: z.string().describe("The new thought content"),
    }),
    handler: async (args: { id: string; content: string }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        if (args.content.length > 10_000) {
          return { content: [{ type: "text" as const, text: `Content exceeds maximum length of 10,000 characters (received: ${args.content.length})` }], isError: true };
        }

        // Parallel: re-embed + re-extract (same pattern as capture_thought)
        const [embedding, metadataJson] = await Promise.all([
          generateEmbedding(args.content),
          chatCompletion(EXTRACTION_PROMPT, args.content),
        ]);

        const metadata: ThoughtMetadata = validateMetadata(JSON.parse(metadataJson));

        const { data, error } = await supabaseAdmin
          .from("thoughts")
          .update({ content: args.content, embedding, metadata })
          .eq("id", args.id)
          .eq("brain_id", brainId)
          .select("id, updated_at")
          .single();

        if (error) {
          // PGRST116: "The result contains 0 rows" — thought not found
          if (error.code === "PGRST116") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Thought not found: ${args.id}`,
                },
              ],
              isError: true,
            };
          }
          throw error;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: data.id,
                updated_at: data.updated_at,
                metadata,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Update failed: ${message}` },
          ],
          isError: true,
        };
      }
    },
  });
}
