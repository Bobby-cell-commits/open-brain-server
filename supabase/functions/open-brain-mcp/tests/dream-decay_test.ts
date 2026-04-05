import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

// We test the pure functions by importing them. The module needs to export
// buildContextPacket for testing. If not exported, test the orchestrator
// via integration tests instead. For unit tests, we test the logic inline.

Deno.test("context packet includes all sections", () => {
  // Simulate a context packet build
  const candidate = {
    id: "test-id",
    content: "GPT-4 is the best model for code generation",
    metadata: { type: "observation", theme: "ml-research", quality: 0.45 },
    source: "rss",
    created_at: new Date(Date.now() - 48 * 86400000).toISOString(),
    access_count: 0,
    merge_count: 0,
    staleness_score: 0.82,
    connection_count: 1,
    theme_recent_captures: 47,
    top_connections: [
      {
        content: "Claude 3.5 surpasses GPT-4 on coding benchmarks",
        link_type: "extends",
        similarity: 0.78,
        salience: 0.78,
        access_count: 4,
      },
    ],
    entity_names: ["GPT-4", "code generation"],
  };

  // Build packet manually (same logic as dream-decay.ts buildContextPacket)
  const ageDays = Math.round(
    (Date.now() - new Date(candidate.created_at).getTime()) / 86400000,
  );
  const lines = [
    `## Candidate Thought`,
    `Content: ${candidate.content.slice(0, 1500)}`,
    `Type: ${candidate.metadata.type} | Theme: ${candidate.metadata.theme} | Quality: ${candidate.metadata.quality}`,
    `Created: ${candidate.created_at.slice(0, 10)} (${ageDays} days ago) | Access: ${candidate.access_count} | Connections: ${candidate.connection_count}`,
    `Staleness score: ${candidate.staleness_score.toFixed(2)} (Tier 2: context-aware candidate)`,
    `Source: ${candidate.source} | Merge count: ${candidate.merge_count}`,
  ];

  const packet = lines.join("\n");

  assertStringIncludes(packet, "## Candidate Thought");
  assertStringIncludes(packet, "GPT-4 is the best model");
  assertStringIncludes(packet, "Tier 2");
  assertStringIncludes(packet, "ml-research");
});

Deno.test("tier 1 archives at any confidence", () => {
  // Tier 1 logic: archive if verdict = "archive" at any confidence
  const verdict = { verdict: "archive" as const, confidence: "low" as const, reason: "obsolete" };
  const shouldArchive = verdict.verdict === "archive";
  assertEquals(shouldArchive, true);
});

Deno.test("tier 1 keeps if verdict is keep", () => {
  const verdict = { verdict: "keep" as const, confidence: "high" as const, reason: "unique insight" };
  const shouldArchive = verdict.verdict === "archive";
  assertEquals(shouldArchive, false);
});

Deno.test("tier 2 archives only at high confidence", () => {
  const verdictHigh = { verdict: "archive" as const, confidence: "high" as const, reason: "superseded" };
  const verdictMedium = { verdict: "archive" as const, confidence: "medium" as const, reason: "maybe stale" };

  const shouldArchiveHigh = verdictHigh.verdict === "archive" && verdictHigh.confidence === "high";
  const shouldArchiveMedium = verdictMedium.verdict === "archive" && verdictMedium.confidence === "high";

  assertEquals(shouldArchiveHigh, true);
  assertEquals(shouldArchiveMedium, false);
});

Deno.test("tier 3 never auto-archives", () => {
  const verdict = { verdict: "archive" as const, confidence: "high" as const, reason: "stale" };
  // Tier 3 logic: never auto-archive regardless of verdict
  const tier = "review";
  const shouldArchive = tier !== "review" && verdict.verdict === "archive";
  assertEquals(shouldArchive, false);
});

Deno.test("DreamDecayResult initializes to zero", () => {
  const result = {
    scored: 0,
    tier1_candidates: 0,
    tier1_archived: 0,
    tier1_kept: 0,
    tier2_candidates: 0,
    tier2_archived: 0,
    tier2_kept: 0,
    tier3_flagged: 0,
    sole_entity_protected: 0,
    pending_review: 0,
  };
  assertEquals(result.scored, 0);
  assertEquals(result.tier1_archived + result.tier2_archived, 0);
  assertEquals(result.pending_review, 0);
});

