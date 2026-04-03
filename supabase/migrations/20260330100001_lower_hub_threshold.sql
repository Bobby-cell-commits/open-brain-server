-- Lower analysis_rich_thoughts threshold from 0.75 to 0.70 to match
-- the updated LINK_THRESHOLD in auto-link.ts.

CREATE OR REPLACE FUNCTION analysis_rich_thoughts(min_conn integer DEFAULT 5)
RETURNS TABLE(id uuid, source text, strong_matches bigint, preview text)
LANGUAGE sql STABLE
SET statement_timeout = '30s'
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
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> t.embedding) >= 0.70
    ORDER BY embedding <=> t.embedding ASC
    LIMIT 20
  ) m
  WHERE t.embedding IS NOT NULL
  GROUP BY t.id, t.source, t.content
  HAVING count(*) >= min_conn
  ORDER BY count(*) DESC
  LIMIT 20;
$$;
