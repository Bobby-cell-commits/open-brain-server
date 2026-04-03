// run-pipeline: Edge Function that fetches RSS, triages via LLM, and captures to Open Brain.
// Reddit ingestion runs locally via Windows Task Scheduler (Supabase IPs are blocked by Reddit).
// Invoked via HTTP POST (by pg_cron, GitHub Actions, or manual trigger).

import { supabaseAdmin } from "../_shared/supabase-client.ts";
import { chatCompletion, generateEmbedding } from "../_shared/openrouter.ts";
import { errorResponse } from "../_shared/errors.ts";
import { checkDedup, storeConnections } from "../_shared/auto-link.ts";
import { dreamDedup } from "../_shared/dream-dedup.ts";
import { resolveEntities } from "../_shared/entities.ts";
import { insertThought } from "../_shared/insert-thought.ts";

const OWNER_BRAIN_ID = Deno.env.get("OWNER_BRAIN_ID") ?? "00000000-0000-4000-a000-000000000001";

// --- Config ---

const RSS_FEEDS: Record<string, string> = {
  "Simon Willison": "https://simonwillison.net/atom/everything/",
  "Latent Space": "https://www.latent.space/feed",
  "The Rundown AI": "https://rss.beehiiv.com/feeds/2R3C6Bt5wj.xml",
  "Ahead of AI": "https://magazine.sebastianraschka.com/feed",
  "Interconnects": "https://www.interconnects.ai/feed",
  "Decoding AI": "https://www.decodingai.com/feed",
};

// --- HF Papers Config ---

const HF_DAILY_PAPERS_URL = "https://huggingface.co/api/daily_papers";

const HF_SCREEN_TITLE_TERMS = [
  "language model", "llm", "agent", "reasoning", "embedding",
  "retriev", "code model", "code foundation", "benchmark", "efficient", "hallucin",
];

const HF_KEYWORD_ALLOWLIST = new Set([
  "large language models", "large language model agents",
  "retrieval-augmented generation", "hallucinations",
  "tool learning", "tool-use proficiency", "tool-using agents", "tool interaction",
  "code foundation model", "software engineering",
  "kv-cache", "mathematical reasoning",
  "mixture-of-experts", "knowledge distillation",
  "multilingual embedding models",
  "reinforcement learning from human feedback",
  "multimodal large language models", "language models",
]);

const HF_UPVOTE_CATCH_ALL = 40;

// --- Emergent Mind Config ---

const EMERGENT_MIND_API_URL = "https://www.emergentmind.com/papers.json";
const EMERGENT_MIND_TEMP_THRESHOLD = 50;
const EMERGENT_MIND_HOT_THRESHOLD = 200; // bypass triage actionability gate (lowered from 500)
// All arXiv category IDs — requests all subjects
const EMERGENT_MIND_CATEGORY_IDS = Array.from({ length: 155 }, (_, i) => i + 1).join(",");

