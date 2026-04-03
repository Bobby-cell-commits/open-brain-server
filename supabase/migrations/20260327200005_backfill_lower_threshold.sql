-- Lower backfill threshold from 0.75 to 0.70 — diagnostic showed best matches
-- for unlinked thoughts are in the 0.70-0.75 range.

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
  SELECT count(*) INTO remaining_count
  FROM thoughts t
  WHERE t.embedding IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM thought_connections tc WHERE tc.source_thought_id = t.id
    );

  IF p_limit = 0 OR remaining_count = 0 THEN
    RETURN jsonb_build_object('thoughts_processed', 0, 'connections_inserted', 0, 'remaining', remaining_count);
  END IF;

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

  FOR thought_rec IN
    SELECT t.id, t.embedding
    FROM thoughts t
    WHERE t.id = ANY(batch_ids)
  LOOP
    batch_count := batch_count + 1;

    FOR match_rec IN
      SELECT m.id, m.similarity
      FROM match_thoughts(thought_rec.embedding, 0.70, 4) m
      WHERE m.id != thought_rec.id
      LIMIT 3
    LOOP
      INSERT INTO thought_connections (id, source_thought_id, target_thought_id, similarity, link_type, metadata)
      VALUES (gen_random_uuid(), thought_rec.id, match_rec.id, match_rec.similarity, 'related', '{}'::jsonb)
      ON CONFLICT (source_thought_id, target_thought_id) DO NOTHING;
      conn_count := conn_count + 1;
    END LOOP;
  END LOOP;

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
