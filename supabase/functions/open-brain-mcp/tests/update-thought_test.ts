// Tests for update_thought tool — OpenRouter (embedding + chat completion),
// Supabase table ops (update).

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  createMockMcp,
  mockChain,
  stubFrom,
  restore,
  mockCtx,
} from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerUpdateThought } from "../tools/update-thought.ts";
import * as z from "npm:zod@3";

// ---------------------------------------------------------------------------
// Fetch stub — handles both embedding and chat completion OpenRouter calls
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = (url: string | URL | Request, _init?: RequestInit) => {
    const urlStr =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;

    if (urlStr.includes("openrouter")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.4, 0.5, 0.6] }],
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    people: [],
                    topics: ["updated-topic"],
                    type: "observation",
                    action_items: [],
                    dates_mentioned: [],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("update_thought: updates thought and returns id", async () => {
  const { mcp, tools } = createMockMcp();
  registerUpdateThought(mcp as any, z);
  const handler = tools.get("update_thought")!;

  stubFetch();
  try {
    // .from("thoughts").update().eq().select().single() returns updated row
    stubFrom(supabaseAdmin, (table: string) => {
      if (table === "thoughts") {
        return mockChain({
          data: {
            id: "11111111-2222-3333-4444-555555555555",
            updated_at: "2026-03-29T12:00:00Z",
          },
          error: null,
        });
      }
      return mockChain({ data: null, error: null });
    });

    const result = await handler({
      id: "11111111-2222-3333-4444-555555555555",
      content: "Updated thought content",
    }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);

    assertEquals(parsed.id, "11111111-2222-3333-4444-555555555555");
    assertEquals(parsed.updated_at, "2026-03-29T12:00:00Z");
    assertEquals(parsed.metadata.type, "observation");
    assertEquals(parsed.metadata.topics[0], "updated-topic");
    assertEquals(result.isError, undefined);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("update_thought: not found returns isError", async () => {
  const { mcp, tools } = createMockMcp();
  registerUpdateThought(mcp as any, z);
  const handler = tools.get("update_thought")!;

  stubFetch();
  try {
    // Simulate PGRST116 — "The result contains 0 rows" (thought not found)
    stubFrom(supabaseAdmin, (table: string) => {
      if (table === "thoughts") {
        return mockChain({
          data: null,
          error: { code: "PGRST116", message: "The result contains 0 rows" },
        });
      }
      return mockChain({ data: null, error: null });
    });

    const result = await handler({
      id: "00000000-0000-0000-0000-000000000000",
      content: "Content for nonexistent thought",
    }, mockCtx());

    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "not found");
    assertStringIncludes(
      result.content[0].text,
      "00000000-0000-0000-0000-000000000000",
    );
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("update_thought: error returns isError", async () => {
  const { mcp, tools } = createMockMcp();
  registerUpdateThought(mcp as any, z);
  const handler = tools.get("update_thought")!;

  // Stub fetch to reject — simulates OpenRouter failure
  globalThis.fetch = () => {
    return Promise.reject(new Error("Network timeout"));
  };

  try {
    stubFrom(supabaseAdmin, () => mockChain({ data: null, error: null }));

    const result = await handler({
      id: "11111111-2222-3333-4444-555555555555",
      content: "This will fail",
    }, mockCtx());

    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Update failed");
    assertStringIncludes(result.content[0].text, "Network timeout");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("update_thought: missing brain context returns error", async () => {
  const { mcp, tools } = createMockMcp();
  registerUpdateThought(mcp as any, z);
  const handler = tools.get("update_thought")!;
  const result = await handler({ id: "abc", content: "test" });
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
