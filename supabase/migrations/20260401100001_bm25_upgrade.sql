-- BM25 scoring upgrade: replace ts_rank with proper BM25 in hybrid search.
-- Adds bm25_score() function, updates hybrid_search_thoughts, refactors graph_expanded_search.

SET search_path = 'public';

-- ============================================================
-- 1. Standalone BM25 scoring function
-- ============================================================
-- Computes BM25(k1=1.2, b=0.75) for a single document against pre-computed term stats.
-- Corpus stats and term document frequencies are passed in — the calling query computes
-- them once in CTEs, NOT per-row.
--
-- Parameters:
--   doc_fts        - document's tsvector column
--   doc_len        - character length of document content
--   avg_doc_len    - average content length across corpus (from CTE)
--   total_docs     - total number of documents in corpus (from CTE)
--   term_doc_freqs - JSONB map of {lexeme: document_frequency} (from CTE via ts_stat)
--
-- Returns: float BM25 score (higher = more relevant)

CREATE OR REPLACE FUNCTION bm25_score(
  doc_fts tsvector,
  doc_len int,
  avg_doc_len float,
  total_docs int,
  term_doc_freqs jsonb
)
RETURNS float
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  k1 CONSTANT float := 1.2;
  b  CONSTANT float := 0.75;
  score float := 0.0;
  term text;
  df_text text;
  df int;
  tf int;
  idf float;
  term_score float;
BEGIN
  FOR term, df_text IN SELECT key, value FROM jsonb_each_text(term_doc_freqs)
  LOOP
    df := df_text::int;

    -- Term frequency: count positions of this lexeme in the document's tsvector
    tf := COALESCE(
      (SELECT array_length(positions, 1)
       FROM unnest(doc_fts) AS u(lexeme, positions, weights)
       WHERE u.lexeme = term),
      0
    );

    -- Skip terms not present in this document
    IF tf = 0 THEN CONTINUE; END IF;

    -- IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    idf := ln((total_docs - df + 0.5) / (df + 0.5) + 1.0);

    -- BM25 per-term score
    term_score := idf * (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * (doc_len::float / avg_doc_len)));

    score := score + term_score;
  END LOOP;

  RETURN score;
END;
$$;

-- ============================================================
-- 2. Update hybrid_search_thoughts to use BM25 scoring
-- ============================================================
-- Replaces ts_rank() with bm25_score() in the keyword CTE.
-- Three new CTEs compute corpus stats and term doc frequencies ONCE per query.
-- Signature and return type unchanged — fts_rank now contains BM25 score.

CREATE OR REPLACE FUNCTION hybrid_search_thoughts(
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
  ),
  query_terms AS (
    SELECT lexeme
    FROM unnest(to_tsvector('english', query_text)) AS t(lexeme, positions, weights)
  ),
  term_doc_freqs AS (
    SELECT COALESCE(jsonb_object_agg(s.word, s.ndoc), '{}'::jsonb) AS freqs
    FROM ts_stat('SELECT fts FROM thoughts') s
    WHERE s.word IN (SELECT lexeme FROM query_terms)
  ),
  semantic AS (
    SELECT
      id,
      1 - (embedding <=> query_embedding) AS similarity,
      ROW_NUMBER() OVER (ORDER BY embedding <=> query_embedding) AS rank_ix
    FROM thoughts
    WHERE embedding <=> query_embedding < 1 - match_threshold
      AND COALESCE((metadata->>'quality')::float, 1.0) >= min_quality
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
    WHERE th.fts @@ websearch_to_tsquery('english', query_text)
      AND COALESCE((th.metadata->>'quality')::float, 1.0) >= min_quality
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

-- ============================================================
-- 3. Refactor graph_expanded_search to call hybrid_search_thoughts
-- ============================================================
-- Removes duplicated semantic + keyword CTEs. Calls hybrid_search_thoughts
-- for direct results, then adds 1-hop graph expansion on top.
-- Signature and return type unchanged.

CREATE OR REPLACE FUNCTION graph_expanded_search(
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
  -- Step 1: Get direct results from hybrid search (request 2x for graph expansion headroom)
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
      query_text,
      query_embedding,
      match_count * 2,
      match_threshold,
      rrf_k,
      min_quality
    ) h
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
  best_neighbors AS (
    SELECT DISTINCT ON (ne.neighbor_id)
      ne.neighbor_id,
      ne.conn_sim,
      ne.parent_score
    FROM neighbor_edges ne
    WHERE ne.neighbor_id NOT IN (SELECT d.id FROM direct d)
    ORDER BY ne.neighbor_id, ne.conn_sim DESC
  ),
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
