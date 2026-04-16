// dream-synthesis: Tests for insight synthesis (Dream Cycle Phase C).

import { assertEquals, assertGreater } from "jsr:@std/assert";
import { mockChain, stubRpc, stubFrom, restore } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { dreamSynthesis } from "../../_shared/dream-synthesis.ts";

const TEST_BRAIN_ID = "test-brain-00000000";

// --- Fetch stub for OpenRouter LLM + embedding calls ---
const originalFetch = globalThis.fetch;

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function stubFetchSequence(responses: Array<Record<string, unknown>>) {
  let callIndex = 0;
  globalThis.fetch = (url: string | URL | Request, _init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

    // Embedding requests
    if (urlStr.includes("/embeddings")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    // LLM chat completion requests — return responses in order
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    // String responses (synthesis text) pass through as-is;
    // object responses (probes, evaluation) get JSON-stringified.
    const contentStr = typeof resp === "string" ? resp : JSON.stringify(resp);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: contentStr } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// --- Helpers ---

function makeCandidateRow(
  componentId: string,
  memberIds: string[],
  clusterSize: number,
  theme = "ml-research",
) {
  return {
    component_id: componentId,
    member_ids: memberIds,
    cluster_size: clusterSize,
    newest_thought_at: new Date().toISOString(),
    dominant_theme: theme,
  };
}

function makeThoughtRow(id: string, content: string, theme = "ml-research") {
  return {
    id,
    content,
    metadata: { type: "observation", theme, quality: 0.7 },
    source: "rss",
  };
}

// --- Tests ---

Deno.test("returns zeroed result when no candidates found", async () => {
  stubRpc(supabaseAdmin, (name) => {
    if (name === "find_synthesis_candidates") {
      return mockChain({ data: [], error: null });
    }
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await dreamSynthesis(TEST_BRAIN_ID);
    assertEquals(result.clusters_found, 0);
    assertEquals(result.clusters_synthesized, 0);
    assertEquals(result.clusters_skipped_low_coverage, 0);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("synthesizes a passing cluster and inserts thought + connections", async () => {
  const members = ["aaa", "bbb", "ccc"];
  const candidate = makeCandidateRow("aaa", members, 3);

  // LLM response sequence: 1=synthesis, 2=probes, 3=evaluation
  stubFetchSequence([
    // Call 1: synthesis generation (JSON — chatCompletion uses response_format: json_object)
    { synthesis: "These three thoughts converge on a key insight about ML model evaluation.", gap: "How do these evaluation methods scale to production workloads?" },
    // Call 2: probe generation
    { probes: ["What ML topic is discussed?", "How many methods are compared?", "What is the main finding?"] },
    // Call 3: probe evaluation (separated — sees synthesis + questions only)
    { evaluations: [
      { question: "What ML topic is discussed?", answered: true, evidence: "ML model evaluation" },
      { question: "How many methods are compared?", answered: true, evidence: "three thoughts" },
      { question: "What is the main finding?", answered: true, evidence: "key insight" },
    ], coverage: 1.0, pass: true },
  ]);

  let insertedThought: any = null;
  let insertedConnections: any[] = [];

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "graph_analysis_cache") {
      return mockChain({ data: { result: [candidate] }, error: null });
    }
    if (table === "thoughts") {
      return {
        select: () => mockChain({
          data: members.map((id) =>
            makeThoughtRow(id, `Content of thought ${id}`)
          ),
          error: null,
        }),
        insert: (row: any) => {
          insertedThought = row;
          return {
            select: () => ({
              single: () =>
                mockChain({
                  data: { id: "synth-001", created_at: new Date().toISOString() },
                  error: null,
                }),
            }),
          };
        },
      };
    }
    if (table === "thought_connections") {
      return {
        insert: (rows: any) => {
          insertedConnections = Array.isArray(rows) ? rows : [rows];
          return mockChain({ data: null, error: null });
        },
      };
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamSynthesis(TEST_BRAIN_ID);

    assertEquals(result.clusters_found, 1);
    assertEquals(result.clusters_synthesized, 1);
    assertEquals(result.clusters_skipped_low_coverage, 0);
    assertGreater(result.avg_coverage, 0);

    // Verify inserted thought
    assertEquals(insertedThought.source, "dream");
    assertEquals(insertedThought.metadata.type, "synthesis");
    assertEquals(insertedThought.metadata.evidence_ids.length, 3);

    // Verify connections: 3 'synthesizes' connections (one per source)
    assertEquals(insertedConnections.length, 3);
    for (const conn of insertedConnections) {
      assertEquals(conn.link_type, "synthesizes");
      assertEquals(conn.source_thought_id, "synth-001");
    }
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("skips cluster when probe QA coverage is below 0.70", async () => {
  const members = ["aaa", "bbb", "ccc"];
  const candidate = makeCandidateRow("aaa", members, 3);

  stubFetchSequence([
    // synthesis (JSON format)
    { synthesis: "A weak synthesis that misses key facts.", gap: "Everything." },
    // probes
    { probes: ["Q1?", "Q2?", "Q3?", "Q4?", "Q5?"] },
    // evaluation — low coverage
    { evaluations: [
      { question: "Q1?", answered: false, evidence: null },
      { question: "Q2?", answered: false, evidence: null },
      { question: "Q3?", answered: true, evidence: "some" },
      { question: "Q4?", answered: false, evidence: null },
      { question: "Q5?", answered: false, evidence: null },
    ], coverage: 0.2, pass: false },
  ]);

  let insertCalled = false;

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "graph_analysis_cache") {
      return mockChain({ data: { result: [candidate] }, error: null });
    }
    if (table === "thoughts") {
      return {
        select: () => mockChain({
          data: members.map((id) => makeThoughtRow(id, `Content ${id}`)),
          error: null,
        }),
        insert: () => {
          insertCalled = true;
          return { select: () => ({ single: () => mockChain({ data: { id: "x" }, error: null }) }) };
        },
      };
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamSynthesis(TEST_BRAIN_ID);
    assertEquals(result.clusters_found, 1);
    assertEquals(result.clusters_synthesized, 0);
    assertEquals(result.clusters_skipped_low_coverage, 1);
    assertEquals(insertCalled, false);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("RPC error returns zeroed result gracefully", async () => {
  stubRpc(supabaseAdmin, (name) => {
    if (name === "find_synthesis_candidates") {
      return mockChain({ data: null, error: { message: "function not found" } });
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamSynthesis(TEST_BRAIN_ID);
    assertEquals(result.clusters_found, 0);
    assertEquals(result.clusters_synthesized, 0);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("insert returning null data skips cluster without crash", async () => {
  const members = ["aaa", "bbb", "ccc"];
  const candidate = makeCandidateRow("aaa", members, 3);

  stubFetchSequence([
    { synthesis: "A solid synthesis.", gap: "What next?" },
    { probes: ["Q1?", "Q2?", "Q3?"] },
    { evaluations: [
      { question: "Q1?", answered: true, evidence: "yes" },
      { question: "Q2?", answered: true, evidence: "yes" },
      { question: "Q3?", answered: true, evidence: "yes" },
    ], coverage: 1.0, pass: true },
  ]);

  let connectionInsertCalled = false;

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "graph_analysis_cache") {
      return mockChain({ data: { result: [candidate] }, error: null });
    }
    if (table === "thoughts") {
      return {
        select: () => mockChain({
          data: members.map((id) => makeThoughtRow(id, `Content ${id}`)),
          error: null,
        }),
        insert: () => ({
          select: () => ({
            single: () => mockChain({ data: null, error: null }),
          }),
        }),
      };
    }
    if (table === "thought_connections") {
      return {
        insert: () => {
          connectionInsertCalled = true;
          return mockChain({ data: null, error: null });
        },
      };
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamSynthesis(TEST_BRAIN_ID);
    assertEquals(result.clusters_found, 1);
    assertEquals(result.clusters_synthesized, 0);
    assertEquals(connectionInsertCalled, false);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("LLM failure on synthesis skips cluster gracefully", async () => {
  const members = ["aaa", "bbb", "ccc"];
  const candidate = makeCandidateRow("aaa", members, 3);

  // Stub fetch to fail on LLM calls
  globalThis.fetch = (_url: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
  };

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "graph_analysis_cache") {
      return mockChain({ data: { result: [candidate] }, error: null });
    }
    if (table === "thoughts") {
      return {
        select: () => mockChain({
          data: members.map((id) => makeThoughtRow(id, `Content ${id}`)),
          error: null,
        }),
      };
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamSynthesis(TEST_BRAIN_ID);
    assertEquals(result.clusters_found, 1);
    assertEquals(result.clusters_synthesized, 0);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});
