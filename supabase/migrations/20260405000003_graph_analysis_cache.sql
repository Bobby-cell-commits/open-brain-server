-- Graph analysis cache: stores precomputed results from O(n²) analysis RPCs.
-- Populated by refresh-graph-analysis Edge Function on daily schedule.
-- Read by analyze/dedup_review MCP tools instead of calling RPCs directly.

-- ============================================================================
-- 1. Cache table
-- ============================================================================

CREATE TABLE graph_analysis_cache (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brain_id      uuid NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  analysis_type text NOT NULL,
  result        jsonb NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  duration_ms   int,
  UNIQUE(brain_id, analysis_type)
);

-- ============================================================================
-- 2. RLS — same service_role_only pattern as all other tables
-- ============================================================================

ALTER TABLE graph_analysis_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_analysis_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON graph_analysis_cache
  FOR ALL USING (current_setting('role') = 'service_role');

-- ============================================================================
-- 3. Statement timeouts on analysis RPCs (for offline execution)
-- ============================================================================

-- These RPCs are now called via direct Postgres connection from the refresh
-- Edge Function, not via PostgREST. The 300s timeout is a safety net for
-- offline computation — generous enough for ~10K thoughts.

CREATE OR REPLACE FUNCTION analysis_connection_density(
  p_brain_id uuid
)
RETURNS TABLE(threshold text, thoughts bigint, avg_links numeric, median_links int, zero_links bigint, ten_plus_links bigint, max_links bigint)
LANGUAGE sql
STABLE
SET statement_timeout = '300s'
SET search_path = 'public'
AS $$
  WITH neighbor_counts AS (
    SELECT
      t.id,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.70) AS links_at_70,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.75) AS links_at_75,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.80) AS links_at_80,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.85) AS links_at_85
    FROM thoughts t
    CROSS JOIN LATERAL (
      SELECT embedding
      FROM thoughts
      WHERE id != t.id
        AND brain_id = p_brain_id
        AND archived_at IS NULL
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.70
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 20
    ) m
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
      AND t.embedding IS NOT NULL
    GROUP BY t.id
  )
  SELECT '0.70', count(*), round(avg(links_at_70), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_70)::int,
    count(*) FILTER (WHERE links_at_70 = 0),
    count(*) FILTER (WHERE links_at_70 >= 10),
    max(links_at_70)
  FROM neighbor_counts
  UNION ALL
  SELECT '0.75', count(*), round(avg(links_at_75), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_75)::int,
    count(*) FILTER (WHERE links_at_75 = 0),
    count(*) FILTER (WHERE links_at_75 >= 10),
    max(links_at_75)
  FROM neighbor_counts
  UNION ALL
  SELECT '0.80', count(*), round(avg(links_at_80), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_80)::int,
    count(*) FILTER (WHERE links_at_80 = 0),
    count(*) FILTER (WHERE links_at_80 >= 10),
    max(links_at_80)
  FROM neighbor_counts
  UNION ALL
  SELECT '0.85', count(*), round(avg(links_at_85), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_85)::int,
    count(*) FILTER (WHERE links_at_85 = 0),
    count(*) FILTER (WHERE links_at_85 >= 10),
    max(links_at_85)
  FROM neighbor_counts
  ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION analysis_rich_thoughts(
  p_brain_id uuid,
  min_conn integer DEFAULT 5
)
RETURNS TABLE(id uuid, source text, strong_matches bigint, preview text)
LANGUAGE sql
STABLE
SET statement_timeout = '300s'
SET search_path = 'public'
AS $$
  SELECT
    t.id,
    t.source,
    count(*) AS strong_matches,
    left(t.content, 80) AS preview
  FROM thoughts t
  CROSS JOIN LATERAL (
    SELECT embedding
    FROM thoughts
    WHERE id != t.id
      AND brain_id = p_brain_id
      AND archived_at IS NULL
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> t.embedding) >= 0.70
    ORDER BY embedding <=> t.embedding ASC
    LIMIT 20
  ) m
  WHERE t.brain_id = p_brain_id
    AND t.archived_at IS NULL
    AND t.embedding IS NOT NULL
  GROUP BY t.id, t.source, t.content
  HAVING count(*) >= min_conn
  ORDER BY count(*) DESC
  LIMIT 20;
