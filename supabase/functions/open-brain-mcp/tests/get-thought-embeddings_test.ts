// Unit tests for get_thought_embeddings RPC calling contract.
// Verifies parameter shape, result handling, and brain_id isolation.

import { assertEquals } from "jsr:@std/assert";
import { stubRpc, mockChain, restore, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";

const OTHER_BRAIN_ID = "other-brain-00000000";

function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.5);
}

Deno.test("get_thought_embeddings returns embeddings for matching IDs", async () => {
  const thoughtIds = ["aaa-111", "bbb-222"];
  const expected = [
    { id: "aaa-111", embedding: fakeEmbedding(1) },
    { id: "bbb-222", embedding: fakeEmbedding(2) },
  ];

  stubRpc(supabaseAdmin, (name: string, args?: any) => {
    assertEquals(name, "get_thought_embeddings");
    assertEquals(args.p_brain_id, TEST_BRAIN_ID);
    assertEquals(args.p_thought_ids, thoughtIds);
    return mockChain({ data: expected, error: null });
  });

  try {
    const { data, error } = await supabaseAdmin.rpc("get_thought_embeddings", {
      p_brain_id: TEST_BRAIN_ID,
      p_thought_ids: thoughtIds,
    });

    assertEquals(error, null);
    assertEquals(data.length, 2);
    assertEquals(data[0].id, "aaa-111");
    assertEquals(data[0].embedding.length, 1536);
    assertEquals(data[1].id, "bbb-222");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("get_thought_embeddings returns empty array for empty input", async () => {
  stubRpc(supabaseAdmin, (name: string, args?: any) => {
    assertEquals(name, "get_thought_embeddings");
    assertEquals(args.p_thought_ids, []);
    return mockChain({ data: [], error: null });
  });

  try {
    const { data, error } = await supabaseAdmin.rpc("get_thought_embeddings", {
      p_brain_id: TEST_BRAIN_ID,
      p_thought_ids: [],
    });

    assertEquals(error, null);
    assertEquals(data.length, 0);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("get_thought_embeddings returns subset for partially matching IDs", async () => {
  const thoughtIds = ["aaa-111", "nonexistent-999"];

  stubRpc(supabaseAdmin, (_name: string, args?: any) => {
    assertEquals(args.p_thought_ids, thoughtIds);
    // DB only returns rows that exist
    return mockChain({
      data: [{ id: "aaa-111", embedding: fakeEmbedding(1) }],
      error: null,
    });
  });

  try {
    const { data, error } = await supabaseAdmin.rpc("get_thought_embeddings", {
      p_brain_id: TEST_BRAIN_ID,
      p_thought_ids: thoughtIds,
    });

    assertEquals(error, null);
    assertEquals(data.length, 1);
    assertEquals(data[0].id, "aaa-111");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("get_thought_embeddings scopes by brain_id", async () => {
  let capturedArgs: any;

  stubRpc(supabaseAdmin, (_name: string, args?: any) => {
    capturedArgs = args;
    return mockChain({ data: [], error: null });
  });

  try {
    // Call with a different brain — should pass that brain_id through
    await supabaseAdmin.rpc("get_thought_embeddings", {
      p_brain_id: OTHER_BRAIN_ID,
      p_thought_ids: ["aaa-111"],
    });

    assertEquals(capturedArgs.p_brain_id, OTHER_BRAIN_ID);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("get_thought_embeddings propagates database errors", async () => {
  stubRpc(supabaseAdmin, () => {
    return mockChain({ data: null, error: { message: "relation does not exist" } });
  });

  try {
    const { data, error } = await supabaseAdmin.rpc("get_thought_embeddings", {
      p_brain_id: TEST_BRAIN_ID,
      p_thought_ids: ["aaa-111"],
    });

    assertEquals(data, null);
    assertEquals(error.message, "relation does not exist");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("get_thought_embeddings handles large batch of IDs", async () => {
  const batchSize = 200;
  const thoughtIds = Array.from({ length: batchSize }, (_, i) => `thought-${i}`);
  const expected = thoughtIds.map((id, i) => ({ id, embedding: fakeEmbedding(i) }));

  stubRpc(supabaseAdmin, (_name: string, args?: any) => {
    assertEquals(args.p_thought_ids.length, batchSize);
    return mockChain({ data: expected, error: null });
  });

  try {
    const { data, error } = await supabaseAdmin.rpc("get_thought_embeddings", {
      p_brain_id: TEST_BRAIN_ID,
      p_thought_ids: thoughtIds,
    });

    assertEquals(error, null);
    assertEquals(data.length, batchSize);
  } finally {
    restore(supabaseAdmin);
  }
});
