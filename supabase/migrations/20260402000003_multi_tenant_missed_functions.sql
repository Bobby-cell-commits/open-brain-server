-- Multi-tenant: add p_brain_id to functions missed in 20260402000002
SET search_path = 'public';

-- ============================================================================
-- 1. thought_stats
-- ============================================================================

DROP FUNCTION IF EXISTS thought_stats(integer);

CREATE OR REPLACE FUNCTION thought_stats(
  p_brain_id uuid,
  days_back integer DEFAULT NULL
)
RETURNS json
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  SELECT json_build_object(
    'total_thoughts', (
      SELECT count(*) FROM thoughts
      WHERE brain_id = p_brain_id
        AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
    ),
    'by_type', coalesce(
      (
        SELECT json_object_agg(t, cnt) FROM (
          SELECT metadata->>'type' AS t, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
          GROUP BY metadata->>'type'
        ) sub
      ),
      '{}'::json
    ),
    'by_theme', coalesce(
      (
        SELECT json_object_agg(th, cnt) FROM (
          SELECT metadata->>'theme' AS th, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
            AND metadata->>'theme' IS NOT NULL
          GROUP BY metadata->>'theme'
        ) sub
      ),
      '{}'::json
    ),
    'top_topics', coalesce(
      (
        SELECT json_agg(json_build_object('topic', topic, 'count', cnt) ORDER BY cnt DESC)
        FROM (
          SELECT jsonb_array_elements_text(metadata->'topics') AS topic, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
          GROUP BY 1
          ORDER BY cnt DESC
          LIMIT 20
        ) sub
      ),
      '[]'::json
    ),
    'top_people', coalesce(
      (
        SELECT json_agg(json_build_object('person', person, 'count', cnt) ORDER BY cnt DESC)
        FROM (
          SELECT jsonb_array_elements_text(metadata->'people') AS person, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
          GROUP BY 1
          ORDER BY cnt DESC
          LIMIT 20
        ) sub
      ),
      '[]'::json
    )
  );
$$;

-- ============================================================================
-- 2. list_entities
-- ============================================================================

DROP FUNCTION IF EXISTS list_entities(text, int, int);

CREATE OR REPLACE FUNCTION list_entities(
  p_brain_id uuid,
  p_entity_type text DEFAULT NULL,
  p_min_thoughts int DEFAULT 1,
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  name text,
  entity_type text,
  aliases text[],
  thought_count bigint
)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  SELECT
    e.id,
    e.name,
    e.entity_type,
    e.aliases,
    COUNT(te.thought_id) AS thought_count
  FROM entities e
  JOIN thought_entities te ON te.entity_id = e.id
  WHERE e.brain_id = p_brain_id
    AND (p_entity_type IS NULL OR e.entity_type = p_entity_type)
  GROUP BY e.id, e.name, e.entity_type, e.aliases
  HAVING COUNT(te.thought_id) >= p_min_thoughts
  ORDER BY thought_count DESC
  LIMIT LEAST(p_limit, 100);
$$;

-- ============================================================================
-- 3. analysis_baseline
-- ============================================================================

DROP FUNCTION IF EXISTS analysis_baseline();

CREATE OR REPLACE FUNCTION analysis_baseline(
  p_brain_id uuid
)
RETURNS TABLE(source text, total bigint, with_embedding bigint)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  SELECT
    source,
    count(*) AS total,
    count(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding
  FROM thoughts
  WHERE brain_id = p_brain_id
  GROUP BY source
  ORDER BY total DESC;
$$;

-- ============================================================================
-- 4. analysis_dedup_candidates
-- ============================================================================

DROP FUNCTION IF EXISTS analysis_dedup_candidates();

CREATE OR REPLACE FUNCTION analysis_dedup_candidates(
  p_brain_id uuid
)
RETURNS TABLE(similarity numeric, source_a text, source_b text, preview_a text, preview_b text)
LANGUAGE sql
STABLE
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
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> t.embedding) >= 0.85
    ORDER BY embedding <=> t.embedding ASC
    LIMIT 5
  ) m
  WHERE t.brain_id = p_brain_id
    AND t.embedding IS NOT NULL
    AND t.id < m.id
  ORDER BY 1 DESC
  LIMIT 50;
$$;

-- ============================================================================
-- 5. analysis_dedup_zones
-- ============================================================================

DROP FUNCTION IF EXISTS analysis_dedup_zones();

CREATE OR REPLACE FUNCTION analysis_dedup_zones(
  p_brain_id uuid
)
RETURNS TABLE(band text, pair_count bigint)
LANGUAGE sql
STABLE
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
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.85
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 5
    ) m
    WHERE t.brain_id = p_brain_id
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
