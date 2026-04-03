-- Dream Cycle Phase A: RPC to fetch recent thoughts for dedup scanning.

SET search_path = 'public';

CREATE OR REPLACE FUNCTION get_recent_thoughts_with_embeddings(days_back integer DEFAULT 7)
RETURNS TABLE (
  id uuid,
  content text,
  embedding vector(1536),
  source text,
  source_event_id text,
  created_at timestamptz,
  merge_count integer
)
LANGUAGE sql STABLE
SET search_path = 'public'
AS $$
  SELECT t.id, t.content, t.embedding, t.source, t.source_event_id,
         t.created_at, t.merge_count
  FROM thoughts t
  WHERE t.created_at >= now() - make_interval(days => days_back)
    AND t.embedding IS NOT NULL
  ORDER BY t.created_at DESC;
$$;
