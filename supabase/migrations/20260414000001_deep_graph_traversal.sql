-- deep_graph_traversal: Multi-hop graph traversal from seed thoughts.
-- Walks thought_connections + co_occurrence_edges up to p_max_hops hops.
-- Spec: docs/superpowers/specs/2026-04-13-deep-search-design.md

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
  WITH RECURSIVE traversal AS (
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

    -- Recursive step: expand frontier via thought_connections
    SELECT
      t.id AS thought_id,
      t.content,
      t.metadata,
      t.source,
      t.created_at,
      tr.hop_depth + 1,
      (tr.path_score * tc.similarity * 0.6)::float AS path_score,
      t.salience
    FROM traversal tr
    JOIN thought_connections tc
      ON (tc.source_thought_id = tr.thought_id OR tc.target_thought_id = tr.thought_id)
      AND tc.brain_id = p_brain_id
      AND tc.similarity >= p_min_similarity
    JOIN thoughts t
      ON t.id = CASE
        WHEN tc.source_thought_id = tr.thought_id THEN tc.target_thought_id
        ELSE tc.source_thought_id
      END
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
      AND tr.hop_depth + 1 <= v_max_hops

    UNION ALL

    -- Recursive step: expand frontier via co_occurrence_edges
    SELECT
      t.id AS thought_id,
      t.content,
      t.metadata,
      t.source,
      t.created_at,
      tr.hop_depth + 1,
      (tr.path_score * ce.weight * 0.5)::float AS path_score,
      t.salience
    FROM traversal tr
    JOIN co_occurrence_edges ce
      ON (ce.thought_a = tr.thought_id OR ce.thought_b = tr.thought_id)
      AND ce.brain_id = p_brain_id
      AND ce.weight >= 0.1
    JOIN thoughts t
      ON t.id = CASE
        WHEN ce.thought_a = tr.thought_id THEN ce.thought_b
        ELSE ce.thought_a
      END
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
