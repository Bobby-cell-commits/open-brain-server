// auto-link-brain: Tests brainId threading through checkDedup and storeConnections.

import { assertEquals } from "jsr:@std/assert";
import { stubRpc, stubFrom, mockChain, restore, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { checkDedup, storeConnections } from "../../_shared/auto-link.ts";

Deno.test("checkDedup passes p_brain_id to match_thoughts", async () => {
  let capturedArgs: any;

  stubRpc(supabaseAdmin, (name: string, args?: any) => {
    if (name === "match_thoughts") capturedArgs = args;
    return mockChain({ data: [], error: null });
  });

  try {
    await checkDedup(TEST_BRAIN_ID, [0.1, 0.2], "mcp", null, "test content");
    assertEquals(capturedArgs.p_brain_id, TEST_BRAIN_ID);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("checkDedup passes p_brain_id to perform_merge on duplicate", async () => {
  let mergeArgs: any;

  stubRpc(supabaseAdmin, (name: string, args?: any) => {
    if (name === "match_thoughts") {
      return mockChain({
        data: [{ id: "existing", content: "existing thought", similarity: 0.95 }],
        error: null,
      });
    }
    if (name === "perform_merge") mergeArgs = args;
    return mockChain({ data: null, error: null });
  });

  try {
    await checkDedup(TEST_BRAIN_ID, [0.1, 0.2], "mcp", null, "test content");
    assertEquals(mergeArgs.p_brain_id, TEST_BRAIN_ID);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("storeConnections passes p_brain_id to match_thoughts", async () => {
  let capturedArgs: any;

  stubRpc(supabaseAdmin, (name: string, args?: any) => {
    if (name === "match_thoughts") capturedArgs = args;
    return Promise.resolve({ data: [], error: null });
  });

  try {
    await storeConnections(TEST_BRAIN_ID, "new-id", [0.1, 0.2]);
    assertEquals(capturedArgs.p_brain_id, TEST_BRAIN_ID);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("storeConnections includes brain_id in connection rows", async () => {
  let insertedRows: any[] = [];

  stubRpc(supabaseAdmin, () => Promise.resolve({
    data: [{ id: "other-1", content: "related", similarity: 0.78 }],
    error: null,
  }));

  stubFrom(supabaseAdmin, () => ({
    insert: (rows: any[]) => {
      insertedRows = rows;
      return mockChain({ error: null });
    },
  }));

  try {
    await storeConnections(TEST_BRAIN_ID, "new-id", [0.1, 0.2]);
    assertEquals(insertedRows.length, 1);
    assertEquals(insertedRows[0].brain_id, TEST_BRAIN_ID);
  } finally {
    restore(supabaseAdmin);
  }
});
