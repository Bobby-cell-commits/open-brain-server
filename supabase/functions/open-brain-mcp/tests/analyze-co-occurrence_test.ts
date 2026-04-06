// analyze: Tests for co_occurrence analysis type.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubRpc, restore, mockCtx, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerAnalyze } from "../tools/analyze.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerAnalyze(mcp as any, z);
const handler = tools.get("analyze")!;

Deno.test("co_occurrence type calls analyze_co_occurrence RPC", async () => {
  const mockResult = {
    total_edges: 42,
    avg_weight: 1.5,
    max_weight: 8.3,
    weight_distribution: { "0.01-0.1": 5, "0.1-0.5": 15, "0.5-1.0": 12, "1.0+": 10 },
    top_edges: [],
    hub_report: [],
    sessions: { total: 200, last_7d: 20, last_30d: 80 },
  };

  let rpcName = "";
  let rpcArgs: any = null;

  stubRpc(supabaseAdmin, (name, args) => {
    rpcName = name;
    rpcArgs = args;
    return mockChain({ data: mockResult, error: null });
  });
  try {
    const result = await handler({ type: "co_occurrence", min_connections: 5, force: false }, mockCtx());
    assertEquals(rpcName, "analyze_co_occurrence");
    assertEquals(rpcArgs.p_brain_id, TEST_BRAIN_ID);
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.total_edges, 42);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("co_occurrence RPC error returns isError", async () => {
  stubRpc(supabaseAdmin, () =>
    mockChain({ data: null, error: { message: "rpc failed" } })
  );
  try {
    const result = await handler({ type: "co_occurrence", min_connections: 5, force: false }, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Analysis failed");
  } finally {
    restore(supabaseAdmin);
  }
});