// Combined triage + metadata extraction prompt — replaces separate triage + extraction calls.
// Produces both pipeline filtering fields (summary, actionability) and storage metadata
// (type, theme, entities, quality) in a SINGLE LLM call, halving API round-trips.
const PIPELINE_COMBINED_PROMPT = `You are a triage and metadata extraction assistant for a personal knowledge base owned by a developer who builds AI applications and tracks ML research.

Given content from a pipeline source (newsletter article or research paper), produce BOTH a triage assessment AND metadata labels in a SINGLE JSON response.

Return JSON with ALL of the following fields:

--- TRIAGE (for pipeline filtering) ---
- "summary": 2-3 sentence summary focused on what is novel, why it matters, and practical implications

- "category": classify using this procedure:
  1. Is this about AI coding tools, MCP protocol, or developer tooling?
     → YES: "claude-code" → STOP
     → NO: continue to 2
  2. Is this about your industry or professional domain?
     → YES: "domain" → STOP
     → NO: continue to 3
  3. Is this about building AI applications, pipelines, or automation?
     → YES: "side-projects" → STOP
     → NO: continue to 4
  4. Is this ML research, an academic paper, or a technical concept?
     → YES: "learning" → STOP
     → NO: "personal"

- "actionability": classify using this procedure:
  1. Can this be directly applied to a current project this week?
     → YES: "high" → STOP
     → NO: continue to 2
  2. Worth reading or investigating soon — introduces a useful model, technique, tool, or benchmark?
     → YES: "medium" → STOP
     → NO: continue to 3
  3. Useful background knowledge for AI dev or ML research?
     → YES: "low" → STOP
     → NO: "archive"
  NOTE: For research papers, "medium" is the expected rating for relevant work. A paper does not need to be immediately applicable to earn "medium" — novel techniques, strong benchmarks, or useful tools in the AI/ML space qualify.

- "key_topics": array of 2-4 topic tags, lowercase hyphenated
- "tools_mentioned": array of specific tools/libraries/models released (empty if none)
- "urls": array of notable URLs (github repos, demos) if mentioned

--- METADATA (for storage and search) ---
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

- "relevance": one sentence — why is this worth remembering? A reason to care, not a summary.

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

- "topics": array of 2-3 specific tags (GOOD: "pgvector-hnsw", "rag-evaluation" / BAD: "ai", "tools", "research")
- "entities": array of {"name", "type": "person"|"project"|"tool"|"organization", "role": "mention"|"author"|"about"} — specific named entities only
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
- "people": array of people mentioned by name (empty if none)
- "action_items": array of {"task", "assignee", "due"} (empty if none)
- "dates_mentioned": array of dates as YYYY-MM-DD (empty if none)

Be concise. Only extract what is explicitly present. Always respond in English.
If an image is attached, describe what it shows. For memes, explain the joke. For infographics, extract key information.`;

// --- Dedup ---

async function isProcessed(itemId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("pipeline_processed")
    .select("id")
    .eq("id", itemId)
    .maybeSingle();
  return !!data;
}

async function wasCaptured(itemId: string, capturedSource: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("pipeline_processed")
    .select("id")
    .eq("id", itemId)
    .eq("source", capturedSource)
    .maybeSingle();
  return !!data;
}

async function markProcessed(itemId: string, source: string, feed?: string): Promise<void> {
  await supabaseAdmin
    .from("pipeline_processed")
    .upsert({ id: itemId, source, feed, processed_at: new Date().toISOString() });
}

async function feedEntryCount(feedUrl: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("pipeline_processed")
    .select("id", { count: "exact", head: true })
    .eq("feed", feedUrl);
  if (error) throw new Error(`feedEntryCount failed: ${error.message}`);
  return count ?? 0;
}

// --- Triage ---

interface TriageResult {
  summary: string;
  category: string;
  actionability: string;
  key_topics: string[];
  tools_mentioned: string[];
  urls: string[];
}

const TRIAGE_FALLBACK: TriageResult = {
  summary: "",
  category: "learning",
  actionability: "low",
  key_topics: [],
  tools_mentioned: [],
  urls: [],
};

function validateTriageResult(parsed: Record<string, unknown>, fallbackSummary: string): TriageResult {
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : fallbackSummary,
    category: typeof parsed.category === "string" ? parsed.category : TRIAGE_FALLBACK.category,
    actionability: typeof parsed.actionability === "string" ? parsed.actionability : TRIAGE_FALLBACK.actionability,
    key_topics: Array.isArray(parsed.key_topics) ? parsed.key_topics : TRIAGE_FALLBACK.key_topics,
    tools_mentioned: Array.isArray(parsed.tools_mentioned) ? parsed.tools_mentioned : TRIAGE_FALLBACK.tools_mentioned,
    urls: Array.isArray(parsed.urls) ? parsed.urls : TRIAGE_FALLBACK.urls,
  };
}

// Combined result from the merged triage+extraction prompt
interface CombinedResult {
  triage: TriageResult;
  metadata: Record<string, unknown>;
}

