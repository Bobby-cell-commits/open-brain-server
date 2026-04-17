// monitor-pipeline: Health checker + Telegram alerter.
// Modes:
//   POST {}                    — full health check + Telegram alerts
//   POST { "check_only": true } — health check, skip Telegram
//   POST { "log_run": {...} }   — log a pipeline run (for Python pipeline), then health check

import { supabaseAdmin } from "../_shared/supabase-client.ts";
import { errorResponse } from "../_shared/errors.ts";
import { sendMessage, escapeHtml, getAllowedChatId } from "../_shared/telegram.ts";

const ALERT_COOLDOWN_HOURS = 24;

interface SourceHealth {
  source: string;
  total_runs_7d: number | null;
  successful_runs_7d: number | null;
  failed_runs_7d: number | null;
  failure_rate_pct: number | null;
  avg_captured_7d: number | null;
  avg_execution_ms_7d: number | null;
  last_run_at: string | null;
  last_yield_at: string | null;
  total_thoughts: number | null;
  last_capture_at: string | null;
  avg_quality: number | null;
  hours_since_capture: number | null;
}

interface Alert {
  type: string;
  source: string;
  severity: string;
  message: string;
  [key: string]: unknown;
}

function sourceStatus(health: SourceHealth): "healthy" | "warning" | "critical" {
  if (health.hours_since_capture !== null) {
    const threshold = (health.source === "reddit" || health.source.startsWith("rss")) ? 48 : 72;
    if (health.hours_since_capture > threshold * 2) return "critical";
    if (health.hours_since_capture > threshold) return "warning";
  }
  if (health.failure_rate_pct !== null && health.failure_rate_pct > 80) return "critical";
  if (health.failure_rate_pct !== null && health.failure_rate_pct > 50) return "warning";
  return "healthy";
}

function overallStatus(_sources: SourceHealth[], alerts: Alert[]): "healthy" | "degraded" | "critical" {
  if (alerts.some((a) => a.severity === "critical")) return "critical";
  if (alerts.length > 0) return "degraded";
  return "healthy";
}

function formatAlertMessage(alert: Alert, health: SourceHealth | undefined): string {
  const icon = alert.severity === "critical" ? "\u{1F534}" : "\u26A0\uFE0F";
  const lines = [
    `${icon} <b>Pipeline Alert</b>`,
    "",
    `<b>Source:</b> ${escapeHtml(alert.source)}`,
    `<b>Issue:</b> ${escapeHtml(alert.message)}`,
    `<b>Severity:</b> ${alert.severity}`,
  ];
  if (health?.last_capture_at) {
    lines.push(`<b>Last capture:</b> ${health.last_capture_at.slice(0, 16).replace("T", " ")} UTC`);
  }
  lines.push("", "Use <code>pipeline_health</code> MCP tool for details.");
  return lines.join("\n");
}

async function getRecentAlertsSent(): Promise<Map<string, string>> {
  // Check the last monitor run's source_details for previously sent alerts
  const { data } = await supabaseAdmin.rpc("get_pipeline_runs", {
    p_source: "monitor",
    p_days: 2,
    p_limit: 1,
  });
  const runs = (typeof data === "string" ? JSON.parse(data) : data) as any[];
  const map = new Map<string, string>();
  if (runs.length > 0 && runs[0].source_details?.alerts_sent) {
    for (const sent of runs[0].source_details.alerts_sent) {
      // key = "type:source", value = timestamp
      map.set(`${sent.type}:${sent.source}`, runs[0].completed_at);
    }
  }
  return map;
}

