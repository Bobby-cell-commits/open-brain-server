// pipeline: Consolidated pipeline monitoring tool.
// Replaces pipeline_health, pipeline_runs, merge_history.
// Dispatches to the same RPCs via a required `type` enum param.
// Health + runs RPCs are global (system-level). Merges requires brain context.

import { supabaseAdmin } from "../../_shared/supabase-client.ts";

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

// --- Helper functions (from pipeline-health.ts) ---

function formatHoursAgo(hours: number | null): string {
  if (hours === null) return "never";
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${(hours / 24).toFixed(1)}d ago`;
}

function healthStatusIcon(hours: number | null, source: string, failRate: number | null): string {
  if (hours !== null) {
    const threshold = (source === "reddit" || source === "rss") ? 48 : 72;
    if (hours > threshold * 2) return "\u{1F534}";
    if (hours > threshold) return "\u26A0\uFE0F";
  }
  if (failRate !== null && failRate > 50) return "\u26A0\uFE0F";
  return "\u2705";
}

// --- Helper functions (from pipeline-runs.ts) ---

interface PipelineRun {
  id: string;
  started_at: string;
  completed_at: string;
  source: string;
  trigger: string;
  status: string;
  captured: number;
  failed: number;
  skipped: number;
  filtered: number;
  warnings: string[];
  error_message: string | null;
  execution_ms: number;
  salience_refreshed: number | null;
  dream_dedup: Record<string, unknown> | null;
}

function runStatusIcon(status: string): string {
  if (status === "success") return "\u2705";
  if (status === "partial_failure") return "\u26A0\uFE0F";
  return "\u274C";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// --- Helper functions (from merge-history.ts) ---

interface MergeRecord {
  id: string;
  survivor_id: string | null;
  survivor_content_preview: string | null;
  loser_id: string;
  loser_content_preview: string;
  loser_source: string;
  similarity: number;
  merge_type: string;
  llm_reason: string | null;
  created_at: string;
}

function typeBadge(mergeType: string): string {
  if (mergeType === "auto") return "\u{1F916} auto";
  if (mergeType === "llm_confirmed") return "\u{1F9E0} llm_confirmed";
  if (mergeType === "ingest_dedup") return "\u{1F4E5} ingest_dedup";
  return mergeType;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\u2026";
}

// --- Tool registration ---

export function registerPipeline(mcp: McpServer, z: Z): void {
  mcp.tool("pipeline", {
    description:
      "Monitor pipeline operations. type=health shows per-source status and alerts, type=runs queries run history with filters, type=merges shows the dedup merge audit log.",
    inputSchema: z.object({
      type: z
        .enum(["health", "runs", "merges"])
        .describe("Which pipeline view: health, runs, or merges"),
      source: z
        .string()
        .optional()
        .describe("Filter by source (runs mode): rss, hf_papers, emergent_mind, reddit, monitor"),
      days: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .default(7)
        .describe("Look back N days (runs/merges modes, default 7)"),
      status: z
        .string()
        .optional()
        .describe("Filter by status (runs mode): success, partial_failure, failure"),
      merge_type: z
        .string()
        .optional()
        .describe("Filter by merge type (merges mode): auto, llm_confirmed, ingest_dedup"),
      limit: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max results (runs default 10, merges default 20)"),
    }),
    handler: async (args: {
      type: string;
      source?: string;
      days: number;
      status?: string;
      merge_type?: string;
      limit?: number;
    }, ctx: any) => {
      try {
        const brainId = ctx?.authInfo?.extra?.brainId as string;
        if (!brainId) return { content: [{ type: "text" as const, text: "Error: missing brain context" }], isError: true };

        const days = Math.min(args.days ?? 7, 365);
        const limit = Math.min(args.limit ?? (args.type === "merges" ? 20 : 10), 100);

        switch (args.type) {
          case "health":
            return await handleHealth();
          case "runs":
            return await handleRuns({ ...args, days, limit });
          case "merges":
            return await handleMerges({ ...args, days, limit }, brainId);
          default:
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown pipeline type: ${args.type}`,
                },
              ],
              isError: true,
            };
        }
      } catch (err) {
        const message = err instanceof Error
          ? err.message
          : (err as any)?.message ?? JSON.stringify(err);
        return {
          content: [
            { type: "text" as const, text: `Pipeline query failed: ${message}` },
          ],
          isError: true,
        };
      }
    },
  });
}

// --- Mode handlers ---

