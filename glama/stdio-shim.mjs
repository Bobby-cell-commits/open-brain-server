#!/usr/bin/env node
// Glama stdio bridge for Open Brain MCP.
//
// Glama builds its own container (debian + Node + uv Python), clones this
// repo, and spawns the configured cmdArguments under mcp-proxy expecting a
// stdio MCP server. Our production server speaks HTTPS streamable-http on
// Supabase Edge Functions — this shim gives Glama a stdio endpoint to probe.
//
// Real users connect to the hosted endpoint via server.json's "remotes" URL;
// this shim only exists to satisfy Glama's automated inspection (tools/list,
// initialize, ping). Tool CALLS proxy through to the hosted Edge Function.
//
// Keep TOOLS in sync with SERVER_CARD.tools in
// supabase/functions/open-brain-mcp/index.ts.

import { createInterface } from "node:readline";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY ?? "";

const PROTOCOL_VERSION = "2026-03-26";
const SERVER_INFO = { name: "open-brain", version: "1.0.0" };

const OBJ = { type: "object", additionalProperties: true };
const TOOLS = [
  { name: "search_thoughts", description: "Hybrid search (BM25 + vector with RRF). Supports source filter, 1-hop graph expansion, quality gating.", inputSchema: OBJ },
  { name: "deep_search", description: "Multi-hop retrieval with graph traversal + LLM gap-filling sub-queries. Best for bridging topics and multi-session synthesis.", inputSchema: OBJ },
  { name: "list_thoughts", description: "Browse thoughts with salience-ordered filters (type, theme, topic, person, activity, days, min_quality).", inputSchema: OBJ },
  { name: "thought_stats", description: "Aggregate counts with type/theme breakdown, top topics, people, and activity.", inputSchema: OBJ },
  { name: "capture_thought", description: "Store a thought with auto-embedding, auto-linking, entity extraction, and semantic dedup merge.", inputSchema: OBJ },
  { name: "delete_thought", description: "Permanently delete a thought (cascades connections).", inputSchema: OBJ },
  { name: "update_thought", description: "Rewrite a thought's content (re-embeds, re-extracts metadata).", inputSchema: OBJ },
  { name: "weekly_review", description: "LLM synthesis of recent themes, open loops, and suggested next steps.", inputSchema: OBJ },
  { name: "migration_guide", description: "Import runbook for external platforms (Notion, Obsidian, Readwise, etc.).", inputSchema: OBJ },
  { name: "get_connections", description: "Graph traversal from a thought via typed links (extends, contradicts, is-evidence-for, etc.).", inputSchema: OBJ },
  { name: "analyze", description: "Graph analysis: hubs, density, sources, co_occurrence, themes, synthesis_candidates.", inputSchema: OBJ },
  { name: "dedup_review", description: "Duplicate candidate pairs with similarity zone histogram.", inputSchema: OBJ },
  { name: "refresh_salience", description: "Recompute salience scores (recency × access × links × merges × source).", inputSchema: OBJ },
  { name: "list_entities", description: "Browse extracted entities (person, project, tool, organization) by frequency.", inputSchema: OBJ },
  { name: "serendipity_digest", description: "Resurface forgotten high-quality thoughts across rediscovery/orphan/underrepresented/echo slots.", inputSchema: OBJ },
  { name: "pipeline", description: "Pipeline monitoring: health, runs, merges.", inputSchema: OBJ },
  { name: "review_stale", description: "Review flagged stale thoughts (list/approve/reject).", inputSchema: OBJ },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function parseUpstreamResponse(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  const dataLines = trimmed.split("\n").filter((l) => l.startsWith("data: "));
  if (dataLines.length) {
    return JSON.parse(dataLines[dataLines.length - 1].slice(6));
  }
  throw new Error(`Unparseable upstream response: ${trimmed.slice(0, 200)}`);
}

async function proxyToolCall(params) {
  if (!SUPABASE_URL || !MCP_ACCESS_KEY) {
    throw new Error("SUPABASE_URL and MCP_ACCESS_KEY must be set for tool calls");
  }
  const endpoint = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/open-brain-mcp/mcp`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${MCP_ACCESS_KEY}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Upstream ${response.status}: ${text.slice(0, 200)}`);
  }
  const json = parseUpstreamResponse(text);
  if (json.error) throw new Error(json.error.message ?? "Upstream error");
  return json.result;
}

async function handle(request) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return await proxyToolCall(request.params);
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    default: {
      const err = new Error(`Method not found: ${request.method}`);
      err.code = -32601;
      throw err;
    }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  const isNotification = request.id === undefined || request.id === null;
  try {
    const result = await handle(request);
    if (!isNotification) {
      send({ jsonrpc: "2.0", id: request.id, result });
    }
  } catch (err) {
    if (!isNotification) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: err.code ?? -32000, message: err.message ?? String(err) },
      });
    }
  }
});

rl.on("close", () => process.exit(0));
