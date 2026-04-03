-- Migration: Add brain_id parameter to all RPC functions for multi-tenant isolation.
-- Every function gets p_brain_id uuid as the FIRST parameter and filters all queries
-- by brain_id = p_brain_id. Old signatures are dropped first to avoid overloads.

SET search_path = 'public';

-- ============================================================================
-- 1. match_thoughts
-- ============================================================================

DROP FUNCTION IF EXISTS match_thoughts(vector, float, int);

CREATE OR REPLACE FUNCTION match_thoughts(
  p_brain_id uuid,
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  content text,
  embedding vector(1536),
  metadata jsonb,
  source text,
  source_event_id text,
  created_at timestamptz,
  updated_at timestamptz,
  similarity float
)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  SELECT
    thoughts.id,
    thoughts.content,
    thoughts.embedding,
    thoughts.metadata,
    thoughts.source,
    thoughts.source_event_id,
    thoughts.created_at,
    thoughts.updated_at,
    1 - (thoughts.embedding <=> query_embedding) AS similarity
  FROM thoughts
  WHERE thoughts.brain_id = p_brain_id
    AND thoughts.embedding <=> query_embedding < 1 - match_threshold
  ORDER BY thoughts.embedding <=> query_embedding ASC
  LIMIT LEAST(match_count, 200);
$$;

-- ============================================================================
-- 2. hybrid_search_thoughts
-- ============================================================================

