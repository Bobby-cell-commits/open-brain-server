// Integration test: get_thought_embeddings RPC against live Supabase.
// Verifies embedding retrieval, multi-tenant isolation, and edge cases.
// Run: deno test openbrain/tests/integration/get-thought-embeddings_test.ts --no-check --allow-net --allow-env --allow-read

import { assertEquals } from "jsr:@std/assert";
import { config as dotenvConfig } from "https://deno.land/x/dotenv@v3.2.2/mod.ts";

const env = dotenvConfig({ path: "openbrain/.env.local" });
if (!env.SUPABASE_URL) {
  console.error("SUPABASE_URL required in openbrain/.env.local");
  Deno.exit(1);
}
const FUNCTIONS_URL = `${env.SUPABASE_URL}/functions/v1`;
const SUPABASE_REST_URL = `${env.SUPABASE_URL}/rest/v1`;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY!;
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

async function rpcCall(functionName: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_REST_URL}/rpc/${functionName}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${functionName} failed: ${res.status} ${text}`);
  }
  return res.json();
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

// --- Tests ---

Deno.test("get_thought_embeddings", async (t) => {
  let brainA: { brain_id: string; api_key: string };
  let brainB: { brain_id: string; api_key: string };
  let thoughtA1Id: string;
  let thoughtA2Id: string;
  let thoughtB1Id: string;

  await t.step("1. provision two test brains", async () => {
    brainA = await adminProvision("Embeddings Test Brain A");
    brainB = await adminProvision("Embeddings Test Brain B");
    assertEquals(brainA.brain_id !== brainB.brain_id, true);
  });

  await t.step("2. capture thoughts in both brains", async () => {
    const a1 = await mcpCall(brainA.api_key, "capture_thought", {
      content: "Neural architecture search enables automated model design optimization",
    });
    thoughtA1Id = a1.id;

    const a2 = await mcpCall(brainA.api_key, "capture_thought", {
      content: "Retrieval augmented generation combines search with language models",
    });
    thoughtA2Id = a2.id;

    const b1 = await mcpCall(brainB.api_key, "capture_thought", {
      content: "Distributed systems require consensus protocols for consistency",
    });
    thoughtB1Id = b1.id;
  });

  await t.step("3. returns embeddings for brain A thoughts", async () => {
    const results = await rpcCall("get_thought_embeddings", {
      p_brain_id: brainA.brain_id,
      p_thought_ids: [thoughtA1Id, thoughtA2Id],
    });

    assertEquals(results.length, 2);
    const ids = results.map((r: any) => r.id);
    assertEquals(ids.includes(thoughtA1Id), true);
    assertEquals(ids.includes(thoughtA2Id), true);

    // Verify embedding dimensions
    for (const row of results) {
      // pgvector returns as string "[0.1,0.2,...]" via REST API
      const embedding = typeof row.embedding === "string"
        ? JSON.parse(row.embedding)
        : row.embedding;
      assertEquals(embedding.length, 1536);
    }
  });

  await t.step("4. brain isolation — brain A cannot access brain B embeddings", async () => {
    const results = await rpcCall("get_thought_embeddings", {
      p_brain_id: brainA.brain_id,
      p_thought_ids: [thoughtB1Id],
    });

    assertEquals(results.length, 0);
  });

  await t.step("5. brain isolation — brain B cannot access brain A embeddings", async () => {
    const results = await rpcCall("get_thought_embeddings", {
      p_brain_id: brainB.brain_id,
      p_thought_ids: [thoughtA1Id, thoughtA2Id],
    });

    assertEquals(results.length, 0);
  });

  await t.step("6. mixed IDs — only returns own brain's matches", async () => {
    const results = await rpcCall("get_thought_embeddings", {
      p_brain_id: brainA.brain_id,
      p_thought_ids: [thoughtA1Id, thoughtB1Id],
    });

    assertEquals(results.length, 1);
    assertEquals(results[0].id, thoughtA1Id);
  });

  await t.step("7. empty array returns empty results", async () => {
    const results = await rpcCall("get_thought_embeddings", {
      p_brain_id: brainA.brain_id,
      p_thought_ids: [],
    });

    assertEquals(results.length, 0);
  });

  await t.step("8. nonexistent IDs return empty results", async () => {
    const results = await rpcCall("get_thought_embeddings", {
      p_brain_id: brainA.brain_id,
      p_thought_ids: ["00000000-0000-0000-0000-000000000000"],
    });

    assertEquals(results.length, 0);
  });

  await t.step("9. cleanup", async () => {
    await deleteBrain(brainA.brain_id);
    await deleteBrain(brainB.brain_id);
  });
});
