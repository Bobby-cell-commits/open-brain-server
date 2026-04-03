// delete-thought: Tests delete with count pattern.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubFrom, restore, mockCtx } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerDeleteThought } from "../tools/delete-thought.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerDeleteThought(mcp as any, z);
const handler = tools.get("delete_thought")!;

const TEST_ID = "550e8400-e29b-41d4-a716-446655440000";

Deno.test("successful delete returns deleted: true", async () => {
  stubFrom(supabaseAdmin, () => mockChain({ error: null, count: 1 }));
  try {
    const result = await handler({ id: TEST_ID }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.deleted, true);
    assertEquals(parsed.id, TEST_ID);
    assertEquals(result.isError, undefined);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("not found (count=0) returns isError", async () => {
  stubFrom(supabaseAdmin, () => mockChain({ error: null, count: 0 }));
  try {
    const result = await handler({ id: TEST_ID }, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "not found");
    assertStringIncludes(result.content[0].text, TEST_ID);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("db error returns isError", async () => {
  stubFrom(supabaseAdmin, () => mockChain({ error: { message: "fk violation" }, count: null }));
  try {
    const result = await handler({ id: TEST_ID }, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Delete failed");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("missing brain context returns error", async () => {
  const result = await handler({ id: TEST_ID });
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