const METADATA_FALLBACK: Record<string, unknown> = {
  type: "observation",
  relevance: "",
  theme: "learning",
  topics: [],
  entities: [],
  quality: 0.5,
  people: [],
  action_items: [],
  dates_mentioned: [],
};

/**
 * combinedTriageAndExtract: Single LLM call that produces BOTH triage assessment
 * AND metadata labels. Replaces separate triageContent/triagePaper + EXTRACTION_PROMPT calls.
 * Halves the number of LLM round-trips per pipeline thought.
 */
async function combinedTriageAndExtract(content: string, imageUrl?: string): Promise<CombinedResult> {
  try {
    const result = await chatCompletion(PIPELINE_COMBINED_PROMPT, content.slice(0, 4000), undefined, imageUrl);
    const parsed = JSON.parse(result);

    const triage = validateTriageResult(parsed, content.slice(0, 200));

    const metadata: Record<string, unknown> = {
      type: typeof parsed.type === "string" ? parsed.type : METADATA_FALLBACK.type,
      relevance: typeof parsed.relevance === "string" ? parsed.relevance : METADATA_FALLBACK.relevance,
      theme: typeof parsed.theme === "string" ? parsed.theme : METADATA_FALLBACK.theme,
      topics: Array.isArray(parsed.topics) ? parsed.topics : triage.key_topics,
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      quality: typeof parsed.quality === "number" ? parsed.quality : 0.5,
      people: Array.isArray(parsed.people) ? parsed.people : [],
      action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
      dates_mentioned: Array.isArray(parsed.dates_mentioned) ? parsed.dates_mentioned : [],
    };

    return { triage, metadata };
  } catch {
    return {
      triage: { ...TRIAGE_FALLBACK, summary: content.slice(0, 200) },
      metadata: { ...METADATA_FALLBACK },
    };
  }
}

function passesKeywordScreen(paper: { title?: string; upvotes?: number; paper?: { upvotes?: number; ai_keywords?: string[] } }): boolean {
  if ((paper.paper?.upvotes ?? paper.upvotes ?? 0) >= HF_UPVOTE_CATCH_ALL) return true;

  const titleLower = (paper.title ?? "").toLowerCase();
  for (const term of HF_SCREEN_TITLE_TERMS) {
    if (titleLower.includes(term)) return true;
  }

  const aiKeywords = paper.paper?.ai_keywords ?? [];
  for (const kw of aiKeywords) {
    if (HF_KEYWORD_ALLOWLIST.has(kw.toLowerCase())) return true;
  }

  return false;
}

// --- Capture ---

