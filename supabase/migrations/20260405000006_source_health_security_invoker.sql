-- Fix: source_health view was SECURITY DEFINER (runs as view owner, bypassing RLS).
-- Switch to security_invoker = true so the view respects the caller's privileges.
-- Requires DROP + CREATE because ALTER VIEW cannot add security_invoker to an existing view.

DROP VIEW IF EXISTS source_health CASCADE;

CREATE VIEW source_health
WITH (security_invoker = true)
AS
WITH run_stats AS (
  SELECT
    source,
    COUNT(*) AS total_runs_7d,
    COUNT(*) FILTER (WHERE status = 'success') AS successful_runs_7d,
    COUNT(*) FILTER (WHERE status = 'failure') AS failed_runs_7d,
    ROUND(AVG(captured)) AS avg_captured_7d,
    ROUND(AVG(execution_ms)) AS avg_execution_ms_7d,
    MAX(completed_at) AS last_run_at,
    MAX(completed_at) FILTER (WHERE captured > 0) AS last_yield_at
  FROM pipeline_runs
  WHERE completed_at > now() - interval '7 days'
  GROUP BY source
),
thought_stats AS (
  SELECT
    source,
    COUNT(*) AS total_thoughts,
    MAX(created_at) AS last_capture_at,
    ROUND(AVG((metadata->>'quality')::float)::numeric, 2) AS avg_quality
  FROM thoughts
  WHERE archived_at IS NULL
  GROUP BY source
)
SELECT
  COALESCE(r.source, t.source) AS source,
  r.total_runs_7d,
  r.successful_runs_7d,
  r.failed_runs_7d,
  CASE WHEN r.total_runs_7d > 0
    THEN ROUND((r.failed_runs_7d::numeric / r.total_runs_7d) * 100, 1)
    ELSE NULL
  END AS failure_rate_pct,
  r.avg_captured_7d,
  r.avg_execution_ms_7d,
  r.last_run_at,
  r.last_yield_at,
  t.total_thoughts,
  t.last_capture_at,
  t.avg_quality,
  EXTRACT(EPOCH FROM (now() - t.last_capture_at)) / 3600 AS hours_since_capture
FROM run_stats r
FULL OUTER JOIN thought_stats t ON r.source = t.source;

-- Recreate the dependent function that was dropped by CASCADE
CREATE OR REPLACE FUNCTION get_source_health()
RETURNS SETOF source_health
LANGUAGE sql STABLE
SET search_path = 'public'
AS $$
  SELECT * FROM source_health;
$$;
