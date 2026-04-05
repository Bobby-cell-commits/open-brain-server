// tests/capture_test.ts

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { mockFetch, getFetchCalls, restoreFetch } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { mockChain, stubFrom, stubRpc, restore } from "../../open-brain-mcp/tests/_helpers.ts";
import { handleCapture, _deps } from "../handlers/capture.ts";
import type { TelegramMessage } from "../types.ts";

const FAKE_EMBEDDING = Array(1536).fill(0.1);
const FAKE_METADATA = JSON.stringify({
  type: "idea",
  topics: ["test-topic"],
  people: [],
  action_items: [],
  dates_mentioned: [],
  theme: "knowledge-systems",
  relevance: "Test thought",
  quality: 0.7,
  entities: [],
});

const TEST_MESSAGE: TelegramMessage = {
  message_id: 42,
  chat: { id: 12345, type: "private" },
  from: { id: 12345, is_bot: false, first_name: "Test" },
  text: "Graph-expanded search is a powerful pattern for knowledge retrieval",
  date: Math.floor(Date.now() / 1000),
};

const _originalDeps = { ..._deps };

function stubOpenRouter() {
  _deps.generateEmbedding = () => Promise.resolve(FAKE_EMBEDDING);
  _deps.chatCompletion = () => Promise.resolve(FAKE_METADATA);
}

function restoreOpenRouter() {
  _deps.generateEmbedding = _originalDeps.generateEmbedding;
  _deps.chatCompletion = _originalDeps.chatCompletion;
}

function stubSupabaseForCapture() {
  stubRpc(supabaseAdmin, (name: string, args?: any) => {
    if (name === "match_thoughts") {
      assertEquals(args.p_brain_id, "test-owner-brain-00000000");
      return mockChain({ data: [], error: null });
    }
    if (name === "resolve_entities") {
      return mockChain({ data: null, error: null });
    }
    if (name === "compute_salience_for_thought") {
      return mockChain({ data: null, error: null });
    }
    return mockChain({ data: null, error: null });
  });

  // insert calls .from("thoughts").insert()
  stubFrom(supabaseAdmin, () =>
    mockChain({ data: { id: "new-thought-id", created_at: "2026-03-28T00:00:00Z" }, error: null })
  );
}

Deno.test("handleCapture sends reaction and confirmation on success", async () => {
  mockFetch();
  stubOpenRouter();
  stubSupabaseForCapture();
  try {
    await handleCapture(TEST_MESSAGE);
    const calls = getFetchCalls();

    // Should have at least 2 Telegram calls: reaction + confirmation message
    const reactionCall = calls.find((c) => c.url.includes("setMessageReaction"));
    const messageCall = calls.find((c) => c.url.includes("sendMessage"));

    assertEquals(!!reactionCall, true, "should call setMessageReaction");
    assertEquals(!!messageCall, true, "should call sendMessage");

    const msgBody = JSON.parse(messageCall!.init?.body as string);
    assertStringIncludes(msgBody.text, "Captured");
    assertStringIncludes(msgBody.text, "idea");
  } finally {
    restoreFetch();
    restoreOpenRouter();
    restore(supabaseAdmin);
  }
});

Deno.test("handleCapture sends merge message when dedup triggers", async () => {
  mockFetch();
  stubOpenRouter();

  // Stub rpc to return a dedup match at 0.95 similarity
  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "match_thoughts") {
      return mockChain({
        data: [{
          id: "existing-id",
          content: "Graph-expanded search is a powerful pattern",
          similarity: 0.95,
        }],
        error: null,
      });
    }
    if (name === "perform_merge") {
      return mockChain({ data: null, error: null });
    }
    return mockChain({ data: null, error: null });
  });

  try {
    await handleCapture(TEST_MESSAGE);
    const calls = getFetchCalls();
    const messageCall = calls.find((c) => c.url.includes("sendMessage"));
    assertEquals(!!messageCall, true);
    const msgBody = JSON.parse(messageCall!.init?.body as string);
    assertStringIncludes(msgBody.text, "Merged");
  } finally {
    restoreFetch();
    restoreOpenRouter();
    restore(supabaseAdmin);
  }
});

Deno.test("handleCapture sends error message on failure", async () => {
  mockFetch();
  // Don't stub openrouter — let it fail (no real API key)
  stubOpenRouter();

  // Make Supabase insert fail
  stubRpc(supabaseAdmin, () => mockChain({ data: [], error: null }));
  stubFrom(supabaseAdmin, () => mockChain({ data: null, error: { message: "insert failed", code: "500" } }));

  try {
    await handleCapture(TEST_MESSAGE);
    const calls = getFetchCalls();
    const messageCall = calls.find((c) => c.url.includes("sendMessage"));
    assertEquals(!!messageCall, true);
    const msgBody = JSON.parse(messageCall!.init?.body as string);
    assertStringIncludes(msgBody.text, "failed");
  } finally {
    restoreFetch();
    restoreOpenRouter();
    restore(supabaseAdmin);
  }
});

Deno.test("handleCapture enforces quality floor of 0.6 for telegram", async () => {
  const LOW_QUALITY_METADATA = JSON.stringify({
    type: "observation",
    topics: ["test"],
    people: [],
    action_items: [],
    dates_mentioned: [],
    theme: "personal",
    relevance: "Quick note",
    quality: 0.3,
    entities: [],
  });

  mockFetch();
  _deps.generateEmbedding = () => Promise.resolve(FAKE_EMBEDDING);
  _deps.chatCompletion = () => Promise.resolve(LOW_QUALITY_METADATA);

  // Stub rpc (dedup + entities)
  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "match_thoughts") return mockChain({ data: [], error: null });
    if (name === "resolve_entities") return mockChain({ data: null, error: null });
    return mockChain({ data: null, error: null });
  });

  // Track what gets inserted via a capturing chain
  let insertedRecord: any = null;
  stubFrom(supabaseAdmin, (_table: string) => {
    const result = { data: { id: "quality-floor-id", created_at: "2026-03-31T00:00:00Z" }, error: null };
    // Build a chain that captures the insert argument
    return {
      insert(record: any) {
        insertedRecord = record;
        return mockChain(result);
      },
      // Fallback for any other chained method
      select: () => mockChain(result),
    };
  });

  try {
    await handleCapture(TEST_MESSAGE);
    assertEquals(insertedRecord !== null, true, "should have inserted a record");
    assertEquals(
      insertedRecord.metadata.quality >= 0.6,
      true,
      `Expected quality >= 0.6, got ${insertedRecord.metadata.quality}`,
    );
    assertEquals(insertedRecord.brain_id, "test-owner-brain-00000000");
  } finally {
    restoreFetch();
    restoreOpenRouter();
    restore(supabaseAdmin);
  }
});