const CAPTURE_EXTRACTION_PROMPT = `You are a metadata extractor for a personal knowledge base owned by a developer who builds AI applications and tracks ML research. Your job is to produce labels that make thoughts findable and meaningful later — not just keywords that restate the domain.

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

async function captureThought(
  content: string,
  source: string,
  sourceEventId: string,
  precomputed?: { embedding: number[]; metadata: Record<string, unknown> },
): Promise<string> {
  let embedding: number[];
  let metadata: Record<string, unknown>;

  if (precomputed) {
    // Pipeline path: triage+extraction already done in parallel with embedding
    embedding = precomputed.embedding;
    metadata = precomputed.metadata;
  } else {
    // Fallback: parallel embed + extract (used by non-pipeline callers)
    const [emb, metadataJson] = await Promise.all([
      generateEmbedding(content),
      chatCompletion(CAPTURE_EXTRACTION_PROMPT, content),
    ]);
    embedding = emb;
    metadata = JSON.parse(metadataJson);
  }

  // Semantic dedup check (pre-insert)
  const dedup = await checkDedup(OWNER_BRAIN_ID, embedding, source, sourceEventId, content);
  if (dedup.merged) {
    console.log(`Semantic dedup: merged with ${dedup.originalId} (similarity: ${dedup.similarity})`);
    return "duplicate";
  }

  const result = await insertThought({
    brainId: OWNER_BRAIN_ID,
    content,
    embedding,
    metadata,
    source,
    sourceEventId,
  });
  if (result.id === "duplicate") return "duplicate";

  // Store connections (post-insert, best-effort)
  await storeConnections(OWNER_BRAIN_ID, result.id, embedding, content);

  // Resolve entities (post-insert, best-effort)
  if (metadata.entities && Array.isArray(metadata.entities)) {
    await resolveEntities(OWNER_BRAIN_ID, metadata.entities, result.id);
  }

  return result.id;
}

// --- Format enriched content ---

function formatRssContent(feedName: string, entry: any, triage: TriageResult): string {
  const topics = triage.key_topics.join(", ");
  const tools = triage.tools_mentioned.join(", ");

  let s = `[Newsletter: ${feedName}] ${entry.title}\n\n`;
  s += `Summary: ${triage.summary}\n\n`;
  s += `Category: ${triage.category}\nActionability: ${triage.actionability}\nTopics: ${topics}\n`;
  if (tools) s += `Tools: ${tools}\n`;
  s += `\nContent excerpt:\n${(entry.content || entry.summary || "").slice(0, 1500)}\n`;
  s += `\nPublished: ${entry.pubDate || ""}\nSource: ${entry.link || ""}\n`;
  s += `Captured: ${new Date().toISOString()}`;
  return s.slice(0, 4000);
}

function formatHfPaperContent(paper: any, triage: TriageResult): string {
  const paperData = paper.paper ?? {};
  const paperId = paperData.id ?? "";
  const authors = (paperData.authors ?? [])
    .slice(0, 5)
    .map((a: any) => a.name ?? "")
    .join(", ");
  const authorSuffix = (paperData.authors ?? []).length > 5 ? " et al." : "";
  const abstract = (paperData.summary ?? "").slice(0, 1000);
  const topics = triage.key_topics.join(", ");
  const tools = triage.tools_mentioned.join(", ");

  let s = `[HF Paper] ${paper.title ?? ""}\n`;
  s += `Authors: ${authors}${authorSuffix}\n\n`;
  s += `Summary: ${triage.summary}\n\n`;
  s += `Category: ${triage.category}\nActionability: ${triage.actionability}\nTopics: ${topics}\n`;
  if (tools) s += `Tools/Models: ${tools}\n`;
  s += `\nAbstract:\n${abstract}\n\n`;
  s += `Source: https://huggingface.co/papers/${paperId}\n`;
  s += `Captured: ${new Date().toISOString()}`;
  return s.slice(0, 4000);
}

function formatEmergentMindContent(paper: any, triage: TriageResult): string {
  const arxivId = paper.arxiv_paper_id ?? "";
  const abstract = (paper.abstract ?? "").slice(0, 1000);
  const topics = triage.key_topics.join(", ");
  const tools = triage.tools_mentioned.join(", ");
  const tw = paper.twitter_likes_count ?? 0;
  const rd = paper.reddit_points_count ?? 0;
  const hn = paper.hacker_news_points_count ?? 0;
  const gh = paper.github_stars_count ?? 0;
  const temperature = paper.temperature ?? 0;

  let s = `[Emergent Mind] ${paper.title ?? ""}\n\n`;
  s += `Summary: ${triage.summary}\n\n`;
  s += `Category: ${triage.category}\nActionability: ${triage.actionability}\nTopics: ${topics}\n`;
  if (tools) s += `Tools/Models: ${tools}\n`;
  s += `\nSocial signals: ${tw} Twitter, ${rd} Reddit, ${hn} HN, ${gh} GitHub stars\n`;
  s += `Temperature: ${temperature}\n`;
  s += `\nAbstract:\n${abstract}\n\n`;
  s += `Source: https://www.emergentmind.com/papers/${arxivId}\n`;
  s += `arXiv: https://arxiv.org/abs/${arxivId}\n`;
  s += `Captured: ${new Date().toISOString()}`;
  return s.slice(0, 4000);
}