async function handleHealth() {
  const [healthResult, alertsResult] = await Promise.all([
    supabaseAdmin.rpc("get_source_health"),
    supabaseAdmin.rpc("check_alert_conditions"),
  ]);

  if (healthResult.error) throw healthResult.error;
  if (alertsResult.error) throw alertsResult.error;

  const sources = (healthResult.data ?? []) as any[];
  const alerts = (alertsResult.data ?? []) as any[];

  // Exclude legacy manual-capture sources superseded by telegram
  const LEGACY_SOURCES = new Set(["mcp", "slack"]);
  const activeSources = sources.filter((s: any) => !LEGACY_SOURCES.has(s.source));

  const lines: string[] = [`Pipeline Health \u2014 ${new Date().toISOString().slice(0, 19)}Z`, ""];

  if (activeSources.length === 0) {
    lines.push("No source data available. Pipeline may not have run yet.");
  } else {
    lines.push("Sources:");
    for (const s of activeSources) {
      const icon = healthStatusIcon(s.hours_since_capture, s.source, s.failure_rate_pct);
      const status = s.hours_since_capture !== null
        ? `last capture: ${formatHoursAgo(s.hours_since_capture)}`
        : "no captures";
      const runs = s.total_runs_7d
        ? `7d: ${s.total_runs_7d} runs, ${s.failure_rate_pct ?? 0}% fail, avg ${s.avg_captured_7d ?? 0}/run`
        : `total: ${s.total_thoughts ?? 0} thoughts`;
      const name = (s.source ?? "unknown").padEnd(14);
      lines.push(`  ${name} ${icon}  | ${status} | ${runs}`);
    }
  }

  if (alerts.length > 0) {
    lines.push("");
    lines.push(`Alerts (${alerts.length}):`);
    for (const a of alerts) {
      const icon = a.severity === "critical" ? "\u{1F534}" : "\u26A0\uFE0F";
      lines.push(`  ${icon} ${a.message}`);
    }
  }

  const overall = alerts.some((a: any) => a.severity === "critical")
    ? "CRITICAL"
    : alerts.length > 0
      ? "DEGRADED"
      : "HEALTHY";
  lines.push("");
  lines.push(`Overall: ${overall}`);

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

async function handleRuns(args: {
  source?: string;
  days: number;
  status?: string;
  limit: number;
}) {
  const { data, error } = await supabaseAdmin.rpc("get_pipeline_runs", {
    p_source: args.source ?? null,
    p_days: args.days,
    p_status: args.status ?? null,
    p_limit: args.limit,
  });

  if (error) throw error;

  const runs = (typeof data === "string" ? JSON.parse(data) : data) as PipelineRun[];

  if (runs.length === 0) {
    const filter = args.source ? ` for ${args.source}` : "";
    return {
      content: [{
        type: "text" as const,
        text: `No pipeline runs found${filter} in the last ${args.days} days.`,
      }],
    };
  }

  const sourceLabel = args.source ?? "all sources";
  const lines: string[] = [
    `Pipeline Runs \u2014 ${sourceLabel} (last ${args.days} days)`,
    "",
  ];

  for (const run of runs) {
    const ts = run.completed_at.slice(0, 16).replace("T", " ");
    const icon = runStatusIcon(run.status);
    const stats = `${run.captured} captured, ${run.failed} failed, ${run.filtered} filtered`;
    const duration = formatDuration(run.execution_ms);
    lines.push(`${ts}  ${icon} ${run.status.padEnd(16)} | ${stats} | ${duration}`);

    if (run.error_message) {
      lines.push(`  \u2514\u2500 error: ${run.error_message}`);
    }
    if (run.warnings && run.warnings.length > 0) {
      for (const w of run.warnings) {
        lines.push(`  \u2514\u2500 warning: ${w}`);
      }
    }
  }

  const totalCaptured = runs.reduce((sum, r) => sum + r.captured, 0);
  const avgExecution = runs.reduce((sum, r) => sum + r.execution_ms, 0) / runs.length;
  const failRate = runs.length > 0
    ? Math.round((runs.filter((r) => r.status === "failure").length / runs.length) * 100)
    : 0;

  lines.push("");
  lines.push(
    `Summary: ${runs.length} runs, ${totalCaptured} total captured, ` +
    `${failRate}% failure rate, ${formatDuration(avgExecution)} avg`,
  );

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

async function handleMerges(args: {
  days: number;
  merge_type?: string;
  limit: number;
}, brainId: string) {
  const { data, error } = await supabaseAdmin.rpc("get_merge_history", {
    p_brain_id: brainId,
    p_days: args.days,
    p_merge_type: args.merge_type ?? null,
    p_limit: args.limit,
  });

  if (error) throw error;

  const merges = (typeof data === "string" ? JSON.parse(data) : data) as MergeRecord[];

  if (merges.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `No merges found in the last ${args.days} days.`,
      }],
    };
  }

  const lines: string[] = [
    `Merge History \u2014 last ${args.days} days`,
    "",
  ];

  for (const m of merges) {
    const ts = m.created_at.slice(0, 16).replace("T", " ");
    const badge = typeBadge(m.merge_type);
    const sim = m.similarity.toFixed(3);
    lines.push(`${ts}  ${badge} | similarity ${sim} | source: ${m.loser_source}`);

    if (m.survivor_content_preview) {
      lines.push(`  \u251C\u2500 survivor: ${truncate(m.survivor_content_preview, 100)}`);
    }
    lines.push(`  \u2514\u2500 loser:    ${truncate(m.loser_content_preview, 100)}`);

    if (m.llm_reason) {
      lines.push(`  \u2514\u2500 reason:   ${m.llm_reason}`);
    }
  }

  const autoCount = merges.filter((m) => m.merge_type === "auto").length;
  const llmCount = merges.filter((m) => m.merge_type === "llm_confirmed").length;
  const ingestCount = merges.filter((m) => m.merge_type === "ingest_dedup").length;

  lines.push("");
  lines.push(
    `${merges.length} merges (${autoCount} auto, ${llmCount} llm_confirmed, ${ingestCount} ingest_dedup)`,
  );

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
