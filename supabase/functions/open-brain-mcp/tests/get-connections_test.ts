// get_connections: Tests RPC call pattern and result enrichment.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubRpc, restore, mockCtx, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerGetConnections } from "../tools/get-connections.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerGetConnections(mcp as any, z);
const handler = tools.get("get_connections")!;

const TEST_ID = "550e8400-e29b-41d4-a716-446655440000";

Deno.test("passes thought_id to RPC", async () => {
  let capturedName: string | undefined;
  let capturedArgs: any;

  stubRpc(supabaseAdmin, (name, args) => {
    capturedName = name;
    capturedArgs = args;
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({ thought_id: TEST_ID }, mockCtx());
    assertEquals(capturedName, "get_thought_connections");
    assertEquals(capturedArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(capturedArgs.p_thought_id, TEST_ID);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("returns connection results as JSON", async () => {
  const rpcData = [
    {
      connected_thought_id: "aaa-bbb",
      content: "Some thought",
      similarity: 0.87,
      link_type: "extends",
      connection_metadata: { reason: "builds on the same idea" },
      created_at: "2026-03-01T00:00:00Z",
    },
    {
      connected_thought_id: "ccc-ddd",
      content: "Another thought",
      similarity: 0.76,
      link_type: "related",
      connection_metadata: null,
      created_at: "2026-03-02T00:00:00Z",
    },
  ];

  stubRpc(supabaseAdmin, () => mockChain({ data: rpcData, error: null }));
  try {
    const result = await handler({ thought_id: TEST_ID }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.length, 2);
    assertEquals(parsed[0].connected_thought_id, "aaa-bbb");
    assertEquals(parsed[0].similarity, 0.87);
    assertEquals(parsed[0].link_type, "extends");
    assertEquals(parsed[0].reason, "builds on the same idea");
    assertEquals(parsed[1].reason, null);
    assertEquals(result.isError, undefined);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("RPC error returns isError", async () => {
  stubRpc(supabaseAdmin, () =>
    mockChain({ data: null, error: { message: "relation not found" } }),
  );
  try {
    const result = await handler({ thought_id: TEST_ID }, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "failed");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("missing brain context returns error", async () => {
  const result = await handler({ thought_id: "abc" });
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