// --- Pipeline runners ---

const MAX_FIRST_RUN = 5;

async function processRssFeeds(): Promise<{ captured: number; skipped: number; failed: number; filtered: number }> {
  const stats = { captured: 0, skipped: 0, failed: 0, filtered: 0 };

  for (const [feedName, feedUrl] of Object.entries(RSS_FEEDS)) {
    try {
      const resp = await fetch(feedUrl, {
        headers: { "User-Agent": "open-brain-pipeline/1.0" },
      });
      if (!resp.ok) {
        console.error(`Feed fetch failed: ${feedName} (${resp.status})`);
        continue;
      }
      const xml = await resp.text();
      let entries = parseRssEntries(xml);

      // First-run protection: only process N most recent, mark rest as seen
      const existingCount = await feedEntryCount(feedUrl);
      if (existingCount === 0 && entries.length > MAX_FIRST_RUN) {
        console.log(`First run for ${feedName}: processing ${MAX_FIRST_RUN} most recent, marking ${entries.length - MAX_FIRST_RUN} as seen`);
        for (const entry of entries.slice(MAX_FIRST_RUN)) {
          const entryId = entry.guid || entry.link || `${feedUrl}|${entry.title}`;
          await markProcessed(entryId, `rss-${feedName}-skipped`, feedUrl);
        }
        entries = entries.slice(0, MAX_FIRST_RUN);
      }

      for (const entry of entries.slice(0, 10)) {
        const entryId = entry.guid || entry.link || `${feedUrl}|${entry.title}`;

        if (await isProcessed(entryId)) { stats.skipped++; continue; }

        try {
          const rawInput = `${feedName}: ${entry.title}\n\n${(entry.content || entry.summary || "").slice(0, 1500)}`;

          // Combined triage+extraction AND embedding in parallel (2 calls instead of 3)
          const [combined, embedding] = await Promise.all([
            combinedTriageAndExtract(rawInput),
            generateEmbedding(rawInput),
          ]);

          const enriched = formatRssContent(feedName, entry, combined.triage);
          const result = await captureThought(enriched, "rss", entryId, {
            embedding,
            metadata: combined.metadata,
          });
          if (result !== "duplicate") {
            await markProcessed(entryId, "rss", feedUrl);
            stats.captured++;
          } else {
            stats.skipped++;
          }
        } catch (e) {
          console.error(`RSS capture failed (${feedName}): ${e}`);
          stats.failed++;
        }
      }
    } catch (e) {
      console.error(`Feed processing failed (${feedName}): ${e}`);
    }
  }

  return stats;
}