DROP FUNCTION IF EXISTS hybrid_search_thoughts(text, vector, int, float, int, float);

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
  ),
  query_terms AS (
    SELECT lexeme
    FROM unnest(to_tsvector('english', query_text)) AS t(lexeme, positions, weights)
  ),
  term_doc_freqs AS (
    SELECT COALESCE(jsonb_object_agg(s.word, s.ndoc), '{}'::jsonb) AS freqs
    FROM ts_stat(format('SELECT fts FROM thoughts WHERE brain_id = %L', p_brain_id)) s
    WHERE s.word IN (SELECT lexeme FROM query_terms)
  ),
  semantic AS (
    SELECT
      id,
      1 - (embedding <=> query_embedding) AS similarity,
      ROW_NUMBER() OVER (ORDER BY embedding <=> query_embedding) AS rank_ix
    FROM thoughts
    WHERE brain_id = p_brain_id
      AND embedding <=> query_embedding < 1 - match_threshold
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
    WHERE th.brain_id = p_brain_id
      AND th.fts @@ websearch_to_tsquery('english', query_text)
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

-- ============================================================================
-- 3. graph_expanded_search
-- ============================================================================

DROP FUNCTION IF EXISTS graph_expanded_search(text, vector, int, float, int, float);

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
      p_brain_id,
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
    WHERE t.brain_id = p_brain_id
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

-- ============================================================================
-- 4. get_thought_connections
-- ============================================================================

DROP FUNCTION IF EXISTS get_thought_connections(uuid);

CREATE OR REPLACE FUNCTION get_thought_connections(
  p_brain_id uuid,
  p_thought_id uuid
)
RETURNS TABLE(
  connected_thought_id uuid,
  content text,
  similarity float,
  link_type text,
  connection_metadata jsonb,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  SELECT * FROM (
    SELECT DISTINCT ON (peer_id) peer_id, t.content, tc.similarity, tc.link_type, tc.metadata, tc.created_at
    FROM thought_connections tc
    CROSS JOIN LATERAL (
      SELECT CASE WHEN tc.source_thought_id = p_thought_id
                  THEN tc.target_thought_id
                  ELSE tc.source_thought_id END AS peer_id
    ) peers
    JOIN thoughts t ON t.id = peer_id
    WHERE (tc.source_thought_id = p_thought_id OR tc.target_thought_id = p_thought_id)
      AND tc.brain_id = p_brain_id
      AND t.brain_id = p_brain_id
    ORDER BY peer_id, tc.similarity DESC
  ) deduped
  ORDER BY similarity DESC;
$$;

-- ============================================================================
-- 5. perform_merge
-- ============================================================================

DROP FUNCTION IF EXISTS perform_merge(uuid, jsonb);

CREATE OR REPLACE FUNCTION perform_merge(
  p_brain_id uuid,
  p_id uuid,
  p_merge_entry jsonb
)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = 'public'
AS $$
  UPDATE thoughts
  SET merge_count = merge_count + 1,
      metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{merged_from}',
        COALESCE(metadata->'merged_from', '[]'::jsonb) || p_merge_entry
      )
  WHERE id = p_id
    AND brain_id = p_brain_id;
$$;

-- ============================================================================
-- 6. log_merge
-- ============================================================================

DROP FUNCTION IF EXISTS log_merge(uuid, uuid, float, text, text, text, text, text);

CREATE OR REPLACE FUNCTION log_merge(
  p_brain_id uuid,
  p_survivor_id uuid,
  p_loser_id uuid,
  p_similarity float,
  p_merge_type text,
  p_loser_content text,
  p_loser_source text,
  p_loser_source_event_id text DEFAULT NULL,
  p_llm_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = 'public'
AS $$
  INSERT INTO merge_audit_log (
    brain_id, survivor_id, loser_id, similarity, merge_type,
    loser_content, loser_source, loser_source_event_id, llm_reason
  )
  VALUES (
    p_brain_id, p_survivor_id, p_loser_id, p_similarity, p_merge_type,
    p_loser_content, p_loser_source, p_loser_source_event_id, p_llm_reason
  );
$$;

-- ============================================================================
-- 7. get_merge_history
-- ============================================================================

DROP FUNCTION IF EXISTS get_merge_history(int, text, int);

CREATE OR REPLACE FUNCTION get_merge_history(
  p_brain_id uuid,
  p_days int DEFAULT 7,
  p_merge_type text DEFAULT NULL,
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  survivor_id uuid,
  survivor_content_preview text,
  loser_id uuid,
  loser_content_preview text,
  loser_source text,
  similarity float,
  merge_type text,
  llm_reason text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  SELECT
    m.id,
    m.survivor_id,
    LEFT(t.content, 200) AS survivor_content_preview,
    m.loser_id,
    LEFT(m.loser_content, 200) AS loser_content_preview,
    m.loser_source,
    m.similarity,
    m.merge_type,
    m.llm_reason,
    m.created_at
  FROM merge_audit_log m
  LEFT JOIN thoughts t ON t.id = m.survivor_id
  WHERE m.brain_id = p_brain_id
    AND m.created_at >= now() - make_interval(days => p_days)
    AND (p_merge_type IS NULL OR m.merge_type = p_merge_type)
  ORDER BY m.created_at DESC
  LIMIT LEAST(p_limit, 100);
$$;

-- ============================================================================
-- 8. resolve_entities
-- ============================================================================

DROP FUNCTION IF EXISTS resolve_entities(jsonb, uuid);

CREATE OR REPLACE FUNCTION resolve_entities(
  p_brain_id uuid,
  p_entities jsonb,
  p_thought_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = 'public'
AS $$
DECLARE
  ent jsonb;
  ent_name text;
  ent_type text;
  ent_role text;
  resolved_id uuid;
BEGIN
  FOR ent IN SELECT * FROM jsonb_array_elements(p_entities)
  LOOP
    ent_name := ent->>'name';
    ent_type := ent->>'type';
    ent_role := COALESCE(ent->>'role', 'mention');

    IF ent_name IS NULL OR ent_type IS NULL THEN
      CONTINUE;
    END IF;

    -- Normalize: trim + collapse whitespace
    ent_name := regexp_replace(trim(ent_name), '\s+', ' ', 'g');

    -- Try exact match first (scoped to brain)
    SELECT id INTO resolved_id
    FROM entities
    WHERE brain_id = p_brain_id AND name = ent_name AND entity_type = ent_type;

    -- If no exact match, check aliases (case-insensitive, scoped to brain)
    IF resolved_id IS NULL THEN
      SELECT id INTO resolved_id
      FROM entities
      WHERE brain_id = p_brain_id
        AND entity_type = ent_type
        AND EXISTS (
          SELECT 1 FROM unnest(aliases) AS a
          WHERE lower(a) = lower(ent_name)
        );
    END IF;

    -- If still no match, create new entity
    IF resolved_id IS NULL THEN
      INSERT INTO entities (brain_id, name, entity_type)
      VALUES (p_brain_id, ent_name, ent_type)
      ON CONFLICT (brain_id, name, entity_type) DO NOTHING
      RETURNING id INTO resolved_id;

      -- Handle race condition: if DO NOTHING fired, fetch the existing id
      IF resolved_id IS NULL THEN
        SELECT id INTO resolved_id
        FROM entities
        WHERE brain_id = p_brain_id AND name = ent_name AND entity_type = ent_type;
      END IF;
    ELSE
      -- Matched existing entity — add raw name as alias if different from canonical
      UPDATE entities
      SET aliases = array_append(aliases, ent_name),
          updated_at = now()
      WHERE id = resolved_id
        AND name != ent_name
        AND NOT (ent_name = ANY(aliases));
    END IF;

    -- Link thought to entity (ignore duplicates)
    INSERT INTO thought_entities (brain_id, thought_id, entity_id, mention_type)
    VALUES (p_brain_id, p_thought_id, resolved_id, ent_role)
    ON CONFLICT (thought_id, entity_id, mention_type) DO NOTHING;
  END LOOP;
END;
$$;

-- ============================================================================
-- 9. find_dedup_candidates
-- ============================================================================

DROP FUNCTION IF EXISTS find_dedup_candidates(integer, float, integer);

CREATE OR REPLACE FUNCTION find_dedup_candidates(
  p_brain_id uuid,
  days_back integer DEFAULT 7,
  similarity_threshold float DEFAULT 0.92,
  max_candidates_per_thought integer DEFAULT 5
)
RETURNS TABLE(
  thought_a_id uuid,
  thought_a_content text,
  thought_a_source text,
  thought_a_source_event_id text,
  thought_a_merge_count integer,
  thought_a_created_at timestamptz,
  thought_b_id uuid,
  thought_b_content text,
  thought_b_source text,
  thought_b_source_event_id text,
  thought_b_merge_count integer,
  thought_b_created_at timestamptz,
  pair_similarity float
)
LANGUAGE plpgsql
VOLATILE
SET search_path = 'public'
AS $$
DECLARE
  recent record;
  match record;
  seen_pairs text[] := '{}';
  pair_key text;
BEGIN
  FOR recent IN
    SELECT t.id, t.content, t.embedding, t.source, t.source_event_id,
           t.merge_count, t.created_at
    FROM thoughts t
    WHERE t.brain_id = p_brain_id
      AND t.created_at > now() - make_interval(days => days_back)
      AND t.embedding IS NOT NULL
    ORDER BY t.created_at DESC
  LOOP
    FOR match IN
      SELECT t.id, t.content, t.source, t.source_event_id,
             t.merge_count, t.created_at,
             1 - (t.embedding <=> recent.embedding) AS sim
      FROM thoughts t
      WHERE t.brain_id = p_brain_id
        AND t.id != recent.id
        AND t.embedding IS NOT NULL
        AND 1 - (t.embedding <=> recent.embedding) >= similarity_threshold
      ORDER BY t.embedding <=> recent.embedding ASC
      LIMIT max_candidates_per_thought
    LOOP
      -- Normalize pair key to deduplicate symmetric pairs
      IF recent.id::text < match.id::text THEN
        pair_key := recent.id::text || '|' || match.id::text;
      ELSE
        pair_key := match.id::text || '|' || recent.id::text;
      END IF;

      IF NOT pair_key = ANY(seen_pairs) THEN
        seen_pairs := array_append(seen_pairs, pair_key);

        thought_a_id := recent.id;
        thought_a_content := recent.content;
        thought_a_source := recent.source;
        thought_a_source_event_id := recent.source_event_id;
        thought_a_merge_count := recent.merge_count;
        thought_a_created_at := recent.created_at;
        thought_b_id := match.id;
        thought_b_content := match.content;
        thought_b_source := match.source;
        thought_b_source_event_id := match.source_event_id;
        thought_b_merge_count := match.merge_count;
        thought_b_created_at := match.created_at;
        pair_similarity := match.sim;

        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- ============================================================================
-- 10. compute_salience_for_thought
-- ============================================================================

DROP FUNCTION IF EXISTS compute_salience_for_thought(uuid);

CREATE OR REPLACE FUNCTION compute_salience_for_thought(
  p_brain_id uuid,
  p_thought_id uuid
)
RETURNS float
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  result float;
BEGIN
  WITH connection_counts AS (
    SELECT count(*) as cnt
    FROM (
      SELECT source_thought_id as thought_id FROM thought_connections WHERE source_thought_id = p_thought_id
      UNION ALL
      SELECT target_thought_id as thought_id FROM thought_connections WHERE target_thought_id = p_thought_id
    ) edges
  )
  UPDATE thoughts t
  SET salience = (
    CASE WHEN t.pinned THEN 1.0
         ELSE exp(-extract(epoch FROM now() - t.created_at) / 86400.0 / 20.2)
    END
    * (1 + ln(t.access_count + 1))
    * (1 + 0.1 * coalesce(cc.cnt, 0))
    * (1 + 0.2 * t.merge_count)
    * CASE t.source
        WHEN 'telegram' THEN 1.5
        WHEN 'slack' THEN 1.2
        WHEN 'mcp' THEN 1.2
        ELSE 0.9
      END
  )
  FROM connection_counts cc
  WHERE t.id = p_thought_id
    AND t.brain_id = p_brain_id
  RETURNING t.salience INTO result;

  RETURN result;
END;
$$;

-- ============================================================================
-- 11. refresh_salience (called refresh_salience_scores in task, actual name is refresh_salience)
-- ============================================================================

DROP FUNCTION IF EXISTS refresh_salience();

CREATE OR REPLACE FUNCTION refresh_salience(
  p_brain_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH connection_counts AS (
    SELECT thought_id, count(*) as cnt
    FROM (
      SELECT source_thought_id as thought_id FROM thought_connections
        WHERE source_thought_id IN (SELECT id FROM thoughts WHERE brain_id = p_brain_id)
      UNION ALL
      SELECT target_thought_id as thought_id FROM thought_connections
        WHERE target_thought_id IN (SELECT id FROM thoughts WHERE brain_id = p_brain_id)
    ) edges
    GROUP BY thought_id
  )
  UPDATE thoughts t
  SET salience = (
    CASE WHEN t.pinned THEN 1.0
         ELSE exp(-extract(epoch FROM now() - t.created_at) / 86400.0 / 20.2)
    END
    * (1 + ln(t.access_count + 1))
    * (1 + 0.1 * coalesce(cc.cnt, 0))
    * (1 + 0.2 * t.merge_count)
    * CASE t.source
        WHEN 'telegram' THEN 1.5
        WHEN 'slack' THEN 1.2
        WHEN 'mcp' THEN 1.2
        ELSE 0.9
      END
  )
  FROM (SELECT id FROM thoughts WHERE brain_id = p_brain_id) sub
  LEFT JOIN connection_counts cc ON cc.thought_id = sub.id
  WHERE t.id = sub.id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- ============================================================================
-- 12. analysis_rich_thoughts
-- ============================================================================

DROP FUNCTION IF EXISTS analysis_rich_thoughts(integer);

CREATE OR REPLACE FUNCTION analysis_rich_thoughts(
  p_brain_id uuid,
  min_conn integer DEFAULT 5
)
RETURNS TABLE(id uuid, source text, strong_matches bigint, preview text)
LANGUAGE sql
STABLE
SET statement_timeout = '60s'
SET search_path = 'public'
AS $$
  SELECT
    t.id,
    t.source,
    count(*) AS strong_matches,
    left(t.content, 80) AS preview
  FROM thoughts t
  CROSS JOIN LATERAL (
    SELECT embedding
    FROM thoughts
    WHERE id != t.id
      AND brain_id = p_brain_id
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> t.embedding) >= 0.70
    ORDER BY embedding <=> t.embedding ASC
    LIMIT 20
  ) m
  WHERE t.brain_id = p_brain_id
    AND t.embedding IS NOT NULL
  GROUP BY t.id, t.source, t.content
  HAVING count(*) >= min_conn
  ORDER BY count(*) DESC
  LIMIT 20;
$$;

-- ============================================================================
-- 13. analysis_connection_density
-- ============================================================================

DROP FUNCTION IF EXISTS analysis_connection_density();

CREATE OR REPLACE FUNCTION analysis_connection_density(
  p_brain_id uuid
)
RETURNS TABLE(threshold text, thoughts bigint, avg_links numeric, median_links int, zero_links bigint, ten_plus_links bigint, max_links bigint)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  WITH neighbor_counts AS (
    SELECT
      t.id,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.70) AS links_at_70,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.75) AS links_at_75,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.80) AS links_at_80,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.85) AS links_at_85
    FROM thoughts t
    CROSS JOIN LATERAL (
      SELECT embedding
      FROM thoughts
      WHERE id != t.id
        AND brain_id = p_brain_id
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.70
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 20
    ) m
    WHERE t.brain_id = p_brain_id
      AND t.embedding IS NOT NULL
    GROUP BY t.id
  )
  SELECT '0.70', count(*), round(avg(links_at_70), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_70)::int,
    count(*) FILTER (WHERE links_at_70 = 0),
    count(*) FILTER (WHERE links_at_70 >= 10),
    max(links_at_70)
  FROM neighbor_counts
  UNION ALL
  SELECT '0.75', count(*), round(avg(links_at_75), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_75)::int,
    count(*) FILTER (WHERE links_at_75 = 0),
    count(*) FILTER (WHERE links_at_75 >= 10),
    max(links_at_75)
  FROM neighbor_counts
  UNION ALL
  SELECT '0.80', count(*), round(avg(links_at_80), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_80)::int,
    count(*) FILTER (WHERE links_at_80 = 0),
    count(*) FILTER (WHERE links_at_80 >= 10),
    max(links_at_80)
  FROM neighbor_counts
  UNION ALL
  SELECT '0.85', count(*), round(avg(links_at_85), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_85)::int,
    count(*) FILTER (WHERE links_at_85 = 0),
    count(*) FILTER (WHERE links_at_85 >= 10),
    max(links_at_85)
  FROM neighbor_counts
  ORDER BY 1;