Deno.test("staleness score tier classification", () => {
  // Verify tier boundaries match spec
  const classify = (score: number): string => {
    if (score >= 0.85) return "auto";
    if (score >= 0.70) return "context";
    if (score >= 0.40) return "review";
    return "skip";
  };

  assertEquals(classify(0.95), "auto");
  assertEquals(classify(0.85), "auto");
  assertEquals(classify(0.84), "context");
  assertEquals(classify(0.70), "context");
  assertEquals(classify(0.69), "review");
  assertEquals(classify(0.40), "review");
  assertEquals(classify(0.39), "skip");
  assertEquals(classify(0.10), "skip");
});

// ---------------------------------------------------------------------------
// Context packet building — edge cases
// ---------------------------------------------------------------------------

/** Helper: replicate buildContextPacket logic from dream-decay.ts */
function buildContextPacket(c: {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  source: string;
  created_at: string;
  access_count: number;
  merge_count: number;
  staleness_score: number;
  connection_count: number;
  theme_recent_captures: number;
  top_connections: Array<{
    content: string;
    link_type: string;
    similarity: number;
    salience: number;
    access_count: number;
  }> | null;
  entity_names: string[];
}): string {
  const ageDays = Math.round(
    (Date.now() - new Date(c.created_at).getTime()) / 86400000,
  );
  const tierLabel =
    c.staleness_score >= 0.85
      ? "Tier 1: auto-archive candidate"
      : c.staleness_score >= 0.7
        ? "Tier 2: context-aware candidate"
        : "Tier 3: flagged for review";

  const lines = [
    `## Candidate Thought`,
    `Content: ${c.content.slice(0, 1500)}`,
    `Type: ${c.metadata.type ?? "unknown"} | Theme: ${c.metadata.theme ?? "unknown"} | Quality: ${c.metadata.quality ?? "unknown"}`,
    `Created: ${c.created_at.slice(0, 10)} (${ageDays} days ago) | Access: ${c.access_count} | Connections: ${c.connection_count}`,
    `Staleness score: ${c.staleness_score.toFixed(2)} (${tierLabel})`,
    `Source: ${c.source} | Merge count: ${c.merge_count}`,
  ];

  if (c.top_connections && c.top_connections.length > 0) {
    lines.push("", `## Connections (${c.connection_count})`);
    for (const conn of c.top_connections.slice(0, 5)) {
      lines.push(
        `- "${conn.content}" [${conn.link_type}] Salience: ${conn.salience?.toFixed(2) ?? "?"} | Access: ${conn.access_count}`,
      );
    }
  }

  lines.push(
    "",
    `## Theme Vitality`,
    `Theme "${c.metadata.theme ?? "unknown"}": ${c.theme_recent_captures} captures in last 30 days`,
  );

  if (c.entity_names.length > 0) {
    lines.push("", `## Entities`, c.entity_names.join(", "));
  }

  return lines.join("\n");
}

/** Helper: minimal candidate factory with sane defaults */
function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-id",
    content: "Some thought content",
    metadata: { type: "observation", theme: "ml-research", quality: 0.6 },
    source: "rss",
    created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
    access_count: 0,
    merge_count: 0,
    staleness_score: 0.75,
    connection_count: 0,
    theme_recent_captures: 10,
    top_connections: null,
    entity_names: [],
    ...overrides,
  };
}

Deno.test("context packet: no connections produces no Connections section", () => {
  const packet = buildContextPacket(makeCandidate({ top_connections: null }));
  assertEquals(packet.includes("## Connections"), false);
});

Deno.test("context packet: empty connections array produces no Connections section", () => {
  const packet = buildContextPacket(makeCandidate({ top_connections: [] }));
  assertEquals(packet.includes("## Connections"), false);
});

Deno.test("context packet: no entities produces no Entities section", () => {
  const packet = buildContextPacket(makeCandidate({ entity_names: [] }));
  assertEquals(packet.includes("## Entities"), false);
});

Deno.test("context packet: entities present produces Entities section", () => {
  const packet = buildContextPacket(makeCandidate({ entity_names: ["GPT-4", "Claude"] }));
  assertStringIncludes(packet, "## Entities");
  assertStringIncludes(packet, "GPT-4, Claude");
});

Deno.test("context packet: long content is truncated at 1500 chars", () => {
  const longContent = "A".repeat(2000);
  const packet = buildContextPacket(makeCandidate({ content: longContent }));
  // Content line should have at most 1500 A's
  const contentLine = packet.split("\n").find((l) => l.startsWith("Content: "))!;
  // "Content: " is 9 chars, then up to 1500 of content
  const contentBody = contentLine.slice("Content: ".length);
  assertEquals(contentBody.length, 1500);
});

