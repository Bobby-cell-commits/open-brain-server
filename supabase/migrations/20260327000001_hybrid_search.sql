-- Hybrid search: tsvector column + GIN index + hybrid_search_thoughts RPC
-- Adds full-text keyword search alongside existing vector search.
-- Results blended via Reciprocal Rank Fusion (RRF) × salience.

SET search_path = 'public';

-- 1. Add tsvector generated column (auto-populates for all existing rows)
ALTER TABLE thoughts
ADD COLUMN fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

-- 2. GIN index for fast full-text queries
CREATE INDEX idx_thoughts_fts ON thoughts USING GIN (fts);

-- 3. Hybrid search RPC: vector + keyword via RRF
CREATE OR REPLACE FUNCTION hybrid_search_thoughts(
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
  merge_count integer
)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  WITH semantic AS (
    SELECT
      id,
      1 - (embedding <=> query_embedding) AS similarity,
      ROW_NUMBER() OVER (ORDER BY embedding <=> query_embedding) AS rank_ix
    FROM thoughts
    WHERE embedding <=> query_embedding < 1 - match_threshold
    ORDER BY embedding <=> query_embedding
    LIMIT least(match_count * 2, 200)
  ),
  keyword AS (
    SELECT
      id,
      ts_rank(fts, websearch_to_tsquery('english', query_text)) AS fts_rank,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank(fts, websearch_to_tsquery('english', query_text)) DESC
      ) AS rank_ix
    FROM thoughts
    WHERE fts @@ websearch_to_tsquery('english', query_text)
    ORDER BY ts_rank(fts, websearch_to_tsquery('english', query_text)) DESC
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
