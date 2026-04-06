-- graph_expanded_search v2: adds co-occurrence expansion pass
-- Spec: docs/superpowers/specs/2026-04-06-co-occurrence-edge-strengthening-design.md

CREATE OR REPLACE FUNCTION graph_expanded_search(
  p_brain_id uuid,
  query_text text,
  query_embedding vector(1536),
  match_count int DEFAULT 10,
  match_threshold float DEFAULT 0.7,
  rrf_k int DEFAULT 60,
  min_quality float DEFAULT 0.4
)
RETURNS TABLE (
  id uuid,
  content text,
  metadata jsonb,
  source text,
  source_event_id text,
  created_at timestamptz,
  updated_at timestamptz,
  similarity float,
  fts_rank real,
  rrf_score float,
  blended_score float,
  salience float,
  pinned boolean,
  merge_count integer,
  graph_expanded boolean
)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
AS $$
BEGIN
  RETURN QUERY
  -- Step 1: Direct results from hybrid search (2x headroom for expansion)
  WITH direct AS (
    SELECT
      h.id,
      h.content,
      h.metadata,
      h.source,
      h.source_event_id,
      h.created_at,
      h.updated_at,
      h.similarity,
      h.fts_rank,
      h.rrf_score,
      h.blended_score,
      h.salience,
      h.pinned,
      h.merge_count,
      false AS graph_expanded
    FROM hybrid_search_thoughts(
      p_brain_id,
      query_text,
      query_embedding,
      match_count * 2,
      match_threshold,
      rrf_k,
      min_quality
    ) h
  ),
  -- Step 2: Static expansion — 1-hop neighbors via thought_connections
  top_direct AS (
    SELECT d.id, d.blended_score FROM direct d ORDER BY d.blended_score DESC LIMIT 5
  ),
  neighbor_edges AS (
    SELECT
      CASE WHEN tc.source_thought_id = td.id THEN tc.target_thought_id
           ELSE tc.source_thought_id END AS neighbor_id,
      tc.similarity AS conn_sim,
      td.blended_score AS parent_score
    FROM top_direct td
    JOIN thought_connections tc
      ON (tc.source_thought_id = td.id OR tc.target_thought_id = td.id)
      AND tc.brain_id = p_brain_id
  ),
  best_neighbors AS (
    SELECT DISTINCT ON (ne.neighbor_id)
      ne.neighbor_id,
      ne.conn_sim,
      ne.parent_score
    FROM neighbor_edges ne
    WHERE ne.neighbor_id NOT IN (SELECT d.id FROM direct d)
    ORDER BY ne.neighbor_id, ne.conn_sim DESC
  ),
  static_expanded AS (
    SELECT
      t.id,
      t.content,
      t.metadata,
      t.source,
      t.source_event_id,
      t.created_at,
      t.updated_at,
      0.0::float AS similarity,
      0.0::real AS fts_rank,
      0.0::float AS rrf_score,
      (bn.parent_score * bn.conn_sim * 0.5)::float AS blended_score,
      t.salience,
      t.pinned,
      t.merge_count,
      true AS graph_expanded
    FROM best_neighbors bn
    JOIN thoughts t ON t.id = bn.neighbor_id
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
  ),
  -- Step 3: Co-occurrence expansion — neighbors via co_occurrence_edges
  co_occurrence_neighbors AS (
    SELECT DISTINCT ON (neighbor_id)
      neighbor_id,
      parent_score,
      co_weight
    FROM (
      SELECT
        CASE WHEN ce.thought_a = td.id THEN ce.thought_b ELSE ce.thought_a END AS neighbor_id,
        td.blended_score AS parent_score,
        ce.weight AS co_weight,
        ROW_NUMBER() OVER (PARTITION BY td.id ORDER BY ce.weight DESC) AS rn
      FROM top_direct td
      JOIN co_occurrence_edges ce
        ON (ce.thought_a = td.id OR ce.thought_b = td.id)
        AND ce.brain_id = p_brain_id
        AND ce.weight >= 0.1
    ) ranked
    WHERE rn <= 3
      AND neighbor_id NOT IN (SELECT d.id FROM direct d)
      AND neighbor_id NOT IN (SELECT se.id FROM static_expanded se)
    ORDER BY neighbor_id, co_weight DESC
  ),
  co_occurrence_expanded AS (
    SELECT
      t.id,
      t.content,
      t.metadata,
      t.source,
      t.source_event_id,
      t.created_at,
      t.updated_at,
      0.0::float AS similarity,
      0.0::real AS fts_rank,
      0.0::float AS rrf_score,
      (cn.parent_score * cn.co_weight * 0.4)::float AS blended_score,
      t.salience,
      t.pinned,
      t.merge_count,
      true AS graph_expanded
    FROM co_occurrence_neighbors cn
    JOIN thoughts t ON t.id = cn.neighbor_id
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
  ),
  -- Step 4: Union all three sources
  all_results AS (
    SELECT * FROM direct
    UNION ALL
    SELECT * FROM static_expanded
    UNION ALL
    SELECT * FROM co_occurrence_expanded
  )
  SELECT * FROM all_results
  ORDER BY blended_score DESC
  LIMIT least(match_count, 200);
END;
$$;
