// run-pipeline: Edge Function that fetches RSS, triages via LLM, and captures to Open Brain.
// Reddit ingestion runs locally via Windows Task Scheduler (Supabase IPs are blocked by Reddit).
// Invoked via HTTP POST (by pg_cron, GitHub Actions, or manual trigger).

import { supabaseAdmin } from "../_shared/supabase-client.ts";
import { chatCompletion, generateEmbedding } from "../_shared/openrouter.ts";
import { errorResponse, corsHeaders } from "../_shared/errors.ts";
import { VALID_THEMES, VALID_ACTIVITIES } from "../_shared/types.ts";
import { checkDedup, storeConnections, storeEntityBridges } from "../_shared/auto-link.ts";
import { dreamDedup } from "../_shared/dream-dedup.ts";
import { dreamDecay } from "../_shared/dream-decay.ts";
import { dreamThemes } from "../_shared/dream-themes.ts";
import { dreamSynthesis } from "../_shared/dream-synthesis.ts";
import { resolveEntities } from "../_shared/entities.ts";
import { insertThought } from "../_shared/insert-thought.ts";
import { sendMessage, escapeHtml, getAllowedChatId } from "../_shared/telegram.ts";

const OWNER_BRAIN_ID = Deno.env.get("OWNER_BRAIN_ID") ?? "00000000-0000-4000-a000-000000000001";

// --- Config ---

// --- RSS Feeds split by processing profile ---
// Each category gets its own source dispatch (`rss_newsletters`, `rss_blogs`,
// `rss_aggregators`), invoked in parallel by a GitHub Actions matrix so each
// invocation gets its own 150s idle-timeout budget. See
// docs/superpowers/plans/2026-04-16-run-pipeline-rss-split.md.

const RSS_NEWSLETTERS: Record<string, string> = {
  "Simon Willison": "https://simonwillison.net/atom/everything/",
  "Latent Space": "https://www.latent.space/feed",
  "The Rundown AI": "https://rss.beehiiv.com/feeds/2R3C6Bt5wj.xml",
  "Ahead of AI": "https://magazine.sebastianraschka.com/feed",
  "Interconnects": "https://www.interconnects.ai/feed",
  "Decoding AI": "https://www.decodingai.com/feed",
  "The AI Engineer": "https://theaiengineer.substack.com/feed",
  "Turing Post": "https://turingpost.substack.com/feed",
};

const RSS_AGGREGATORS: Record<string, string> = {
  // Triage-gated: community-moderated content, S/N varies
  "Lobsters": "https://lobste.rs/t/ai,distributed,databases,devops,security,programming.rss",
  "HN Frontpage": "https://hnrss.org/frontpage?points=100",
};

const RSS_BLOGS: Record<string, string> = {
  // Individual technical blogs — curated, low-volume, high-S/N, no gating needed
  "Marc Brooker": "https://brooker.co.za/blog/atom.xml",
  "Julia Evans": "https://jvns.ca/atom.xml",
  "Brendan Gregg": "https://www.brendangregg.com/blog/rss.xml",
  "Phil Eaton": "https://notes.eatonphil.com/rss.xml",
  "Chris Wellons": "https://nullprogram.com/feed/",
  // 2026-04-17: re-added after 3-category split lifted the 15-feed ceiling.
  "rachelbythebay": "https://rachelbythebay.com/w/atom.xml",
  "Eli Bendersky": "https://eli.thegreenplace.net/feeds/all.atom.xml",
  "Hillel Wayne": "https://www.hillelwayne.com/index.xml",
  "Drew DeVault": "https://drewdevault.com/blog/index.xml",
  "Filippo Valsorda": "https://words.filippo.io/rss/",
};

// --- HF Papers Config ---

const HF_DAILY_PAPERS_URL = "https://huggingface.co/api/daily_papers";

