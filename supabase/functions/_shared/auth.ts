// auth.ts: SHA-256 key hashing and auth middleware factory.
// Extracted from index.ts for testability.

export async function hashKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function extractKeyFromRequest(req: Request): string | undefined {
  const url = new URL(req.url);

  // Authorization: Bearer <key> — standard MCP/OAuth header, preferred by registry scanners
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }

  const pathSegments = url.pathname.split("/").filter(Boolean);
  const pathKey = pathSegments.length >= 2 && pathSegments[0] === "open-brain-mcp"
    ? pathSegments[1] === "mcp" ? undefined : pathSegments[1]
    : undefined;
  return req.headers.get("x-brain-key") || url.searchParams.get("key") || pathKey || undefined;
}

export interface AuthResult {
  brainId: string;
  isAdmin: boolean;
}

export async function resolveAuth(
  key: string,
  supabaseClient: any,
): Promise<AuthResult | null> {
  // Check admin key first
  const adminKey = Deno.env.get("ADMIN_KEY");
  if (adminKey && key === adminKey) {
    return { brainId: "admin", isAdmin: true };
  }

  // Hash and look up brain key
  const keyHash = await hashKey(key);
  const { data: keyRecord, error } = await supabaseClient
    .from("brain_api_keys")
    .select("brain_id")
    .eq("key_hash", keyHash)
    .is("revoked_at", null)
    .single();

  if (error || !keyRecord) return null;

  // Fire-and-forget: update last_used_at
  supabaseClient
    .from("brain_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", keyHash)
    .then(() => {});

  return { brainId: keyRecord.brain_id, isAdmin: false };
}
