-- Diagnostic: test match_thoughts from within plpgsql using a specific thought's embedding

CREATE OR REPLACE FUNCTION diag_backfill_test(p_thought_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  test_id uuid;
  test_embedding vector(1536);
  match_count int;
  sample_match RECORD;
BEGIN
  -- Pick a thought to test (either provided or first unlinked one)
  IF p_thought_id IS NOT NULL THEN
    SELECT t.id, t.embedding INTO test_id, test_embedding
    FROM thoughts t WHERE t.id = p_thought_id;
  ELSE
    SELECT t.id, t.embedding INTO test_id, test_embedding
    FROM thoughts t
    WHERE t.embedding IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM thought_connections tc WHERE tc.source_thought_id = t.id)
    LIMIT 1;
  END IF;

  IF test_id IS NULL THEN
    RETURN jsonb_build_object('error', 'no thought found');
  END IF;

  -- Test: how many matches does match_thoughts return at various thresholds?
  SELECT count(*) INTO match_count
  FROM match_thoughts(test_embedding, 0.5, 10) m
  WHERE m.id != test_id;

  -- Get best match details
  SELECT m.id, m.similarity INTO sample_match
  FROM match_thoughts(test_embedding, 0.5, 10) m
  WHERE m.id != test_id
  ORDER BY m.similarity DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'test_thought_id', test_id,
    'embedding_length', array_length(test_embedding::real[], 1),
    'matches_at_0.5', match_count,
    'best_match_id', sample_match.id,
    'best_match_similarity', sample_match.similarity
  );
END;
$$;
