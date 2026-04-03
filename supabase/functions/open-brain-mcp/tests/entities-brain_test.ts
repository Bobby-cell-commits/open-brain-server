// entities-brain: Tests brainId threading through resolveEntities.

import "./_helpers.ts";
import { assertEquals } from "jsr:@std/assert";
import { stubRpc, restore, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { resolveEntities } from "../../_shared/entities.ts";

Deno.test("resolveEntities passes p_brain_id to resolve_entities RPC", async () => {
  let capturedArgs: any;

  stubRpc(supabaseAdmin, (_name: string, args?: any) => {
    capturedArgs = args;
    return Promise.resolve({ data: null, error: null });
  });

  try {
    await resolveEntities(TEST_BRAIN_ID, [{ name: "Deno", type: "tool", role: "about" }], "thought-1");
    assertEquals(capturedArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(capturedArgs.p_thought_id, "thought-1");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("resolveEntities skips RPC for empty entities", async () => {
  let rpcCalled = false;

  stubRpc(supabaseAdmin, () => {
    rpcCalled = true;
    return Promise.resolve({ data: null, error: null });
  });

  try {
    await resolveEntities(TEST_BRAIN_ID, [], "thought-1");
    assertEquals(rpcCalled, false);
  } finally {
    restore(supabaseAdmin);
  }
});
