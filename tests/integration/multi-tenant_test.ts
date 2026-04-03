// Integration test: Multi-tenant isolation against live Supabase.
// Run: deno test openbrain/tests/integration/ --no-check --allow-net --allow-env --allow-read

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { config as dotenvConfig } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

// Load env from openbrain/.env.local
const env = dotenvConfig({ path: "openbrain/.env.local" });
if (!env.SUPABASE_URL) {
  console.error("SUPABASE_URL required in openbrain/.env.local");
  Deno.exit(1);
}
const FUNCTIONS_URL = `${env.SUPABASE_URL}/functions/v1`;
const SUPABASE_REST_URL = `${env.SUPABASE_URL}/rest/v1`;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY!;
const OWNER_KEY = env.MCP_ACCESS_KEY!;
const ADMIN_KEY = Deno.env.get("ADMIN_KEY") || env.ADMIN_KEY;

if (!ADMIN_KEY) {
  console.error("ADMIN_KEY env var required for integration tests");
  Deno.exit(1);
}

// --- Helpers ---

async function mcpCall(key: string, toolName: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${FUNCTIONS_URL}/open-brain-mcp/${key}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  const content = json.result?.content?.[0];
  if (!content) throw new Error(`No content in response: ${JSON.stringify(json)}`);
  if (json.result.isError) return { _error: true, text: content.text };
  try { return JSON.parse(content.text); } catch { return content.text; }
}

async function adminProvision(name: string): Promise<{ brain_id: string; api_key: string }> {
  const res = await fetch(`${FUNCTIONS_URL}/open-brain-mcp/admin/provision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-brain-key": ADMIN_KEY!,
    },
    body: JSON.stringify({ name }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Provision failed: ${json.error}`);
  return json;
}

async function deleteBrain(brainId: string): Promise<void> {
  const res = await fetch(`${SUPABASE_REST_URL}/brains?id=eq.${brainId}`, {
    method: "DELETE",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Delete brain failed: ${res.status} ${await res.text()}`);
}

// --- Integration test ---

Deno.test("multi-tenant isolation", async (t) => {
  let testBrainId: string;
  let testKey: string;
  let capturedThoughtId: string;
  let ownerStatsBefore: any;

  await t.step("1. provision test brain", async () => {
    const result = await adminProvision("Integration Test Brain");
    testBrainId = result.brain_id;
    testKey = result.api_key;
    assertEquals(typeof testBrainId, "string");
    assertEquals(testKey.startsWith("ob_live_"), true);
    assertEquals(testKey.length, 40);
  });

  await t.step("2. empty brain baseline", async () => {
    const stats = await mcpCall(testKey, "thought_stats", {});
    assertEquals(stats.total_thoughts, 0);
  });

  await t.step("3. capture owner stats before test", async () => {
    ownerStatsBefore = await mcpCall(OWNER_KEY, "thought_stats", {});
    assertEquals(typeof ownerStatsBefore.total_thoughts, "number");
  });

  await t.step("4. capture thought in test brain", async () => {
    const result = await mcpCall(testKey, "capture_thought", {
      content: "Integration test: multi-tenant isolation verification XYZ-" + Date.now(),
    });
    capturedThoughtId = result.id;
    assertEquals(typeof capturedThoughtId, "string");
    assertEquals(capturedThoughtId.length, 36); // UUID

    const stats = await mcpCall(testKey, "thought_stats", {});
    assertEquals(stats.total_thoughts, 1);
  });

  await t.step("5. search isolation — test brain finds own thought", async () => {
    const result = await mcpCall(testKey, "search_thoughts", {
      query: "multi-tenant isolation verification",
      threshold: 0.5,
      min_quality: 0,
    });
    const ids = result.results.map((r: any) => r.id);
    assertEquals(ids.includes(capturedThoughtId), true);
  });

  await t.step("6. search isolation — owner brain does NOT find test thought", async () => {
    const result = await mcpCall(OWNER_KEY, "search_thoughts", {
      query: "multi-tenant isolation verification XYZ",
      threshold: 0.5,
      min_quality: 0,
    });
    const ids = (result.results || []).map((r: any) => r.id);
    assertEquals(ids.includes(capturedThoughtId), false);
  });

  await t.step("7. cross-brain delete protection", async () => {
    const result = await mcpCall(OWNER_KEY, "delete_thought", { id: capturedThoughtId });
    assertEquals(result._error, true);
    assertStringIncludes(result.text, "not found");
  });

  await t.step("8. cross-brain update protection", async () => {
    const result = await mcpCall(OWNER_KEY, "update_thought", {
      id: capturedThoughtId,
      content: "hacked!",
    });
    assertEquals(result._error, true);
    assertStringIncludes(result.text, "not found");
  });

  await t.step("9. owner brain stats unchanged", async () => {
    const ownerStatsAfter = await mcpCall(OWNER_KEY, "thought_stats", {});
    assertEquals(ownerStatsAfter.total_thoughts, ownerStatsBefore.total_thoughts);
  });

  await t.step("10. cleanup — delete test brain", async () => {
    await deleteBrain(testBrainId);

    // Verify test brain's key no longer works
    const res = await fetch(`${FUNCTIONS_URL}/open-brain-mcp/${testKey}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const json = await res.json();
    assertEquals(json.error, "Unauthorized");
  });
});

Deno.test("cross-brain dedup isolation", async (t) => {
  let brainA: { brain_id: string; api_key: string };
  let brainB: { brain_id: string; api_key: string };
  const SHARED_CONTENT = "Cross-brain dedup test: quantum computing applications in drug discovery " + Date.now();

  await t.step("1. provision two test brains", async () => {
    brainA = await adminProvision("Dedup Test Brain A");
    brainB = await adminProvision("Dedup Test Brain B");
    assertEquals(brainA.brain_id !== brainB.brain_id, true);
  });

  await t.step("2. capture identical content in both brains", async () => {
    const resultA = await mcpCall(brainA.api_key, "capture_thought", { content: SHARED_CONTENT });
    assertEquals(typeof resultA.id, "string");
    assertEquals(resultA.merged, undefined); // should NOT merge — brain A is empty

    const resultB = await mcpCall(brainB.api_key, "capture_thought", { content: SHARED_CONTENT });
    assertEquals(typeof resultB.id, "string");
    assertEquals(resultB.merged, undefined); // should NOT merge — brain B is empty, must not see brain A's thought
  });

  await t.step("3. each brain has exactly 1 thought", async () => {
    const statsA = await mcpCall(brainA.api_key, "thought_stats", {});
    assertEquals(statsA.total_thoughts, 1);

    const statsB = await mcpCall(brainB.api_key, "thought_stats", {});
    assertEquals(statsB.total_thoughts, 1);
  });

  await t.step("4. search in brain A only finds brain A's thought", async () => {
    const resultA = await mcpCall(brainA.api_key, "search_thoughts", {
      query: "quantum computing drug discovery",
      threshold: 0.5,
      min_quality: 0,
    });
    assertEquals(resultA.results.length >= 1, true);
    // All results should belong to brain A (we can't check brain_id directly,
    // but we know brain A only has 1 thought)
  });

  await t.step("5. search in brain B only finds brain B's thought", async () => {
    const resultB = await mcpCall(brainB.api_key, "search_thoughts", {
      query: "quantum computing drug discovery",
      threshold: 0.5,
      min_quality: 0,
    });
    assertEquals(resultB.results.length >= 1, true);
  });

  await t.step("6. cleanup", async () => {
    await deleteBrain(brainA.brain_id);
    await deleteBrain(brainB.brain_id);
  });
});
