// dedup_review: Tests parallel RPC calls, combined result, and client-side limit slicing.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubRpc, restore, mockCtx } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerDedupReview } from "../tools/dedup-review.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerDedupReview(mcp as any, z);
const handler = tools.get("dedup_review")!;

Deno.test("calls both dedup RPCs", async () => {
  const capturedNames: string[] = [];

  stubRpc(supabaseAdmin, (name) => {
    capturedNames.push(name);
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({ limit: 20 }, mockCtx());
    assertEquals(capturedNames.includes("analysis_dedup_candidates"), true);
    assertEquals(capturedNames.includes("analysis_dedup_zones"), true);
    assertEquals(capturedNames.length, 2);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("returns candidates and zones", async () => {
  const candidatesData = [
    { id_a: "aaa", id_b: "bbb", similarity: 0.93, preview_a: "foo", preview_b: "bar" },
  ];
  const zonesData = [
    { zone: "0.92-0.95", count: 3 },
    { zone: "0.95+", count: 1 },
  ];

  stubRpc(supabaseAdmin, (name) => {
    if (name === "analysis_dedup_candidates") {
      return mockChain({ data: candidatesData, error: null });
    }
    return mockChain({ data: zonesData, error: null });
  });
  try {
    const result = await handler({ limit: 20 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.candidates, candidatesData);
    assertEquals(parsed.zones, zonesData);
    assertEquals(result.isError, undefined);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("slices candidates to limit", async () => {
  const candidatesData = [
    { id_a: "1", id_b: "2", similarity: 0.95 },
    { id_a: "3", id_b: "4", similarity: 0.94 },
    { id_a: "5", id_b: "6", similarity: 0.93 },
    { id_a: "7", id_b: "8", similarity: 0.92 },
    { id_a: "9", id_b: "10", similarity: 0.91 },
  ];
  const zonesData = [{ zone: "0.92-0.95", count: 5 }];

  stubRpc(supabaseAdmin, (name) => {
    if (name === "analysis_dedup_candidates") {
      return mockChain({ data: candidatesData, error: null });
    }
    return mockChain({ data: zonesData, error: null });
  });
  try {
    const result = await handler({ limit: 2 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.candidates.length, 2);
    assertEquals(parsed.candidates[0].id_a, "1");
    assertEquals(parsed.candidates[1].id_a, "3");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("RPC error returns isError", async () => {
  stubRpc(supabaseAdmin, () =>
    mockChain({ data: null, error: { message: "connection refused" } }),
  );
  try {
    const result = await handler({ limit: 20 }, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Dedup review failed");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("missing brain context returns error", async () => {
  const result = await handler({ limit: 20 });
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
