-- Dream Phase D: Decay & Pruning
-- Adds staleness scoring columns, pruning log table, and 5 RPCs.

-- 1. New columns on thoughts
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS archived_at timestamptz DEFAULT NULL;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS staleness_score float DEFAULT NULL;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS staleness_scored_at timestamptz DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_thoughts_archived ON thoughts (archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_staleness ON thoughts (staleness_score DESC NULLS LAST) WHERE archived_at IS NULL;

-- 2. Pruning log table (mirrors merge_audit_log pattern)
CREATE TABLE IF NOT EXISTS pruning_log (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brain_id        uuid NOT NULL REFERENCES brains(id),
  thought_id      uuid NOT NULL REFERENCES thoughts(id),
  staleness_score float NOT NULL,
  tier            text NOT NULL,
  verdict         text NOT NULL,
  llm_reason      text,
  context_packet  jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT valid_tier CHECK (tier IN ('auto', 'context_confirmed', 'manual')),
  CONSTRAINT valid_verdict CHECK (verdict IN ('archive', 'keep'))
);

CREATE INDEX IF NOT EXISTS idx_pruning_log_brain ON pruning_log (brain_id, created_at DESC);

-- Enable RLS (service_role only, matching existing tables)
ALTER TABLE pruning_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY pruning_log_service ON pruning_log
    FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Add dream_decay column to pipeline_runs
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS dream_decay jsonb;

-- 4. compute_staleness_scores: Batch staleness scoring
CREATE OR REPLACE FUNCTION compute_staleness_scores(
  p_brain_id uuid,
  p_min_age_days integer DEFAULT 21,
  p_low_quality_min_age_days integer DEFAULT 14
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH eligible AS (
    SELECT t.id,
           EXTRACT(EPOCH FROM now() - t.created_at) / 86400.0 AS age_days,
           t.access_count,
           COALESCE((t.metadata->>'quality')::float, 0.5) AS quality,
           COALESCE(cc.cnt, 0) AS connections,
           t.metadata->>'theme' AS theme
    FROM thoughts t
    LEFT JOIN (
      SELECT thought_id, COUNT(*) AS cnt
      FROM (
        SELECT source_thought_id AS thought_id FROM thought_connections
        UNION ALL
        SELECT target_thought_id AS thought_id FROM thought_connections
      ) all_links
      GROUP BY thought_id
    ) cc ON cc.thought_id = t.id
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
      AND t.pinned = false
      AND t.source != 'dream'
      AND (t.staleness_scored_at IS NULL OR t.staleness_scored_at < now())
      AND (
        (EXTRACT(EPOCH FROM now() - t.created_at) / 86400.0 >= p_min_age_days)
        OR
        (COALESCE((t.metadata->>'quality')::float, 0.5) < 0.4
         AND EXTRACT(EPOCH FROM now() - t.created_at) / 86400.0 >= p_low_quality_min_age_days)
      )
  ),
  theme_vitality AS (
    SELECT metadata->>'theme' AS theme,
           COUNT(*) AS recent_captures
    FROM thoughts
    WHERE brain_id = p_brain_id
      AND archived_at IS NULL
      AND created_at > now() - interval '30 days'
    GROUP BY metadata->>'theme'
  ),
  scored AS (
    SELECT
      e.id,
      LEAST(1.0,
        (1.0 - exp(-e.age_days / 30.0))
        * (1.0 / (1.0 + 0.2 * ln(1.0 + e.access_count)))
        * (1.0 / (1.0 + 0.1 * LEAST(e.connections, 10)))
        * (CASE WHEN e.quality >= 0.7 THEN 0.7
                WHEN e.quality <= 0.3 THEN 1.3
                ELSE 1.0 END)
        * (1.0 / (1.0 + 0.1 * COALESCE(tv.recent_captures, 0)))
      ) AS staleness
    FROM eligible e
    LEFT JOIN theme_vitality tv ON tv.theme = e.theme
  )
  UPDATE thoughts t
  SET staleness_score = s.staleness,
      staleness_scored_at = now()
  FROM scored s
  WHERE t.id = s.id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- 5. get_stale_candidates
CREATE OR REPLACE FUNCTION get_stale_candidates(
  p_brain_id uuid,
  p_tier text,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  source text,
  created_at timestamptz,
  access_count integer,
  merge_count integer,
  staleness_score float,
  connection_count bigint,
  theme_recent_captures bigint,
  top_connections jsonb,
  entity_names text[]
)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
AS $$
DECLARE
  min_score float;
  max_score float;
BEGIN
  CASE p_tier
    WHEN 'auto' THEN min_score := 0.85; max_score := 1.01;
    WHEN 'context' THEN min_score := 0.70; max_score := 0.85;
    WHEN 'review' THEN min_score := 0.40; max_score := 0.70;
    ELSE RAISE EXCEPTION 'Invalid tier: %. Use auto, context, or review', p_tier;
  END CASE;

  RETURN QUERY
  WITH candidates AS (
    SELECT t.id, t.content, t.metadata, t.source, t.created_at,
           t.access_count, t.merge_count, t.staleness_score
    FROM thoughts t
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
      AND t.staleness_score >= min_score
      AND t.staleness_score < max_score
    ORDER BY t.staleness_score DESC
    LIMIT p_limit
  ),
  conn_counts AS (
    SELECT al.thought_id, COUNT(*) AS cnt
    FROM (
      SELECT source_thought_id AS thought_id FROM thought_connections
        WHERE source_thought_id IN (SELECT c.id FROM candidates c)
      UNION ALL
      SELECT target_thought_id AS thought_id FROM thought_connections
        WHERE target_thought_id IN (SELECT c.id FROM candidates c)
    ) al
    GROUP BY al.thought_id
  ),
  top_conns AS (
    SELECT al.thought_id,
           jsonb_agg(jsonb_build_object(
             'content', left(t2.content, 200),
             'link_type', al.link_type,
             'similarity', al.similarity,
             'salience', t2.salience,
             'access_count', t2.access_count
           ) ORDER BY al.similarity DESC) AS conns
    FROM (
      SELECT source_thought_id AS thought_id, target_thought_id AS peer_id, link_type, similarity
        FROM thought_connections WHERE source_thought_id IN (SELECT c.id FROM candidates c)
      UNION ALL
      SELECT target_thought_id AS thought_id, source_thought_id AS peer_id, link_type, similarity
        FROM thought_connections WHERE target_thought_id IN (SELECT c.id FROM candidates c)
    ) al
    JOIN thoughts t2 ON t2.id = al.peer_id
    GROUP BY al.thought_id
  ),
  theme_vitality AS (
    SELECT th.metadata->>'theme' AS theme, COUNT(*) AS recent_captures
    FROM thoughts th
    WHERE th.brain_id = p_brain_id
      AND th.archived_at IS NULL
      AND th.created_at > now() - interval '30 days'
    GROUP BY th.metadata->>'theme'
  ),
  entity_info AS (
    SELECT te.thought_id,
           array_agg(DISTINCT e.name) AS names
    FROM thought_entities te
    JOIN entities e ON e.id = te.entity_id
    WHERE te.thought_id IN (SELECT c.id FROM candidates c)
    GROUP BY te.thought_id
  )
  SELECT c.id, c.content, c.metadata, c.source, c.created_at,
         c.access_count, c.merge_count, c.staleness_score,
         COALESCE(cc.cnt, 0) AS connection_count,
         COALESCE(tv.recent_captures, 0) AS theme_recent_captures,
         tc.conns AS top_connections,
         COALESCE(ei.names, ARRAY[]::text[]) AS entity_names
  FROM candidates c
  LEFT JOIN conn_counts cc ON cc.thought_id = c.id
  LEFT JOIN top_conns tc ON tc.thought_id = c.id
  LEFT JOIN theme_vitality tv ON tv.theme = c.metadata->>'theme'
  LEFT JOIN entity_info ei ON ei.thought_id = c.id
  ORDER BY c.staleness_score DESC;
END;
$$;

-- 6. archive_thought
CREATE OR REPLACE FUNCTION archive_thought(
  p_brain_id uuid,
  p_thought_id uuid
)
RETURNS void
LANGUAGE sql
SET search_path = 'public'
AS $$
  UPDATE thoughts
  SET archived_at = now()
  WHERE id = p_thought_id AND brain_id = p_brain_id;
$$;

-- 7. unarchive_thought
CREATE OR REPLACE FUNCTION unarchive_thought(
  p_brain_id uuid,
  p_thought_id uuid
)
RETURNS void
LANGUAGE sql
SET search_path = 'public'
AS $$
  UPDATE thoughts
  SET archived_at = NULL, staleness_score = NULL, staleness_scored_at = NULL
  WHERE id = p_thought_id AND brain_id = p_brain_id;
$$;

-- 8. check_sole_entity_protection
CREATE OR REPLACE FUNCTION check_sole_entity_protection(
  p_brain_id uuid,
  p_thought_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM thought_entities te
    JOIN entities e ON e.id = te.entity_id
    WHERE te.thought_id = p_thought_id
      AND (
        SELECT COUNT(*)
        FROM thought_entities te2
        JOIN thoughts t ON t.id = te2.thought_id
        WHERE te2.entity_id = e.id
          AND t.brain_id = p_brain_id
          AND t.archived_at IS NULL
          AND t.id != p_thought_id
      ) = 0
  );
$$;

-- 9. Update log_pipeline_run to accept dream_decay param
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
  p_execution_ms integer DEFAULT 0,
  p_dream_decay jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO pipeline_runs (
    started_at, source, trigger, status,
    captured, failed, skipped, filtered,
    warnings, error_message, source_details,
    salience_refreshed, dream_dedup, execution_ms, dream_decay
  ) VALUES (
    p_started_at, p_source, p_trigger, p_status,
    p_captured, p_failed, p_skipped, p_filtered,
    p_warnings, p_error_message, p_source_details,
    p_salience_refreshed, p_dream_dedup, p_execution_ms, p_dream_decay
  )
  RETURNING id;
$$;

-- 10. log_pruning
CREATE OR REPLACE FUNCTION log_pruning(
  p_brain_id uuid,
  p_thought_id uuid,
  p_staleness_score float,
  p_tier text,
  p_verdict text,
  p_llm_reason text DEFAULT NULL,
  p_context_packet jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
SET search_path = 'public'
AS $$
  INSERT INTO pruning_log (brain_id, thought_id, staleness_score, tier, verdict, llm_reason, context_packet)
  VALUES (p_brain_id, p_thought_id, p_staleness_score, p_tier, p_verdict, p_llm_reason, p_context_packet)
  RETURNING id;
$$;
