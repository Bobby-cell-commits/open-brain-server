-- Fix analysis_rich_thoughts() to include thought ID in return columns.
-- Required for MCP analysis_hubs tool: discover skill needs IDs to traverse
-- connections via get_connections tool.

SET search_path = 'public';

-- Must DROP first — PostgreSQL cannot change return type with CREATE OR REPLACE
DROP FUNCTION IF EXISTS analysis_rich_thoughts();

CREATE FUNCTION analysis_rich_thoughts()
RETURNS TABLE(id uuid, source text, strong_matches bigint, preview text)
LANGUAGE sql STABLE
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
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> t.embedding) >= 0.75
    ORDER BY embedding <=> t.embedding ASC
    LIMIT 20
  ) m
  WHERE t.embedding IS NOT NULL
  GROUP BY t.id, t.source, t.content
  HAVING count(*) >= 5
  ORDER BY count(*) DESC
  LIMIT 20;
$$;