$$;

-- ============================================================================
-- 14. analysis_source_pairs
-- ============================================================================

DROP FUNCTION IF EXISTS analysis_source_pairs();

CREATE OR REPLACE FUNCTION analysis_source_pairs(
  p_brain_id uuid
)
RETURNS TABLE(source_1 text, source_2 text, pairs bigint, avg_sim numeric, max_sim numeric)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  WITH high_pairs AS (
    SELECT
      least(t.source, m.source) AS source_1,
      greatest(t.source, m.source) AS source_2,
      1 - (t.embedding <=> m.embedding) AS similarity
    FROM thoughts t
    CROSS JOIN LATERAL (
      SELECT id, source, embedding
      FROM thoughts
      WHERE id != t.id
        AND brain_id = p_brain_id
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.85
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 5
    ) m
    WHERE t.brain_id = p_brain_id
      AND t.embedding IS NOT NULL
      AND t.id < m.id
  )
  SELECT
    source_1,
    source_2,
    count(*) AS pairs,
    round(avg(similarity)::numeric, 4) AS avg_sim,
    round(max(similarity)::numeric, 4) AS max_sim
  FROM high_pairs
  GROUP BY source_1, source_2
  ORDER BY pairs DESC;
$$;

-- ============================================================================
-- 15. serendipity_digest
-- ============================================================================

