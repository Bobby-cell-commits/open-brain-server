// tests/_helpers.ts
// IMPORT ORDER MATTERS: import this module FIRST in every test file.
// Sets env vars before any module reads them at evaluation time.

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");
Deno.env.set("OPENROUTER_API_KEY", "test-key");
Deno.env.set("TELEGRAM_BOT_TOKEN", "test-bot-token");
Deno.env.set("TELEGRAM_SECRET_TOKEN", "test-secret");
Deno.env.set("TELEGRAM_ALLOWED_CHAT_ID", "12345");
Deno.env.set("OWNER_BRAIN_ID", "test-owner-brain-00000000");

// Stop Supabase auth timers that trigger Deno's leak detector.
const { supabaseAdmin: _client } = await import("../../_shared/supabase-client.ts");
_client.auth.stopAutoRefresh();
await new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// Fetch spy for Telegram API calls
// ---------------------------------------------------------------------------

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchCalls: FetchCall[] = [];
let fetchResponse: Response = new Response(JSON.stringify({ ok: true, result: true }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

export function mockFetch(response?: Response) {
  fetchCalls = [];
  if (response) fetchResponse = response;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Pass through non-Telegram calls to real fetch (e.g., Supabase, OpenRouter)
    if (!url.includes("api.telegram.org")) {
      return await globalThis.__originalFetch(input, init);
    }

    fetchCalls.push({ url, init });
    return fetchResponse.clone();
  }) as typeof fetch;
}

export function getFetchCalls(): FetchCall[] {
  return fetchCalls;
}

export function restoreFetch() {
  if (globalThis.__originalFetch) {
    globalThis.fetch = globalThis.__originalFetch;
  }
}

// Store original fetch before any tests run
declare global {
  var __originalFetch: typeof fetch;
}
globalThis.__originalFetch = globalThis.fetch;
