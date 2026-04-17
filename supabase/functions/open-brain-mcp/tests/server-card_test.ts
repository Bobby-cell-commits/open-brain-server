// server-card: Tests public MCP server card at /.well-known/mcp/server-card.json
// Registry scanners (Smithery, Glama, mcpservers.org) probe this path unauthenticated.

import { assertEquals } from "jsr:@std/assert";

// Import the Hono app indirectly via a minimal harness. The full index.ts
// constructs the app and binds Deno.serve at module load, so we reconstruct
// just the server card subset here to test its shape contract.

import { Hono } from "npm:hono@4";

// Duplicate of the SERVER_CARD shape in index.ts — test guards the contract
// that registry scanners depend on. If index.ts changes shape, update here.
function buildTestApp() {
  const app = new Hono();
  const SERVER_CARD = {
    schema_version: "0.1",
    name: "open-brain",
    version: "1.0.0",
    description: "test",
    protocolVersion: "2026-03-26",
    capabilities: { tools: { listChanged: false } },
    auth: { type: "bearer", scheme: "Bearer" },
    tools: [{ name: "search_thoughts", description: "test" }],
  };
  const handler = (c: any) => c.json(SERVER_CARD);
  app.get("/.well-known/mcp/server-card.json", handler);
  app.get("/open-brain-mcp/.well-known/mcp/server-card.json", handler);
  return app;
}

Deno.test("server-card.json is served unauthenticated at root well-known path", async () => {
  const app = buildTestApp();
  const res = await app.fetch(
    new Request("http://localhost/.well-known/mcp/server-card.json"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.name, "open-brain");
  assertEquals(body.schema_version, "0.1");
  assertEquals(body.auth.type, "bearer");
});

Deno.test("server-card.json is also served under /open-brain-mcp prefix (Supabase path)", async () => {
  const app = buildTestApp();
  const res = await app.fetch(
    new Request("http://localhost/open-brain-mcp/.well-known/mcp/server-card.json"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.name, "open-brain");
});

Deno.test("actual index.ts exposes well-known paths", async () => {
  // Read index.ts source and verify both routes are registered.
  const src = await Deno.readTextFile(
    new URL("../index.ts", import.meta.url),
  );
  assertEquals(src.includes('"/.well-known/mcp/server-card.json"'), true);
  assertEquals(
    src.includes('"/open-brain-mcp/.well-known/mcp/server-card.json"'),
    true,
  );
  assertEquals(src.includes("SERVER_CARD"), true);
});

Deno.test("actual index.ts SERVER_CARD contract shape", async () => {
  // Guard the shape contract against accidental shrinkage.
  const src = await Deno.readTextFile(
    new URL("../index.ts", import.meta.url),
  );
  assertEquals(src.includes('schema_version: "0.1"'), true);
  assertEquals(src.includes('name: "open-brain"'), true);
  assertEquals(src.includes('protocolVersion: "2026-03-26"'), true);
  assertEquals(src.includes('type: "bearer"'), true);
  assertEquals(src.includes('scheme: "Bearer"'), true);
  // Sanity check that all 17 tool names appear.
  const toolNames = [
    "search_thoughts", "deep_search", "list_thoughts", "thought_stats",
    "capture_thought", "delete_thought", "update_thought", "weekly_review",
    "migration_guide", "get_connections", "analyze", "dedup_review",
    "refresh_salience", "list_entities", "serendipity_digest", "pipeline",
    "review_stale",
  ];
  for (const name of toolNames) {
    assertEquals(src.includes(`name: "${name}"`), true, `missing tool: ${name}`);
  }
});