const HF_SCREEN_TITLE_TERMS = [
  "language model", "llm", "agent", "reasoning", "embedding",
  "retriev", "code model", "code foundation", "benchmark", "efficient", "hallucin",
  // 2026-04-09: widened to capture architecture, optimization, and evaluation papers
  "transformer", "attention", "pruning", "knowledge", "reward",
  "autoregressive", "test-time", "alignment", "code repair", "program repair",
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
  // 2026-04-09: expanded to catch papers via ai_keywords when title terms miss
  "reinforcement learning", "instruction tuning", "in-context learning",
  "knowledge graph", "knowledge graphs", "semantic search",
  "question answering", "information extraction", "named entity recognition",
  "chain-of-thought", "prompt engineering", "vision-language models",
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
  theme: "ml-research",
  activity: "opinion",
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
    const raw = JSON.parse(result);

    // Handle both flat and nested response formats. gpt-4o-mini sometimes nests
    // fields under "TRIAGE"/"METADATA" keys (interpreting prompt section headers
    // as JSON structure) instead of returning flat top-level fields.
    const triageFields = raw.TRIAGE ?? raw.triage ?? raw;
    const metaFields = raw.METADATA ?? raw.metadata ?? raw;
    // Merge so validateTriageResult sees triage keys at top level
    const parsed = { ...triageFields, ...metaFields };

    const triage = validateTriageResult(parsed, content.slice(0, 200));

    const metadata: Record<string, unknown> = {
      type: typeof parsed.type === "string" ? parsed.type : METADATA_FALLBACK.type,
      relevance: typeof parsed.relevance === "string" ? parsed.relevance : METADATA_FALLBACK.relevance,
      theme: typeof parsed.theme === "string" && (VALID_THEMES as readonly string[]).includes(parsed.theme) ? parsed.theme : "ml-research",
      activity: typeof parsed.activity === "string" && (VALID_ACTIVITIES as readonly string[]).includes(parsed.activity) ? parsed.activity : "opinion",
      topics: Array.isArray(parsed.topics) ? parsed.topics : triage.key_topics,
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      quality: typeof parsed.quality === "number" ? parsed.quality : 0.5,
      people: Array.isArray(parsed.people) ? parsed.people : [],
      action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
      dates_mentioned: Array.isArray(parsed.dates_mentioned) ? parsed.dates_mentioned : [],
    };

    return { triage, metadata };
  } catch (e) {
    const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`combinedTriageAndExtract FAILED: ${errMsg} | content: ${content.slice(0, 100)}`);
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

  // Store entity bridges (post-insert, best-effort)
  if (metadata.entities && Array.isArray(metadata.entities)) {
    await storeEntityBridges(OWNER_BRAIN_ID, result.id);
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
// Cap first-run cold-starts per invocation — prevents bulk feed additions from blowing
// past Supabase's 150s idle timeout. Cold-start is ~25-30s (archive marking + 5 LLM
// captures). One per run is the only safe ceiling when steady-state already consumes
// ~100s on a 20-feed config. Remaining new feeds defer to the next run.
const MAX_COLD_STARTS_PER_RUN = 1;

interface RssProcessOptions {
  gateActionability: boolean;
}

async function processRssFeeds(
  feeds: Record<string, string>,
  options: RssProcessOptions,
): Promise<{ captured: number; skipped: number; failed: number; filtered: number }> {
  const stats = { captured: 0, skipped: 0, failed: 0, filtered: 0 };
  let coldStartsThisRun = 0;

  for (const [feedName, feedUrl] of Object.entries(feeds)) {
    try {
      // Gate cold-start discovery before we even fetch the feed — saves bandwidth on deferred feeds.
      const existingCount = await feedEntryCount(feedUrl);
      if (existingCount === 0 && coldStartsThisRun >= MAX_COLD_STARTS_PER_RUN) {
        console.log(`Deferring cold-start for ${feedName}: per-run cap reached (${MAX_COLD_STARTS_PER_RUN}). Will process on next run.`);
        continue;
      }

      const resp = await fetch(feedUrl, {
        headers: { "User-Agent": "open-brain-pipeline/1.0" },
      });
      if (!resp.ok) {
        console.error(`Feed fetch failed: ${feedName} (${resp.status})`);
        continue;
      }
      const xml = await resp.text();
      let entries = parseRssEntries(xml);

      // Any feed with no prior entries counts against the per-run cap — even tiny feeds
      // (≤MAX_FIRST_RUN entries) still pay cold-start LLM cost for each entry. Previously
      // the counter was gated by `entries.length > MAX_FIRST_RUN`, which let small feeds
      // bypass the cap and produced ~151s hangs when multiple small blogs were added
      // together.
      if (existingCount === 0) {
        coldStartsThisRun++;
      }

      // First-run protection: only process N most recent, mark rest as seen
      if (existingCount === 0 && entries.length > MAX_FIRST_RUN) {
        console.log(`First run for ${feedName}: processing ${MAX_FIRST_RUN} most recent, marking ${entries.length - MAX_FIRST_RUN} as seen`);
        for (const entry of entries.slice(MAX_FIRST_RUN)) {
          const entryId = canonicalEntryId(feedUrl, entry);
          await markProcessed(entryId, `rss-${feedName}-skipped`, feedUrl);
        }
        entries = entries.slice(0, MAX_FIRST_RUN);
      }

      for (const entry of entries.slice(0, 10)) {
        const entryId = canonicalEntryId(feedUrl, entry);

        if (await isProcessed(entryId)) { stats.skipped++; continue; }

        try {
          const rawInput = `${feedName}: ${entry.title}\n\n${(entry.content || entry.summary || "").slice(0, 1500)}`;

          // Combined triage+extraction AND embedding in parallel (2 calls instead of 3)
          const [combined, embedding] = await Promise.all([
            combinedTriageAndExtract(rawInput),
            generateEmbedding(rawInput),
          ]);

          // Actionability gate — mirror HF Papers / Emergent Mind. Critical for community
          // aggregators (HN, Lobsters) where unfiltered signal-to-noise is low.
          // Skipped for curated categories (newsletters, blogs) — saves an LLM call per
          // item and the gate was already a no-op on vetted sources.
          if (options.gateActionability) {
            const actionability = combined.triage.actionability;
            if (actionability === "low" || actionability === "archive") {
              await markProcessed(entryId, "rss-filtered", feedUrl);
              stats.filtered++;
              continue;
            }
          }

          const enriched = formatRssContent(feedName, entry, combined.triage);
          const result = await captureThought(enriched, "rss", entryId, {
            embedding,
            metadata: combined.metadata,
          });
          await markProcessed(entryId, result !== "duplicate" ? "rss" : "rss-dedup", feedUrl);
          if (result !== "duplicate") {
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
        await markProcessed(eventId, result !== "duplicate" ? "hf_papers" : "hf_papers-dedup", "hf_papers");
        if (result !== "duplicate") {
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
        await markProcessed(eventId, result !== "duplicate" ? "emergent_mind" : "emergent_mind-dedup", "emergent_mind");
        if (result !== "duplicate") {
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

// Community aggregators (HN, Lobsters) can expose the same story under multiple feed URLs
// as tag combos or point thresholds shift. Extract stable item IDs so dedup catches repeats
// via `pipeline_processed` before we burn an embedding + triage call. Mirrors the HF↔EM
// arXiv cross-dedup pattern (`wasCaptured`) for URL-based ID matching at ingest time.
function canonicalEntryId(feedUrl: string, entry: RssEntry): string {
  if (feedUrl.includes("hnrss.org") || feedUrl.includes("news.ycombinator.com")) {
    const source = entry.guid || entry.link || "";
    const match = source.match(/[?&]id=(\d+)/);
    if (match) return `hn_${match[1]}`;
  }
  if (feedUrl.includes("lobste.rs")) {
    const source = entry.guid || entry.link || "";
    const match = source.match(/\/s\/([a-z0-9]+)/i);
    if (match) return `lobsters_${match[1]}`;
  }
  return entry.guid || entry.link || `${feedUrl}|${entry.title}`;
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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  // Auth: x-brain-key (MCP/cron callers) or service_role JWT (dashboard/supabase-js)
  const brainKey = req.headers.get("x-brain-key");
  if (brainKey !== Deno.env.get("MCP_ACCESS_KEY")) {
    const apiKey = req.headers.get("apikey") || "";
    const authHeader = req.headers.get("authorization") || "";
    const token = apiKey || authHeader.replace(/^Bearer\s+/i, "");
    let isServiceRole = false;
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      isServiceRole = payload.role === "service_role";
    } catch { /* not a valid JWT */ }
    if (!isServiceRole) {
      return errorResponse("Unauthorized", 401);
    }
  }

  const runStartTime = Date.now();

  // Parse source and options from request body
  let source = "all";
  let runDreamDedup = false;
  let dreamScanDays: number | undefined;
  let runDreamDecay = false;
  let runCoOccurrenceDecay = false;
  let runDreamThemes = false;
  let runDreamSynthesis = false;
  let runSerendipity = false;
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
    if (body.dream_decay === true) {
      runDreamDecay = true;
    }
    if (body.co_occurrence_decay === true) {
      runCoOccurrenceDecay = true;
    }
    if (body.dream_themes === true) {
      runDreamThemes = true;
    }
    if (body.dream_synthesis === true) {
      runDreamSynthesis = true;
    }
    if (body.serendipity === true) {
      runSerendipity = true;
    }
  } catch {
    // Empty body or invalid JSON — default to "all"
  }

  const sources: Record<string, any> = {};
  const validSources = ["rss", "rss_newsletters", "rss_blogs", "rss_aggregators", "hf_papers", "emergent_mind", "all", "none"];
  if (!validSources.includes(source)) {
    return errorResponse(`Invalid source: "${source}". Valid: ${validSources.join(", ")}`, 400);
  }

  let totalCaptured = 0;
  let totalFailed = 0;
  const warnings: string[] = [];

  if (source === "rss_newsletters" || source === "rss" || source === "all") {
    try {
      sources.rss_newsletters = await processRssFeeds(RSS_NEWSLETTERS, { gateActionability: false });
      totalCaptured += sources.rss_newsletters.captured;
      totalFailed += sources.rss_newsletters.failed;
    } catch (e) {
      sources.rss_newsletters_error = e instanceof Error ? e.message : String(e);
    }
  }

  if (source === "rss_blogs" || source === "rss" || source === "all") {
    try {
      sources.rss_blogs = await processRssFeeds(RSS_BLOGS, { gateActionability: false });
      totalCaptured += sources.rss_blogs.captured;
      totalFailed += sources.rss_blogs.failed;
    } catch (e) {
      sources.rss_blogs_error = e instanceof Error ? e.message : String(e);
    }
  }

  if (source === "rss_aggregators" || source === "rss" || source === "all") {
    try {
      sources.rss_aggregators = await processRssFeeds(RSS_AGGREGATORS, { gateActionability: true });
      totalCaptured += sources.rss_aggregators.captured;
      totalFailed += sources.rss_aggregators.failed;
    } catch (e) {
      sources.rss_aggregators_error = e instanceof Error ? e.message : String(e);
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
    const { data } = await supabaseAdmin.rpc("refresh_salience", { p_brain_id: OWNER_BRAIN_ID });
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

  // Dream Cycle Phase D: automated staleness detection & archival (opt-in via dream_decay:true)
  let dreamDecayResult = null;
  if (runDreamDecay) {
    try {
      dreamDecayResult = await dreamDecay(OWNER_BRAIN_ID);
      const archived = dreamDecayResult.tier1_archived + dreamDecayResult.tier2_archived;
      if (archived > 0) {
        console.log(`Dream decay: archived ${archived} stale thought(s)`);
      }
    } catch (e) {
      console.error(`Dream decay failed: ${e}`);
    }
  }

  // Co-occurrence edge decay (opt-in via co_occurrence_decay:true)
  let coOccurrenceDecayResult = null;
  if (runCoOccurrenceDecay) {
    try {
      const { data, error } = await supabaseAdmin.rpc("decay_co_occurrence_edges", {
        p_brain_id: OWNER_BRAIN_ID,
      });
      if (error) throw error;
      coOccurrenceDecayResult = data;
      console.log("Co-occurrence decay:", JSON.stringify(data));
    } catch (err) {
      console.error("Co-occurrence decay failed:", err);
      coOccurrenceDecayResult = { error: String(err) };
    }
  }

  // Dream Cycle Phase B: theme tracking (opt-in via dream_themes:true)
  let dreamThemesResult = null;
  if (runDreamThemes) {
    try {
      dreamThemesResult = await dreamThemes(OWNER_BRAIN_ID);
      if (dreamThemesResult.transitions.length > 0) {
        console.log(`Dream themes: ${dreamThemesResult.transitions.length} lifecycle transition(s)`);
      }
    } catch (e) {
      console.error(`Dream themes failed: ${e}`);
    }
  }

  // Dream Cycle Phase C: insight synthesis (opt-in via dream_synthesis:true)
  let dreamSynthesisResult = null;
  if (runDreamSynthesis) {
    try {
      dreamSynthesisResult = await dreamSynthesis(OWNER_BRAIN_ID);
      if (dreamSynthesisResult.clusters_synthesized > 0) {
        console.log(`Dream synthesis: synthesized ${dreamSynthesisResult.clusters_synthesized} cluster(s)`);
      }
    } catch (e) {
      console.error(`Dream synthesis failed: ${e}`);
    }
  }

  // Serendipity digest → Telegram (opt-in via serendipity:true)
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

  let serendipityResult: { slots_sent: number } | null = null;
  if (runSerendipity) {
    try {
      const { data, error } = await supabaseAdmin.rpc("serendipity_digest", {
        p_brain_id: OWNER_BRAIN_ID,
      });
      if (error) throw error;

      const rows = (data as DigestRow[]) ?? [];
      if (rows.length > 0) {
        const slotConfig: Record<string, { emoji: string; label: string; prompt: string }> = {
          rediscovery: {
            emoji: "💎",
            label: "Forgotten gem",
            prompt: "Still relevant? Has your thinking evolved since this was captured?",
          },
          orphan: {
            emoji: "🏝️",
            label: "Isolated thought",
            prompt: "This has zero connections. Does it relate to anything you're working on now?",
          },
          underrepresented: {
            emoji: "🔍",
            label: "Neglected theme",
            prompt: "This theme has the fewest thoughts. Blind spot or intentional deprioritization?",
          },
          echo: {
            emoji: "🔄",
            label: "Pattern signal",
            prompt: "This older thought echoes something you captured recently. Convergence worth exploring?",
          },
        };

        const fallbackConfig = { emoji: "✨", label: "Resurface", prompt: "" };

        const sections = rows.map((r) => {
          const cfg = slotConfig[r.slot] ?? fallbackConfig;
          const age = Math.floor(
            (Date.now() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24),
          );
          const truncated = r.content.length > 300
            ? r.content.slice(0, 300) + "…"
            : r.content;
          const meta = [
            r.theme ? `<code>${escapeHtml(r.theme)}</code>` : null,
            r.source,
            `${age}d ago`,
            r.quality != null ? `q:${r.quality.toFixed(1)}` : null,
          ].filter(Boolean).join(" · ");

          return [
            `${cfg.emoji} <b>${escapeHtml(cfg.label)}</b>`,
            `${escapeHtml(truncated)}`,
            meta,
            `<i>${cfg.prompt}</i>`,
          ].join("\n");
        });

        const message = `🔮 <b>Serendipity Digest</b>\n\n${sections.join("\n\n──────────\n\n")}`;
        await sendMessage(getAllowedChatId(), message);
        serendipityResult = { slots_sent: rows.length };
        console.log(`Serendipity: sent ${rows.length} slot(s) to Telegram`);
      } else {
        serendipityResult = { slots_sent: 0 };
        console.log("Serendipity: no thoughts available, skipping Telegram");
      }
    } catch (e) {
      console.error(`Serendipity digest failed: ${e}`);
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
      p_dream_decay: dreamDecayResult,
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
      dream_decay: dreamDecayResult,
      co_occurrence_decay: coOccurrenceDecayResult,
      dream_themes: dreamThemesResult,
      dream_synthesis: dreamSynthesisResult,
      serendipity: serendipityResult,
      timestamp: new Date().toISOString(),
    }),
    { headers: { "Content-Type": "application/json", ...corsHeaders } },
  );
});
