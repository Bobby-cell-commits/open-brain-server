-- find_dedup_candidates: Server-side pair-finding for dream dedup.
-- Replaces N individual match_thoughts calls with one RPC call.
-- Uses the existing pgvector index for efficient similarity search.

CREATE OR REPLACE FUNCTION find_dedup_candidates(
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
    WHERE t.created_at > now() - make_interval(days => days_back)
      AND t.embedding IS NOT NULL
    ORDER BY t.created_at DESC
  LOOP
    FOR match IN
      SELECT t.id, t.content, t.source, t.source_event_id,
             t.merge_count, t.created_at,
             1 - (t.embedding <=> recent.embedding) AS sim
      FROM thoughts t
      WHERE t.id != recent.id
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