$$;

CREATE OR REPLACE FUNCTION analysis_source_pairs(
  p_brain_id uuid
)
RETURNS TABLE(source_1 text, source_2 text, pairs bigint, avg_sim numeric, max_sim numeric)
LANGUAGE sql
STABLE
SET statement_timeout = '300s'
SET search_path = 'public'
AS $$
  WITH high_pairs AS (
    SELECT
      least(t.source, m.source) AS source_1,
      greatest(t.source, m.source) AS source_2,
      1 - (t.embedding <=> m.embedding) AS similarity
    FROM thoughts t
    CROSS JOIN LATERAL (
      SELECT id, source, embedding
      FROM thoughts
      WHERE id != t.id
        AND brain_id = p_brain_id
        AND archived_at IS NULL
        AND embedding IS NOT NULL
        AND source != t.source
        AND 1 - (embedding <=> t.embedding) >= 0.85
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 5
    ) m
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
      AND t.embedding IS NOT NULL
  )
  SELECT
    source_1,
    source_2,
    count(*) AS pairs,
    round(avg(similarity)::numeric, 4) AS avg_sim,
    round(max(similarity)::numeric, 4) AS max_sim
  FROM high_pairs
  GROUP BY source_1, source_2
  ORDER BY pairs DESC;
$$;

CREATE OR REPLACE FUNCTION analysis_dedup_candidates(
  p_brain_id uuid
)
RETURNS TABLE(similarity numeric, source_a text, source_b text, preview_a text, preview_b text)
LANGUAGE sql
STABLE
SET statement_timeout = '300s'
SET search_path = 'public'
AS $$
  SELECT
    round((1 - (t.embedding <=> m.embedding))::numeric, 4) AS similarity,
    t.source AS source_a,
    m.source AS source_b,
    left(t.content, 80) AS preview_a,
    left(m.content, 80) AS preview_b
  FROM thoughts t
  CROSS JOIN LATERAL (
    SELECT id, source, content, embedding
    FROM thoughts
    WHERE id != t.id
      AND brain_id = p_brain_id
      AND archived_at IS NULL
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> t.embedding) >= 0.85
    ORDER BY embedding <=> t.embedding ASC
    LIMIT 5
  ) m
  WHERE t.brain_id = p_brain_id
    AND t.archived_at IS NULL
    AND t.embedding IS NOT NULL
    AND t.id < m.id
  ORDER BY 1 DESC
  LIMIT 50;
$$;

CREATE OR REPLACE FUNCTION analysis_dedup_zones(
  p_brain_id uuid
)
RETURNS TABLE(band text, pair_count bigint)
LANGUAGE sql
STABLE
SET statement_timeout = '300s'
SET search_path = 'public'
AS $$
  WITH high_pairs AS (
    SELECT
      t.id AS id_a,
      m.id AS id_b,
      1 - (t.embedding <=> m.embedding) AS similarity
    FROM thoughts t
    CROSS JOIN LATERAL (
      SELECT id, embedding
      FROM thoughts
      WHERE id != t.id
        AND brain_id = p_brain_id
        AND archived_at IS NULL
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.85
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 5
    ) m
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
      AND t.embedding IS NOT NULL
      AND t.id < m.id
  )
  SELECT
    CASE
      WHEN similarity >= 0.95 THEN '0.95-1.00 (near-identical)'
      WHEN similarity >= 0.92 THEN '0.92-0.95 (current dedup threshold)'
      WHEN similarity >= 0.88 THEN '0.88-0.92 (borderline)'
      WHEN similarity >= 0.85 THEN '0.85-0.88 (near-miss zone)'
    END AS band,
    count(*) AS pair_count
  FROM high_pairs
  GROUP BY band
  ORDER BY band DESC;
$$;