async function processHfPapers(): Promise<{ captured: number; skipped: number; failed: number; filtered: number }> {
  const stats = { captured: 0, skipped: 0, failed: 0, filtered: 0 };

  let papers: any[];
  try {
    const resp = await fetch(HF_DAILY_PAPERS_URL, {
      headers: { "User-Agent": "open-brain-pipeline/1.0" },
    });
    if (!resp.ok) {
      console.error(`HF daily papers fetch failed (${resp.status})`);
      return stats;
    }
    papers = await resp.json();
  } catch (e) {
    console.error(`HF daily papers fetch error: ${e}`);
    return stats;
  }

  console.log(`Fetched ${papers.length} daily papers from HuggingFace`);

  for (const paper of papers) {
    const paperData = paper.paper ?? {};
    const paperId = paperData.id ?? "";
    const eventId = `hf_paper_${paperId}`;

    if (await isProcessed(eventId)) { stats.skipped++; continue; }

    // Keyword screen
    if (!passesKeywordScreen(paper)) {
      await markProcessed(eventId, "hf_papers-filtered", "hf_papers");
      stats.filtered++;
      continue;
    }

    try {
      const authors = (paperData.authors ?? []).slice(0, 5).map((a: any) => a.name ?? "").join(", ");
      const rawInput = `Title: ${paper.title ?? ""}\nAuthors: ${authors}\nURL: https://huggingface.co/papers/${paperId}\n\nAbstract:\n${(paperData.summary ?? "").slice(0, 3000)}`;

      // Combined triage+extraction AND embedding in parallel
      const [combined, embedding] = await Promise.all([
        combinedTriageAndExtract(rawInput),
        generateEmbedding(rawInput),
      ]);

      // Capture medium+ actionability OR high-upvote papers
      const hasHighUpvotes = (paperData.upvotes ?? 0) >= HF_UPVOTE_CATCH_ALL;
      if (combined.triage.actionability === "high" || combined.triage.actionability === "medium" || hasHighUpvotes) {
        const enriched = formatHfPaperContent(paper, combined.triage);
        const result = await captureThought(enriched, "hf_papers", eventId, { embedding, metadata: combined.metadata });
        if (result !== "duplicate") {
          await markProcessed(eventId, "hf_papers", "hf_papers");
          stats.captured++;
        } else {
          stats.skipped++;
        }
      } else {
        await markProcessed(eventId, "hf_papers-low", "hf_papers");
        stats.filtered++;
      }
    } catch (e) {
      console.error(`HF paper capture failed (${paperId}): ${e}`);
      stats.failed++;
    }
  }

  return stats;
}

async function processEmergentMind(): Promise<{ captured: number; skipped: number; failed: number; filtered: number; warnings: string[] }> {
  const stats = { captured: 0, skipped: 0, failed: 0, filtered: 0, warnings: [] as string[] };

  // Fetch from JSON API
  let papers: any[];
  try {
    const url = `${EMERGENT_MIND_API_URL}?timeframe=7d&category_ids=${EMERGENT_MIND_CATEGORY_IDS}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "open-brain-pipeline/1.0" },
    });
    if (!resp.ok) {
      stats.warnings.push(`emergent_mind: API fetch failed (${resp.status})`);
      return stats;
    }
    const data = await resp.json();
    papers = data.papers ?? [];
    if (!Array.isArray(papers)) {
      stats.warnings.push(`emergent_mind: API response 'papers' is not an array`);
      return stats;
    }
  } catch (e) {
    stats.warnings.push(`emergent_mind: API fetch error: ${e}`);
    return stats;
  }

  console.log(`Fetched ${papers.length} trending papers from Emergent Mind`);

  // First-run protection: only process top N by temperature, mark rest as seen
  const emExistingCount = await feedEntryCount("emergent_mind");
  if (emExistingCount === 0 && papers.length > MAX_FIRST_RUN) {
    console.log(`First run for Emergent Mind: processing ${MAX_FIRST_RUN} hottest, marking ${papers.length - MAX_FIRST_RUN} as seen`);
    // Papers are already sorted by temperature (highest first) from the API
    for (const paper of papers.slice(MAX_FIRST_RUN)) {
      const eventId = `emergentmind_${paper.arxiv_paper_id ?? ""}`;
      await markProcessed(eventId, "emergentmind-first-run-skip", "emergent_mind");
    }
    papers = papers.slice(0, MAX_FIRST_RUN);
  }

  for (const paper of papers) {
    const arxivId = paper.arxiv_paper_id ?? "";
    const temperature = paper.temperature ?? 0;
    const eventId = `emergentmind_${arxivId}`;

    // Dedup — skip previously processed
    if (await isProcessed(eventId)) { stats.skipped++; continue; }

    // Cross-dedup against HF Papers — only skip if HF actually captured it
    if (await wasCaptured(`hf_paper_${arxivId}`, "hf_papers")) {
      await markProcessed(eventId, "emergentmind-hf-dedup", "emergent_mind");
      stats.skipped++;
      continue;
    }

    // Temperature filter
    if (temperature < EMERGENT_MIND_TEMP_THRESHOLD) {
      await markProcessed(eventId, "emergentmind-low-temp", "emergent_mind");
      stats.filtered++;
      continue;
    }

    try {
      const abstract = (paper.abstract ?? "").slice(0, 3000);
      const rawInput = `Title: ${paper.title ?? ""}\nURL: https://www.emergentmind.com/papers/${arxivId}\n\nAbstract:\n${abstract}`;

      // Combined triage+extraction AND embedding in parallel
      const [combined, embedding] = await Promise.all([
        combinedTriageAndExtract(rawInput),
        generateEmbedding(rawInput),
      ]);

      // Capture if medium+ actionability OR high community temperature
      const passesActionability = combined.triage.actionability === "high" || combined.triage.actionability === "medium";
      const isHotPaper = temperature >= EMERGENT_MIND_HOT_THRESHOLD;
      if (passesActionability || isHotPaper) {
        const enriched = formatEmergentMindContent(paper, combined.triage);
        // Store temperature in metadata for downstream salience use
        const metadata = { ...combined.metadata, temperature };
        const result = await captureThought(enriched, "emergent_mind", eventId, { embedding, metadata });
        if (result !== "duplicate") {
          await markProcessed(eventId, "emergent_mind", "emergent_mind");
          stats.captured++;
        } else {
          stats.skipped++;
        }
      } else {
        await markProcessed(eventId, "emergentmind-low", "emergent_mind");
        stats.filtered++;
      }
    } catch (e) {
      console.error(`Emergent Mind capture failed (${arxivId}): ${e}`);
      stats.failed++;
    }
  }

  return stats;
}

