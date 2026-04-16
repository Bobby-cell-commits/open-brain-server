-- RPC timeout audit: the authenticator role has statement_timeout=8s, which
-- applies to all PostgREST calls (Edge Functions via supabaseAdmin.rpc()).
-- Three functions exceed or approach this limit and need function-level overrides.
--
-- Benchmarks at 3,911 thoughts (2026-04-13):
--   refresh_salience:        19.5s  (2.4x over, BROKEN)
--   find_dedup_candidates:    8.3s  (over, BROKEN)
--   compute_staleness_scores: 3.1s  (safe now, will hit 8s at ~10K thoughts)

SET search_path = 'public';

-- ==========================================================================
-- 1. refresh_salience — 19.5s, full-table UPDATE with connection count CTE
-- ==========================================================================
CREATE OR REPLACE FUNCTION refresh_salience(
  p_brain_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = 'public'
SET statement_timeout = '60s'
AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH connection_counts AS (
    SELECT thought_id, count(*) as cnt
    FROM (
      SELECT source_thought_id as thought_id FROM thought_connections
        WHERE source_thought_id IN (SELECT id FROM thoughts WHERE brain_id = p_brain_id AND archived_at IS NULL)
      UNION ALL
      SELECT target_thought_id as thought_id FROM thought_connections
        WHERE target_thought_id IN (SELECT id FROM thoughts WHERE brain_id = p_brain_id AND archived_at IS NULL)
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
  FROM (SELECT id FROM thoughts WHERE brain_id = p_brain_id AND archived_at IS NULL) sub
  LEFT JOIN connection_counts cc ON cc.thought_id = sub.id
  WHERE t.id = sub.id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- ==========================================================================
-- 2. find_dedup_candidates — 8.3s, nested pgvector similarity loops
-- ==========================================================================
CREATE OR REPLACE FUNCTION find_dedup_candidates(
  p_brain_id uuid,
  days_back integer DEFAULT 7,
  similarity_threshold float DEFAULT 0.92,
  max_candidates_per_thought integer DEFAULT 5
)
RETURNS TABLE(
  thought_a_id uuid,
  thought_a_content text,
  thought_a_source text,
  thought_a_source_event_id text,
  thought_a_merge_count integer,
  thought_a_created_at timestamptz,
  thought_b_id uuid,
  thought_b_content text,
  thought_b_source text,
  thought_b_source_event_id text,
  thought_b_merge_count integer,
  thought_b_created_at timestamptz,
  pair_similarity float
)
LANGUAGE plpgsql
VOLATILE
SET search_path = 'public'
SET statement_timeout = '30s'
AS $$
DECLARE
  recent record;
  match record;
  seen_pairs text[] := '{}';
  pair_key text;
BEGIN
  FOR recent IN
    SELECT t.id, t.content, t.embedding, t.source, t.source_event_id,
           t.merge_count, t.created_at
    FROM thoughts t
    WHERE t.brain_id = p_brain_id
      AND t.created_at > now() - make_interval(days => days_back)
      AND t.embedding IS NOT NULL
      AND t.archived_at IS NULL
      AND t.source != 'dream'
    ORDER BY t.created_at DESC
  LOOP
    FOR match IN
      SELECT t.id, t.content, t.source, t.source_event_id,
             t.merge_count, t.created_at,
             1 - (t.embedding <=> recent.embedding) AS sim
      FROM thoughts t
      WHERE t.brain_id = p_brain_id
        AND t.id != recent.id
        AND t.embedding IS NOT NULL
        AND t.archived_at IS NULL
        AND t.source != 'dream'
        AND 1 - (t.embedding <=> recent.embedding) >= similarity_threshold
      ORDER BY t.embedding <=> recent.embedding ASC
      LIMIT max_candidates_per_thought
    LOOP
      IF recent.id::text < match.id::text THEN
        pair_key := recent.id::text || '|' || match.id::text;
      ELSE
        pair_key := match.id::text || '|' || recent.id::text;
      END IF;

      IF NOT pair_key = ANY(seen_pairs) THEN
        seen_pairs := array_append(seen_pairs, pair_key);

        thought_a_id := recent.id;
        thought_a_content := recent.content;
        thought_a_source := recent.source;
        thought_a_source_event_id := recent.source_event_id;
        thought_a_merge_count := recent.merge_count;
        thought_a_created_at := recent.created_at;

        thought_b_id := match.id;
        thought_b_content := match.content;
        thought_b_source := match.source;
        thought_b_source_event_id := match.source_event_id;
        thought_b_merge_count := match.merge_count;
        thought_b_created_at := match.created_at;
        pair_similarity := match.sim;

        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- ==========================================================================
-- 3. compute_staleness_scores — 3.1s now, preventive (will hit 8s at ~10K)
-- ==========================================================================
CREATE OR REPLACE FUNCTION compute_staleness_scores(
  p_brain_id uuid,
  p_min_age_days integer DEFAULT 21,
  p_low_quality_min_age_days integer DEFAULT 14
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = 'public'
SET statement_timeout = '30s'
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
