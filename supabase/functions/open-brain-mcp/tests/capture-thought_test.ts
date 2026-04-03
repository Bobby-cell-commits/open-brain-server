// Tests for capture_thought tool — OpenRouter (embedding + chat completion),
// Supabase RPC (dedup), and Supabase table ops (insert).

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  createMockMcp,
  mockChain,
  stubRpc,
  stubFrom,
  restore,
  mockCtx,
} from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerCaptureThought } from "../tools/capture-thought.ts";
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
      // Return a response that satisfies both generateEmbedding and chatCompletion.
      // generateEmbedding reads result.data[0].embedding
      // chatCompletion reads result.choices[0].message.content
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3] }],
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    people: [],
                    topics: ["test-topic"],
                    type: "idea",
                    theme: "ml-research",
                    relevance: "test relevance",
                    action_items: [],
                    dates_mentioned: [],
                    quality: 0.7,
                    entities: [],
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

Deno.test("capture_thought: captures thought and returns id", async () => {
  const { mcp, tools } = createMockMcp();
  registerCaptureThought(mcp as any, z);
  const handler = tools.get("capture_thought")!;

  stubFetch();
  try {
    // checkDedup calls rpc("match_thoughts") — return no matches (no dedup)
    // storeConnections also calls rpc("match_thoughts") — return no matches
    // resolveEntities calls rpc("resolve_entities") — return success
    stubRpc(supabaseAdmin, (name: string, _args?: any) => {
      if (name === "match_thoughts") {
        return mockChain({ data: [], error: null });
      }
      if (name === "resolve_entities") {
        return mockChain({ data: null, error: null });
      }
      return mockChain({ data: null, error: null });
    });

    // .from("thoughts").insert(...).select().single() returns the new row
    stubFrom(supabaseAdmin, (table: string) => {
      if (table === "thoughts") {
        return mockChain({
          data: {
            id: "aaaa-bbbb-cccc-dddd",
            created_at: "2026-03-29T10:00:00Z",
          },
          error: null,
        });
      }
      // thought_connections insert (from storeConnections)
      if (table === "thought_connections") {
        return mockChain({ data: null, error: null });
      }
      return mockChain({ data: null, error: null });
    });

    const result = await handler({ content: "A test thought about AI tools" }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);

    assertEquals(parsed.id, "aaaa-bbbb-cccc-dddd");
    assertEquals(parsed.message, "Thought captured successfully");
    assertEquals(parsed.metadata.type, "idea");
    assertEquals(result.isError, undefined);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("capture_thought: returns merged result when dedup matches", async () => {
  const { mcp, tools } = createMockMcp();
  registerCaptureThought(mcp as any, z);
  const handler = tools.get("capture_thought")!;

  stubFetch();
  try {
    // checkDedup: rpc("match_thoughts") returns a high-similarity match (>= 0.92)
    // rpc("perform_merge") and rpc("log_merge") are also called during merge
    stubRpc(supabaseAdmin, (name: string, _args?: any) => {
      if (name === "match_thoughts") {
        return mockChain({
          data: [
            {
              id: "existing-thought-id",
              content: "An existing thought about AI tools that is very similar",
              similarity: 0.95,
            },
          ],
          error: null,
        });
      }
      if (name === "perform_merge") {
        return mockChain({ data: null, error: null });
      }
      if (name === "log_merge") {
        return mockChain({ data: null, error: null });
      }
      return mockChain({ data: null, error: null });
    });

    // from() should not be called for insert when merged, but stub anyway
    stubFrom(supabaseAdmin, () => mockChain({ data: null, error: null }));

    const result = await handler({ content: "A test thought about AI tools" }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);

    assertEquals(parsed.merged, true);
    assertEquals(parsed.original_id, "existing-thought-id");
    assertEquals(parsed.similarity, 0.95);
    assertStringIncludes(parsed.message, "merged");
    assertEquals(result.isError, undefined);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("capture_thought: error returns isError", async () => {
  const { mcp, tools } = createMockMcp();
  registerCaptureThought(mcp as any, z);
  const handler = tools.get("capture_thought")!;

  // Stub fetch to reject — simulates OpenRouter failure
  globalThis.fetch = () => {
    return Promise.reject(new Error("OpenRouter is down"));
  };

  try {
    // Stubs should not be reached, but add them for safety
    stubRpc(supabaseAdmin, () => mockChain({ data: null, error: null }));
    stubFrom(supabaseAdmin, () => mockChain({ data: null, error: null }));

    const result = await handler({ content: "This will fail" }, mockCtx());

    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Capture failed");
    assertStringIncludes(result.content[0].text, "OpenRouter is down");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("capture_thought: missing brain context returns error", async () => {
  const { mcp, tools } = createMockMcp();
  registerCaptureThought(mcp as any, z);
  const handler = tools.get("capture_thought")!;
  const result = await handler({ content: "test" });
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
