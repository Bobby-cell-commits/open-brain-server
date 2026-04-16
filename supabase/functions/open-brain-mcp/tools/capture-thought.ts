// capture_thought: Store a new thought with automatic embedding and metadata extraction.
// Uses shared auto-link module for semantic dedup (pre-insert) and connection storage (post-insert).

import { generateEmbedding, chatCompletion } from "../../_shared/openrouter.ts";
import { insertThought } from "../../_shared/insert-thought.ts";
import { checkDedup, storeConnections, storeEntityBridges } from "../../_shared/auto-link.ts";
import { resolveEntities } from "../../_shared/entities.ts";

import type { McpServer } from "npm:mcp-lite";
import { validateMetadata, type ThoughtMetadata } from "../../_shared/types.ts";

type Z = typeof import("npm:zod@3");

// Duplicated from ingest-thought (intentional -- avoids cross-function import coupling)
const EXTRACTION_PROMPT = `You are a metadata extractor for a personal knowledge base owned by a developer who builds AI applications and tracks ML research. Your job is to produce labels that make thoughts findable and meaningful later — not just keywords that restate the domain.

Return JSON with:

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

- "relevance": one sentence — why is this thought worth remembering? Not a summary. A reason to care.

- "theme": classify using this procedure:
  1. About AI-powered coding tools, code completion, or code generation?
     → YES: "ai-coding-tools" → STOP
     → NO: continue to 2
  2. About ML research, models, training, benchmarks, or academic papers?
     → YES: "ml-research" → STOP
     → NO: continue to 3
  3. About knowledge management, memory systems, RAG, search, or PKM tools?
     → YES: "knowledge-systems" → STOP
     → NO: continue to 4
  4. About chip architecture, embedded systems, FPGA, semiconductors, or electronics?
     → YES: "hardware-systems" → STOP
     → NO: continue to 5
  5. About infrastructure, deployment, databases, DevOps, cloud, or systems programming?
     → YES: "infrastructure" → STOP
     → NO: continue to 6
  6. About developer workflows, tooling, or the craft of software engineering?
     → YES: "developer-experience" → STOP
     → NO: continue to 7
  7. About vulnerability research, cryptography, privacy, or security threats?
     → YES: "security" → STOP
     → NO: continue to 8
  8. About bioinformatics, scientific workflows, statistical computing, or Julia/R ecosystem?
     → YES: "scientific-computing" → STOP
     → NO: continue to 9
  9. About AI regulation, privacy law, tech policy, or compliance?
     → YES: "regulation-policy" → STOP
     → NO: continue to 10
  10. About structural tech analysis, compute economics, business models, or market sizing?
      → YES: "tech-economics" → STOP
      → NO: continue to 11
  11. About industry news, company announcements, product launches, or ecosystem shifts?
      → YES: "industry-trends" → STOP
      → NO: Pick the closest theme from steps 1-11.

  Theme anti-patterns — common mistakes to avoid:
  - Newsletter roundups about AI companies or model releases → "industry-trends", NOT "career-personal"
  - Academic paper summaries from arXiv or HuggingFace → "ml-research", NOT "opinion"
  - Career advice, interview tips, workplace culture → theme "developer-experience", activity "career-personal"
  - Self-hosting or monitoring tool questions → "infrastructure", NOT "career-personal"
  - Humor/memes about a technology topic → use that topic's theme, NOT "career-personal"
  - Someone built a RAG pipeline as a weekend project → theme "knowledge-systems", activity "project-showcase"
  - EU AI Act analysis → "regulation-policy", NOT "industry-trends"
  - SemiAnalysis chip breakdown → "hardware-systems", NOT "infrastructure"
  - Benedict Evans annual letter → "tech-economics", NOT "industry-trends"

- "activity": classify using this procedure:
  1. Is this an academic paper, preprint, or formal study?
     → YES: "research-paper" → STOP
     → NO: continue to 2
  2. Is this a discussion thread, debate, Q&A, or community conversation?
     → YES: "community-discussion" → STOP
     → NO: continue to 3
  3. Is this someone demonstrating or releasing a project they built?
     → YES: "project-showcase" → STOP
     → NO: continue to 4
  4. Is this a product launch, release note, pricing change, or company news?
     → YES: "announcement" → STOP
     → NO: continue to 5
  5. Is this a periodic survey, benchmark report, or data-driven industry analysis?
     → YES: "industry-report" → STOP
     → NO: continue to 6
  6. Is this a how-to, guide, walkthrough, or educational content?
     → YES: "tutorial" → STOP
     → NO: continue to 7
  7. Is this career advice, job search, work-life balance, or non-technical reflection?
     → YES: "career-personal" → STOP
     → NO: continue to 8
  8. Is this an opinion piece, hot take, commentary, or editorial?
     → YES: "opinion" → STOP
     → NO: "opinion"

- "topics": array of 2-3 specific topic tags, lowercase hyphenated.
  Tags should be specific enough that searching for one returns a focused set, not half the database.
  GOOD: "copilot-rate-limits", "zettelkasten-memory", "deno-edge-functions", "multi-agent-orchestration"
  BAD: "ai", "research", "tools", "automation", "productivity", "open-source", "machine-learning"

- "entities": array of objects with "name", "type", "role":
  - type: one of "person", "project", "tool", "organization"
  - role: one of "mention" (referenced in passing), "author" (thought is by/from this entity), "about" (thought is primarily about this entity)
  - Extract specific, named entities only. Do not create entities for generic concepts.
  GOOD: {"name": "Simon Willison", "type": "person", "role": "mention"}, {"name": "pgvector", "type": "tool", "role": "about"}
  BAD: {"name": "AI", "type": "tool", "role": "about"}, {"name": "the author", "type": "person", "role": "author"}

- "quality": rate using this procedure:
  1. Contains original insight, a specific testable claim, or actionable advice backed by evidence?
     → YES: 0.8–1.0 → STOP
     → NO: continue to 2
  2. Solid reference with useful context, clear signal, or specific technical details?
     → YES: 0.6–0.8 → STOP
     → NO: continue to 3
  3. Contains at least one specific, non-obvious piece of information?
     → YES: 0.3–0.5 → STOP
     → NO: 0.1–0.2

- "people": array of people mentioned by name (empty if none) — kept for backward compatibility
- "action_items": array of {"task", "assignee", "due"} objects (empty if none)
- "dates_mentioned": array of dates in YYYY-MM-DD format (empty if none)

Only extract what is explicitly present. Always respond in English regardless of input language.
If the content is just a URL with no context, set type to "task", relevance to "Flagged for investigation", quality to 0.3, and infer topics from any visible domain or path clues.`;

