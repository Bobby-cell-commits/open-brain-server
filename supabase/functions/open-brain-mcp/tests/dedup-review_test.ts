// dedup_review: Tests parallel cache reads, combined result, and client-side limit slicing.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubRpc, stubFrom, restore, mockCtx } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerDedupReview } from "../tools/dedup-review.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerDedupReview(mcp as any, z);
const handler = tools.get("dedup_review")!;

Deno.test("calls both dedup cache reads", async () => {
  let fromCallCount = 0;

  stubFrom(supabaseAdmin, () => {
    fromCallCount++;
    return mockChain({ data: { result: [], computed_at: "2026-04-06T00:00:00Z", duration_ms: 100 }, error: null });
  });
  try {
    await handler({ limit: 20 }, mockCtx());
    // readCache is called twice in Promise.all (once for dedup_candidates, once for dedup_zones)
    assertEquals(fromCallCount >= 2, true);
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

  let fromCallCount = 0;
  stubFrom(supabaseAdmin, () => {
    fromCallCount++;
    // First call = dedup_candidates, second call = dedup_zones
    const result = fromCallCount === 1 ? candidatesData : zonesData;
    return mockChain({ data: { result, computed_at: "2026-04-06T00:00:00Z", duration_ms: 100 }, error: null });
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

  let fromCallCount = 0;
  stubFrom(supabaseAdmin, () => {
    fromCallCount++;
    const result = fromCallCount === 1 ? candidatesData : zonesData;
    return mockChain({ data: { result, computed_at: "2026-04-06T00:00:00Z", duration_ms: 100 }, error: null });
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
  stubFrom(supabaseAdmin, () => {
    throw new Error("connection refused");
  });
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
