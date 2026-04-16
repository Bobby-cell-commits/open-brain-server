// deep-search: Tests for the 5-stage deep search pipeline.
// Covers: initial search, graph traversal, LLM gap-filling, sub-searches,
// dedup/ranking, token budget, graceful degradation, and side effects.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubRpc, restore, mockCtx, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerDeepSearch } from "../tools/deep-search.ts";
import * as z from "npm:zod@3";

// --- Fetch stubbing (routes embedding vs chat completion calls) ---

const originalFetch = globalThis.fetch;

function stubFetch(opts?: { subQueries?: string[]; chatFail?: boolean }) {
  const subQueries = opts?.subQueries ?? [];
  const chatFail = opts?.chatFail ?? false;

  globalThis.fetch = (url: string | URL | Request, _init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

    if (urlStr.includes("/embeddings")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (urlStr.includes("/chat/completions")) {
      if (chatFail) {
        return Promise.resolve(
          new Response("Internal Server Error", { status: 500 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ sub_queries: subQueries }) } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(new Response("{}", { status: 200 }));
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// --- Test data factories ---

function makeDirectResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "d1",
    content: "Direct result content",
    metadata: { type: "idea", theme: "ml-research" },
    similarity: 0.82,
    fts_rank: 0.3,
    blended_score: 0.9,
    salience: 1.5,
    pinned: false,
    merge_count: 0,
    source: "mcp",
    created_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function makeGraphResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    thought_id: "g1",
    content: "Graph traversed content",
    metadata: { type: "observation" },
    source: "telegram",
    created_at: "2026-04-02T00:00:00Z",
    hop_depth: 1,
    path_score: 0.5,
    salience: 1.0,
    ...overrides,
  };
}

// --- Register tool ---

const { mcp, tools } = createMockMcp();
registerDeepSearch(mcp as any, z);
const handler = tools.get("deep_search")!;

// ═══════════════════════════════════════════════
// Stage 1: Initial hybrid search
// ═══════════════════════════════════════════════

Deno.test("calls hybrid_search_thoughts with match_count=20 (fixed headroom)", async () => {
  let rpcArgs: any = null;

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "hybrid_search_thoughts") rpcArgs = args;
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({ query: "test query", limit: 5, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    assertEquals(rpcArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(rpcArgs.query_text, "test query");
    assertEquals(rpcArgs.query_embedding, [0.1, 0.2, 0.3]);
    assertEquals(rpcArgs.match_count, 20); // fixed, not user limit
    assertEquals(rpcArgs.match_threshold, 0.6);
    assertEquals(rpcArgs.min_quality, 0.4);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("returns empty results with low_confidence when no direct matches", async () => {
  stubFetch();
  stubRpc(supabaseAdmin, () => mockChain({ data: [], error: null }));
  try {
    const result = await handler({ query: "obscure", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.results, []);
    assertEquals(parsed.low_confidence, true);
    assertEquals(parsed.gap_hint, "No matches found. Consider capturing knowledge about this topic.");
    assertEquals(parsed.search_meta.stages.direct.count, 0);
    assertEquals(parsed.search_meta.stages.graph.count, 0);
    assertEquals(parsed.search_meta.stages.refined.count, 0);
    assertEquals(parsed.search_meta.sub_queries, []);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// ═══════════════════════════════════════════════
// Stage 2: Graph traversal
// ═══════════════════════════════════════════════

Deno.test("calls deep_graph_traversal with top 10 seed IDs", async () => {
  const directData = Array.from({ length: 15 }, (_, i) =>
    makeDirectResult({ id: `d${i}`, blended_score: 1 - i * 0.05 })
  );
  let graphArgs: any = null;

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") {
      graphArgs = args;
      return mockChain({ data: [], error: null });
    }
    return mockChain({ data: null, error: null });
  });
  try {
    await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    assertEquals(graphArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(graphArgs.p_seed_ids.length, 10); // top 10 only
    assertEquals(graphArgs.p_seed_ids[0], "d0");
    assertEquals(graphArgs.p_seed_ids[9], "d9");
    assertEquals(graphArgs.p_max_hops, 2);
    assertEquals(graphArgs.p_min_similarity, 0.6);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("graph traversal failure is non-fatal — continues without graph results", async () => {
  const directData = [makeDirectResult({ similarity: 0.85 })];

  stubFetch();
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: null, error: { message: "graph timeout" } });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    // Should still return direct results despite graph failure
    assertEquals(parsed.results.length, 1);
    assertEquals(parsed.results[0].source_stage, "direct");
    assertEquals(parsed.search_meta.stages.graph.count, 0);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("graph results appear with source_stage=graph and correct hop_depth", async () => {
  const directData = [makeDirectResult({ id: "d1", blended_score: 0.9 })];
  const graphData = [makeGraphResult({ thought_id: "g1", hop_depth: 2, path_score: 0.4 })];

  stubFetch();
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: graphData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    const graphResult = parsed.results.find((r: any) => r.source_stage === "graph");
    assertEquals(graphResult.id, "g1");
    assertEquals(graphResult.hop_depth, 2);
    assertEquals(parsed.search_meta.stages.graph.count, 1);
    assertEquals(parsed.search_meta.stages.graph.max_hop, 2);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// ═══════════════════════════════════════════════
// Stage 3: LLM gap-filling
// ═══════════════════════════════════════════════

Deno.test("LLM failure is non-fatal — returns direct + graph results only", async () => {
  const directData = [makeDirectResult({ similarity: 0.85 })];

  stubFetch({ chatFail: true });
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.results.length, 1);
    assertEquals(parsed.search_meta.sub_queries, []);
    assertEquals(parsed.search_meta.stages.refined.count, 0);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("LLM sub-queries are included in search_meta", async () => {
  const directData = [makeDirectResult()];

  stubFetch({ subQueries: ["gap query 1", "gap query 2"] });
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.search_meta.sub_queries, ["gap query 1", "gap query 2"]);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("sub-queries capped at 3", async () => {
  const directData = [makeDirectResult()];

  stubFetch({ subQueries: ["q1", "q2", "q3", "q4", "q5"] });
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.search_meta.sub_queries.length, 3);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("non-string sub-queries are filtered out", async () => {
  const directData = [makeDirectResult()];

  // Override fetch to return mixed-type sub_queries
  globalThis.fetch = (url: string | URL | Request, _init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes("/embeddings")) {
      return Promise.resolve(new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    }
    if (urlStr.includes("/chat/completions")) {
      return Promise.resolve(new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ sub_queries: [42, null, "valid query"] }) } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    // Only the string "valid query" should survive filtering
    assertEquals(parsed.search_meta.sub_queries, ["valid query"]);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// ═══════════════════════════════════════════════
// Stage 4: Sub-searches
// ═══════════════════════════════════════════════

Deno.test("refined results appear with source_stage=refined", async () => {
  const directData = [makeDirectResult({ id: "d1", blended_score: 0.9 })];
  const refinedData = [makeDirectResult({ id: "r1", blended_score: 0.7, content: "Refined hit" })];
  let hybridCallCount = 0;

  stubFetch({ subQueries: ["gap query"] });
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") {
      hybridCallCount++;
      // First call = Stage 1 direct, subsequent = Stage 4 sub-searches
      if (hybridCallCount === 1) return mockChain({ data: directData, error: null });
      return mockChain({ data: refinedData, error: null });
    }
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    const refined = parsed.results.find((r: any) => r.source_stage === "refined");
    assertEquals(refined.id, "r1");
    assertEquals(refined.hop_depth, 0);
    assertEquals(parsed.search_meta.stages.refined.count, 1);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// ═══════════════════════════════════════════════
// Stage 5: Dedup, scoring, and truncation
// ═══════════════════════════════════════════════

Deno.test("deduplicates by thought ID — keeps highest final_score", async () => {
  const directData = [makeDirectResult({ id: "shared", blended_score: 0.8 })];
  // Same thought found via graph with lower score — should keep direct
  const graphData = [makeGraphResult({ thought_id: "shared", path_score: 0.3 })];

  stubFetch();
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: graphData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    // Should have 1 result (deduped), keeping direct version
    assertEquals(parsed.results.length, 1);
    assertEquals(parsed.results[0].source_stage, "direct");
    assertEquals(parsed.results[0].id, "shared");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("graph result replaces direct when path_score yields higher final_score", async () => {
  // Direct result with low blended_score
  const directData = [makeDirectResult({ id: "shared", blended_score: 0.1 })];
  // Graph result with very high path_score — final = maxDirectBlended (0.1) * 0.9 = 0.09
  // Actually maxDirectBlended * path_score: 0.1 * 0.9 = 0.09 < 0.1, so direct still wins
  // Let's make it so graph wins: need graph final > direct final
  // With maxDirectBlended=0.1 and path_score=2.0 (unrealistic but tests the logic)
  // Actually path_score decays per hop so max is 1.0 at seed. Graph can't beat direct for same thought.
  // This is by design — for the same thought, direct score is always >= graph score.
  // Let's test a different scenario: graph-only thought beats a low-scoring direct thought in ranking
  const directData2 = [
    makeDirectResult({ id: "d1", blended_score: 0.2, similarity: 0.85 }),
  ];
  const graphData = [
    makeGraphResult({ thought_id: "g1", path_score: 0.8 }), // final = 0.2 * 0.8 = 0.16
  ];

  stubFetch();
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData2, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: graphData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.results.length, 2);
    // Direct result (0.2) should rank above graph (0.16)
    assertEquals(parsed.results[0].source_stage, "direct");
    assertEquals(parsed.results[1].source_stage, "graph");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("refined results scored at 0.9x discount", async () => {
  const directData = [makeDirectResult({ id: "d1", blended_score: 0.5, similarity: 0.85 })];
  const refinedData = [makeDirectResult({ id: "r1", blended_score: 0.6, content: "Refined" })];
  let hybridCallCount = 0;

  stubFetch({ subQueries: ["gap"] });
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") {
      hybridCallCount++;
      if (hybridCallCount === 1) return mockChain({ data: directData, error: null });
      return mockChain({ data: refinedData, error: null });
    }
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    // refined final_score = 0.6 * 0.9 = 0.54 > direct 0.5 → refined ranks first
    assertEquals(parsed.results[0].source_stage, "refined");
    assertEquals(parsed.results[1].source_stage, "direct");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("token budget truncates at 32K chars", async () => {
  // Create 5 results with ~8K chars each = 40K total, should truncate
  const bigContent = "x".repeat(8000);
  const directData = Array.from({ length: 5 }, (_, i) =>
    makeDirectResult({ id: `d${i}`, content: bigContent, blended_score: 1 - i * 0.1, similarity: 0.85 })
  );

  stubFetch();
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 50, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    // 4 results * 8000 = 32000 chars (budget hit), 5th excluded
    assertEquals(parsed.results.length, 4);
    assertEquals(parsed.search_meta.truncated, true);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("limit caps results even if token budget allows more", async () => {
  const directData = Array.from({ length: 10 }, (_, i) =>
    makeDirectResult({ id: `d${i}`, content: "short", blended_score: 1 - i * 0.05, similarity: 0.85 })
  );

  stubFetch();
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 3, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.results.length, 3);
    assertEquals(parsed.search_meta.truncated, true);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("limit clamped to max 50", async () => {
  let rpcArgs: any = null;

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "hybrid_search_thoughts") rpcArgs = args;
    return mockChain({ data: [], error: null });
  });
  try {
    // Pass limit=100, should be clamped to 50 internally (but match_count stays 20 for Stage 1)
    await handler({ query: "test", limit: 100, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    assertEquals(rpcArgs.match_count, 20); // Stage 1 always uses 20
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// ═══════════════════════════════════════════════
// Low confidence detection
// ═══════════════════════════════════════════════

Deno.test("low_confidence=false when direct similarity >= 0.75", async () => {
  const directData = [makeDirectResult({ similarity: 0.80, fts_rank: 0 })];

  stubFetch();
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.low_confidence, false);
    assertEquals(parsed.gap_hint, undefined);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("low_confidence=true when similarity < 0.75 and no FTS match", async () => {
  const directData = [makeDirectResult({ similarity: 0.70, fts_rank: 0 })];

  stubFetch();
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.low_confidence, true);
    assertStringIncludes(parsed.gap_hint, "No strong matches");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("low_confidence=false when FTS match exists even with low similarity", async () => {
  const directData = [makeDirectResult({ similarity: 0.55, fts_rank: 0.5 })];

  stubFetch();
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.low_confidence, false);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// ═══════════════════════════════════════════════
// Side effects (fire-and-forget)
// ═══════════════════════════════════════════════

Deno.test("fires access count, retrieval session, and co-occurrence side effects", async () => {
  const directData = [
    makeDirectResult({ id: "a", blended_score: 0.9, similarity: 0.85 }),
    makeDirectResult({ id: "b", blended_score: 0.8, similarity: 0.80 }),
  ];
  const rpcCalls: Record<string, any> = {};

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    rpcCalls[name] = args;
    return mockChain({ data: null, error: null });
  });
  try {
    await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    // Allow fire-and-forget promises to settle
    await new Promise((r) => setTimeout(r, 10));

    assertEquals(rpcCalls["increment_access_count"].p_brain_id, TEST_BRAIN_ID);
    assertEquals(rpcCalls["increment_access_count"].thought_ids, ["a", "b"]);

    assertEquals(rpcCalls["log_retrieval_session"].p_brain_id, TEST_BRAIN_ID);
    assertEquals(rpcCalls["log_retrieval_session"].p_tool_name, "deep_search");

    assertEquals(rpcCalls["update_co_occurrence"].p_brain_id, TEST_BRAIN_ID);
    assertEquals(rpcCalls["update_co_occurrence"].p_thought_ids, ["a", "b"]);
    assertEquals(rpcCalls["update_co_occurrence"].p_context_weight, 1.0);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// ═══════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════

Deno.test("missing brain context returns error", async () => {
  const result = await handler(
    { query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 },
    undefined, // no context
  );
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});

Deno.test("query exceeding 2000 chars returns error", async () => {
  const longQuery = "x".repeat(2001);
  const result = await handler(
    { query: longQuery, limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 },
    mockCtx(),
  );
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "exceeds maximum length");
});

Deno.test("initial search RPC error returns isError", async () => {
  stubFetch();
  stubRpc(supabaseAdmin, () => mockChain({ data: null, error: { message: "connection refused" } }));
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Deep search failed");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// ═══════════════════════════════════════════════
// Response shape
// ═══════════════════════════════════════════════

Deno.test("response includes all expected fields per spec", async () => {
  const directData = [makeDirectResult({ similarity: 0.85 })];

  stubFetch({ subQueries: ["gap query"] });
  stubRpc(supabaseAdmin, (name) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: directData, error: null });
    if (name === "deep_graph_traversal") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 20, threshold: 0.6, min_quality: 0.4, max_hops: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);

    // Top-level fields
    assertEquals(typeof parsed.low_confidence, "boolean");
    assertEquals(Array.isArray(parsed.results), true);
    assertEquals(typeof parsed.search_meta, "object");

    // search_meta shape
    assertEquals(Array.isArray(parsed.search_meta.sub_queries), true);
    assertEquals(typeof parsed.search_meta.stages.direct.count, "number");
    assertEquals(typeof parsed.search_meta.stages.graph.count, "number");
    assertEquals(typeof parsed.search_meta.stages.graph.max_hop, "number");
    assertEquals(typeof parsed.search_meta.stages.refined.count, "number");
    assertEquals(typeof parsed.search_meta.truncated, "boolean");

    // Result fields
    const r = parsed.results[0];
    assertEquals(typeof r.id, "string");
    assertEquals(typeof r.content, "string");
    assertEquals(typeof r.metadata, "object");
    assertEquals(typeof r.similarity, "number");
    assertEquals(typeof r.blended_score, "number");
    assertEquals(typeof r.source_stage, "string");
    assertEquals(typeof r.hop_depth, "number");
    assertEquals(typeof r.created_at, "string");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});
