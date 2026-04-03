-- Remove dead `filter` param from match_thoughts.
-- The parameter was never used in the function body and no callers pass it.

-- Drop old signature (4 params including filter)
DROP FUNCTION IF EXISTS match_thoughts(vector, float, int, jsonb);

-- Recreate without filter param
CREATE OR REPLACE FUNCTION match_thoughts(
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
  WHERE thoughts.embedding <=> query_embedding < 1 - match_threshold
  ORDER BY thoughts.embedding <=> query_embedding ASC
  LIMIT LEAST(match_count, 200);
$$;
