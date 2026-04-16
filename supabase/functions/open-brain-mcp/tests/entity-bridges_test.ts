// entity-bridges: Tests for storeEntityBridges() — entity-based cross-cluster bridge creation.
import { assertEquals } from "jsr:@std/assert";
import {
  stubRpc,
  stubFrom,
  mockChain,
  restore,
  TEST_BRAIN_ID,
} from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { storeEntityBridges } from "../../_shared/auto-link.ts";

Deno.test("storeEntityBridges skips when thought has no entities", async () => {
  const rpcCalls: string[] = [];
  stubRpc(supabaseAdmin, (name: string) => {
    rpcCalls.push(name);
    return mockChain({ data: [], error: null });
  });
  try {
    await storeEntityBridges(TEST_BRAIN_ID, "thought-1");
    assertEquals(
      rpcCalls.includes("find_entity_overlaps"),
      false,
      "Should not call find_entity_overlaps when thought has no entities",
    );
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("storeEntityBridges queries thought_entities then inserts bridges", async () => {
  const rpcCalls: { name: string; args: any }[] = [];
  let insertedRows: any[] = [];

  // First RPC call: get entities for this thought
  // Second RPC call: get overlapping thoughts with df counts
  stubRpc(supabaseAdmin, (name: string, args?: any) => {
    rpcCalls.push({ name, args });
    if (name === "get_thought_entity_ids") {
      return mockChain({
        data: [
          { entity_id: "ent-1", entity_name: "pgvector", df: 5 },
          { entity_id: "ent-2", entity_name: "Supabase", df: 13 },
        ],
        error: null,
      });
    }
    if (name === "find_entity_overlaps") {
      return mockChain({
        data: [
          {
            thought_id: "other-1",
            shared_entities: ["pgvector", "Supabase"],
            raw_score: 0.25 + 1.0 / 12, // 1/(5-1) + 1/(13-1)
          },
          {
            thought_id: "other-2",
            shared_entities: ["pgvector"],
            raw_score: 0.25, // 1/(5-1)
          },
        ],
        error: null,
      });
    }
    return mockChain({ data: [], error: null });
  });

  stubFrom(supabaseAdmin, () => ({
    upsert: (rows: any[]) => {
      insertedRows = rows;
      return mockChain({ error: null });
    },
  }));

  try {
    await storeEntityBridges(TEST_BRAIN_ID, "thought-new");

    // Should have called both RPCs
    assertEquals(rpcCalls.length, 2);
    assertEquals(rpcCalls[0].name, "get_thought_entity_ids");
    assertEquals(rpcCalls[0].args.p_thought_id, "thought-new");
    assertEquals(rpcCalls[1].name, "find_entity_overlaps");

    // Should insert 2 bridge rows
    assertEquals(insertedRows.length, 2);

    // Check first row structure
    const row1 = insertedRows[0];
    assertEquals(row1.link_type, "entity-bridge");
    assertEquals(row1.brain_id, TEST_BRAIN_ID);
    assertEquals(typeof row1.similarity, "number");
    assertEquals(row1.similarity > 0, true);
    assertEquals(row1.similarity <= 1, true);
    assertEquals(row1.metadata.shared_entities.includes("pgvector"), true);
    assertEquals(row1.metadata.alpha, 1.0);

    // source < target UUID ordering
    const ids = [row1.source_thought_id, row1.target_thought_id].sort();
    assertEquals(row1.source_thought_id, ids[0]);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("storeEntityBridges includes brain_id in RPC calls", async () => {
  let capturedArgs: any;
  stubRpc(supabaseAdmin, (name: string, args?: any) => {
    if (name === "get_thought_entity_ids") {
      capturedArgs = args;
      return mockChain({ data: [], error: null });
    }
    return mockChain({ data: [], error: null });
  });
  try {
    await storeEntityBridges(TEST_BRAIN_ID, "thought-1");
    assertEquals(capturedArgs.p_brain_id, TEST_BRAIN_ID);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("storeEntityBridges swallows errors (best-effort)", async () => {
  stubRpc(supabaseAdmin, () => {
    throw new Error("DB connection lost");
  });
  try {
    // Should not throw
    await storeEntityBridges(TEST_BRAIN_ID, "thought-1");
  } finally {
    restore(supabaseAdmin);
  }
});

// ---------------------------------------------------------------------------
// Newman-IDF formula verification
// ---------------------------------------------------------------------------

Deno.test("storeEntityBridges computes Newman-IDF similarity correctly", async () => {
  let insertedRows: any[] = [];

  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "get_thought_entity_ids") {
      return mockChain({
        data: [{ entity_id: "ent-1", entity_name: "pgvector", df: 5 }],
        error: null,
      });
    }
    if (name === "find_entity_overlaps") {
      // Single entity with df=5 → raw_score = 1/(5-1) = 0.25
      // Two entities: df=5 and df=13 → raw_score = 1/4 + 1/12 = 0.3333...
      return mockChain({
        data: [
          { thought_id: "other-1", shared_entities: ["pgvector"], raw_score: 0.25 },
          {
            thought_id: "other-2",
            shared_entities: ["pgvector", "Supabase"],
            raw_score: 1 / 4 + 1 / 12,
          },
        ],
        error: null,
      });
    }
    return mockChain({ data: [], error: null });
  });

  stubFrom(supabaseAdmin, () => ({
    upsert: (rows: any[]) => {
      insertedRows = rows;
      return mockChain({ error: null });
    },
  }));

  try {
    await storeEntityBridges(TEST_BRAIN_ID, "thought-new");

    // 1 - exp(-1.0 * 0.25) ≈ 0.2212
    const expected1 = 1 - Math.exp(-1.0 * 0.25);
    assertEquals(insertedRows[0].similarity, expected1);

    // 1 - exp(-1.0 * (1/4 + 1/12)) ≈ 0.2835
    const expected2 = 1 - Math.exp(-1.0 * (1 / 4 + 1 / 12));
    assertEquals(insertedRows[1].similarity, expected2);
  } finally {
    restore(supabaseAdmin);
  }
});

// ---------------------------------------------------------------------------
// UUID ordering: new thought sorts AFTER the other thought
// ---------------------------------------------------------------------------

Deno.test("storeEntityBridges orders UUIDs lexicographically (source < target)", async () => {
  let insertedRows: any[] = [];

  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "get_thought_entity_ids") {
      return mockChain({
        data: [{ entity_id: "ent-1", entity_name: "Deno", df: 3 }],
        error: null,
      });
    }
    if (name === "find_entity_overlaps") {
      return mockChain({
        data: [
          { thought_id: "aaaa-first", shared_entities: ["Deno"], raw_score: 0.5 },
        ],
        error: null,
      });
    }
    return mockChain({ data: [], error: null });
  });

  stubFrom(supabaseAdmin, () => ({
    upsert: (rows: any[]) => {
      insertedRows = rows;
      return mockChain({ error: null });
    },
  }));

  try {
    // "zzzz-new" sorts AFTER "aaaa-first" — source should be aaaa, target should be zzzz
    await storeEntityBridges(TEST_BRAIN_ID, "zzzz-new");
    assertEquals(insertedRows[0].source_thought_id, "aaaa-first");
    assertEquals(insertedRows[0].target_thought_id, "zzzz-new");
  } finally {
    restore(supabaseAdmin);
  }
});

// ---------------------------------------------------------------------------
// Entities exist but no other thought shares them
// ---------------------------------------------------------------------------

Deno.test("storeEntityBridges skips when entities exist but no overlaps", async () => {
  const rpcCalls: string[] = [];
  let upsertCalled = false;

  stubRpc(supabaseAdmin, (name: string) => {
    rpcCalls.push(name);
    if (name === "get_thought_entity_ids") {
      return mockChain({
        data: [{ entity_id: "ent-1", entity_name: "UniqueEntity", df: 2 }],
        error: null,
      });
    }
    if (name === "find_entity_overlaps") {
      return mockChain({ data: [], error: null }); // no overlaps
    }
    return mockChain({ data: [], error: null });
  });

  stubFrom(supabaseAdmin, () => ({
    upsert: () => {
      upsertCalled = true;
      return mockChain({ error: null });
    },
  }));

  try {
    await storeEntityBridges(TEST_BRAIN_ID, "thought-lonely");

    // Both RPCs called, but no upsert
    assertEquals(rpcCalls.includes("get_thought_entity_ids"), true);
    assertEquals(rpcCalls.includes("find_entity_overlaps"), true);
    assertEquals(upsertCalled, false);
  } finally {
    restore(supabaseAdmin);
  }
});

// ---------------------------------------------------------------------------
// Upsert configuration: ignoreDuplicates preserves semantic edges
// ---------------------------------------------------------------------------

Deno.test("storeEntityBridges uses ignoreDuplicates to preserve existing edges", async () => {
  let capturedUpsertOpts: any;

  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "get_thought_entity_ids") {
      return mockChain({
        data: [{ entity_id: "ent-1", entity_name: "Deno", df: 4 }],
        error: null,
      });
    }
    if (name === "find_entity_overlaps") {
      return mockChain({
        data: [
          { thought_id: "other-1", shared_entities: ["Deno"], raw_score: 0.333 },
        ],
        error: null,
      });
    }
    return mockChain({ data: [], error: null });
  });

  stubFrom(supabaseAdmin, () => ({
    upsert: (_rows: any[], opts: any) => {
      capturedUpsertOpts = opts;
      return mockChain({ error: null });
    },
  }));

  try {
    await storeEntityBridges(TEST_BRAIN_ID, "thought-x");
    assertEquals(capturedUpsertOpts.onConflict, "source_thought_id,target_thought_id");
    assertEquals(capturedUpsertOpts.ignoreDuplicates, true);
  } finally {
    restore(supabaseAdmin);
  }
});

