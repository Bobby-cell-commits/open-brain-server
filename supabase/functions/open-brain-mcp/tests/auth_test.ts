// auth: Tests SHA-256 hashing, key extraction, and brain resolution.

import { assertEquals } from "jsr:@std/assert";
import { mockChain, stubFrom, restore } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { hashKey, extractKeyFromRequest, resolveAuth } from "../../_shared/auth.ts";

// --- hashKey ---

Deno.test("hashKey produces correct SHA-256 hex", async () => {
  const hash = await hashKey("test-key-123");
  assertEquals(hash.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(hash), true);
  const hash2 = await hashKey("test-key-123");
  assertEquals(hash, hash2);
});

Deno.test("hashKey produces different hashes for different inputs", async () => {
  const h1 = await hashKey("key-a");
  const h2 = await hashKey("key-b");
  assertEquals(h1 !== h2, true);
});

// --- extractKeyFromRequest ---

Deno.test("extractKeyFromRequest gets key from path", () => {
  const req = new Request("http://localhost/open-brain-mcp/my-key/mcp", { method: "POST" });
  assertEquals(extractKeyFromRequest(req), "my-key");
});

Deno.test("extractKeyFromRequest gets key from x-brain-key header", () => {
  const req = new Request("http://localhost/open-brain-mcp/mcp", {
    method: "POST",
    headers: { "x-brain-key": "header-key" },
  });
  assertEquals(extractKeyFromRequest(req), "header-key");
});

Deno.test("extractKeyFromRequest gets key from Authorization Bearer header", () => {
  const req = new Request("http://localhost/open-brain-mcp/mcp", {
    method: "POST",
    headers: { "Authorization": "Bearer bearer-key-123" },
  });
  assertEquals(extractKeyFromRequest(req), "bearer-key-123");
});

Deno.test("extractKeyFromRequest Bearer header takes precedence over path segment", () => {
  const req = new Request("http://localhost/open-brain-mcp/path-key/mcp", {
    method: "POST",
    headers: { "Authorization": "Bearer bearer-key-456" },
  });
  assertEquals(extractKeyFromRequest(req), "bearer-key-456");
});

Deno.test("extractKeyFromRequest handles lowercase 'bearer' scheme", () => {
  const req = new Request("http://localhost/open-brain-mcp/mcp", {
    method: "POST",
    headers: { "Authorization": "bearer lower-key" },
  });
  assertEquals(extractKeyFromRequest(req), "lower-key");
});

Deno.test("extractKeyFromRequest ignores non-Bearer Authorization schemes", () => {
  const req = new Request("http://localhost/open-brain-mcp/path-key/mcp", {
    method: "POST",
    headers: { "Authorization": "Basic dXNlcjpwYXNz" },
  });
  assertEquals(extractKeyFromRequest(req), "path-key");
});

Deno.test("extractKeyFromRequest gets key from query param", () => {
  const req = new Request("http://localhost/open-brain-mcp/mcp?key=query-key", { method: "POST" });
  assertEquals(extractKeyFromRequest(req), "query-key");
});

Deno.test("extractKeyFromRequest returns undefined when no key", () => {
  const req = new Request("http://localhost/open-brain-mcp/mcp", { method: "POST" });
  assertEquals(extractKeyFromRequest(req), undefined);
});

// --- resolveAuth ---

Deno.test("resolveAuth returns brainId for valid key", async () => {
  const testKey = "ob_live_testkey123";
  const expectedHash = await hashKey(testKey);

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "brain_api_keys") {
      return {
        select: () => ({
          eq: (col: string, val: string) => {
            if (col === "key_hash") assertEquals(val, expectedHash);
            return {
              is: () => ({
                single: () => Promise.resolve({ data: { brain_id: "brain-uuid-123" }, error: null }),
              }),
            };
          },
        }),
        update: () => mockChain({ data: null, error: null }),
      };
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await resolveAuth(testKey, supabaseAdmin);
    assertEquals(result?.brainId, "brain-uuid-123");
    assertEquals(result?.isAdmin, false);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("resolveAuth returns null for invalid key", async () => {
  stubFrom(supabaseAdmin, () => ({
    select: () => ({
      eq: () => ({
        is: () => ({
          single: () => Promise.resolve({ data: null, error: { message: "not found" } }),
        }),
      }),
    }),
    update: () => mockChain({ data: null, error: null }),
  }));

  try {
    const result = await resolveAuth("invalid-key", supabaseAdmin);
    assertEquals(result, null);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("resolveAuth returns admin for ADMIN_KEY match", async () => {
  Deno.env.set("ADMIN_KEY", "my-admin-key");
  try {
    const result = await resolveAuth("my-admin-key", supabaseAdmin);
    assertEquals(result?.brainId, "admin");
    assertEquals(result?.isAdmin, true);
  } finally {
    Deno.env.delete("ADMIN_KEY");
  }
});

Deno.test("resolveAuth falls through to DB lookup when key != ADMIN_KEY", async () => {
  Deno.env.set("ADMIN_KEY", "my-admin-key");
  let dbLookupCalled = false;

  stubFrom(supabaseAdmin, () => ({
    select: () => ({
      eq: () => {
        dbLookupCalled = true;
        return {
          is: () => ({
            single: () => Promise.resolve({ data: { brain_id: "some-brain" }, error: null }),
          }),
        };
      },
    }),
    update: () => mockChain({ data: null, error: null }),
  }));

  try {
    await resolveAuth("not-the-admin-key", supabaseAdmin);
    assertEquals(dbLookupCalled, true);
  } finally {
    Deno.env.delete("ADMIN_KEY");
    restore(supabaseAdmin);
  }
});
