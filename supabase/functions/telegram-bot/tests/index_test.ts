// tests/index_test.ts

import { assertEquals } from "jsr:@std/assert";
import "./_helpers.ts";

// Track background promises so tests can await them before cleanup.
const _bgPromises: Promise<unknown>[] = [];

// Polyfill EdgeRuntime before index.ts is imported — it uses EdgeRuntime.waitUntil()
// Store promises so tests can drain them before asserting/cleanup.
(globalThis as any).EdgeRuntime = {
  waitUntil: (p: Promise<unknown>) => {
    _bgPromises.push(p.catch(() => {}));
  },
};

// Make Deno.serve a no-op so importing index.ts doesn't start a real server.
(Deno as any).serve = () => {};

// Helper: drain all pending background promises, then clear the queue.
async function drainBg(): Promise<void> {
  const pending = _bgPromises.splice(0);
  await Promise.allSettled(pending);
}

// sanitizeOps/sanitizeResources: false on the first test because importing index.ts
// triggers supabase-client.ts evaluation which starts an auth auto-refresh interval.
// Subsequent tests reuse the cached module so the interval is already running.
Deno.test(
  { name: "rejects non-POST requests with 405", sanitizeOps: false, sanitizeResources: false },
  async () => {
    const { handleRequest } = await import("../index.ts");
    const req = new Request("http://localhost/telegram-bot", { method: "GET" });
    const res = await handleRequest(req);
    await drainBg();
    assertEquals(res.status, 405);
  },
);

Deno.test("rejects missing secret token with 401", async () => {
  const { handleRequest } = await import("../index.ts");
  const body = JSON.stringify({
    update_id: 1,
    message: { message_id: 1, chat: { id: 12345, type: "private" }, text: "hello", date: 0 },
  });
  const req = new Request("http://localhost/telegram-bot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 401);
});

Deno.test("rejects wrong secret token with 401", async () => {
  const { handleRequest } = await import("../index.ts");
  const body = JSON.stringify({
    update_id: 1,
    message: { message_id: 1, chat: { id: 12345, type: "private" }, text: "hello", date: 0 },
  });
  const req = new Request("http://localhost/telegram-bot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
    },
    body,
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 401);
});

Deno.test("silently drops messages from unauthorized chat IDs", async () => {
  const { handleRequest } = await import("../index.ts");
  const body = JSON.stringify({
    update_id: 1,
    message: { message_id: 1, chat: { id: 99999, type: "private" }, text: "hello", date: 0 },
  });
  const req = new Request("http://localhost/telegram-bot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-secret",
    },
    body,
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.ok, true);
});

// sanitizeOps: false because EdgeRuntime.waitUntil fires capture in background;
// we drain it before cleanup but Deno's op sanitizer still sees the Supabase interval.
Deno.test(
  { name: "returns 200 for valid authorized request", sanitizeOps: false, sanitizeResources: false },
  async () => {
    const { handleRequest } = await import("../index.ts");
    const { mockFetch, restoreFetch } = await import("./_helpers.ts");
    mockFetch();

    // Stub capture handler's _deps (not the openrouter module directly)
    const { _deps } = await import("../handlers/capture.ts");
    const origDeps = { ..._deps };
    _deps.generateEmbedding = async () => Array(1536).fill(0.1);
    _deps.chatCompletion = async () => JSON.stringify({
      type: "idea",
      topics: ["test"],
      people: [],
      action_items: [],
      dates_mentioned: [],
      theme: "personal",
      relevance: "test",
      quality: 0.5,
      entities: [],
    });

    const { supabaseAdmin } = await import("../../_shared/supabase-client.ts");
    const { mockChain, stubRpc, stubFrom, restore } = await import(
      "../../open-brain-mcp/tests/_helpers.ts"
    );
    stubRpc(supabaseAdmin, () => mockChain({ data: [], error: null }));
    stubFrom(supabaseAdmin, () =>
      mockChain({ data: { id: "test-id" }, error: null })
    );

    try {
      const body = JSON.stringify({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 12345, type: "private" },
          text: "a thought",
          date: 0,
        },
      });
      const req = new Request("http://localhost/telegram-bot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "test-secret",
        },
        body,
      });
      const res = await handleRequest(req);
      assertEquals(res.status, 200);
      // Drain background promises before restoring stubs
      await drainBg();
    } finally {
      restoreFetch();
      Object.assign(_deps, origDeps);
      restore(supabaseAdmin);
    }
  },
);
