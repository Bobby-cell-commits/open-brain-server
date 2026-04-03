// admin-routes.ts: Brain provisioning and listing endpoints.
// Extracted from index.ts for testability.

import type { Hono } from "npm:hono@4";

export function registerAdminRoutes(
  app: Hono,
  supabaseClient: any,
  hashKeyFn: (key: string) => Promise<string>,
): void {
  app.post("/open-brain-mcp/admin/provision", async (c) => {
    if (!c.get("isAdmin")) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json();
    const { name, email } = body as { name: string; email?: string };

    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }

    const brainId = crypto.randomUUID();

    // Generate API key: "ob_live_" + 32 random alphanumeric chars
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const randomPart = Array.from(randomBytes)
      .map((b) => charset[b % charset.length])
      .join("");
    const apiKey = `ob_live_${randomPart}`;

    const keyHash = await hashKeyFn(apiKey);

    // Insert brain
    const { error: brainError } = await supabaseClient
      .from("brains")
      .insert({ id: brainId, name, owner_email: email || null });

    if (brainError) {
      return c.json({ error: `Failed to create brain: ${brainError.message}` }, 500);
    }

    // Insert API key
    const { error: keyError } = await supabaseClient
      .from("brain_api_keys")
      .insert({
        brain_id: brainId,
        key_hash: keyHash,
        key_prefix: apiKey.slice(0, 8),
        label: "initial",
      });

    if (keyError) {
      return c.json({ error: `Failed to create API key: ${keyError.message}` }, 500);
    }

    return c.json({
      brain_id: brainId,
      api_key: apiKey,
      mcp_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/open-brain-mcp/${apiKey}/mcp`,
    });
  });

  app.get("/open-brain-mcp/admin/brains", async (c) => {
    // Auth middleware skips non-POST methods, so check admin key inline for GET
    const adminKey = Deno.env.get("ADMIN_KEY");
    const key = c.req.header("x-brain-key") ||
      new URL(c.req.url).searchParams.get("key");
    if (!adminKey || key !== adminKey) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const { data, error } = await supabaseClient
      .from("brains")
      .select("id, name, owner_email, created_at, thoughts(count)")
      .order("created_at", { ascending: false });

    if (error) {
      return c.json({ error: `Failed to list brains: ${error.message}` }, 500);
    }

    // Flatten Supabase's aggregate shape: thoughts: [{count: N}] → thought_count: N
    const brains = (data || []).map((b: any) => ({
      id: b.id,
      name: b.name,
      owner_email: b.owner_email,
      created_at: b.created_at,
      thought_count: b.thoughts?.[0]?.count ?? 0,
    }));

    return c.json(brains);
  });
}
