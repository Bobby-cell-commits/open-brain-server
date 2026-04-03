// list-entities: Tests for the list_entities MCP tool.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, stubRpc, restore, mockCtx, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerListEntities } from "../tools/list-entities.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerListEntities(mcp as any, z);
const handler = tools.get("list_entities")!;

Deno.test("returns entities as JSON", async () => {
  const data = [
    { id: "e1", name: "pgvector", entity_type: "tool", aliases: [], thought_count: 15 },
    { id: "e2", name: "Simon Willison", entity_type: "person", aliases: ["simonw"], thought_count: 8 },
  ];
  stubRpc(supabaseAdmin, () => Promise.resolve({ data, error: null }));
  try {
    const result = await handler({}, mockCtx());
    assertEquals(result.isError, undefined);
    assertEquals(JSON.parse(result.content[0].text), data);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("passes entity_type filter to RPC", async () => {
  let rpcArgs: any;
  stubRpc(supabaseAdmin, (_name: string, args?: any) => {
    rpcArgs = args;
    return Promise.resolve({ data: [], error: null });
  });
  try {
    await handler({ entity_type: "tool" }, mockCtx());
    assertEquals(rpcArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(rpcArgs.p_entity_type, "tool");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("passes min_thoughts and limit to RPC", async () => {
  let rpcArgs: any;
  stubRpc(supabaseAdmin, (_name: string, args?: any) => {
    rpcArgs = args;
    return Promise.resolve({ data: [], error: null });
  });
  try {
    await handler({ min_thoughts: 5, limit: 10 }, mockCtx());
    assertEquals(rpcArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(rpcArgs.p_min_thoughts, 5);
    assertEquals(rpcArgs.p_limit, 10);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("db error returns isError", async () => {
  stubRpc(supabaseAdmin, () => Promise.resolve({ data: null, error: { message: "timeout" } }));
  try {
    const result = await handler({}, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "failed");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("missing brain context returns error", async () => {
  const result = await handler({});
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
