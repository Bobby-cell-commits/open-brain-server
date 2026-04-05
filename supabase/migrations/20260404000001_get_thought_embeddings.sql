-- Returns raw embedding vectors for a batch of thought IDs.
-- Used by the /discover skill's adaptive track clustering to compute
-- centroids and cosine similarities.

CREATE OR REPLACE FUNCTION get_thought_embeddings(
  p_brain_id UUID,
  p_thought_ids UUID[]
)
RETURNS TABLE(id UUID, embedding vector(1536))
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.embedding
  FROM thoughts t
  WHERE t.brain_id = p_brain_id
    AND t.id = ANY(p_thought_ids);
END;
$$;
