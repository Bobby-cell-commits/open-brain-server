-- Add zero-yield alert: fires when a source has 3+ successful runs but captures nothing
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

    -- Zero yield: 3+ successful runs but avg captures = 0
    -- Skip sources that never capture (monitor, none/dedup-only)
    IF rec.source NOT IN ('monitor', 'none')
       AND rec.successful_runs_7d IS NOT NULL AND rec.successful_runs_7d >= 3
       AND (rec.avg_captured_7d IS NULL OR rec.avg_captured_7d = 0) THEN
      alerts := alerts || jsonb_build_object(
        'type', 'zero_yield',
        'source', rec.source,
        'severity', 'warning',
        'message', rec.source || ': ' || rec.successful_runs_7d ||
          ' successful runs in 7d but 0 captures — pipeline may be filtering everything',
        'successful_runs', rec.successful_runs_7d
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