export function registerCaptureThought(mcp: McpServer, z: Z): void {
  mcp.tool("capture_thought", {
    description:
      "Capture a new thought with automatic embedding and metadata extraction",
    inputSchema: z.object({
      content: z.string().describe("The thought text to capture"),
      source: z.string().optional().describe("Source identifier (default: 'mcp')"),
      source_event_id: z.string().optional().describe("Source-specific event ID for idempotency"),
    }),
    handler: async (args: { content: string; source?: string; source_event_id?: string }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        if (args.content.length > 10_000) {
          return { content: [{ type: "text" as const, text: `Content exceeds maximum length of 10,000 characters (received: ${args.content.length})` }], isError: true };
        }

        const source = args.source ?? "mcp";

        // Parallel: embedding + metadata extraction
        const [embedding, metadataJson] = await Promise.all([
          generateEmbedding(args.content),
          chatCompletion(EXTRACTION_PROMPT, args.content),
        ]);

        const metadata: ThoughtMetadata = validateMetadata(JSON.parse(metadataJson));

        // Semantic dedup check (pre-insert)
        const dedup = await checkDedup(
          brainId,
          embedding,
          source,
          args.source_event_id ?? null,
          args.content,
        );

        if (dedup.merged) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  merged: true,
                  original_id: dedup.originalId,
                  original_preview: dedup.originalContentPreview,
                  similarity: dedup.similarity,
                  message: "Thought merged with existing similar thought",
                }),
              },
            ],
          };
        }

        // Insert
        const data = await insertThought({
          brainId,
          content: args.content,
          embedding,
          metadata,
          source,
          sourceEventId: args.source_event_id ?? null,
        });

        // Store connections (post-insert, best-effort)
        const connections = await storeConnections(brainId, data.id, embedding, args.content);

        // Resolve entities (post-insert, best-effort)
        if (metadata.entities && Array.isArray(metadata.entities)) {
          await resolveEntities(brainId, metadata.entities, data.id);
        }

        // Store entity bridges (post-insert, best-effort)
        if (metadata.entities && Array.isArray(metadata.entities)) {
          await storeEntityBridges(brainId, data.id);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: data.id,
                created_at: data.created_at,
                metadata,
                message: "Thought captured successfully",
                ...(connections.length > 0 ? { related: connections } : {}),
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Capture failed: ${message}` },
          ],
          isError: true,
        };
      }
    },
  });
}