function isWithinCooldown(lastSent: string | undefined): boolean {
  if (!lastSent) return false;
  const hoursSince = (Date.now() - new Date(lastSent).getTime()) / (1000 * 60 * 60);
  return hoursSince < ALERT_COOLDOWN_HOURS;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  // Auth
  const key = req.headers.get("x-brain-key");
  if (key !== Deno.env.get("MCP_ACCESS_KEY")) {
    return errorResponse("Unauthorized", 401);
  }

  const startTime = Date.now();

  // Parse request body
  let checkOnly = false;
  let logRun: Record<string, unknown> | null = null;
  try {
    const body = await req.json();
    checkOnly = body.check_only === true;
    if (body.log_run && typeof body.log_run === "object") {
      logRun = body.log_run;
    }
  } catch {
    // Empty body — default to full health check
  }

  // If logging a run, insert it first
  if (logRun) {
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_started_at: logRun.started_at ?? new Date(startTime).toISOString(),
        p_source: logRun.source ?? "unknown",
        p_trigger: logRun.trigger ?? "local_python",
        p_status: logRun.status ?? "success",
        p_captured: logRun.captured ?? 0,
        p_failed: logRun.failed ?? 0,
        p_skipped: logRun.skipped ?? 0,
        p_filtered: logRun.filtered ?? 0,
        p_warnings: logRun.warnings ?? [],
        p_error_message: logRun.error_message ?? null,
        p_source_details: logRun.source_details ?? null,
        p_salience_refreshed: logRun.salience_refreshed ?? null,
        p_dream_dedup: logRun.dream_dedup ?? null,
        p_execution_ms: logRun.execution_ms ?? 0,
      });
    } catch (err) {
      console.error("Failed to log run:", err);
    }
  }

  // Get health data and alerts in parallel
  const [healthResult, alertsResult] = await Promise.all([
    supabaseAdmin.rpc("get_source_health"),
    supabaseAdmin.rpc("check_alert_conditions"),
  ]);

  const sources: SourceHealth[] = healthResult.data ?? [];
  const rawAlerts = alertsResult.data ?? [];
  const alerts: Alert[] = (typeof rawAlerts === "string" ? JSON.parse(rawAlerts) : rawAlerts) as Alert[];

  // Send Telegram alerts (unless check_only)
  let alertsSent = 0;
  const alertsSentLog: Array<{ type: string; source: string }> = [];

  if (!checkOnly && alerts.length > 0) {
    try {
      const chatId = getAllowedChatId();
      const recentSent = await getRecentAlertsSent();

      for (const alert of alerts) {
        const alertKey = `${alert.type}:${alert.source}`;
        if (isWithinCooldown(recentSent.get(alertKey))) {
          continue; // Skip — already alerted recently
        }

        const health = sources.find((s) => s.source === alert.source);
        const message = formatAlertMessage(alert, health);

        try {
          await sendMessage(chatId, message);
          alertsSent++;
          alertsSentLog.push({ type: alert.type, source: alert.source });
        } catch (err) {
          console.error(`Failed to send alert for ${alert.source}:`, err);
        }
      }
    } catch (err) {
      console.error("Failed to send Telegram alerts:", err);
    }
  }

  // Log this monitor run to pipeline_runs
  const executionMs = Date.now() - startTime;
  try {
    await supabaseAdmin.rpc("log_pipeline_run", {
      p_started_at: new Date(startTime).toISOString(),
      p_source: "monitor",
      p_trigger: req.headers.get("x-trigger") ?? "manual",
      p_status: "success",
      p_captured: 0,
      p_failed: 0,
      p_skipped: 0,
      p_filtered: 0,
      p_warnings: [],
      p_error_message: null,
      p_source_details: { alerts_sent: alertsSentLog, alert_count: alerts.length },
      p_salience_refreshed: null,
      p_dream_dedup: null,
      p_execution_ms: executionMs,
    });
  } catch (err) {
    console.error("Failed to log monitor run:", err);
  }

  // Build response
  const status = overallStatus(sources, alerts);
  const responseBody = {
    status,
    sources: sources.filter((s) => s.source !== "mcp" && s.source !== "slack").map((s) => ({
      source: s.source,
      status: sourceStatus(s),
      last_capture: s.last_capture_at,
      hours_since_capture: s.hours_since_capture ? Math.round(s.hours_since_capture * 10) / 10 : null,
      runs_7d: s.total_runs_7d,
      failure_rate: s.failure_rate_pct,
      avg_captured: s.avg_captured_7d,
      avg_execution_ms: s.avg_execution_ms_7d,
      total_thoughts: s.total_thoughts,
      avg_quality: s.avg_quality,
    })),
    alerts,
    alerts_sent: alertsSent,
    timestamp: new Date().toISOString(),
  };

  return new Response(JSON.stringify(responseBody), {
    headers: { "Content-Type": "application/json" },
  });
});
