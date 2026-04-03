-- Migration: Telegram salience priority
-- 1. Update source weights: telegram=1.5 (highest), slack/mcp=1.2, others=0.9
-- 2. Add compute_salience_for_thought() for immediate salience at capture time

-- 1. Updated refresh_salience with new source weights
CREATE OR REPLACE FUNCTION refresh_salience()
RETURNS integer
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH connection_counts AS (
    SELECT thought_id, count(*) as cnt
    FROM (
      SELECT source_thought_id as thought_id FROM thought_connections
      UNION ALL
      SELECT target_thought_id as thought_id FROM thought_connections
    ) edges
    GROUP BY thought_id
  )
  UPDATE thoughts t
  SET salience = (
    CASE WHEN t.pinned THEN 1.0
         ELSE exp(-extract(epoch FROM now() - t.created_at) / 86400.0 / 20.2)
    END
    * (1 + ln(t.access_count + 1))
    * (1 + 0.1 * coalesce(cc.cnt, 0))
    * (1 + 0.2 * t.merge_count)
    * CASE t.source
        WHEN 'telegram' THEN 1.5
        WHEN 'slack' THEN 1.2
        WHEN 'mcp' THEN 1.2
        ELSE 0.9
      END
  )
  FROM (SELECT id FROM thoughts) sub
  LEFT JOIN connection_counts cc ON cc.thought_id = sub.id
  WHERE t.id = sub.id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- 2. Compute salience for a single thought (used at capture time)
CREATE OR REPLACE FUNCTION compute_salience_for_thought(p_thought_id uuid)
RETURNS float
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  result float;
BEGIN
  WITH connection_counts AS (
    SELECT count(*) as cnt
    FROM (
      SELECT source_thought_id as thought_id FROM thought_connections WHERE source_thought_id = p_thought_id
      UNION ALL
      SELECT target_thought_id as thought_id FROM thought_connections WHERE target_thought_id = p_thought_id
    ) edges
  )
  UPDATE thoughts t
  SET salience = (
    CASE WHEN t.pinned THEN 1.0
         ELSE exp(-extract(epoch FROM now() - t.created_at) / 86400.0 / 20.2)
    END
    * (1 + ln(t.access_count + 1))
    * (1 + 0.1 * coalesce(cc.cnt, 0))
    * (1 + 0.2 * t.merge_count)
    * CASE t.source
        WHEN 'telegram' THEN 1.5
        WHEN 'slack' THEN 1.2
        WHEN 'mcp' THEN 1.2
        ELSE 0.9
      END
  )
  FROM connection_counts cc
  WHERE t.id = p_thought_id
  RETURNING t.salience INTO result;

  RETURN result;
END;
$$;
