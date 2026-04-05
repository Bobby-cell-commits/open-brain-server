-- Source-aware quality gating: intentional captures (telegram, mcp) bypass min_quality filter.
-- Quality gate exists to filter automated pipeline noise, not deliberate human captures.

-- ============================================================================
-- hybrid_search_thoughts — add source bypass to quality gate in semantic + keyword CTEs
-- ============================================================================

CREATE OR REPLACE FUNCTION hybrid_search_thoughts(
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
