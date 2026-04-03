-- Backfill connections v2: use match_thoughts in a loop (HNSW index friendly).
-- The LATERAL join approach didn't use the HNSW index, causing 0 results.

CREATE OR REPLACE FUNCTION backfill_connections_batch(p_limit int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  remaining_count bigint;
  thought_rec RECORD;
  match_rec RECORD;
  batch_count int := 0;
  conn_count int := 0;
  batch_ids uuid[];
BEGIN
  -- Count remaining unlinked thoughts
  SELECT count(*) INTO remaining_count
  FROM thoughts t
  WHERE t.embedding IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM thought_connections tc WHERE tc.source_thought_id = t.id
    );

  IF p_limit = 0 OR remaining_count = 0 THEN
    RETURN jsonb_build_object('thoughts_processed', 0, 'connections_inserted', 0, 'remaining', remaining_count);
  END IF;

  -- Collect batch IDs first (so we can mark them as processed even if 0 connections found)
  SELECT array_agg(sub.id) INTO batch_ids
  FROM (
    SELECT t.id
    FROM thoughts t
    WHERE t.embedding IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM thought_connections tc WHERE tc.source_thought_id = t.id
      )
    ORDER BY t.created_at DESC
    LIMIT p_limit
  ) sub;

  -- Process each thought: call match_thoughts (uses HNSW index) then insert connections
  FOR thought_rec IN
    SELECT t.id, t.embedding
    FROM thoughts t
    WHERE t.id = ANY(batch_ids)
  LOOP
    batch_count := batch_count + 1;

    -- Find top 4 matches (one might be self), using match_thoughts which leverages HNSW
    FOR match_rec IN
      SELECT m.id, m.similarity
      FROM match_thoughts(thought_rec.embedding, 0.75, 4) m
      WHERE m.id != thought_rec.id
      LIMIT 3
    LOOP
      INSERT INTO thought_connections (id, source_thought_id, target_thought_id, similarity, link_type, metadata)
      VALUES (gen_random_uuid(), thought_rec.id, match_rec.id, match_rec.similarity, 'related', '{}'::jsonb)
      ON CONFLICT (source_thought_id, target_thought_id) DO NOTHING;

      conn_count := conn_count + 1;
    END LOOP;

  END LOOP;

  -- Recount remaining
  SELECT count(*) INTO remaining_count
  FROM thoughts t
  WHERE t.embedding IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM thought_connections tc WHERE tc.source_thought_id = t.id
    );

  RETURN jsonb_build_object(
    'thoughts_processed', batch_count,
    'connections_inserted', conn_count,
    'remaining', remaining_count
  );
END;
$$;
