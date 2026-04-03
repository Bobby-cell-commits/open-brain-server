// handlers/capture.ts: Plain text → thought capture.
// Mirrors ingest-thought pipeline: embed → extract → dedup → insert → connect → entities → confirm.

import {
  generateEmbedding as _generateEmbedding,
  chatCompletion as _chatCompletion,
} from "../../_shared/openrouter.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { checkDedup, storeConnections } from "../../_shared/auto-link.ts";
import { resolveEntities } from "../../_shared/entities.ts";
import { insertThought } from "../../_shared/insert-thought.ts";
import { sendMessage, setReaction, formatConfirmation } from "../telegram.ts";
import type { TelegramMessage } from "../types.ts";
import { validateMetadata, type ThoughtMetadata } from "../../_shared/types.ts";

// Mutable deps — allows tests to stub without violating frozen ESM namespace rules.
export const _deps = {
  generateEmbedding: _generateEmbedding,
  chatCompletion: _chatCompletion,
};

// Duplicated from ingest-thought (intentional — avoids cross-function deployment coupling)
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
  2. About ML research, models, training, or academic papers?
     → YES: "ml-research" → STOP
     → NO: continue to 3
  3. About knowledge management, memory systems, RAG, or search?
     → YES: "knowledge-systems" → STOP
     → NO: continue to 4
  4. About infrastructure, deployment, databases, or DevOps?
     → YES: "infrastructure" → STOP
     → NO: continue to 5
  5. About developer workflows, tooling, or productivity?
     → YES: "developer-experience" → STOP
     → NO: continue to 6
  6. About a personal side project or building something?
     → YES: "side-projects" → STOP
     → NO: continue to 7
  7. About industry trends, company news, or market dynamics?
     → YES: "industry-trends" → STOP
     → NO: "personal"

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

export async function handleCapture(message: TelegramMessage): Promise<void> {
  const OWNER_BRAIN_ID = Deno.env.get("OWNER_BRAIN_ID") ?? "00000000-0000-4000-a000-000000000001";
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const text = message.text ?? "";

  // Acknowledge receipt
  await setReaction(chatId, messageId, "🧠");

  try {
    // Parallel: embedding + metadata extraction
    const [embedding, metadataJson] = await Promise.all([
      _deps.generateEmbedding(text),
      _deps.chatCompletion(EXTRACTION_PROMPT, text),
    ]);

    const metadata: ThoughtMetadata = validateMetadata(JSON.parse(metadataJson));

    // Telegram captures are deliberate — enforce quality floor above the default 0.4 gate
    if (typeof metadata.quality === "number" && metadata.quality < 0.6) {
      metadata.quality = 0.6;
    }

    // Semantic dedup check (pre-insert)
    const dedup = await checkDedup(OWNER_BRAIN_ID, embedding, "telegram", messageId.toString(), text);

    if (dedup.merged) {
      await sendMessage(
        chatId,
        `🔗 <b>Merged</b> with existing thought (similarity: ${dedup.similarity?.toFixed(2)}).\nOriginal: "<i>${escapeHtml(dedup.originalContentPreview ?? "")}...</i>"`,
        { reply_to_message_id: messageId },
      );
      return;
    }

    // Insert
    const result = await insertThought({
      brainId: OWNER_BRAIN_ID,
      content: text,
      embedding,
      metadata,
      source: "telegram",
      sourceEventId: messageId.toString(),
    });
    if (result.id === "duplicate") {
      console.log("Duplicate telegram event, skipping:", messageId);
      return;
    }

    // Post-insert: connections + entities (best-effort)
    const connections = await storeConnections(OWNER_BRAIN_ID, result.id, embedding, text);

    // Compute salience immediately (telegram gets highest source weight)
    supabaseAdmin.rpc("compute_salience_for_thought", { p_brain_id: OWNER_BRAIN_ID, p_thought_id: result.id }).then(() => {}, () => {});

    if (metadata.entities && Array.isArray(metadata.entities)) {
      await resolveEntities(OWNER_BRAIN_ID, metadata.entities, result.id);
    }

    // Confirmation reply
    let confirmText = formatConfirmation(metadata);
    if (connections.length > 0) {
      const top = connections[0];
      confirmText += `\n\n🔗 <b>Related:</b> "<i>${escapeHtml(top.content_preview)}...</i>" (${(top.similarity * 100).toFixed(0)}% similar)`;
    }

    await sendMessage(chatId, confirmText, { reply_to_message_id: messageId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Telegram capture failed:", errMsg);
    await sendMessage(
      chatId,
      `❌ Capture failed: ${escapeHtml(errMsg)}`,
      { reply_to_message_id: messageId },
    );
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