// ---------------------------------------------------------------------------
// RPC errors: entity lookup error vs overlap lookup error
// ---------------------------------------------------------------------------

Deno.test("storeEntityBridges handles entity lookup RPC error gracefully", async () => {
  let overlapCalled = false;

  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "get_thought_entity_ids") {
      return mockChain({ data: null, error: { message: "relation not found" } });
    }
    if (name === "find_entity_overlaps") {
      overlapCalled = true;
    }
    return mockChain({ data: [], error: null });
  });

  try {
    await storeEntityBridges(TEST_BRAIN_ID, "thought-1");
    assertEquals(overlapCalled, false, "Should not call find_entity_overlaps after entity error");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("storeEntityBridges handles overlap RPC error gracefully", async () => {
  let upsertCalled = false;

  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "get_thought_entity_ids") {
      return mockChain({
        data: [{ entity_id: "ent-1", entity_name: "Deno", df: 3 }],
        error: null,
      });
    }
    if (name === "find_entity_overlaps") {
      return mockChain({ data: null, error: { message: "timeout" } });
    }
    return mockChain({ data: [], error: null });
  });

  stubFrom(supabaseAdmin, () => ({
    upsert: () => {
      upsertCalled = true;
      return mockChain({ error: null });
    },
  }));

  try {
    await storeEntityBridges(TEST_BRAIN_ID, "thought-1");
    assertEquals(upsertCalled, false, "Should not upsert after overlap error");
  } finally {
    restore(supabaseAdmin);
  }
});
