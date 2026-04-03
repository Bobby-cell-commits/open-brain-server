// serendipity-digest: Tests RPC call and response formatting.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { createMockMcp, mockChain, stubRpc, restore, mockCtx, TEST_BRAIN_ID } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { registerSerendipityDigest } from "../tools/serendipity-digest.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerSerendipityDigest(mcp as any, z);
const handler = tools.get("serendipity_digest")!;

Deno.test("passes p_brain_id to serendipity_digest RPC", async () => {
  let capturedName: string | undefined;
  let capturedArgs: any;

  stubRpc(supabaseAdmin, (name, args) => {
    capturedName = name;
    capturedArgs = args;
    return mockChain({ data: [], error: null });
  });
  try {
    await handler({}, mockCtx());
    assertEquals(capturedName, "serendipity_digest");
    assertEquals(capturedArgs.p_brain_id, TEST_BRAIN_ID);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("returns formatted digest with 4 slots", async () => {
  const digestData = [
    { slot: "rediscovery", id: "aaa", content: "Old gem about embeddings", source: "telegram", theme: "ml-research", quality: 0.9, created_at: "2026-01-15T10:00:00Z", reason: "High quality, not accessed in 30+ days" },
    { slot: "orphan", id: "bbb", content: "Disconnected thought about Rust", source: "mcp", theme: "ai-coding-tools", quality: 0.7, created_at: "2026-02-20T14:00:00Z", reason: "Zero connections" },
    { slot: "underrepresented", id: "ccc", content: "Note on personal workflow", source: "telegram", theme: "personal", quality: 0.6, created_at: "2026-03-01T08:00:00Z", reason: "Theme has fewest thoughts" },
    { slot: "echo", id: "ddd", content: "Related to recent AI agents capture", source: "reddit", theme: "ml-research", quality: 0.8, created_at: "2026-02-10T12:00:00Z", reason: "Echoes recent capture" },
  ];

  stubRpc(supabaseAdmin, () => mockChain({ data: digestData, error: null }));
  try {
    const result = await handler({}, mockCtx());
    assertEquals(result.isError, undefined);
    const text = result.content[0].text;
    assertStringIncludes(text, "REDISCOVERY");
    assertStringIncludes(text, "ORPHAN");
    assertStringIncludes(text, "UNDERREPRESENTED");
    assertStringIncludes(text, "ECHO");
    assertStringIncludes(text, "Old gem about embeddings");
    assertStringIncludes(text, "id: aaa");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("empty results returns no-thoughts message", async () => {
  stubRpc(supabaseAdmin, () => mockChain({ data: [], error: null }));
  try {
    const result = await handler({}, mockCtx());
    assertEquals(result.isError, undefined);
    assertStringIncludes(result.content[0].text, "No thoughts available");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("RPC error returns isError", async () => {
  stubRpc(supabaseAdmin, () => mockChain({ data: null, error: { message: "function not found" } }));
  try {
    const result = await handler({}, mockCtx());
    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "Serendipity digest failed");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("missing brain context returns error", async () => {
  const result = await handler({});
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "missing brain context");
});
