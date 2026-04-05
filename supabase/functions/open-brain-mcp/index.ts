// open-brain-mcp: MCP server Edge Function
// Exposes thought tools (search, list, stats, capture, weekly review, migration guide)
// over Streamable HTTP transport with API key → brain_id authentication.

import { McpServer, StreamableHttpTransport } from "npm:mcp-lite";
import { Hono } from "npm:hono@4";
import { z } from "npm:zod@3";
import { zodToJsonSchema } from "npm:zod-to-json-schema@3";

import { supabaseAdmin } from "../_shared/supabase-client.ts";
import { extractKeyFromRequest, resolveAuth, hashKey } from "../_shared/auth.ts";
import { registerSearchThoughts } from "./tools/search-thoughts.ts";
import { registerListThoughts } from "./tools/list-thoughts.ts";
import { registerThoughtStats } from "./tools/thought-stats.ts";
import { registerCaptureThought } from "./tools/capture-thought.ts";
import { registerWeeklyReview } from "./tools/weekly-review.ts";
import { registerMigrationGuide } from "./tools/migration-guide.ts";
import { registerDeleteThought } from "./tools/delete-thought.ts";
import { registerUpdateThought } from "./tools/update-thought.ts";
import { registerGetConnections } from "./tools/get-connections.ts";
import { registerAnalyze } from "./tools/analyze.ts";
import { registerDedupReview } from "./tools/dedup-review.ts";
import { registerRefreshSalience } from "./tools/refresh-salience.ts";
import { registerListEntities } from "./tools/list-entities.ts";
import { registerSerendipityDigest } from "./tools/serendipity-digest.ts";
import { registerPipeline } from "./tools/pipeline.ts";
import { registerReviewStale } from "./tools/review-stale.ts";
import { registerAdminRoutes } from "./admin-routes.ts";

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

// ---------------------------------------------------------------------------
// Auth middleware — resolves API key to brain_id via database lookup
// ---------------------------------------------------------------------------

app.use("*", async (c, next) => {
  if (c.req.method !== "POST") {
    return next();
  }

  const key = extractKeyFromRequest(c.req.raw);
  if (!key) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const auth = await resolveAuth(key, supabaseAdmin);
  if (!auth) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("brainId", auth.brainId);
  if (auth.isAdmin) c.set("isAdmin", true);
  return next();
});

// ---------------------------------------------------------------------------
// MCP server factory (fresh instance per request -- Edge Functions are ephemeral)
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const mcp = new McpServer({
    name: "open-brain",
    version: "1.0.0",
    schemaAdapter: (schema) => zodToJsonSchema(schema as z.ZodType),
  });

  // Register all 16 tools
  registerSearchThoughts(mcp, z);
  registerListThoughts(mcp, z);
  registerThoughtStats(mcp, z);
  registerCaptureThought(mcp, z);
  registerWeeklyReview(mcp, z);
  registerMigrationGuide(mcp, z);
  registerDeleteThought(mcp, z);
  registerUpdateThought(mcp, z);
  registerGetConnections(mcp, z);
  registerAnalyze(mcp, z);
  registerDedupReview(mcp, z);
  registerRefreshSalience(mcp, z);
  registerListEntities(mcp, z);
  registerSerendipityDigest(mcp, z);
  registerPipeline(mcp, z);
  registerReviewStale(mcp, z);

  return mcp;
}

// ---------------------------------------------------------------------------
// Transport (stateless, safe to reuse at module scope)
// ---------------------------------------------------------------------------

const transport = new StreamableHttpTransport();

// ---------------------------------------------------------------------------
// Admin routes (must be registered BEFORE :key catchall)
// ---------------------------------------------------------------------------

registerAdminRoutes(app, supabaseAdmin, hashKey);

// ---------------------------------------------------------------------------
// MCP route
// ---------------------------------------------------------------------------

async function handleMcp(c: any) {
  // Return 200 for GET/DELETE/OPTIONS probes — Claude Code's MCP client may send
  // these during discovery. The transport only handles POST; non-POST methods
  // hitting the transport return 400/405 which can trigger the OAuth flow.
  if (c.req.method !== "POST") {
    return c.json({
      jsonrpc: "2.0",
      result: { serverInfo: { name: "open-brain", version: "1.0.0" } },
    });
  }
  const mcp = createMcpServer();
  const handler = transport.bind(mcp);
  const brainId = c.get("brainId");
  return await handler(c.req.raw, {
    authInfo: { token: "", scopes: [], extra: { brainId } },
  });
}

app.all("/open-brain-mcp/:key/mcp", handleMcp);
app.all("/open-brain-mcp/:key", handleMcp);
app.all("/open-brain-mcp/mcp", handleMcp);
app.all("/open-brain-mcp", handleMcp);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(app.fetch);
