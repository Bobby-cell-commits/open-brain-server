// thought-stats: Tests RPC call pattern.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubRpc, restore, mockCtx, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerThoughtStats } from "../tools/thought-stats.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerThoughtStats(mcp as any, z);
const handler = tools.get("thought_stats")!;

Deno.test("no days passes null to days_back RPC param", async () => {
  let capturedName: string | undefined;
  let capturedArgs: any;

  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "get_theme_stats") return mockChain({ data: null, error: null });
    capturedName = name;
    capturedArgs = args;
    return mockChain({ data: { total: 42, by_type: {} }, error: null });
  });
  try {
    const result = await handler({}, mockCtx());
    assertEquals(capturedName, "thought_stats");
    assertEquals(capturedArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(capturedArgs.days_back, null);
    assertEquals(result.isError, undefined);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("with days passes value to days_back", async () => {
  let capturedArgs: any;

  stubRpc(supabaseAdmin, (name, args) => {
    if (name === "get_theme_stats") return mockChain({ data: null, error: null });
    capturedArgs = args;
    return mockChain({ data: { total: 10 }, error: null });
  });
  try {
    await handler({ days: 7 }, mockCtx());
    assertEquals(capturedArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(capturedArgs.days_back, 7);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("returns stats data as JSON", async () => {
  const statsData = { total: 100, by_type: { idea: 40, task: 30 }, top_topics: ["ai", "tools"] };

  stubRpc(supabaseAdmin, (name) => {
    if (name === "get_theme_stats") return mockChain({ data: null, error: null });
    return mockChain({ data: statsData, error: null });
  });
  try {
    const result = await handler({}, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.total, statsData.total);
    assertEquals(parsed.by_type, statsData.by_type);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("db error returns isError", async () => {
  stubRpc(supabaseAdmin, () => mockChain({ data: null, error: { message: "rpc timeout" } }));
  try {
    const result = await handler({}, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Stats failed");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("returns by_theme in stats data", async () => {
  const statsData = {
    total_thoughts: 100,
    by_type: { idea: 40, task: 30 },
    by_theme: { "ml-research": 50, "ai-coding-tools": 30 },
    top_topics: [{ topic: "ai", count: 20 }],
    top_people: [{ person: "alice", count: 5 }],
  };

  stubRpc(supabaseAdmin, (name) => {
    if (name === "get_theme_stats") return mockChain({ data: null, error: null });
    return mockChain({ data: statsData, error: null });
  });
  try {
    const result = await handler({}, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.by_theme, { "ml-research": 50, "ai-coding-tools": 30 });
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("missing brain context returns error", async () => {
  const result = await handler({});
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});

Deno.test("includes theme_tracking with velocity and lifecycle", async () => {
  const statsData = {
    total_thoughts: 100,
    by_type: { idea: 40 },
    by_theme: { "ml-research": 50, "personal": 30 },
    top_topics: [],
    top_people: [],
  };
  const themeStatsData = [
    { name: "ml-research", velocity: 5.2, lifecycle_state: "active", thought_count: 50 },
    { name: "personal", velocity: 1.5, lifecycle_state: "mature", thought_count: 30 },
  ];

  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "thought_stats") return mockChain({ data: statsData, error: null });
    if (name === "get_theme_stats") return mockChain({ data: themeStatsData, error: null });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({}, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.theme_tracking["ml-research"].velocity, 5.2);
    assertEquals(parsed.theme_tracking["ml-research"].lifecycle, "active");
    assertEquals(parsed.theme_tracking["personal"].lifecycle, "mature");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("thought_stats works when theme_tracking RPC fails", async () => {
  const statsData = { total_thoughts: 100, by_type: { idea: 40 } };

  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "thought_stats") return mockChain({ data: statsData, error: null });
    if (name === "get_theme_stats") return mockChain({ data: null, error: { message: "no themes table" } });
    return mockChain({ data: null, error: null });
  });
  try {
    const result = await handler({}, mockCtx());
    // Should still return base stats even if theme enrichment fails
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.total_thoughts, 100);
  } finally {
    restore(supabaseAdmin);
  }
});
