// openbrain/supabase/functions/open-brain-mcp/tests/entities_test.ts

import "./_helpers.ts";
import { assertEquals } from "jsr:@std/assert";
import type { EntityMention } from "../../_shared/types.ts";
import { createMockMcp, stubRpc, restore, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { resolveEntities } from "../../_shared/entities.ts";

Deno.test("EntityMention type has required fields", () => {
  const mention: EntityMention = {
    name: "Simon Willison",
    type: "person",
    role: "mention",
  };
  assertEquals(mention.name, "Simon Willison");
  assertEquals(mention.type, "person");
  assertEquals(mention.role, "mention");
});

Deno.test("resolveEntities calls resolve_entities RPC with formatted entities", async () => {
  let rpcName: string | undefined;
  let rpcArgs: any;

  stubRpc(supabaseAdmin, (name: string, args?: any) => {
    rpcName = name;
    rpcArgs = args;
    return Promise.resolve({ data: null, error: null });
  });

  try {
    await resolveEntities(
      TEST_BRAIN_ID,
      [{ name: "pgvector", type: "tool", role: "about" }],
      "thought-123",
    );
    assertEquals(rpcName, "resolve_entities");
    assertEquals(rpcArgs.p_brain_id, TEST_BRAIN_ID);
    assertEquals(rpcArgs.p_thought_id, "thought-123");
    assertEquals(rpcArgs.p_entities[0].name, "pgvector");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("resolveEntities skips empty entities array", async () => {
  let rpcCalled = false;

  stubRpc(supabaseAdmin, () => {
    rpcCalled = true;
    return Promise.resolve({ data: null, error: null });
  });

  try {
    await resolveEntities(TEST_BRAIN_ID, [], "thought-123");
    assertEquals(rpcCalled, false);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("resolveEntities swallows errors (best-effort)", async () => {
  stubRpc(supabaseAdmin, () => {
    return Promise.resolve({ data: null, error: { message: "db timeout" } });
  });

  try {
    // Should not throw
    await resolveEntities(
      TEST_BRAIN_ID,
      [{ name: "Deno", type: "tool", role: "mention" }],
      "thought-456",
    );
  } finally {
    restore(supabaseAdmin);
  }
});
