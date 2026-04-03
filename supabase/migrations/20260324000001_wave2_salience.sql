-- Migration: Wave 2 — Salience + Reinforcement
-- Adds usage tracking columns, salience scoring, and updated match_thoughts.

-- 1. Schema additions
ALTER TABLE thoughts ADD COLUMN access_count integer NOT NULL DEFAULT 0;
ALTER TABLE thoughts ADD COLUMN last_accessed_at timestamptz;
ALTER TABLE thoughts ADD COLUMN salience float;
ALTER TABLE thoughts ADD COLUMN pinned boolean NOT NULL DEFAULT false;

CREATE INDEX idx_thoughts_salience ON thoughts(salience DESC NULLS LAST);

-- 2. Usage tracking RPC
CREATE OR REPLACE FUNCTION increment_access_count(thought_ids uuid[])
RETURNS void
LANGUAGE sql
AS $$
  UPDATE thoughts
  SET access_count = access_count + 1,
      last_accessed_at = now()
  WHERE id = ANY(thought_ids);
$$;

-- 3. Salience refresh RPC
CREATE OR REPLACE FUNCTION refresh_salience()
RETURNS integer
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH connection_counts AS (
    SELECT thought_id, count(*) as cnt
    FROM (
      SELECT source_thought_id as thought_id FROM thought_connections
      UNION ALL
      SELECT target_thought_id as thought_id FROM thought_connections
    ) edges
    GROUP BY thought_id
  )
  UPDATE thoughts t
  SET salience = (
    CASE WHEN t.pinned THEN 1.0
         ELSE exp(-extract(epoch FROM now() - t.created_at) / 86400.0 / 20.2)
    END
    * (1 + ln(t.access_count + 1))
    * (1 + 0.1 * coalesce(cc.cnt, 0))
    * (1 + 0.2 * t.merge_count)
    * CASE WHEN t.source IN ('slack', 'mcp') THEN 1.2 ELSE 0.9 END
  )
  FROM (SELECT id FROM thoughts) sub
  LEFT JOIN connection_counts cc ON cc.thought_id = sub.id
  WHERE t.id = sub.id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- 4. Updated match_thoughts — adds salience, pinned, merge_count to return + search_path fix
DROP FUNCTION IF EXISTS match_thoughts;

CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding vector(1536),
  match_threshold float default 0.7,
  match_count int default 10,
  filter jsonb default '{}'::jsonb
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
  similarity float,
  salience float,
  pinned boolean,
  merge_count integer
)
LANGUAGE sql
STABLE
SET search_path = 'public'
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
    1 - (thoughts.embedding <=> query_embedding) as similarity,
    thoughts.salience,
    thoughts.pinned,
    thoughts.merge_count
  FROM thoughts
  WHERE thoughts.embedding <=> query_embedding < 1 - match_threshold
  ORDER BY thoughts.embedding <=> query_embedding ASC
  LIMIT least(match_count, 200);
$$;