// Simple RSS/Atom XML parser (no external deps)
interface RssEntry {
  title: string;
  link: string;
  guid?: string;
  content?: string;
  summary?: string;
  pubDate?: string;
}

function parseRssEntries(xml: string): RssEntry[] {
  const entries: RssEntry[] = [];

  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;

  const items = [...xml.matchAll(itemRegex), ...xml.matchAll(entryRegex)];

  for (const match of items) {
    const block = match[1];
    entries.push({
      title: extractTag(block, "title"),
      link: extractTag(block, "link") || extractAttr(block, "link", "href"),
      guid: extractTag(block, "guid") || extractTag(block, "id"),
      content: stripHtml(extractTag(block, "content:encoded") || extractTag(block, "content") || ""),
      summary: stripHtml(extractTag(block, "description") || extractTag(block, "summary") || ""),
      pubDate: extractTag(block, "pubDate") || extractTag(block, "published") || extractTag(block, "updated"),
    });
  }

  return entries;
}

function extractTag(xml: string, tag: string): string {
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, "i");
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i");
  const match = xml.match(regex);
  return match ? match[1] : "";
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// --- Main handler ---

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  // Auth: require MCP_ACCESS_KEY
  const key = req.headers.get("x-brain-key");
  if (key !== Deno.env.get("MCP_ACCESS_KEY")) {
    return errorResponse("Unauthorized", 401);
  }

  const runStartTime = Date.now();

  // Parse source and options from request body
  let source = "all";
  let runDreamDedup = false;
  let dreamScanDays: number | undefined;
  try {
    const body = await req.json();
    if (body.source && typeof body.source === "string") {
      source = body.source;
    }
    if (body.dream_dedup === true) {
      runDreamDedup = true;
    }
    if (typeof body.scan_days === "number" && body.scan_days > 0) {
      dreamScanDays = body.scan_days;
    }
  } catch {
    // Empty body or invalid JSON — default to "all"
  }

  const sources: Record<string, any> = {};
  const validSources = ["rss", "hf_papers", "emergent_mind", "all", "none"];
  if (!validSources.includes(source)) {
    return errorResponse(`Invalid source: "${source}". Valid: ${validSources.join(", ")}`, 400);
  }

  let totalCaptured = 0;
  let totalFailed = 0;
  const warnings: string[] = [];

  if (source === "rss" || source === "all") {
    try {
      sources.rss = await processRssFeeds();
      totalCaptured += sources.rss.captured;
      totalFailed += sources.rss.failed;
    } catch (e) {
      sources.rss_error = e instanceof Error ? e.message : String(e);
    }
  }

  if (source === "hf_papers" || source === "all") {
    try {
      sources.hf_papers = await processHfPapers();
      totalCaptured += sources.hf_papers.captured;
      totalFailed += sources.hf_papers.failed;
    } catch (e) {
      sources.hf_papers_error = e instanceof Error ? e.message : String(e);
    }
  }

  if (source === "emergent_mind" || source === "all") {
    try {
      const emResult = await processEmergentMind();
      sources.emergent_mind = emResult;
      totalCaptured += emResult.captured;
      totalFailed += emResult.failed;
      // Propagate warnings (emergent_mind is a third-party API that may change without notice)
      if (emResult.warnings.length > 0) {
        warnings.push(...emResult.warnings);
      }
    } catch (e) {
      sources.emergent_mind_error = e instanceof Error ? e.message : String(e);
    }
  }

  // Refresh salience scores after pipeline captures
  let salienceRefreshed = 0;
  try {
    const { data } = await supabaseAdmin.rpc("refresh_salience");
    salienceRefreshed = data ?? 0;
  } catch (e) {
    console.error(`Salience refresh failed: ${e}`);
  }

  // Dream Cycle Phase A: automated dedup & merge (opt-in via dream_dedup:true)
  // Separated from default pipeline runs to stay within Edge Function resource limits.
  let dreamDedupResult = null;
  if (runDreamDedup) {
    try {
      dreamDedupResult = await dreamDedup(OWNER_BRAIN_ID, dreamScanDays);
      if (dreamDedupResult.deleted > 0) {
        console.log(`Dream dedup: merged ${dreamDedupResult.deleted} duplicate(s)`);
      }
    } catch (e) {
      console.error(`Dream dedup failed: ${e}`);
    }
  }

  // --- Pipeline run logging ---
  const executionMs = Date.now() - runStartTime;
  const hasErrors = Object.keys(sources).some((k) => k.endsWith("_error"));
  const runStatus = hasErrors
    ? totalCaptured > 0 ? "partial_failure" : "failure"
    : "success";

  // Detect trigger from header (GitHub Actions sets this), default to "manual"
  const trigger = req.headers.get("x-trigger") ?? "manual";

  try {
    await supabaseAdmin.rpc("log_pipeline_run", {
      p_started_at: new Date(runStartTime).toISOString(),
      p_source: source,
      p_trigger: trigger,
      p_status: runStatus,
      p_captured: totalCaptured,
      p_failed: totalFailed,
      p_skipped: Object.values(sources)
        .filter((v): v is Record<string, number> => typeof v === "object" && v !== null && "skipped" in v)
        .reduce((sum, s) => sum + (s.skipped ?? 0), 0),
      p_filtered: Object.values(sources)
        .filter((v): v is Record<string, number> => typeof v === "object" && v !== null && "filtered" in v)
        .reduce((sum, s) => sum + (s.filtered ?? 0), 0),
      p_warnings: warnings,
      p_error_message: hasErrors
        ? Object.entries(sources)
            .filter(([k]) => k.endsWith("_error"))
            .map(([k, v]) => `${k}: ${v}`)
            .join("; ")
        : null,
      p_source_details: sources,
      p_salience_refreshed: salienceRefreshed,
      p_dream_dedup: dreamDedupResult,
      p_execution_ms: executionMs,
    });
  } catch (logErr) {
    console.error("Failed to log pipeline run:", logErr);
    // Non-blocking — don't fail the pipeline over monitoring
  }

  return new Response(
    JSON.stringify({
      status: "complete",
      total_captured: totalCaptured,
      total_failed: totalFailed,
      warnings,
      sources,
      salience_refreshed: salienceRefreshed,
      dream_dedup: dreamDedupResult,
      timestamp: new Date().toISOString(),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
