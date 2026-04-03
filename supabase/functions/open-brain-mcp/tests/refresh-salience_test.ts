// refresh_salience: Tests the RPC wrapper tool.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubRpc, restore, mockCtx, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerRefreshSalience } from "../tools/refresh-salience.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerRefreshSalience(mcp as any, z);
const handler = tools.get("refresh_salience")!;

Deno.test("returns updated_count on success", async () => {
  let capturedName: string | undefined;
  stubRpc(supabaseAdmin, (name) => {
    capturedName = name;
    return mockChain({ data: 1472, error: null });
  });
  try {
    const result = await handler({}, mockCtx());
    assertEquals(capturedName, "refresh_salience");
    const parsed = JSON.parse(result.content[0].text);
    assertEquals(parsed.updated_count, 1472);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("returns isError on RPC failure", async () => {
  stubRpc(supabaseAdmin, () =>
    mockChain({ data: null, error: { message: "function not found" } }),
  );
  try {
    const result = await handler({}, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Refresh salience failed");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("missing brain context returns error", async () => {
  const result = await handler({});
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
