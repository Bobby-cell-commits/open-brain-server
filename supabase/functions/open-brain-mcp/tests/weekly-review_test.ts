// Tests for weekly_review tool — Supabase query (thoughts) + OpenRouter chat completion.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  createMockMcp,
  mockChain,
  stubFrom,
  restore,
  mockCtx,
} from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerWeeklyReview } from "../tools/weekly-review.ts";
import * as z from "npm:zod@3";

// ---------------------------------------------------------------------------
// Fetch stub — chat completion for gpt-4o review synthesis
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;

function stubFetchForReview() {
  globalThis.fetch = (_url: string | URL | Request, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  themes: [
                    { theme: "AI tools", description: "Focus on AI tooling" },
                  ],
                  open_loops: ["Review pgvector performance"],
                  connections: ["AI tools link to knowledge systems"],
                  suggested_next_steps: ["Benchmark embedding models"],
                  summary: "A productive week exploring AI infrastructure.",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("weekly_review: returns review with period metadata", async () => {
  const { mcp, tools } = createMockMcp();
  registerWeeklyReview(mcp as any, z);
  const handler = tools.get("weekly_review")!;

  stubFetchForReview();
  try {
    // .from("thoughts").select(..., { count: "exact" }).gte().order().limit()
    // Returns 2 thoughts
    stubFrom(supabaseAdmin, (table: string) => {
      if (table === "thoughts") {
        return mockChain({
          data: [
            {
              id: "thought-1",
              content: "AI coding tools are evolving fast",
              metadata: { type: "observation", topics: ["ai-tools"] },
              created_at: "2026-03-28T10:00:00Z",
            },
            {
              id: "thought-2",
              content: "pgvector performance benchmarks look promising",
              metadata: { type: "reference", topics: ["pgvector"] },
              created_at: "2026-03-27T14:00:00Z",
            },
          ],
          error: null,
          count: 2,
        });
      }
      return mockChain({ data: null, error: null });
    });

    const result = await handler({ days: 7 }, mockCtx());
    const parsed = JSON.parse(result.content[0].text);

    // Verify review structure
    assertEquals(Array.isArray(parsed.review.themes), true);
    assertEquals(parsed.review.themes.length, 1);
    assertEquals(parsed.review.themes[0].theme, "AI tools");
    assertEquals(Array.isArray(parsed.review.open_loops), true);
    assertEquals(Array.isArray(parsed.review.suggested_next_steps), true);

    // Verify period metadata
    assertEquals(parsed.period.days, 7);
    assertEquals(parsed.period.thought_count, 2);
    assertEquals(parsed.period.total_in_period, 2);

    // Verify thought list
    assertEquals(parsed.thoughts.length, 2);
    assertEquals(parsed.thoughts[0].id, "thought-1");

    assertEquals(result.isError, undefined);
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("weekly_review: returns message when no thoughts found", async () => {
  const { mcp, tools } = createMockMcp();
  registerWeeklyReview(mcp as any, z);
  const handler = tools.get("weekly_review")!;

  // No fetch stub needed — should not reach OpenRouter when 0 thoughts
  try {
    stubFrom(supabaseAdmin, (table: string) => {
      if (table === "thoughts") {
        return mockChain({
          data: [],
          error: null,
          count: 0,
        });
      }
      return mockChain({ data: null, error: null });
    });

    const result = await handler({ days: 7 }, mockCtx());

    assertEquals(result.isError, undefined);
    assertStringIncludes(result.content[0].text, "No thoughts");
    assertStringIncludes(result.content[0].text, "7 days");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("weekly_review: error returns isError", async () => {
  const { mcp, tools } = createMockMcp();
  registerWeeklyReview(mcp as any, z);
  const handler = tools.get("weekly_review")!;

  try {
    // Simulate Supabase query error
    stubFrom(supabaseAdmin, (table: string) => {
      if (table === "thoughts") {
        return mockChain({
          data: null,
          error: { code: "42P01", message: "relation \"thoughts\" does not exist" },
          count: null,
        });
      }
      return mockChain({ data: null, error: null });
    });

    const result = await handler({ days: 7 }, mockCtx());

    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Weekly review failed");
  } finally {
    restore(supabaseAdmin);
    restoreFetch();
  }
});

Deno.test("weekly_review: missing brain context returns error", async () => {
  const { mcp, tools } = createMockMcp();
  registerWeeklyReview(mcp as any, z);
  const handler = tools.get("weekly_review")!;
  const result = await handler({});
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