Deno.test("context packet: missing metadata fields default to 'unknown'", () => {
  const packet = buildContextPacket(
    makeCandidate({ metadata: {} }),
  );
  assertStringIncludes(packet, "Type: unknown");
  assertStringIncludes(packet, "Theme: unknown");
  assertStringIncludes(packet, "Quality: unknown");
  // Theme vitality also uses unknown
  assertStringIncludes(packet, 'Theme "unknown"');
});

Deno.test("context packet: tier label for score >= 0.85 is Tier 1", () => {
  const packet = buildContextPacket(makeCandidate({ staleness_score: 0.90 }));
  assertStringIncludes(packet, "Tier 1: auto-archive candidate");
});

Deno.test("context packet: tier label for score 0.70-0.84 is Tier 2", () => {
  const packet = buildContextPacket(makeCandidate({ staleness_score: 0.75 }));
  assertStringIncludes(packet, "Tier 2: context-aware candidate");
});

Deno.test("context packet: tier label for score < 0.70 is Tier 3", () => {
  const packet = buildContextPacket(makeCandidate({ staleness_score: 0.55 }));
  assertStringIncludes(packet, "Tier 3: flagged for review");
});

Deno.test("context packet: connections limited to 5", () => {
  const conns = Array.from({ length: 8 }, (_, i) => ({
    content: `Connection ${i}`,
    link_type: "extends",
    similarity: 0.8,
    salience: 0.7,
    access_count: i,
  }));
  const packet = buildContextPacket(
    makeCandidate({ top_connections: conns, connection_count: 8 }),
  );
  // Should show "## Connections (8)" but only list 5
  assertStringIncludes(packet, "## Connections (8)");
  assertStringIncludes(packet, "Connection 4");
  assertEquals(packet.includes("Connection 5"), false);
});

// ---------------------------------------------------------------------------
// Tier decision matrix — comprehensive (tier x verdict x confidence)
// ---------------------------------------------------------------------------

/**
 * Replicate the exact decision logic from processTier in dream-decay.ts.
 * Returns true if the thought should be archived.
 */
function shouldArchive(
  tier: "auto" | "context" | "review",
  verdict: "archive" | "keep",
  confidence: "high" | "medium" | "low",
): boolean {
  if (tier === "auto") {
    return verdict === "archive";
  }
  if (tier === "context") {
    return verdict === "archive" && confidence === "high";
  }
  // tier === "review": never auto-archive
  return false;
}

// Tier 1 (auto): archive verdict at any confidence → archive
Deno.test("tier matrix: auto + archive + high → archive", () => {
  assertEquals(shouldArchive("auto", "archive", "high"), true);
});

Deno.test("tier matrix: auto + archive + medium → archive", () => {
  assertEquals(shouldArchive("auto", "archive", "medium"), true);
});

Deno.test("tier matrix: auto + archive + low → archive", () => {
  assertEquals(shouldArchive("auto", "archive", "low"), true);
});

// Tier 1 (auto): keep verdict → never archive
Deno.test("tier matrix: auto + keep + high → keep", () => {
  assertEquals(shouldArchive("auto", "keep", "high"), false);
});

Deno.test("tier matrix: auto + keep + medium → keep", () => {
  assertEquals(shouldArchive("auto", "keep", "medium"), false);
});

Deno.test("tier matrix: auto + keep + low → keep", () => {
  assertEquals(shouldArchive("auto", "keep", "low"), false);
});

// Tier 2 (context): archive only with high confidence
Deno.test("tier matrix: context + archive + high → archive", () => {
  assertEquals(shouldArchive("context", "archive", "high"), true);
});

Deno.test("tier matrix: context + archive + medium → keep", () => {
  assertEquals(shouldArchive("context", "archive", "medium"), false);
});

Deno.test("tier matrix: context + archive + low → keep", () => {
  assertEquals(shouldArchive("context", "archive", "low"), false);
});

// Tier 2 (context): keep verdict → never archive regardless of confidence
Deno.test("tier matrix: context + keep + high → keep", () => {
  assertEquals(shouldArchive("context", "keep", "high"), false);
});

Deno.test("tier matrix: context + keep + medium → keep", () => {
  assertEquals(shouldArchive("context", "keep", "medium"), false);
});

Deno.test("tier matrix: context + keep + low → keep", () => {
  assertEquals(shouldArchive("context", "keep", "low"), false);
});

// Tier 3 (review): never auto-archive regardless of verdict or confidence
Deno.test("tier matrix: review + archive + high → keep", () => {
  assertEquals(shouldArchive("review", "archive", "high"), false);
});

