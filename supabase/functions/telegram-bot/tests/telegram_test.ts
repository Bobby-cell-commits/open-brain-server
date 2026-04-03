// tests/telegram_test.ts

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { mockFetch, getFetchCalls, restoreFetch } from "./_helpers.ts";
import { sendMessage, setReaction, formatConfirmation } from "../telegram.ts";
import type { ThoughtMetadata } from "../../_shared/types.ts";

Deno.test("sendMessage calls Telegram API with correct URL and body", async () => {
  mockFetch();
  try {
    await sendMessage(12345, "Hello brain");
    const calls = getFetchCalls();
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0].url, "api.telegram.org/bottest-bot-token/sendMessage");
    const body = JSON.parse(calls[0].init?.body as string);
    assertEquals(body.chat_id, 12345);
    assertEquals(body.text, "Hello brain");
    assertEquals(body.parse_mode, "HTML");
  } finally {
    restoreFetch();
  }
});

Deno.test("sendMessage passes reply_to_message_id when provided", async () => {
  mockFetch();
  try {
    await sendMessage(12345, "reply", { reply_to_message_id: 99 });
    const calls = getFetchCalls();
    const body = JSON.parse(calls[0].init?.body as string);
    assertEquals(body.reply_to_message_id, 99);
  } finally {
    restoreFetch();
  }
});

Deno.test("setReaction calls setMessageReaction endpoint", async () => {
  mockFetch();
  try {
    await setReaction(12345, 42, "🧠");
    const calls = getFetchCalls();
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0].url, "setMessageReaction");
    const body = JSON.parse(calls[0].init?.body as string);
    assertEquals(body.chat_id, 12345);
    assertEquals(body.message_id, 42);
    assertEquals(body.reaction[0].emoji, "🧠");
  } finally {
    restoreFetch();
  }
});

Deno.test("formatConfirmation includes type and topics", () => {
  const metadata: ThoughtMetadata = {
    type: "idea",
    topics: ["graph-search", "pgvector"],
    people: [],
    action_items: [],
    dates_mentioned: [],
    theme: "knowledge-systems",
    relevance: "Graph traversal for better retrieval",
    quality: 0.8,
  };
  const result = formatConfirmation(metadata);
  assertStringIncludes(result, "idea");
  assertStringIncludes(result, "graph-search");
  assertStringIncludes(result, "pgvector");
});

Deno.test("formatConfirmation includes action items when present", () => {
  const metadata: ThoughtMetadata = {
    type: "task",
    topics: ["telegram-migration"],
    people: [],
    action_items: [{ task: "Set up bot", assignee: null, due: "2026-04-03" }],
    dates_mentioned: ["2026-04-03"],
  };
  const result = formatConfirmation(metadata);
  assertStringIncludes(result, "Set up bot");
  assertStringIncludes(result, "2026-04-03");
});

Deno.test("formatConfirmation includes people when present", () => {
  const metadata: ThoughtMetadata = {
    type: "person_note",
    topics: ["collaboration"],
    people: ["Simon Willison"],
    action_items: [],
    dates_mentioned: [],
  };
  const result = formatConfirmation(metadata);
  assertStringIncludes(result, "Simon Willison");
});