DROP FUNCTION IF EXISTS serendipity_digest();

CREATE OR REPLACE FUNCTION serendipity_digest(
  p_brain_id uuid
)
RETURNS TABLE (
  slot text,
  id uuid,
  content text,
  source text,
  theme text,
  quality float,
  created_at timestamptz,
  reason text
)
LANGUAGE sql
STABLE
SET statement_timeout = '30s'
SET search_path = 'public'
AS $$
  -- Slot 1: Random high-quality old thought
  (
    SELECT
      'rediscovery' AS slot,
      t.id,
      left(t.content, 300) AS content,
      t.source,
      t.metadata->>'theme' AS theme,
      (t.metadata->>'quality')::float AS quality,
      t.created_at,
      'High-quality thought from ' || to_char(t.created_at, 'Mon DD') AS reason
    FROM thoughts t
    WHERE t.brain_id = p_brain_id
      AND t.created_at < now() - interval '14 days'
      AND (t.metadata->>'quality')::float >= 0.7
      AND t.embedding IS NOT NULL
    ORDER BY random()
    LIMIT 1
  )

  UNION ALL

  -- Slot 2: Orphan thought (no connections)
  (
    SELECT
      'orphan' AS slot,
      t.id,
      left(t.content, 300) AS content,
      t.source,
      t.metadata->>'theme' AS theme,
      (t.metadata->>'quality')::float AS quality,
      t.created_at,
      'No connections — might link to something new' AS reason
    FROM thoughts t
    WHERE t.brain_id = p_brain_id
      AND t.embedding IS NOT NULL
      AND (t.metadata->>'quality')::float >= 0.5
      AND NOT EXISTS (
        SELECT 1 FROM thought_connections tc
        WHERE tc.source_thought_id = t.id OR tc.target_thought_id = t.id
      )
    ORDER BY random()
    LIMIT 1
  )

  UNION ALL

  -- Slot 3: Underrepresented theme
  (
    SELECT
      'underrepresented' AS slot,
      t.id,
      left(t.content, 300) AS content,
      t.source,
      t.metadata->>'theme' AS theme,
      (t.metadata->>'quality')::float AS quality,
      t.created_at,
      'From underrepresented theme: ' || (t.metadata->>'theme') AS reason
    FROM thoughts t
    WHERE t.brain_id = p_brain_id
      AND t.metadata->>'theme' = (
        SELECT metadata->>'theme'
        FROM thoughts
        WHERE brain_id = p_brain_id
          AND metadata->>'theme' IS NOT NULL
        GROUP BY metadata->>'theme'
        ORDER BY count(*) ASC
        LIMIT 1
      )
      AND (t.metadata->>'quality')::float >= 0.5
    ORDER BY random()
    LIMIT 1
  )

  UNION ALL

  -- Slot 4: Related to recent captures (most similar to a random recent thought)
  (
    SELECT
      'echo' AS slot,
      older.id,
      left(older.content, 300) AS content,
      older.source,
      older.metadata->>'theme' AS theme,
      (older.metadata->>'quality')::float AS quality,
      older.created_at,
      'Echoes a recent capture' AS reason
    FROM thoughts recent
    CROSS JOIN LATERAL (
      SELECT t.*
      FROM thoughts t
      WHERE t.brain_id = p_brain_id
        AND t.id != recent.id
        AND t.created_at < now() - interval '7 days'
        AND t.embedding IS NOT NULL
        AND 1 - (t.embedding <=> recent.embedding) >= 0.70
      ORDER BY t.embedding <=> recent.embedding ASC
      LIMIT 1
    ) older
    WHERE recent.brain_id = p_brain_id
      AND recent.created_at > now() - interval '3 days'
      AND recent.embedding IS NOT NULL
    ORDER BY random()
    LIMIT 1
  );
$$;

-- ============================================================================
-- 16. increment_access_count
-- ============================================================================

DROP FUNCTION IF EXISTS increment_access_count(uuid[]);

CREATE OR REPLACE FUNCTION increment_access_count(
  p_brain_id uuid,
  thought_ids uuid[]
)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = 'public'
AS $$
  UPDATE thoughts
  SET access_count = access_count + 1,
      last_accessed_at = now()
  WHERE id = ANY(thought_ids)
    AND brain_id = p_brain_id;
$$;

-- ============================================================================
-- Done. All 16 RPC functions now require p_brain_id as their first parameter
-- and scope every query to the specified brain.
-- ============================================================================
