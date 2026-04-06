// list-thoughts: Tests query builder chain with optional filters.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubFrom, stubRpc, restore, mockCtx, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerListThoughts } from "../tools/list-thoughts.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerListThoughts(mcp as any, z);
const handler = tools.get("list_thoughts")!;

Deno.test("returns thoughts as JSON", async () => {
  const data = [
    { id: "abc", content: "test thought", metadata: { type: "idea" }, source: "mcp", created_at: "2026-01-01" },
  ];
  stubFrom(supabaseAdmin, () => mockChain({ data, error: null }));
  stubRpc(supabaseAdmin, () => Promise.resolve({ data: null, error: null }));
  try {
    const result = await handler({ limit: 20 }, mockCtx());
    assertEquals(result.isError, undefined);
    assertEquals(JSON.parse(result.content[0].text), data);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("empty result returns empty array", async () => {
  stubFrom(supabaseAdmin, () => mockChain({ data: [], error: null }));
  stubRpc(supabaseAdmin, () => Promise.resolve({ data: null, error: null }));
  try {
    const result = await handler({ limit: 20 }, mockCtx());
    assertEquals(JSON.parse(result.content[0].text), []);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("db error returns isError", async () => {
  stubFrom(supabaseAdmin, () => mockChain({ data: null, error: { message: "timeout" } }));
  try {
    const result = await handler({ limit: 20 }, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "List failed");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("respects limit parameter", async () => {
  const data = [{ id: "1" }, { id: "2" }, { id: "3" }];
  let capturedLimit: number | undefined;
  const eqCalls: any[][] = [];

  stubFrom(supabaseAdmin, () => {
    // Track calls through the chain
    const chain: any = {
      select: () => chain,
      order: () => chain,
      limit: (n: number) => { capturedLimit = n; return chain; },
      filter: () => chain,
      contains: () => chain,
      gte: () => chain,
      eq: (...args: any[]) => { eqCalls.push(args); return chain; },
      then: (res: (v: any) => void) => res({ data, error: null }),
    };
    return chain;
  });
  stubRpc(supabaseAdmin, () => Promise.resolve({ data: null, error: null }));
  try {
    await handler({ limit: 5 }, mockCtx());
    assertEquals(capturedLimit, 5);
    const brainEq = eqCalls.find((c: any[]) => c[0] === "brain_id");
    assertEquals(brainEq, ["brain_id", TEST_BRAIN_ID]);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("type filter applies correct JSONB filter", async () => {
  let filterArgs: any[] = [];
  const eqCalls: any[][] = [];

  stubFrom(supabaseAdmin, () => {
    const chain: any = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      filter: (...args: any[]) => { filterArgs = args; return chain; },
      contains: () => chain,
      gte: () => chain,
      eq: (...args: any[]) => { eqCalls.push(args); return chain; },
      then: (res: (v: any) => void) => res({ data: [], error: null }),
    };
    return chain;
  });
  stubRpc(supabaseAdmin, () => mockChain({ data: null, error: null }));
  try {
    await handler({ type: "idea", limit: 20 }, mockCtx());
    assertEquals(filterArgs, ["metadata->>type", "eq", "idea"]);
    const brainEq = eqCalls.find((c: any[]) => c[0] === "brain_id");
    assertEquals(brainEq, ["brain_id", TEST_BRAIN_ID]);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("fires increment_access_count RPC for returned thought IDs", async () => {
  const data = [
    { id: "aaa", content: "thought 1" },
    { id: "bbb", content: "thought 2" },
  ];
  let rpcCalled = false;
  let rpcArgs: any = null;

  stubFrom(supabaseAdmin, () => mockChain({ data, error: null }));
  stubRpc(supabaseAdmin, (name: string, args?: any) => {
    if (name === "increment_access_count") {
      rpcCalled = true;
      rpcArgs = args;
    }
    return Promise.resolve({ data: null, error: null });
  });
  try {
    await handler({ limit: 20 }, mockCtx());
    assertEquals(rpcCalled, true);
    assertEquals(rpcArgs.thought_ids, ["aaa", "bbb"]);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("does not fire increment_access_count for empty results", async () => {
  let accessRpcCalled = false;

  stubFrom(supabaseAdmin, () => mockChain({ data: [], error: null }));
  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "increment_access_count") accessRpcCalled = true;
    return Promise.resolve({ data: null, error: null });
  });
  try {
    await handler({ limit: 20 }, mockCtx());
    assertEquals(accessRpcCalled, false);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("orders by salience DESC then created_at DESC", async () => {
  const capturedOrder: { column: string; ascending: boolean }[] = [];
  const eqCalls: any[][] = [];

  stubFrom(supabaseAdmin, () => {
    const chain: any = {
      select: () => chain,
      order: (col: string, opts: { ascending: boolean }) => {
        capturedOrder.push({ column: col, ascending: opts.ascending });
        return chain;
      },
      limit: () => chain,
      filter: () => chain,
      contains: () => chain,
      gte: () => chain,
      eq: (...args: any[]) => { eqCalls.push(args); return chain; },
      then: (res: (v: any) => void) => res({ data: [], error: null }),
    };
    return chain;
  });
  // Stub .rpc() so fire-and-forget increment_access_count doesn't hit real client
  stubRpc(supabaseAdmin, () => Promise.resolve({ data: null, error: null }));
  try {
    await handler({ limit: 20 }, mockCtx());
    assertEquals(capturedOrder.length, 2);
    assertEquals(capturedOrder[0], { column: "salience", ascending: false });
    assertEquals(capturedOrder[1], { column: "created_at", ascending: false });
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("min_quality default 0.4 applies quality filter", async () => {
  const orCalls: any[][] = [];
  const eqCalls: any[][] = [];

  stubFrom(supabaseAdmin, () => {
    const chain: any = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      filter: () => chain,
      contains: () => chain,
      gte: () => chain,
      eq: (...args: any[]) => { eqCalls.push(args); return chain; },
      or: (...args: any[]) => { orCalls.push(args); return chain; },
      then: (res: (v: any) => void) => res({ data: [], error: null }),
    };
    return chain;
  });
  stubRpc(supabaseAdmin, () => mockChain({ data: null, error: null }));
  try {
    await handler({ min_quality: 0.4, limit: 20 }, mockCtx());
    const qualityOr = orCalls.find((c) => typeof c[0] === "string" && c[0].includes("metadata->>quality"));
    assertEquals(qualityOr, ["source.in.(telegram,mcp),metadata->>quality.gte.0.4"]);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("min_quality=0 disables quality filter (passes everything)", async () => {
  const gteCalls: any[][] = [];
  const orCalls: any[][] = [];

  stubFrom(supabaseAdmin, () => {
    const chain: any = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      filter: () => chain,
      contains: () => chain,
      gte: (...args: any[]) => { gteCalls.push(args); return chain; },
      eq: () => chain,
      or: (...args: any[]) => { orCalls.push(args); return chain; },
      then: (res: (v: any) => void) => res({ data: [], error: null }),
    };
    return chain;
  });
  stubRpc(supabaseAdmin, () => mockChain({ data: null, error: null }));
  try {
    await handler({ min_quality: 0, limit: 20 }, mockCtx());
    // min_quality=0 means the condition `min_quality > 0` is false — no quality filter applied
    const qualityGte = gteCalls.find((c) => c[0] === "metadata->>quality");
    assertEquals(qualityGte, undefined);
    const qualityOr = orCalls.find((c) => typeof c[0] === "string" && c[0].includes("metadata->>quality"));
    assertEquals(qualityOr, undefined);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("theme filter applies correct JSONB filter", async () => {
  const filterCalls: any[][] = [];
  const eqCalls: any[][] = [];

  stubFrom(supabaseAdmin, () => {
    const chain: any = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      filter: (...args: any[]) => { filterCalls.push(args); return chain; },
      contains: () => chain,
      gte: () => chain,
      eq: (...args: any[]) => { eqCalls.push(args); return chain; },
      or: () => chain,
      then: (res: (v: any) => void) => res({ data: [], error: null }),
    };
    return chain;
  });
  stubRpc(supabaseAdmin, () => mockChain({ data: null, error: null }));
  try {
    await handler({ theme: "ml-research", limit: 20 }, mockCtx());
    // Should have exactly one filter call for theme
    assertEquals(filterCalls.length, 1);
    assertEquals(filterCalls[0], ["metadata->>theme", "eq", "ml-research"]);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("source filter applies correct equality filter", async () => {
  const eqCalls: any[][] = [];

  stubFrom(supabaseAdmin, () => {
    const chain: any = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      filter: () => chain,
      contains: () => chain,
      gte: () => chain,
      eq: (...args: any[]) => { eqCalls.push(args); return chain; },
      or: () => chain,
      then: (res: (v: any) => void) => res({ data: [], error: null }),
    };
    return chain;
  });
  stubRpc(supabaseAdmin, () => mockChain({ data: null, error: null }));
  try {
    await handler({ source: "telegram", limit: 20 }, mockCtx());
    const sourceEq = eqCalls.find((c: any[]) => c[0] === "source");
    assertEquals(sourceEq, ["source", "telegram"]);
    const brainEq = eqCalls.find((c: any[]) => c[0] === "brain_id");
    assertEquals(brainEq, ["brain_id", TEST_BRAIN_ID]);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("since filter applies gte on created_at with ISO timestamp", async () => {
  const gteCalls: any[][] = [];

  stubFrom(supabaseAdmin, () => {
    const chain: any = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      filter: () => chain,
      contains: () => chain,
      gte: (...args: any[]) => { gteCalls.push(args); return chain; },
      eq: () => chain,
      or: () => chain,
      then: (res: (v: any) => void) => res({ data: [], error: null }),
    };
    return chain;
  });
  stubRpc(supabaseAdmin, () => mockChain({ data: null, error: null }));
  try {
    await handler({ since: "2026-04-01T08:30:00Z", limit: 20 }, mockCtx());
    const createdAtCall = gteCalls.find((c) => c[0] === "created_at");
    assertEquals(createdAtCall, ["created_at", "2026-04-01T08:30:00Z"]);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("since takes precedence over days when both provided", async () => {
  const gteCalls: any[][] = [];

  stubFrom(supabaseAdmin, () => {
    const chain: any = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      filter: () => chain,
      contains: () => chain,
      gte: (...args: any[]) => { gteCalls.push(args); return chain; },
      eq: () => chain,
      or: () => chain,
      then: (res: (v: any) => void) => res({ data: [], error: null }),
    };
    return chain;
  });
  stubRpc(supabaseAdmin, () => mockChain({ data: null, error: null }));
  try {
    await handler({ since: "2026-04-01T08:30:00Z", days: 7, limit: 20 }, mockCtx());
    const createdAtCalls = gteCalls.filter((c) => c[0] === "created_at");
    // Only one created_at gte call, using the since value
    assertEquals(createdAtCalls.length, 1);
    assertEquals(createdAtCalls[0], ["created_at", "2026-04-01T08:30:00Z"]);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("missing brain context returns error", async () => {
  const result = await handler({ limit: 20 });
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
