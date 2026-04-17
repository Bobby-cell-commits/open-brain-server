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
import { registerDeepSearch } from "./tools/deep-search.ts";
import { registerAdminRoutes } from "./admin-routes.ts";

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

// ---------------------------------------------------------------------------
// Public server card — registry discovery (Smithery, Glama, mcpservers.org)
// ---------------------------------------------------------------------------

const SERVER_CARD = {
  schema_version: "0.1",
  name: "open-brain",
  version: "1.0.0",
  description:
    "Personal knowledge infrastructure with structured memory: hybrid search + multi-hop graph retrieval, automatic entity extraction, Newman-IDF weighted entity bridges, theme tracking, staleness pruning, and insight synthesis. 37.2% LongMemEval baseline.",
  homepage: "https://github.com/Bobby-cell-commits/open-brain-server",
  repository: "https://github.com/Bobby-cell-commits/open-brain-server",
  license: "MIT",
  protocolVersion: "2026-03-26",
  capabilities: {
    tools: { listChanged: false },
    prompts: null,
    resources: null,
    sampling: null,
    logging: null,
  },
  auth: {
    type: "bearer",
    header: "Authorization",
    scheme: "Bearer",
    description:
      "Pass your brain API key as 'Authorization: Bearer <key>'. Legacy 'x-brain-key' header and path-segment auth also supported.",
  },
  tools: [
    { name: "search_thoughts", description: "Hybrid search (BM25 + vector with RRF). Supports source filter, 1-hop graph expansion, quality gating." },
    { name: "deep_search", description: "Multi-hop retrieval with graph traversal + LLM gap-filling sub-queries. Best for bridging topics and multi-session synthesis." },
    { name: "list_thoughts", description: "Browse thoughts with salience-ordered filters (type, theme, topic, person, activity, days, min_quality)." },
    { name: "thought_stats", description: "Aggregate counts with type/theme breakdown, top topics, people, and activity." },
    { name: "capture_thought", description: "Store a thought with auto-embedding, auto-linking, entity extraction, and semantic dedup merge." },
    { name: "delete_thought", description: "Permanently delete a thought (cascades connections)." },
    { name: "update_thought", description: "Rewrite a thought's content (re-embeds, re-extracts metadata)." },
    { name: "weekly_review", description: "LLM synthesis of recent themes, open loops, and suggested next steps." },
    { name: "migration_guide", description: "Import runbook for external platforms (Notion, Obsidian, Readwise, etc.)." },
    { name: "get_connections", description: "Graph traversal from a thought via typed links (extends, contradicts, is-evidence-for, etc.)." },
    { name: "analyze", description: "Graph analysis: hubs, density, sources, co_occurrence, themes, synthesis_candidates." },
    { name: "dedup_review", description: "Duplicate candidate pairs with similarity zone histogram." },
    { name: "refresh_salience", description: "Recompute salience scores (recency × access × links × merges × source)." },
    { name: "list_entities", description: "Browse extracted entities (person, project, tool, organization) by frequency." },
    { name: "serendipity_digest", description: "Resurface forgotten high-quality thoughts across rediscovery/orphan/underrepresented/echo slots." },
    { name: "pipeline", description: "Pipeline monitoring: health, runs, merges." },
    { name: "review_stale", description: "Review flagged stale thoughts (list/approve/reject)." },
  ],
};

function handleServerCard(c: any) {
  return c.json(SERVER_CARD);
}

app.get("/.well-known/mcp/server-card.json", handleServerCard);
app.get("/open-brain-mcp/.well-known/mcp/server-card.json", handleServerCard);

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

  // Register all 17 tools
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
  registerDeepSearch(mcp, z);

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
  if (c.req.method !== "POST") {
    return c.json({
      jsonrpc: "2.0",
      result: { serverInfo: { name: "open-brain", version: "1.0.0" } },
    });
  }
  const mcp = createMcpServer();
  const handler = transport.bind(mcp);
  const brainId = c.get("brainId");
  const brainContext = c.req.header("x-brain-context") ?? "manual";
  return await handler(c.req.raw, {
    authInfo: { token: "", scopes: [], extra: { brainId, brainContext } },
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