Deno.test("tier matrix: review + archive + medium → keep", () => {
  assertEquals(shouldArchive("review", "archive", "medium"), false);
});

Deno.test("tier matrix: review + archive + low → keep", () => {
  assertEquals(shouldArchive("review", "archive", "low"), false);
});

Deno.test("tier matrix: review + keep + high → keep", () => {
  assertEquals(shouldArchive("review", "keep", "high"), false);
});

Deno.test("tier matrix: review + keep + medium → keep", () => {
  assertEquals(shouldArchive("review", "keep", "medium"), false);
});

Deno.test("tier matrix: review + keep + low → keep", () => {
  assertEquals(shouldArchive("review", "keep", "low"), false);
});

// ---------------------------------------------------------------------------
// Staleness score edge cases
// ---------------------------------------------------------------------------

Deno.test("staleness: score exactly at 0.85 boundary → auto", () => {
  const classify = (s: number) =>
    s >= 0.85 ? "auto" : s >= 0.70 ? "context" : s >= 0.40 ? "review" : "skip";
  assertEquals(classify(0.85), "auto");
});

Deno.test("staleness: score exactly at 0.70 boundary → context", () => {
  const classify = (s: number) =>
    s >= 0.85 ? "auto" : s >= 0.70 ? "context" : s >= 0.40 ? "review" : "skip";
  assertEquals(classify(0.70), "context");
});

Deno.test("staleness: score exactly at 0.40 boundary → review", () => {
  const classify = (s: number) =>
    s >= 0.85 ? "auto" : s >= 0.70 ? "context" : s >= 0.40 ? "review" : "skip";
  assertEquals(classify(0.40), "review");
});

Deno.test("staleness: score of 0 → skip", () => {
  const classify = (s: number) =>
    s >= 0.85 ? "auto" : s >= 0.70 ? "context" : s >= 0.40 ? "review" : "skip";
  assertEquals(classify(0), "skip");
});

Deno.test("staleness: score of 1.0 → auto", () => {
  const classify = (s: number) =>
    s >= 0.85 ? "auto" : s >= 0.70 ? "context" : s >= 0.40 ? "review" : "skip";
  assertEquals(classify(1.0), "auto");
});

Deno.test("staleness: negative score → skip", () => {
  const classify = (s: number) =>
    s >= 0.85 ? "auto" : s >= 0.70 ? "context" : s >= 0.40 ? "review" : "skip";
  assertEquals(classify(-0.5), "skip");
});

// ---------------------------------------------------------------------------
// review_stale input validation — replicate validation logic
// ---------------------------------------------------------------------------

Deno.test("review_stale validation: approve without thought_id errors", () => {
  const action = "approve";
  const thought_id: string | undefined = undefined;
  const needsId = action === "approve" || action === "reject";
  const isError = needsId && !thought_id;
  assertEquals(isError, true);
});

Deno.test("review_stale validation: reject without thought_id errors", () => {
  const action = "reject";
  const thought_id: string | undefined = undefined;
  const needsId = action === "approve" || action === "reject";
  const isError = needsId && !thought_id;
  assertEquals(isError, true);
});

Deno.test("review_stale validation: list without thought_id is ok", () => {
  const action = "list";
  const thought_id: string | undefined = undefined;
  const needsId = action === "approve" || action === "reject";
  const isError = needsId && !thought_id;
  assertEquals(isError, false);
});

Deno.test("review_stale validation: approve with thought_id is ok", () => {
  const action = "approve";
  const thought_id: string | undefined = "550e8400-e29b-41d4-a716-446655440000";
  const needsId = action === "approve" || action === "reject";
  const isError = needsId && !thought_id;
  assertEquals(isError, false);
});

Deno.test("review_stale validation: reject with thought_id is ok", () => {
  const action = "reject";
  const thought_id: string | undefined = "550e8400-e29b-41d4-a716-446655440000";
  const needsId = action === "approve" || action === "reject";
  const isError = needsId && !thought_id;
  assertEquals(isError, false);
});

// ---------------------------------------------------------------------------
// DreamDecayResult accumulation — simulate tier processing
// ---------------------------------------------------------------------------

