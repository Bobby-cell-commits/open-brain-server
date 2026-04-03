-- Pipeline monitoring: run logging, health views, alert checks
-- Depends on: thoughts table (existing)

-- 1. pipeline_runs table
CREATE TABLE pipeline_runs (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  started_at      timestamptz NOT NULL,
  completed_at    timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL,
  trigger         text NOT NULL,
  status          text NOT NULL,
  captured        integer NOT NULL DEFAULT 0,
  failed          integer NOT NULL DEFAULT 0,
  skipped         integer NOT NULL DEFAULT 0,
  filtered        integer NOT NULL DEFAULT 0,
  warnings        jsonb DEFAULT '[]'::jsonb,
  error_message   text,
  source_details  jsonb,
  salience_refreshed integer,
  dream_dedup     jsonb,
  execution_ms    integer NOT NULL,
  CONSTRAINT valid_status CHECK (status IN ('success', 'partial_failure', 'failure'))
);

CREATE INDEX idx_pipeline_runs_source_completed
  ON pipeline_runs (source, completed_at DESC);
CREATE INDEX idx_pipeline_runs_status
  ON pipeline_runs (status) WHERE status != 'success';

-- 2. source_health view
CREATE OR REPLACE VIEW source_health AS
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

-- 3. log_pipeline_run
CREATE OR REPLACE FUNCTION log_pipeline_run(
  p_started_at timestamptz,
  p_source text,
  p_trigger text,
  p_status text,
  p_captured integer DEFAULT 0,
  p_failed integer DEFAULT 0,
  p_skipped integer DEFAULT 0,
  p_filtered integer DEFAULT 0,
  p_warnings jsonb DEFAULT '[]',
  p_error_message text DEFAULT NULL,
  p_source_details jsonb DEFAULT NULL,
  p_salience_refreshed integer DEFAULT NULL,
  p_dream_dedup jsonb DEFAULT NULL,
  p_execution_ms integer DEFAULT 0
) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO pipeline_runs (
    started_at, source, trigger, status,
    captured, failed, skipped, filtered,
    warnings, error_message, source_details,
    salience_refreshed, dream_dedup, execution_ms
  ) VALUES (
    p_started_at, p_source, p_trigger, p_status,
    p_captured, p_failed, p_skipped, p_filtered,
    p_warnings, p_error_message, p_source_details,
    p_salience_refreshed, p_dream_dedup, p_execution_ms
  )
  RETURNING id;
$$;

-- 4. get_source_health
CREATE OR REPLACE FUNCTION get_source_health()
RETURNS SETOF source_health
LANGUAGE sql STABLE
SET search_path = 'public'
AS $$
  SELECT * FROM source_health;
$$;

-- 5. get_pipeline_runs
CREATE OR REPLACE FUNCTION get_pipeline_runs(
  p_source text DEFAULT NULL,
  p_days integer DEFAULT 7,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = 'public'
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
  FROM (
    SELECT id, started_at, completed_at, source, trigger, status,
           captured, failed, skipped, filtered,
           warnings, error_message, execution_ms,
           salience_refreshed, dream_dedup, source_details
    FROM pipeline_runs
    WHERE completed_at > now() - make_interval(days => p_days)
      AND (p_source IS NULL OR source = p_source)
      AND (p_status IS NULL OR status = p_status)
    ORDER BY completed_at DESC
    LIMIT p_limit
  ) r;
$$;

-- 6. check_alert_conditions
CREATE OR REPLACE FUNCTION check_alert_conditions()
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = 'public'
AS $$
DECLARE
  alerts jsonb := '[]'::jsonb;
  rec record;
  threshold_hours numeric;
  severity text;
BEGIN
  FOR rec IN SELECT * FROM source_health LOOP
    -- Skip sources that only appear in thoughts (no pipeline runs) like 'mcp', 'telegram', 'slack'
    IF rec.total_runs_7d IS NULL THEN
      CONTINUE;
    END IF;

    -- Stale source: no captures in threshold period
    IF rec.hours_since_capture IS NOT NULL THEN
      threshold_hours := CASE rec.source
        WHEN 'reddit' THEN 48
        WHEN 'rss' THEN 48
        ELSE 72
      END;

      IF rec.hours_since_capture > threshold_hours * 2 THEN
        severity := 'critical';
      ELSIF rec.hours_since_capture > threshold_hours THEN
        severity := 'warning';
      ELSE
        severity := NULL;
      END IF;

      IF severity IS NOT NULL THEN
        alerts := alerts || jsonb_build_object(
          'type', 'source_stale',
          'source', rec.source,
          'severity', severity,
          'message', rec.source || ': no captures in ' ||
            ROUND(rec.hours_since_capture) || ' hours',
          'hours_since_capture', ROUND(rec.hours_since_capture)
        );
      END IF;
    END IF;

    -- High failure rate: >50% in last 7 days
    IF rec.failure_rate_pct IS NOT NULL AND rec.failure_rate_pct > 50 THEN
      alerts := alerts || jsonb_build_object(
        'type', 'high_failure_rate',
        'source', rec.source,
        'severity', CASE WHEN rec.failure_rate_pct > 80 THEN 'critical' ELSE 'warning' END,
        'message', rec.source || ': ' || rec.failure_rate_pct || '% failure rate (7d)',
        'failure_rate', rec.failure_rate_pct
      );
    END IF;
  END LOOP;

  -- Consecutive failures: 3+ back-to-back for any source
  FOR rec IN
    SELECT source, COUNT(*) AS streak
    FROM (
      SELECT source, status,
        ROW_NUMBER() OVER (PARTITION BY source ORDER BY completed_at DESC) AS rn
      FROM pipeline_runs
      WHERE completed_at > now() - interval '7 days'
    ) sub
    WHERE rn <= 5 AND status = 'failure'
    GROUP BY source
    HAVING COUNT(*) >= 3
  LOOP
    alerts := alerts || jsonb_build_object(
      'type', 'consecutive_failures',
      'source', rec.source,
      'severity', 'critical',
      'message', rec.source || ': ' || rec.streak || ' consecutive failures'
    );
  END LOOP;

  RETURN alerts;
END;
$$;
