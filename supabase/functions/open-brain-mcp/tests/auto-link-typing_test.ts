// auto-link-typing: Tests connection typing logic in storeConnections.

import { assertEquals } from "jsr:@std/assert";
import { stubRpc, stubFrom, mockChain, restore, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";

// We need to mock chatCompletion for connection typing.
// Import _deps from auto-link so we can swap chatCompletion without violating ESM namespace rules.
import { storeConnections, _deps } from "../../_shared/auto-link.ts";

Deno.test("storeConnections uses 'related' for connections below 0.80", async () => {
  let insertedRows: any[] = [];

  // match_thoughts returns one result at 0.78 similarity
  stubRpc(supabaseAdmin, () => {
    return Promise.resolve({
      data: [
        { id: "other-1", content: "some thought", similarity: 0.78 },
      ],
      error: null,
    });
  });

  stubFrom(supabaseAdmin, () => ({
    insert: (rows: any[]) => {
      insertedRows = rows;
      return mockChain({ error: null });
    },
  }));

  try {
    await storeConnections(TEST_BRAIN_ID, "new-id", [0.1, 0.2]);
    assertEquals(insertedRows.length, 1);
    assertEquals(insertedRows[0].link_type, "related");
    assertEquals(insertedRows[0].metadata, {});
    assertEquals(insertedRows[0].brain_id, TEST_BRAIN_ID);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("storeConnections calls LLM to classify connections at 0.80+", async () => {
  let insertedRows: any[] = [];
  let chatCalled = false;

  // match_thoughts returns one result at 0.85 similarity
  stubRpc(supabaseAdmin, () => {
    return Promise.resolve({
      data: [
        { id: "other-1", content: "thought about pgvector indexing", similarity: 0.85 },
      ],
      error: null,
    });
  });

  stubFrom(supabaseAdmin, () => ({
    insert: (rows: any[]) => {
      insertedRows = rows;
      return mockChain({ error: null });
    },
  }));

  // Stub chatCompletion via _deps (ESM-safe mutable indirection)
  const origChat = _deps.chatCompletion;
  _deps.chatCompletion = () => {
    chatCalled = true;
    return Promise.resolve(JSON.stringify({ link_type: "extends", reason: "builds on indexing discussion" }));
  };

  try {
    await storeConnections(TEST_BRAIN_ID, "new-id", [0.1, 0.2], "my new thought about pgvector");
    assertEquals(chatCalled, true);
    assertEquals(insertedRows.length, 1);
    assertEquals(insertedRows[0].link_type, "extends");
    assertEquals(insertedRows[0].metadata.reason, "builds on indexing discussion");
  } finally {
    _deps.chatCompletion = origChat;
    restore(supabaseAdmin);
  }
});

Deno.test("storeConnections falls back to 'related' if LLM typing fails", async () => {
  let insertedRows: any[] = [];

  stubRpc(supabaseAdmin, () => {
    return Promise.resolve({
      data: [
        { id: "other-1", content: "thought about something", similarity: 0.90 },
      ],
      error: null,
    });
  });

  stubFrom(supabaseAdmin, () => ({
    insert: (rows: any[]) => {
      insertedRows = rows;
      return mockChain({ error: null });
    },
  }));

  const origChat = _deps.chatCompletion;
  _deps.chatCompletion = () => {
    throw new Error("OpenRouter timeout");
  };

  try {
    await storeConnections(TEST_BRAIN_ID, "new-id", [0.1, 0.2], "new thought content");
    assertEquals(insertedRows.length, 1);
    assertEquals(insertedRows[0].link_type, "related");
  } finally {
    _deps.chatCompletion = origChat;
    restore(supabaseAdmin);
  }
});
