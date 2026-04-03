// insert-thought: Tests shared insert function.

import { assertEquals, assertRejects } from "jsr:@std/assert";
import { mockChain, stubFrom, restore } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { insertThought } from "../../_shared/insert-thought.ts";

const BASE_PARAMS = {
  brainId: "test-brain-id",
  content: "A test thought",
  embedding: [0.1, 0.2, 0.3],
  metadata: { type: "idea" },
  source: "mcp",
  sourceEventId: null,
};

Deno.test("insertThought returns id and created_at on success", async () => {
  let insertedRecord: any;

  stubFrom(supabaseAdmin, () => ({
    insert: (record: any) => {
      insertedRecord = record;
      return {
        select: () => ({
          single: () => Promise.resolve({
            data: { id: "new-id-123", created_at: "2026-04-02T12:00:00Z" },
            error: null,
          }),
        }),
      };
    },
  }));

  try {
    const result = await insertThought(BASE_PARAMS);
    assertEquals(result.id, "new-id-123");
    assertEquals(result.created_at, "2026-04-02T12:00:00Z");
    assertEquals(insertedRecord.brain_id, "test-brain-id");
    assertEquals(insertedRecord.content, "A test thought");
    assertEquals(insertedRecord.source, "mcp");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("insertThought returns duplicate marker on 23505 error", async () => {
  stubFrom(supabaseAdmin, () => ({
    insert: () => ({
      select: () => ({
        single: () => Promise.resolve({
          data: null,
          error: { code: "23505", message: "duplicate key" },
        }),
      }),
    }),
  }));

  try {
    const result = await insertThought(BASE_PARAMS);
    assertEquals(result.id, "duplicate");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("insertThought throws on other errors", async () => {
  stubFrom(supabaseAdmin, () => ({
    insert: () => ({
      select: () => ({
        single: () => Promise.resolve({
          data: null,
          error: { code: "42P01", message: "relation does not exist" },
        }),
      }),
    }),
  }));

  try {
    await assertRejects(
      () => insertThought(BASE_PARAMS),
    );
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("insertThought includes brain_id in payload", async () => {
  let insertedRecord: any;

  stubFrom(supabaseAdmin, () => ({
    insert: (record: any) => {
      insertedRecord = record;
      return {
        select: () => ({
          single: () => Promise.resolve({
            data: { id: "x", created_at: "2026-01-01" },
            error: null,
          }),
        }),
      };
    },
  }));

  try {
    await insertThought({ ...BASE_PARAMS, brainId: "custom-brain-id" });
    assertEquals(insertedRecord.brain_id, "custom-brain-id");
  } finally {
    restore(supabaseAdmin);
  }
});
