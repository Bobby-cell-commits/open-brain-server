// analyze: Tests for consolidated graph analysis tool.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubRpc, restore, mockCtx } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerAnalyze } from "../tools/analyze.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerAnalyze(mcp as any, z);
const handler = tools.get("analyze")!;

// --- hubs mode ---

Deno.test("hubs: calls analysis_rich_thoughts RPC", async () => {
  let capturedName: string | undefined;

  stubRpc(supabaseAdmin, (name) => {
    capturedName = name;
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({ type: "hubs", min_connections: 5 }, mockCtx());
    assertEquals(capturedName, "analysis_rich_thoughts");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("hubs: returns hub thoughts as JSON", async () => {
  const hubData = [
    { id: "aaa", source: "telegram", strong_matches: 8, preview: "AI agents" },
    { id: "bbb", source: "reddit", strong_matches: 12, preview: "LLM tooling" },
  ];

  stubRpc(supabaseAdmin, () => mockChain({ data: hubData, error: null }));
  try {
    const result = await handler({ type: "hubs", min_connections: 5 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.length, 2);
    assertEquals(parsed[0].strong_matches, 8);
    assertEquals(parsed[1].preview, "LLM tooling");
    assertEquals(result.isError, undefined);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("hubs: filters by min_connections when > 5", async () => {
  const hubData = [
    { id: "aaa", source: "telegram", strong_matches: 5, preview: "Low hub" },
    { id: "bbb", source: "reddit", strong_matches: 7, preview: "Mid hub" },
    { id: "ccc", source: "mcp", strong_matches: 10, preview: "High hub" },
  ];

  stubRpc(supabaseAdmin, () => mockChain({ data: hubData, error: null }));
  try {
    const result = await handler({ type: "hubs", min_connections: 7 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.length, 2);
    assertEquals(parsed[0].id, "bbb");
    assertEquals(parsed[1].id, "ccc");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("hubs: RPC error returns isError", async () => {
  stubRpc(supabaseAdmin, () =>
    mockChain({ data: null, error: { message: "timeout" } }),
  );
  try {
    const result = await handler({ type: "hubs", min_connections: 5 }, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Analysis failed");
  } finally {
    restore(supabaseAdmin);
  }
});

// --- density mode ---

Deno.test("density: calls analysis_connection_density RPC", async () => {
  let capturedName: string | undefined;

  stubRpc(supabaseAdmin, (name) => {
    capturedName = name;
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({ type: "density", min_connections: 5 }, mockCtx());
    assertEquals(capturedName, "analysis_connection_density");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("density: returns density data as JSON", async () => {
  const densityData = [
    { threshold: 0.75, avg_links: 2.3, median_links: 2, zero_link_count: 15, ten_plus_count: 3 },
    { threshold: 0.80, avg_links: 1.1, median_links: 1, zero_link_count: 40, ten_plus_count: 0 },
  ];

  stubRpc(supabaseAdmin, () => mockChain({ data: densityData, error: null }));
  try {
    const result = await handler({ type: "density", min_connections: 5 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.length, 2);
    assertEquals(parsed[0].threshold, 0.75);
    assertEquals(parsed[0].avg_links, 2.3);
    assertEquals(result.isError, undefined);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("density: RPC error returns isError", async () => {
  stubRpc(supabaseAdmin, () =>
    mockChain({ data: null, error: { message: "function not found" } }),
  );
  try {
    const result = await handler({ type: "density", min_connections: 5 }, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Analysis failed");
  } finally {
    restore(supabaseAdmin);
  }
});

// --- sources mode ---

Deno.test("sources: calls both analysis RPCs", async () => {
  const capturedNames: string[] = [];

  stubRpc(supabaseAdmin, (name) => {
    capturedNames.push(name);
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({ type: "sources", min_connections: 5 }, mockCtx());
    assertEquals(capturedNames.includes("analysis_baseline"), true);
    assertEquals(capturedNames.includes("analysis_source_pairs"), true);
    assertEquals(capturedNames.length, 2);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("sources: returns combined sources and cross_source", async () => {
  const baselineData = [
    { source: "telegram", count: 200 },
    { source: "reddit", count: 150 },
  ];
  const pairsData = [
    { source_a: "telegram", source_b: "reddit", avg_similarity: 0.72 },
  ];

  stubRpc(supabaseAdmin, (name) => {
    if (name === "analysis_baseline") {
      return mockChain({ data: baselineData, error: null });
    }
    return mockChain({ data: pairsData, error: null });
  });
  try {
    const result = await handler({ type: "sources", min_connections: 5 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.sources, baselineData);
    assertEquals(parsed.cross_source, pairsData);
    assertEquals(result.isError, undefined);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("sources: RPC error returns isError", async () => {
  stubRpc(supabaseAdmin, () =>
    mockChain({ data: null, error: { message: "permission denied" } }),
  );
  try {
    const result = await handler({ type: "sources", min_connections: 5 }, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Analysis failed");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("missing brain context returns error", async () => {
  const result = await handler({ type: "hubs" });
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
