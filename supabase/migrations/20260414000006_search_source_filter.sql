-- Add optional source filter to hybrid_search_thoughts and graph_expanded_search.
-- Enables MCP clients to scope retrieval by origin (e.g., "search only my captures").
-- Phase 1 of episodic/semantic memory split — uses existing source column, no new abstractions.

-- ============================================================================
-- hybrid_search_thoughts — add p_source filter (NULL = all sources)
-- ============================================================================

CREATE OR REPLACE FUNCTION hybrid_search_thoughts(
  p_brain_id uuid,
  query_text text,
  query_embedding vector(1536),
  match_count int DEFAULT 10,
  match_threshold float DEFAULT 0.7,
  rrf_k int DEFAULT 60,
  min_quality float DEFAULT 0.4,
  p_source text DEFAULT NULL
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
  merge_count integer
)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  WITH corpus_stats AS (
    SELECT
      count(*)::int AS total_docs,
      COALESCE(NULLIF(avg(length(content)), 0), 1.0)::float AS avg_doc_len
    FROM thoughts
    WHERE brain_id = p_brain_id
      AND archived_at IS NULL
  ),
  query_terms AS (
    SELECT lexeme
    FROM unnest(to_tsvector('english', query_text)) AS t(lexeme, positions, weights)
  ),
  term_doc_freqs AS (
    SELECT COALESCE(jsonb_object_agg(s.word, s.ndoc), '{}'::jsonb) AS freqs
    FROM ts_stat(format('SELECT fts FROM thoughts WHERE brain_id = %L AND archived_at IS NULL', p_brain_id)) s
    WHERE s.word IN (SELECT lexeme FROM query_terms)
  ),
  semantic AS (
    SELECT
      id,
      1 - (embedding <=> query_embedding) AS similarity,
      ROW_NUMBER() OVER (ORDER BY embedding <=> query_embedding) AS rank_ix
    FROM thoughts
    WHERE brain_id = p_brain_id
      AND archived_at IS NULL
      AND embedding <=> query_embedding < 1 - match_threshold
      AND (source IN ('telegram', 'mcp') OR COALESCE((metadata->>'quality')::float, 1.0) >= min_quality)
      AND (p_source IS NULL OR source = p_source)
    ORDER BY embedding <=> query_embedding
    LIMIT least(match_count * 2, 200)
  ),
  keyword_scored AS (
    SELECT
      th.id,
      bm25_score(
        th.fts,
        length(th.content),
        (SELECT avg_doc_len FROM corpus_stats),
        (SELECT total_docs FROM corpus_stats),
        (SELECT freqs FROM term_doc_freqs)
      ) AS fts_rank
    FROM thoughts th
    WHERE th.brain_id = p_brain_id
      AND th.archived_at IS NULL
      AND th.fts @@ websearch_to_tsquery('english', query_text)
      AND (th.source IN ('telegram', 'mcp') OR COALESCE((th.metadata->>'quality')::float, 1.0) >= min_quality)
      AND (p_source IS NULL OR th.source = p_source)
  ),
  keyword AS (
    SELECT
      ks.id,
      ks.fts_rank,
      ROW_NUMBER() OVER (ORDER BY ks.fts_rank DESC) AS rank_ix
    FROM keyword_scored ks
    ORDER BY ks.fts_rank DESC
    LIMIT least(match_count * 2, 200)
  )
  SELECT
    t.id,
    t.content,
    t.metadata,
    t.source,
    t.source_event_id,
    t.created_at,
    t.updated_at,
    COALESCE(s.similarity, 0.0)::float AS similarity,
    COALESCE(k.fts_rank, 0.0)::real AS fts_rank,
    (
      COALESCE(1.0 / (rrf_k + s.rank_ix), 0.0)
      + COALESCE(1.0 / (rrf_k + k.rank_ix), 0.0)
    )::float AS rrf_score,
    (
      (
        COALESCE(1.0 / (rrf_k + s.rank_ix), 0.0)
        + COALESCE(1.0 / (rrf_k + k.rank_ix), 0.0)
      )
      * COALESCE(t.salience, 1.0)
    )::float AS blended_score,
    t.salience,
    t.pinned,
    t.merge_count
  FROM (
    SELECT id FROM semantic
    UNION
    SELECT id FROM keyword
  ) combined
  JOIN thoughts t ON t.id = combined.id
  LEFT JOIN semantic s ON s.id = combined.id
  LEFT JOIN keyword k ON k.id = combined.id
  ORDER BY blended_score DESC
  LIMIT least(match_count, 200);
$$;


-- ============================================================================
-- graph_expanded_search — pass p_source through to hybrid_search_thoughts
-- ============================================================================

CREATE OR REPLACE FUNCTION graph_expanded_search(
  p_brain_id uuid,
  query_text text,
  query_embedding vector(1536),
  match_count int DEFAULT 10,
  match_threshold float DEFAULT 0.7,
  rrf_k int DEFAULT 60,
  min_quality float DEFAULT 0.4,
  p_source text DEFAULT NULL
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
      min_quality,
      p_source
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
