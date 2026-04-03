// search-thoughts: Tests hybrid search, graph expansion, and knowledge gap detection.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubRpc, restore, mockCtx, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerSearchThoughts } from "../tools/search-thoughts.ts";
import * as z from "npm:zod@3";

// Stub globalThis.fetch to intercept OpenRouter embedding calls
const originalFetch = globalThis.fetch;
function stubFetch() {
  globalThis.fetch = (_url: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

const { mcp, tools } = createMockMcp();
registerSearchThoughts(mcp as any, z);
const handler = tools.get("search_thoughts")!;

// --- Hybrid search basics ---

Deno.test("calls hybrid_search_thoughts by default", async () => {
  let rpcName = "";
  let rpcArgs: any = null;

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name !== "increment_access_count") {
      rpcName = name;
      rpcArgs = args;
    }
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({ query: "test query", limit: 10, threshold: 0.7, expand: false, min_quality: 0.4 }, mockCtx());
    assertEquals(rpcName, "hybrid_search_thoughts");
    assertEquals(rpcArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(rpcArgs.query_text, "test query");
    assertEquals(rpcArgs.query_embedding, [0.1, 0.2, 0.3]);
    assertEquals(rpcArgs.min_quality, 0.4);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("returns results wrapped with low_confidence field", async () => {
  const rpcData = [
    { id: "b", content: "first", similarity: 0.8, fts_rank: 0.3, rrf_score: 0.03, blended_score: 1.6, salience: 2.0, pinned: false, merge_count: 1 },
  ];
  stubFetch();
  stubRpc(supabaseAdmin, (name, _args) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: rpcData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 10, threshold: 0.7, expand: false }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.results.length, 1);
    assertEquals(parsed.results[0].id, "b");
    assertEquals(parsed.low_confidence, false);
    assertEquals(parsed.gap_hint, undefined);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("fires increment_access_count for returned IDs", async () => {
  const rpcData = [
    { id: "x", content: "thought", similarity: 0.9, fts_rank: 0.1, rrf_score: 0.016, blended_score: 0.9, salience: 1.0, pinned: false, merge_count: 0 },
  ];
  let accessRpcCalled = false;
  let accessRpcArgs: any = null;

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: rpcData, error: null });
    if (name === "increment_access_count") {
      accessRpcCalled = true;
      accessRpcArgs = args;
    }
    return mockChain({ data: null, error: null });
  });
  try {
    await handler({ query: "test", limit: 10, threshold: 0.7, expand: false }, mockCtx());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(accessRpcCalled, true);
    assertEquals(accessRpcArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(accessRpcArgs.thought_ids, ["x"]);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("RPC error returns isError", async () => {
  stubFetch();
  stubRpc(supabaseAdmin, () =>
    mockChain({ data: null, error: { message: "rpc failed" } })
  );
  try {
    const result = await handler({ query: "test", limit: 10, threshold: 0.7, expand: false }, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Search failed");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// --- Graph expansion ---

Deno.test("expand=true calls graph_expanded_search", async () => {
  let rpcName = "";

  stubFetch();
  stubRpc(supabaseAdmin, (name, _args) => {
    if (name !== "increment_access_count") rpcName = name;
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({ query: "test", limit: 10, threshold: 0.7, expand: true }, mockCtx());
    assertEquals(rpcName, "graph_expanded_search");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("graph-expanded results include graph_expanded flag", async () => {
  const rpcData = [
    { id: "d1", content: "direct", similarity: 0.85, fts_rank: 0.2, rrf_score: 0.03, blended_score: 1.5, salience: 1.0, pinned: false, merge_count: 0, graph_expanded: false },
    { id: "g1", content: "graph neighbor", similarity: 0.0, fts_rank: 0.0, rrf_score: 0.0, blended_score: 0.5, salience: 0.8, pinned: false, merge_count: 0, graph_expanded: true },
  ];
  stubFetch();
  stubRpc(supabaseAdmin, (name, _args) => {
    if (name === "graph_expanded_search") return mockChain({ data: rpcData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 10, threshold: 0.7, expand: true }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.results.length, 2);
    assertEquals(parsed.results[0].graph_expanded, false);
    assertEquals(parsed.results[1].graph_expanded, true);
    // Has a strong direct match, so not low_confidence
    assertEquals(parsed.low_confidence, false);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// --- Knowledge gap detection ---

Deno.test("low_confidence=true when no results", async () => {
  stubFetch();
  stubRpc(supabaseAdmin, (name, _args) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: [], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "obscure topic", limit: 10, threshold: 0.7, expand: false }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.low_confidence, true);
    assertEquals(parsed.gap_hint, "No strong matches found. Consider capturing knowledge about this topic.");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("low_confidence=true when all results below 0.75 and no FTS matches", async () => {
  const rpcData = [
    { id: "a", content: "weak match", similarity: 0.72, fts_rank: 0.0, rrf_score: 0.01, blended_score: 0.3, salience: 0.5, pinned: false, merge_count: 0 },
    { id: "b", content: "weaker match", similarity: 0.71, fts_rank: 0.0, rrf_score: 0.01, blended_score: 0.2, salience: 0.4, pinned: false, merge_count: 0 },
  ];
  stubFetch();
  stubRpc(supabaseAdmin, (name, _args) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: rpcData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "rare topic", limit: 10, threshold: 0.7, expand: false }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.low_confidence, true);
    assertStringIncludes(parsed.gap_hint, "No strong matches");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("low_confidence=false when FTS matches exist even with low similarity", async () => {
  const rpcData = [
    { id: "a", content: "keyword match", similarity: 0.60, fts_rank: 0.5, rrf_score: 0.02, blended_score: 0.5, salience: 1.0, pinned: false, merge_count: 0 },
  ];
  stubFetch();
  stubRpc(supabaseAdmin, (name, _args) => {
    if (name === "hybrid_search_thoughts") return mockChain({ data: rpcData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "specific term", limit: 10, threshold: 0.5, expand: false }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.low_confidence, false);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("low_confidence ignores graph-expanded results for similarity check", async () => {
  // Only graph-expanded results with high blended_score — but direct matches are weak
  const rpcData = [
    { id: "d1", content: "weak direct", similarity: 0.65, fts_rank: 0.0, rrf_score: 0.01, blended_score: 0.3, salience: 0.5, pinned: false, merge_count: 0, graph_expanded: false },
    { id: "g1", content: "strong graph neighbor", similarity: 0.0, fts_rank: 0.0, rrf_score: 0.0, blended_score: 0.8, salience: 1.5, pinned: false, merge_count: 0, graph_expanded: true },
  ];
  stubFetch();
  stubRpc(supabaseAdmin, (name, _args) => {
    if (name === "graph_expanded_search") return mockChain({ data: rpcData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({ query: "test", limit: 10, threshold: 0.5, expand: true }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    // Direct match at 0.65 < 0.75, no FTS → low_confidence despite graph neighbor
    assertEquals(parsed.low_confidence, true);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// --- Quality gating ---

Deno.test("min_quality=0 disables quality gating", async () => {
  let rpcArgs: any = null;

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name !== "increment_access_count") rpcArgs = args;
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({ query: "test", limit: 10, threshold: 0.7, expand: false, min_quality: 0 }, mockCtx());
    assertEquals(rpcArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(rpcArgs.min_quality, 0);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("custom min_quality=0.7 passes through to RPC", async () => {
  let rpcArgs: any = null;

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name !== "increment_access_count") rpcArgs = args;
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({ query: "test", limit: 10, threshold: 0.7, expand: false, min_quality: 0.7 }, mockCtx());
    assertEquals(rpcArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(rpcArgs.min_quality, 0.7);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("min_quality passes through with graph_expanded_search", async () => {
  let rpcName = "";
  let rpcArgs: any = null;

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name !== "increment_access_count") {
      rpcName = name;
      rpcArgs = args;
    }
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({ query: "test", limit: 10, threshold: 0.7, expand: true, min_quality: 0.6 }, mockCtx());
    assertEquals(rpcName, "graph_expanded_search");
    assertEquals(rpcArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(rpcArgs.min_quality, 0.6);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("missing brain context returns error", async () => {
  const result = await handler({ query: "test", limit: 10, threshold: 0.7, expand: false, min_quality: 0.4 });
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
