-- Co-occurrence RPCs: session logging, edge updates, decay, analysis
SET search_path = 'public';

-- ============================================================================
-- 1. log_retrieval_session — append-only audit log
-- ============================================================================

CREATE OR REPLACE FUNCTION log_retrieval_session(
  p_brain_id uuid,
  p_tool_name text,
  p_context text DEFAULT 'manual',
  p_query_text text DEFAULT NULL,
  p_thought_ids uuid[] DEFAULT '{}'
)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = 'public'
AS $$
  INSERT INTO retrieval_sessions (brain_id, tool_name, context, query_text, thought_ids)
  VALUES (p_brain_id, p_tool_name, p_context, p_query_text, p_thought_ids);
$$;

-- ============================================================================
-- 2. update_co_occurrence — UPSERT edges for all pairs in a result set
-- ============================================================================

CREATE OR REPLACE FUNCTION update_co_occurrence(
  p_brain_id uuid,
  p_thought_ids uuid[],
  p_context_weight float DEFAULT 1.0
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = 'public'
AS $$
DECLARE
  i int;
  j int;
  a uuid;
  b uuid;
  arr_len int := array_length(p_thought_ids, 1);
BEGIN
  IF arr_len IS NULL OR arr_len < 2 THEN
    RETURN;
  END IF;

  FOR i IN 1..arr_len LOOP
    FOR j IN (i+1)..arr_len LOOP
      IF p_thought_ids[i] < p_thought_ids[j] THEN
        a := p_thought_ids[i];
        b := p_thought_ids[j];
      ELSE
        a := p_thought_ids[j];
        b := p_thought_ids[i];
      END IF;

      INSERT INTO co_occurrence_edges
        (brain_id, thought_a, thought_b, raw_count, weighted_count,
         weight, half_life_days, last_co_occurred_at)
      VALUES
        (p_brain_id, a, b, 1, p_context_weight,
         p_context_weight, 7.0, now())
      ON CONFLICT (brain_id, thought_a, thought_b) DO UPDATE SET
        raw_count = co_occurrence_edges.raw_count + 1,
        weighted_count = co_occurrence_edges.weighted_count + EXCLUDED.weighted_count,
        last_co_occurred_at = now(),
        half_life_days = 7.0 * (1 + ln(1 + co_occurrence_edges.weighted_count + EXCLUDED.weighted_count)),
        weight = co_occurrence_edges.weighted_count + EXCLUDED.weighted_count;
    END LOOP;
  END LOOP;
END;
$$;

-- ============================================================================
-- 3. decay_co_occurrence_edges — weekly maintenance batch job
-- ============================================================================

CREATE OR REPLACE FUNCTION decay_co_occurrence_edges(p_brain_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  decayed_count int;
  pruned_count int;
  capped_count int;
BEGIN
  -- Step 1: Decay all edge weights using Ebbinghaus forgetting curve
  UPDATE co_occurrence_edges
  SET weight = weighted_count * power(2.0,
    -extract(epoch FROM now() - last_co_occurred_at) / 86400.0 / half_life_days
  )
  WHERE brain_id = p_brain_id;
  GET DIAGNOSTICS decayed_count = ROW_COUNT;

  -- Step 2: Prune dead edges (weight below floor)
  DELETE FROM co_occurrence_edges
  WHERE brain_id = p_brain_id
    AND weight < 0.01;
  GET DIAGNOSTICS pruned_count = ROW_COUNT;

  -- Step 3: Homeostatic normalization (Turrigiano)
  -- Cap total incoming weight per thought at 10.0
  WITH node_totals AS (
    SELECT thought_id, sum(weight) AS total_weight
    FROM (
      SELECT thought_a AS thought_id, weight FROM co_occurrence_edges WHERE brain_id = p_brain_id
      UNION ALL
      SELECT thought_b AS thought_id, weight FROM co_occurrence_edges WHERE brain_id = p_brain_id
    ) all_edges
    GROUP BY thought_id
    HAVING sum(weight) > 10.0
  ),
  scale_factors AS (
    SELECT thought_id, 10.0 / total_weight AS factor
    FROM node_totals
  )
  UPDATE co_occurrence_edges ce
  SET weight = weight * LEAST(
    COALESCE((SELECT factor FROM scale_factors WHERE thought_id = ce.thought_a), 1.0),
    COALESCE((SELECT factor FROM scale_factors WHERE thought_id = ce.thought_b), 1.0)
  )
  WHERE brain_id = p_brain_id
    AND (ce.thought_a IN (SELECT thought_id FROM scale_factors)
      OR ce.thought_b IN (SELECT thought_id FROM scale_factors));
  GET DIAGNOSTICS capped_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'decayed', decayed_count,
    'pruned', pruned_count,
    'capped', capped_count
  );
END;
$$;

-- ============================================================================
-- 4. analyze_co_occurrence — observability for co-occurrence graph health
-- ============================================================================

CREATE OR REPLACE FUNCTION analyze_co_occurrence(p_brain_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
AS $$
DECLARE
  result jsonb;
BEGIN
  WITH edge_stats AS (
    SELECT
      count(*) AS total_edges,
      coalesce(avg(weight), 0) AS avg_weight,
      coalesce(max(weight), 0) AS max_weight,
      coalesce(avg(raw_count), 0) AS avg_raw_count,
      coalesce(avg(half_life_days), 0) AS avg_half_life
    FROM co_occurrence_edges
    WHERE brain_id = p_brain_id
  ),
  weight_distribution AS (
    SELECT
      count(*) FILTER (WHERE weight >= 0.01 AND weight < 0.1) AS bucket_001_01,
      count(*) FILTER (WHERE weight >= 0.1 AND weight < 0.5) AS bucket_01_05,
      count(*) FILTER (WHERE weight >= 0.5 AND weight < 1.0) AS bucket_05_10,
      count(*) FILTER (WHERE weight >= 1.0) AS bucket_10_plus
    FROM co_occurrence_edges
    WHERE brain_id = p_brain_id
  ),
  top_edges AS (
    SELECT jsonb_agg(edge_row ORDER BY weight DESC) AS edges
    FROM (
      SELECT jsonb_build_object(
        'thought_a', ce.thought_a,
        'thought_b', ce.thought_b,
        'weight', round(ce.weight::numeric, 3),
        'raw_count', ce.raw_count,
        'half_life_days', round(ce.half_life_days::numeric, 1),
        'preview_a', left(ta.content, 80),
        'preview_b', left(tb.content, 80)
      ) AS edge_row, ce.weight
      FROM co_occurrence_edges ce
      JOIN thoughts ta ON ta.id = ce.thought_a AND ta.archived_at IS NULL
      JOIN thoughts tb ON tb.id = ce.thought_b AND tb.archived_at IS NULL
      WHERE ce.brain_id = p_brain_id
      ORDER BY ce.weight DESC
      LIMIT 10
    ) sub
  ),
  hub_report AS (
    SELECT jsonb_agg(hub_row ORDER BY total_weight DESC) AS hubs
    FROM (
      SELECT jsonb_build_object(
        'thought_id', thought_id,
        'total_weight', round(total_weight::numeric, 2),
        'edge_count', edge_count,
        'preview', left(t.content, 80)
      ) AS hub_row, total_weight
      FROM (
        SELECT thought_id, sum(weight) AS total_weight, count(*) AS edge_count
        FROM (
          SELECT thought_a AS thought_id, weight FROM co_occurrence_edges WHERE brain_id = p_brain_id
          UNION ALL
          SELECT thought_b AS thought_id, weight FROM co_occurrence_edges WHERE brain_id = p_brain_id
        ) all_edges
        GROUP BY thought_id
        HAVING sum(weight) > 8.0
      ) heavy_nodes
      JOIN thoughts t ON t.id = heavy_nodes.thought_id AND t.archived_at IS NULL
      ORDER BY total_weight DESC
      LIMIT 10
    ) sub
  ),
  session_stats AS (
    SELECT
      count(*) AS total_sessions,
      count(*) FILTER (WHERE created_at > now() - interval '7 days') AS sessions_7d,
      count(*) FILTER (WHERE created_at > now() - interval '30 days') AS sessions_30d
    FROM retrieval_sessions
    WHERE brain_id = p_brain_id
  )
  SELECT jsonb_build_object(
    'total_edges', es.total_edges,
    'avg_weight', round(es.avg_weight::numeric, 3),
    'max_weight', round(es.max_weight::numeric, 3),
    'avg_raw_count', round(es.avg_raw_count::numeric, 1),
    'avg_half_life_days', round(es.avg_half_life::numeric, 1),
    'weight_distribution', jsonb_build_object(
      '0.01-0.1', wd.bucket_001_01,
      '0.1-0.5', wd.bucket_01_05,
      '0.5-1.0', wd.bucket_05_10,
      '1.0+', wd.bucket_10_plus
    ),
    'top_edges', coalesce(te.edges, '[]'::jsonb),
    'hub_report', coalesce(hr.hubs, '[]'::jsonb),
    'sessions', jsonb_build_object(
      'total', ss.total_sessions,
      'last_7d', ss.sessions_7d,
      'last_30d', ss.sessions_30d
    )
  ) INTO result
  FROM edge_stats es, weight_distribution wd, top_edges te, hub_report hr, session_stats ss;

  RETURN result;
END;
$$;
