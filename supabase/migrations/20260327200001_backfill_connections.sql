-- Backfill connections for thoughts that have no outgoing connections.
-- Uses stored embeddings (no re-embedding). Inserts as link_type 'related'.
-- Call in batches via REST API until remaining = 0.
-- Drop after backfill is complete.

DROP FUNCTION IF EXISTS backfill_connections_batch(int);

CREATE OR REPLACE FUNCTION backfill_connections_batch(p_limit int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  batch_ids uuid[];
  connections_inserted bigint;
  remaining_count bigint;
BEGIN
  -- Get batch of thoughts with no outgoing connections
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

  -- Count remaining before early-exit check (so dry-run with p_limit=0 reports correctly)
  SELECT count(*) INTO remaining_count
  FROM thoughts t
  WHERE t.embedding IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM thought_connections tc WHERE tc.source_thought_id = t.id
    );

  IF batch_ids IS NULL THEN
    RETURN jsonb_build_object('thoughts_processed', 0, 'connections_inserted', 0, 'remaining', remaining_count);
  END IF;

  -- Insert top-3 connections per thought using HNSW index
  WITH inserted AS (
    INSERT INTO thought_connections (id, source_thought_id, target_thought_id, similarity, link_type, metadata)
    SELECT
      gen_random_uuid(),
      t.id,
      s.id,
      1 - (s.embedding <=> t.embedding),
      'related',
      '{}'::jsonb
    FROM thoughts t
    CROSS JOIN LATERAL (
      SELECT s2.id, s2.embedding
      FROM thoughts s2
      WHERE s2.id != t.id
        AND s2.embedding IS NOT NULL
        AND 1 - (s2.embedding <=> t.embedding) >= 0.75
      ORDER BY s2.embedding <=> t.embedding
      LIMIT 3
    ) s
    WHERE t.id = ANY(batch_ids)
    ON CONFLICT (source_thought_id, target_thought_id) DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO connections_inserted FROM inserted;

  -- Count remaining unlinked thoughts
  SELECT count(*) INTO remaining_count
  FROM thoughts t
  WHERE t.embedding IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM thought_connections tc WHERE tc.source_thought_id = t.id
    );

  RETURN jsonb_build_object(
    'thoughts_processed', array_length(batch_ids, 1),
    'connections_inserted', connections_inserted,
    'remaining', remaining_count
  );
END;
$$;
