-- Fix deep_graph_traversal: PostgreSQL recursive CTEs only allow one recursive
-- UNION ALL branch. Combine thought_connections and co_occurrence_edges into a
-- single edge source CTE, then recurse once over it.

CREATE OR REPLACE FUNCTION deep_graph_traversal(
  p_brain_id uuid,
  p_seed_ids uuid[],
  p_max_hops int DEFAULT 2,
  p_min_similarity float DEFAULT 0.6
)
RETURNS TABLE (
  thought_id uuid,
  content text,
  metadata jsonb,
  source text,
  created_at timestamptz,
  hop_depth int,
  path_score float,
  salience float
)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
SET statement_timeout = '15s'
AS $$
DECLARE
  v_max_hops int := LEAST(COALESCE(p_max_hops, 2), 3);
BEGIN
  RETURN QUERY
  WITH RECURSIVE
  -- Combine both edge sources into one flat edge list
  all_edges AS (
    SELECT
      tc.source_thought_id AS from_id,
      tc.target_thought_id AS to_id,
      tc.similarity AS weight,
      0.6 AS decay
    FROM thought_connections tc
    WHERE tc.brain_id = p_brain_id
      AND tc.similarity >= p_min_similarity
    UNION ALL
    SELECT
      tc.target_thought_id AS from_id,
      tc.source_thought_id AS to_id,
      tc.similarity AS weight,
      0.6 AS decay
    FROM thought_connections tc
    WHERE tc.brain_id = p_brain_id
      AND tc.similarity >= p_min_similarity
    UNION ALL
    SELECT
      ce.thought_a AS from_id,
      ce.thought_b AS to_id,
      ce.weight,
      0.5 AS decay
    FROM co_occurrence_edges ce
    WHERE ce.brain_id = p_brain_id
      AND ce.weight >= 0.1
    UNION ALL
    SELECT
      ce.thought_b AS from_id,
      ce.thought_a AS to_id,
      ce.weight,
      0.5 AS decay
    FROM co_occurrence_edges ce
    WHERE ce.brain_id = p_brain_id
      AND ce.weight >= 0.1
  ),
  traversal AS (
    -- Base case: seed thoughts (hop 0)
    SELECT
      t.id AS thought_id,
      t.content,
      t.metadata,
      t.source,
      t.created_at,
      0 AS hop_depth,
      1.0::float AS path_score,
      t.salience
    FROM thoughts t
    WHERE t.id = ANY(p_seed_ids)
      AND t.brain_id = p_brain_id
      AND t.archived_at IS NULL

    UNION ALL

    -- Single recursive step over merged edge list
    SELECT
      t.id AS thought_id,
      t.content,
      t.metadata,
      t.source,
      t.created_at,
      tr.hop_depth + 1,
      (tr.path_score * ae.weight * ae.decay)::float AS path_score,
      t.salience
    FROM traversal tr
    JOIN all_edges ae ON ae.from_id = tr.thought_id
    JOIN thoughts t ON t.id = ae.to_id
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
      AND tr.hop_depth + 1 <= v_max_hops
  ),
  -- Dedup: keep highest path_score per thought, exclude seeds
  best_paths AS (
    SELECT DISTINCT ON (tr.thought_id)
      tr.thought_id,
      tr.content,
      tr.metadata,
      tr.source,
      tr.created_at,
      tr.hop_depth,
      tr.path_score,
      tr.salience
    FROM traversal tr
    WHERE tr.hop_depth > 0
    ORDER BY tr.thought_id, tr.path_score DESC
  )
  SELECT * FROM best_paths
  ORDER BY path_score DESC
  LIMIT 50;
END;
$$;
