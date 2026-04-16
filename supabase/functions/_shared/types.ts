export const EMBEDDING_DIMENSIONS = 1536;

export const CO_OCCURRENCE_WEIGHTS: Record<string, number> = {
  search_thoughts: 1.0,
  deep_search: 1.0,
  list_thoughts: 0.5,
  get_connections: 0.0,
  weekly_review: 0.0,
};

export interface ActionItem {
  task: string;
  assignee: string | null;
  due: string | null;
}

export interface ThoughtMetadata {
  people: string[];
  topics: string[];
  type: string;
  theme?: string;
  activity?: string;
  relevance?: string;
  action_items: ActionItem[];
  dates_mentioned: string[];
  [key: string]: unknown; // LLM may add extra fields
}

export interface ConnectionResult {
  thought_id: string;
  content_preview: string;
  similarity: number;
}

export interface DedupResult {
  merged: boolean;
  originalId?: string;
  originalContentPreview?: string;
  similarity?: number;
}

export interface DreamDedupResult {
  scanned: number;
  pairs_found: number;
  auto_merged: number;
  llm_confirmed: number;
  llm_rejected: number;
  llm_failed: number;
  deleted: number;
}

export interface DreamDecayResult {
  scored: number;
  tier1_candidates: number;
  tier1_archived: number;
  tier1_kept: number;
  tier2_candidates: number;
  tier2_archived: number;
  tier2_kept: number;
  tier3_flagged: number;
  sole_entity_protected: number;
  pending_review: number;
}

export interface DreamThemesResult {
  themes_processed: number;
  thoughts_assigned: number;
  transitions: Array<{ theme: string; from: string; to: string }>;
  snapshot_date: string;
}

export interface DreamSynthesisResult {
  clusters_found: number;
  clusters_synthesized: number;
  clusters_skipped_low_coverage: number;
  avg_coverage: number;
  avg_cluster_size: number;
  shadow_deltas: number[] | null;  // first 4 weeks: separated vs combined coverage delta
}

export interface EntityMention {
  name: string;
  type: "person" | "project" | "tool" | "organization";
  role: "mention" | "author" | "about";
}

export interface EntityResult {
  id: string;
  name: string;
  entity_type: string;
  aliases: string[];
  thought_count: number;
}

export const VALID_THEMES = [
  "ml-research", "developer-experience", "ai-coding-tools", "knowledge-systems",
  "infrastructure", "industry-trends", "hardware-systems", "tech-economics",
  "security", "scientific-computing", "regulation-policy",
] as const;

export const VALID_ACTIVITIES = [
  "research-paper", "community-discussion", "project-showcase", "announcement",
  "industry-report", "opinion", "career-personal", "tutorial",
] as const;

/** Validate and fill missing fields on LLM-extracted metadata. */
export function validateMetadata(raw: Record<string, unknown>): ThoughtMetadata {
  const rawTheme = typeof raw.theme === "string" ? raw.theme : "";
  const rawActivity = typeof raw.activity === "string" ? raw.activity : "";
  return {
    type: typeof raw.type === "string" ? raw.type : "observation",
    relevance: typeof raw.relevance === "string" ? raw.relevance : "",
    theme: (VALID_THEMES as readonly string[]).includes(rawTheme) ? rawTheme : "ml-research",
    activity: (VALID_ACTIVITIES as readonly string[]).includes(rawActivity) ? rawActivity : "opinion",
    topics: Array.isArray(raw.topics) ? raw.topics : [],
    entities: Array.isArray(raw.entities) ? raw.entities : [],
    quality: typeof raw.quality === "number" ? raw.quality : 0.5,
    people: Array.isArray(raw.people) ? raw.people : [],
    action_items: Array.isArray(raw.action_items) ? raw.action_items : [],
    dates_mentioned: Array.isArray(raw.dates_mentioned) ? raw.dates_mentioned : [],
  };
}

export interface ConnectionTypingResult {
  link_type: "extends" | "contradicts" | "is-evidence-for" | "supersedes" | "related";
  reason: string;
}
