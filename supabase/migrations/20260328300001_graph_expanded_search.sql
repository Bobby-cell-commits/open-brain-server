-- Graph-expanded search: hybrid search + 1-hop connection graph traversal.
-- Surfaces thoughts that are semantically distant but graph-adjacent to direct matches.
-- Used by search_thoughts MCP tool with expand=true.

SET search_path = 'public';

CREATE OR REPLACE FUNCTION graph_expanded_search(
  query_text text,
  query_embedding vector(1536),
  match_count int DEFAULT 10,
  match_threshold float DEFAULT 0.7,
  rrf_k int DEFAULT 60
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
  -- Step 1: Standard hybrid search (vector + keyword via RRF)
  WITH semantic AS (
    SELECT
      th.id,
      1 - (th.embedding <=> query_embedding) AS sim,
      ROW_NUMBER() OVER (ORDER BY th.embedding <=> query_embedding) AS rank_ix
    FROM thoughts th
    WHERE th.embedding <=> query_embedding < 1 - match_threshold
    ORDER BY th.embedding <=> query_embedding
    LIMIT least(match_count * 2, 200)
  ),
  kw AS (
    SELECT
      th.id,
      ts_rank(th.fts, websearch_to_tsquery('english', query_text)) AS fts_r,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank(th.fts, websearch_to_tsquery('english', query_text)) DESC
      ) AS rank_ix
    FROM thoughts th
    WHERE th.fts @@ websearch_to_tsquery('english', query_text)
    ORDER BY ts_rank(th.fts, websearch_to_tsquery('english', query_text)) DESC
    LIMIT least(match_count * 2, 200)
  ),
  direct AS (
    SELECT
      t.id,
      t.content,
      t.metadata,
      t.source,
      t.source_event_id,
      t.created_at,
      t.updated_at,
      COALESCE(s.sim, 0.0)::float AS similarity,
      COALESCE(k.fts_r, 0.0)::real AS fts_rank,
      (COALESCE(1.0/(rrf_k + s.rank_ix), 0.0) + COALESCE(1.0/(rrf_k + k.rank_ix), 0.0))::float AS rrf_score,
      ((COALESCE(1.0/(rrf_k + s.rank_ix), 0.0) + COALESCE(1.0/(rrf_k + k.rank_ix), 0.0)) * COALESCE(t.salience, 1.0))::float AS blended_score,
      t.salience,
      t.pinned,
      t.merge_count,
      false AS graph_expanded
    FROM (SELECT cs.id FROM semantic cs UNION SELECT ck.id FROM kw ck) combined
    JOIN thoughts t ON t.id = combined.id
    LEFT JOIN semantic s ON s.id = combined.id
    LEFT JOIN kw k ON k.id = combined.id
  ),
  -- Step 2: Graph expansion — 1-hop neighbors of top 5 direct results
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
      ON tc.source_thought_id = td.id OR tc.target_thought_id = td.id
  ),
  -- For each neighbor, keep only the best connection (highest similarity to any parent)
  best_neighbors AS (
    SELECT DISTINCT ON (ne.neighbor_id)
      ne.neighbor_id,
      ne.conn_sim,
      ne.parent_score
    FROM neighbor_edges ne
    WHERE ne.neighbor_id NOT IN (SELECT d.id FROM direct d)
    ORDER BY ne.neighbor_id, ne.conn_sim DESC
  ),
  -- Score graph-expanded results: parent_blended × connection_similarity × 0.5
  -- Ensures graph-expanded results rank below their parent but above weak direct matches
  expanded AS (
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
  ),
  all_results AS (
    SELECT * FROM direct
    UNION ALL
    SELECT * FROM expanded
  )
  SELECT * FROM all_results
  ORDER BY blended_score DESC
  LIMIT least(match_count, 200);
END;
$$;
