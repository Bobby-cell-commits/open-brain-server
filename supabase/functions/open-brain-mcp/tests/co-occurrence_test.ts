// co-occurrence: Tests session logging and edge UPSERT fire-and-forget calls.

import { assertEquals } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubRpc, restore, mockCtx, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerSearchThoughts } from "../tools/search-thoughts.ts";
import { registerListThoughts } from "../tools/list-thoughts.ts";
import * as z from "npm:zod@3";

// Stub globalThis.fetch for OpenRouter embedding calls
const originalFetch = globalThis.fetch;
function stubFetch() {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// --- search_thoughts co-occurrence ---

const { mcp: searchMcp, tools: searchTools } = createMockMcp();
registerSearchThoughts(searchMcp as any, z);
const searchHandler = searchTools.get("search_thoughts")!;

Deno.test("search_thoughts fires log_retrieval_session with top 10 IDs", async () => {
  const rpcData = Array.from({ length: 15 }, (_, i) => ({
    id: `thought-${String(i).padStart(2, "0")}`,
    content: `thought ${i}`,
    similarity: 0.9 - i * 0.01,
    fts_rank: 0.1,
    rrf_score: 0.02,
    blended_score: 1.0 - i * 0.05,
    salience: 1.0,
    pinned: false,
    merge_count: 0,
  }));

  let sessionArgs: any = null;

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "log_retrieval_session") sessionArgs = args;
    if (name === "hybrid_search_thoughts") return mockChain({ data: rpcData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    await searchHandler(
      { query: "test", limit: 15, threshold: 0.7, expand: false, min_quality: 0.4 },
      mockCtx(),
    );
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(sessionArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(sessionArgs.p_tool_name, "search_thoughts");
    assertEquals(sessionArgs.p_context, "manual");
    assertEquals(sessionArgs.p_query_text, "test");
    // Capped at 10 IDs even though 15 results returned
    assertEquals(sessionArgs.p_thought_ids.length, 10);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("search_thoughts fires update_co_occurrence with weight 1.0", async () => {
  const rpcData = [
    { id: "a", content: "a", similarity: 0.9, fts_rank: 0.1, rrf_score: 0.02, blended_score: 1.0, salience: 1.0, pinned: false, merge_count: 0 },
    { id: "b", content: "b", similarity: 0.8, fts_rank: 0.1, rrf_score: 0.02, blended_score: 0.9, salience: 1.0, pinned: false, merge_count: 0 },
  ];

  let cooccArgs: any = null;

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "update_co_occurrence") cooccArgs = args;
    if (name === "hybrid_search_thoughts") return mockChain({ data: rpcData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    await searchHandler(
      { query: "test", limit: 10, threshold: 0.7, expand: false, min_quality: 0.4 },
      mockCtx(),
    );
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(cooccArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(cooccArgs.p_thought_ids, ["a", "b"]);
    assertEquals(cooccArgs.p_context_weight, 1.0);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("search_thoughts skips co-occurrence when fewer than 2 results", async () => {
  const rpcData = [
    { id: "solo", content: "solo", similarity: 0.9, fts_rank: 0.1, rrf_score: 0.02, blended_score: 1.0, salience: 1.0, pinned: false, merge_count: 0 },
  ];

  let cooccCalled = false;

  stubFetch();
  stubRpc(supabaseAdmin, (name, _args) => {
    if (name === "update_co_occurrence") cooccCalled = true;
    if (name === "hybrid_search_thoughts") return mockChain({ data: rpcData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    await searchHandler(
      { query: "test", limit: 10, threshold: 0.7, expand: false, min_quality: 0.4 },
      mockCtx(),
    );
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(cooccCalled, false);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("search_thoughts passes brainContext from auth extra", async () => {
  let sessionArgs: any = null;

  stubFetch();
  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "log_retrieval_session") sessionArgs = args;
    if (name === "hybrid_search_thoughts") return mockChain({ data: [
      { id: "a", content: "a", similarity: 0.9, fts_rank: 0.1, rrf_score: 0.02, blended_score: 1.0, salience: 1.0, pinned: false, merge_count: 0 },
    ], error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const ctx = { authInfo: { extra: { brainId: TEST_BRAIN_ID, brainContext: "discover" } } };
    await searchHandler(
      { query: "test", limit: 10, threshold: 0.7, expand: false, min_quality: 0.4 },
      ctx,
    );
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(sessionArgs.p_context, "discover");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

// --- list_thoughts co-occurrence ---

const { mcp: listMcp, tools: listTools } = createMockMcp();
registerListThoughts(listMcp as any, z);
const listHandler = listTools.get("list_thoughts")!;

Deno.test("list_thoughts fires update_co_occurrence with weight 0.5", async () => {
  const listData = [
    { id: "x", content: "x" },
    { id: "y", content: "y" },
    { id: "z", content: "z" },
  ];

  let cooccArgs: any = null;

  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "update_co_occurrence") cooccArgs = args;
    return mockChain({ data: null, error: null });
  });
  // Stub .from() for list_thoughts (uses PostgREST, not RPC)
  const origFrom = supabaseAdmin.from;
  supabaseAdmin.from = () => mockChain({ data: listData, error: null });
  try {
    await listHandler({ limit: 20, min_quality: 0.4 }, mockCtx());
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(cooccArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(cooccArgs.p_thought_ids, ["x", "y", "z"]);
    assertEquals(cooccArgs.p_context_weight, 0.5);
  } finally {
    restore(supabaseAdmin);
    supabaseAdmin.from = origFrom;
  }
});

Deno.test("list_thoughts logs session with null query_text", async () => {
  const listData = [{ id: "a", content: "a" }];

  let sessionArgs: any = null;

  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "log_retrieval_session") sessionArgs = args;
    return mockChain({ data: null, error: null });
  });
  const origFrom = supabaseAdmin.from;
  supabaseAdmin.from = () => mockChain({ data: listData, error: null });
  try {
    await listHandler({ limit: 20, min_quality: 0.4 }, mockCtx());
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(sessionArgs.p_tool_name, "list_thoughts");
    assertEquals(sessionArgs.p_query_text, null);
  } finally {
    restore(supabaseAdmin);
    supabaseAdmin.from = origFrom;
  }
});
