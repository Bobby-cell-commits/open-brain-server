-- Fix: DROP both overloaded versions of analysis_rich_thoughts and recreate
-- as a single function with the min_conn parameter.
--
-- Bug: migration 20260330100001 used CREATE OR REPLACE with a different
-- signature (added min_conn param), which created a second overloaded
-- function instead of replacing the original no-arg version. PostgREST
-- can't disambiguate when calling with no arguments → RPC error.

DROP FUNCTION IF EXISTS analysis_rich_thoughts();
DROP FUNCTION IF EXISTS analysis_rich_thoughts(integer);

CREATE FUNCTION analysis_rich_thoughts(min_conn integer DEFAULT 5)
RETURNS TABLE(id uuid, source text, strong_matches bigint, preview text)
LANGUAGE sql STABLE
SET statement_timeout = '60s'
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
