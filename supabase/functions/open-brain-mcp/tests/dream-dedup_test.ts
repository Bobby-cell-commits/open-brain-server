// dream-dedup: Tests for automated dedup & merge (Dream Cycle Phase A).
// Implementation uses find_dedup_candidates RPC for single-round-trip pair discovery.

import { assertEquals } from "jsr:@std/assert";
import { mockChain, stubRpc, stubFrom, restore } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { dreamDedup } from "../../_shared/dream-dedup.ts";

// --- Fetch stub for OpenRouter LLM calls ---
const originalFetch = globalThis.fetch;

function stubFetchLlm(response: { same_idea: boolean; reason: string }) {
  globalThis.fetch = (_url: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(response) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

function stubFetchLlmFailure() {
  globalThis.fetch = (_url: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// --- Helpers ---

function makeThought(id: string, content: string, merge_count = 0) {
  return {
    id,
    content,
    source: "rss",
    source_event_id: `evt-${id}`,
    created_at: new Date().toISOString(),
    merge_count,
  };
}

function makeCandidateRow(
  a: ReturnType<typeof makeThought>,
  b: ReturnType<typeof makeThought>,
  similarity: number,
) {
  return {
    thought_a_id: a.id,
    thought_a_content: a.content,
    thought_a_source: a.source,
    thought_a_source_event_id: a.source_event_id,
    thought_a_merge_count: a.merge_count,
    thought_a_created_at: a.created_at,
    thought_b_id: b.id,
    thought_b_content: b.content,
    thought_b_source: b.source,
    thought_b_source_event_id: b.source_event_id,
    thought_b_merge_count: b.merge_count,
    thought_b_created_at: b.created_at,
    pair_similarity: similarity,
  };
}

// --- Tests ---

Deno.test("returns zeroed result when no candidates", async () => {
  stubRpc(supabaseAdmin, (name) => {
    if (name === "find_dedup_candidates") {
      return mockChain({ data: [], error: null });
    }
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await dreamDedup();
    assertEquals(result.scanned, 0);
    assertEquals(result.pairs_found, 0);
    assertEquals(result.auto_merged, 0);
    assertEquals(result.deleted, 0);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("auto-merges pair at >= 0.95 similarity without LLM", async () => {
  const thoughtA = makeThought("aaa", "thought A content", 0);
  const thoughtB = makeThought("bbb", "thought B content", 1);

  let mergeCalledWith: any = null;
  let deletedId: string | null = null;

  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "find_dedup_candidates") {
      return mockChain({
        data: [makeCandidateRow(thoughtA, thoughtB, 0.97)],
        error: null,
      });
    }
    if (name === "perform_merge") {
      mergeCalledWith = args;
      return mockChain({ data: null, error: null });
    }
    if (name === "log_merge") {
      return mockChain({ data: null, error: null });
    }
    return mockChain({ data: null, error: null });
  });

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "thoughts") {
      return {
        delete: () => ({
          eq: (_col: string, id: string) => {
            deletedId = id;
            return mockChain({ data: null, error: null });
          },
        }),
      };
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamDedup();
    assertEquals(result.scanned, 1);
    assertEquals(result.pairs_found, 1);
    assertEquals(result.auto_merged, 1);
    assertEquals(result.llm_confirmed, 0);
    assertEquals(result.deleted, 1);
    // Survivor is thoughtB (higher merge_count), loser is thoughtA
    assertEquals(mergeCalledWith.p_id, "bbb");
    assertEquals(deletedId, "aaa");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("LLM-confirms pair in 0.92-0.95 range and merges", async () => {
  const thoughtA = makeThought("aaa", "thought A", 0);
  const thoughtB = makeThought("bbb", "thought B", 0);
  // thoughtA is older (survivor by created_at tiebreaker)
  thoughtA.created_at = "2026-03-20T00:00:00Z";
  thoughtB.created_at = "2026-03-25T00:00:00Z";

  let mergeCalledWith: any = null;
  let deletedId: string | null = null;

  stubFetchLlm({ same_idea: true, reason: "Both describe the same research finding" });

  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "find_dedup_candidates") {
      return mockChain({
        data: [makeCandidateRow(thoughtA, thoughtB, 0.93)],
        error: null,
      });
    }
    if (name === "perform_merge") {
      mergeCalledWith = args;
      return mockChain({ data: null, error: null });
    }
    if (name === "log_merge") {
      return mockChain({ data: null, error: null });
    }
    return mockChain({ data: null, error: null });
  });

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "thoughts") {
      return {
        delete: () => ({
          eq: (_col: string, id: string) => {
            deletedId = id;
            return mockChain({ data: null, error: null });
          },
        }),
      };
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamDedup();
    assertEquals(result.llm_confirmed, 1);
    assertEquals(result.llm_rejected, 0);
    assertEquals(result.deleted, 1);
    // Survivor is thoughtA (older), loser is thoughtB
    assertEquals(mergeCalledWith.p_id, "aaa");
    assertEquals(deletedId, "bbb");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("LLM-rejects pair in 0.92-0.95 range — no merge", async () => {
  const thoughtA = makeThought("aaa", "thought A", 0);
  const thoughtB = makeThought("bbb", "thought B", 0);

  let mergeCalled = false;

  stubFetchLlm({ same_idea: false, reason: "Different techniques for the same problem" });

  stubRpc(supabaseAdmin, (name) => {
    if (name === "find_dedup_candidates") {
      return mockChain({
        data: [makeCandidateRow(thoughtA, thoughtB, 0.93)],
        error: null,
      });
    }
    if (name === "perform_merge") {
      mergeCalled = true;
      return mockChain({ data: null, error: null });
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamDedup();
    assertEquals(result.llm_rejected, 1);
    assertEquals(result.llm_confirmed, 0);
    assertEquals(result.deleted, 0);
    assertEquals(mergeCalled, false);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("LLM failure skips pair — fail-safe", async () => {
  const thoughtA = makeThought("aaa", "thought A", 0);
  const thoughtB = makeThought("bbb", "thought B", 0);

  let mergeCalled = false;

  stubFetchLlmFailure();

  stubRpc(supabaseAdmin, (name) => {
    if (name === "find_dedup_candidates") {
      return mockChain({
        data: [makeCandidateRow(thoughtA, thoughtB, 0.93)],
        error: null,
      });
    }
    if (name === "perform_merge") {
      mergeCalled = true;
      return mockChain({ data: null, error: null });
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamDedup();
    assertEquals(result.llm_failed, 1);
    assertEquals(result.deleted, 0);
    assertEquals(mergeCalled, false);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("deduplicates symmetric pairs — processes A↔B only once", async () => {
  const thoughtA = makeThought("aaa", "thought A", 0);
  const thoughtB = makeThought("bbb", "thought B", 0);
  thoughtA.created_at = "2026-03-25T00:00:00Z";
  thoughtB.created_at = "2026-03-26T00:00:00Z";

  let mergeCount = 0;

  stubRpc(supabaseAdmin, (name) => {
    if (name === "find_dedup_candidates") {
      // RPC returns both directions — code should only process once
      return mockChain({
        data: [
          makeCandidateRow(thoughtA, thoughtB, 0.97),
          makeCandidateRow(thoughtB, thoughtA, 0.97),
        ],
        error: null,
      });
    }
    if (name === "perform_merge") {
      mergeCount++;
      return mockChain({ data: null, error: null });
    }
    if (name === "log_merge") {
      return mockChain({ data: null, error: null });
    }
    return mockChain({ data: null, error: null });
  });

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "thoughts") {
      return {
        delete: () => ({
          eq: (_col: string, _id: string) => mockChain({ data: null, error: null }),
        }),
      };
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamDedup();
    // Should only merge once despite both directions appearing
    assertEquals(mergeCount, 1);
    assertEquals(result.auto_merged, 1);
    assertEquals(result.deleted, 1);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("skips pairs involving already-deleted thoughts", async () => {
  const thoughtA = makeThought("aaa", "thought A", 2); // highest merge_count = survivor
  const thoughtB = makeThought("bbb", "thought B", 0);
  const thoughtC = makeThought("ccc", "thought C", 0);

  let mergeCount = 0;
  const deletedIds: string[] = [];

  stubRpc(supabaseAdmin, (name) => {
    if (name === "find_dedup_candidates") {
      return mockChain({
        data: [
          makeCandidateRow(thoughtA, thoughtB, 0.97), // merge: delete B
          makeCandidateRow(thoughtB, thoughtC, 0.96), // skip: B already deleted
          makeCandidateRow(thoughtA, thoughtC, 0.95), // merge: delete C
        ],
        error: null,
      });
    }
    if (name === "perform_merge") {
      mergeCount++;
      return mockChain({ data: null, error: null });
    }
    if (name === "log_merge") {
      return mockChain({ data: null, error: null });
    }
    return mockChain({ data: null, error: null });
  });

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "thoughts") {
      return {
        delete: () => ({
          eq: (_col: string, id: string) => {
            deletedIds.push(id);
            return mockChain({ data: null, error: null });
          },
        }),
      };
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamDedup();
    // A↔B: merge (delete B). B↔C: skip (B deleted). A↔C: merge (delete C).
    assertEquals(mergeCount, 2);
    assertEquals(result.auto_merged, 2);
    assertEquals(result.deleted, 2);
    assertEquals(deletedIds.includes("aaa"), false); // A survives both
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("RPC error on find_dedup_candidates returns zeroed result", async () => {
  stubRpc(supabaseAdmin, (name) => {
    if (name === "find_dedup_candidates") {
      return mockChain({ data: null, error: { message: "function not found" } });
    }
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await dreamDedup();
    assertEquals(result.scanned, 0);
    assertEquals(result.pairs_found, 0);
    assertEquals(result.deleted, 0);
  } finally {
    restore(supabaseAdmin);
  }
});