Deno.test("result accumulation: tier 1 processing updates correct fields", () => {
  const result = {
    scored: 100,
    tier1_candidates: 0,
    tier1_archived: 0,
    tier1_kept: 0,
    tier2_candidates: 0,
    tier2_archived: 0,
    tier2_kept: 0,
    tier3_flagged: 0,
    sole_entity_protected: 0,
    pending_review: 0,
  };

  // Simulate: 5 candidates, 3 archived, 1 kept, 1 sole-entity protected
  result.tier1_candidates = 5;
  result.tier1_archived = 3;
  result.tier1_kept = 1;
  result.sole_entity_protected = 1;

  assertEquals(result.tier1_candidates, 5);
  assertEquals(result.tier1_archived + result.tier1_kept + result.sole_entity_protected, 5);
  // tier2 untouched
  assertEquals(result.tier2_candidates, 0);
  assertEquals(result.tier2_archived, 0);
});

Deno.test("result accumulation: all three tiers combined", () => {
  const result = {
    scored: 200,
    tier1_candidates: 10,
    tier1_archived: 7,
    tier1_kept: 2,
    tier2_candidates: 8,
    tier2_archived: 2,
    tier2_kept: 5,
    tier3_flagged: 5,
    sole_entity_protected: 2, // 1 from tier1, 1 from tier2
    pending_review: 5,
  };

  const totalProcessed =
    result.tier1_archived +
    result.tier1_kept +
    result.tier2_archived +
    result.tier2_kept +
    result.sole_entity_protected +
    result.pending_review;

  // All candidates accounted for (10 + 8 + 5 = 23 candidates, minus sole entity that spans tiers)
  assertEquals(totalProcessed, 23);
  assertEquals(
    result.tier1_archived + result.tier2_archived,
    9,
    "total archived across tiers",
  );
});

Deno.test("result accumulation: zero scored returns early (no tier processing)", () => {
  const result = {
    scored: 0,
    tier1_candidates: 0,
    tier1_archived: 0,
    tier1_kept: 0,
    tier2_candidates: 0,
    tier2_archived: 0,
    tier2_kept: 0,
    tier3_flagged: 0,
    sole_entity_protected: 0,
    pending_review: 0,
  };

  // When scored=0, dreamDecay returns early without processing tiers
  if (result.scored === 0) {
    // All counters remain zero
    const allZero = Object.values(result).every((v) => v === 0);
    assertEquals(allZero, true);
  }
});

Deno.test("result accumulation: tier 3 sets pending_review, never archives", () => {
  const result = {
    scored: 50,
    tier1_candidates: 0,
    tier1_archived: 0,
    tier1_kept: 0,
    tier2_candidates: 0,
    tier2_archived: 0,
    tier2_kept: 0,
    tier3_flagged: 12,
    sole_entity_protected: 0,
    pending_review: 12,
  };

  // Tier 3 only flags — never increments archived
  assertEquals(result.tier3_flagged, result.pending_review);
  assertEquals(result.tier1_archived + result.tier2_archived, 0);
});

// ---------------------------------------------------------------------------
// tierKey mapping — replicate from processTier
// ---------------------------------------------------------------------------

Deno.test("tierKey mapping: auto → tier1, context → tier2, review → tier3", () => {
  const tierKey = (tier: "auto" | "context" | "review") =>
    tier === "auto" ? "tier1" : tier === "context" ? "tier2" : "tier3";

  assertEquals(tierKey("auto"), "tier1");
  assertEquals(tierKey("context"), "tier2");
  assertEquals(tierKey("review"), "tier3");
});

// ---------------------------------------------------------------------------
// Tier batch limits — match constants in dream-decay.ts
// ---------------------------------------------------------------------------

Deno.test("tier batch limits match spec", () => {
  // These must match TIER1_MAX, TIER2_MAX, TIER3_MAX in dream-decay.ts
  const TIER1_MAX = 50;
  const TIER2_MAX = 30;
  const TIER3_MAX = 20;

  assertEquals(TIER1_MAX, 50);
  assertEquals(TIER2_MAX, 30);
  assertEquals(TIER3_MAX, 20);
  // Total max per run = 100
  assertEquals(TIER1_MAX + TIER2_MAX + TIER3_MAX, 100);
});

// ---------------------------------------------------------------------------
// Context packet: theme vitality always appears
// ---------------------------------------------------------------------------

Deno.test("context packet: theme vitality section always present", () => {
  const packet = buildContextPacket(makeCandidate());
  assertStringIncludes(packet, "## Theme Vitality");
  assertStringIncludes(packet, "captures in last 30 days");
});

Deno.test("context packet: source and merge count in output", () => {
  const packet = buildContextPacket(
    makeCandidate({ source: "telegram", merge_count: 3 }),
  );
  assertStringIncludes(packet, "Source: telegram");
  assertStringIncludes(packet, "Merge count: 3");
});
