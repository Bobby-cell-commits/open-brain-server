-- Entity bridge connections: Newman-IDF weighted edges between thoughts sharing entities.
-- Spec: docs/superpowers/specs/2026-04-14-graph-cross-cluster-connectivity-design.md
SET search_path = 'public';

CREATE OR REPLACE FUNCTION refresh_entity_bridges(p_brain_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = 'public'
SET statement_timeout = '300s'
AS $$
DECLARE
  deleted_count int;
  upserted_count int;
BEGIN
  -- Step 1: Delete entity-bridge rows where thoughts no longer share any entities
  -- (e.g., thought was updated and entity was removed, or thought was archived)
  DELETE FROM thought_connections tc
  WHERE tc.link_type = 'entity-bridge'
    AND tc.brain_id = p_brain_id
    AND NOT EXISTS (
      SELECT 1
      FROM thought_entities te1
      JOIN thought_entities te2 ON te2.entity_id = te1.entity_id
        AND te2.thought_id = tc.target_thought_id
      JOIN thoughts t1 ON t1.id = tc.source_thought_id AND t1.archived_at IS NULL
      JOIN thoughts t2 ON t2.id = tc.target_thought_id AND t2.archived_at IS NULL
      WHERE te1.thought_id = tc.source_thought_id
    );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  -- Step 2: Compute all entity pairs with Newman-IDF weights and upsert
  WITH entity_freq AS (
    SELECT te.entity_id, COUNT(DISTINCT te.thought_id) AS df
    FROM thought_entities te
    JOIN thoughts t ON t.id = te.thought_id
      AND t.archived_at IS NULL AND t.brain_id = p_brain_id
    GROUP BY te.entity_id
    HAVING COUNT(DISTINCT te.thought_id) >= 2
  ),
  pair_scores AS (
    SELECT
      LEAST(te1.thought_id, te2.thought_id) AS source_id,
      GREATEST(te1.thought_id, te2.thought_id) AS target_id,
      1 - exp(-1.0 * SUM(1.0 / (ef.df - 1))) AS similarity,
      array_agg(DISTINCT e.name ORDER BY e.name) AS shared_entities
    FROM thought_entities te1
    JOIN thought_entities te2 ON te2.entity_id = te1.entity_id
      AND te1.thought_id < te2.thought_id
    JOIN entity_freq ef ON ef.entity_id = te1.entity_id
    JOIN entities e ON e.id = te1.entity_id
    JOIN thoughts t1 ON t1.id = te1.thought_id
      AND t1.archived_at IS NULL AND t1.brain_id = p_brain_id
    JOIN thoughts t2 ON t2.id = te2.thought_id
      AND t2.archived_at IS NULL AND t2.brain_id = p_brain_id
    GROUP BY LEAST(te1.thought_id, te2.thought_id),
             GREATEST(te1.thought_id, te2.thought_id)
  )
  INSERT INTO thought_connections
    (source_thought_id, target_thought_id, similarity, link_type, metadata, brain_id)
  SELECT
    ps.source_id,
    ps.target_id,
    ps.similarity,
    'entity-bridge',
    jsonb_build_object('shared_entities', ps.shared_entities, 'alpha', 1.0),
    p_brain_id
  FROM pair_scores ps
  ON CONFLICT (source_thought_id, target_thought_id) DO UPDATE
    SET similarity = EXCLUDED.similarity,
        metadata = EXCLUDED.metadata
    WHERE thought_connections.link_type = 'entity-bridge';
  GET DIAGNOSTICS upserted_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted', deleted_count,
    'upserted', upserted_count
  );
END;
$$;
