-- Database review cleanup: expression indexes, orphan drops, search_path hardening.

--------------------------------------------------------------------
-- 1. Expression indexes on hot metadata paths
--------------------------------------------------------------------

-- Quality gating: every hybrid_search_thoughts / graph_expanded_search call
-- filters on (metadata->>'quality')::float. Without this, it's a seq scan.
CREATE INDEX IF NOT EXISTS idx_thoughts_quality
  ON thoughts ((COALESCE((metadata->>'quality')::float, 1.0)));

-- Theme aggregation: thought_stats groups by metadata->>'theme'.
CREATE INDEX IF NOT EXISTS idx_thoughts_theme
  ON thoughts ((metadata->>'theme'));

--------------------------------------------------------------------
-- 2. Drop orphaned functions
--------------------------------------------------------------------

-- Never called from any Edge Function.
DROP FUNCTION IF EXISTS get_thought_entities(uuid);

-- Superseded by find_dedup_candidates; no callers.
DROP FUNCTION IF EXISTS get_recent_thoughts_with_embeddings(integer);

-- Never wired to MCP tools.
DROP FUNCTION IF EXISTS analysis_similarity_histogram();

-- Never wired to MCP tools.
DROP FUNCTION IF EXISTS analysis_per_source_similarity();

-- One-time backfill job, completed. Recreated only for schema-cache nudge.
DROP FUNCTION IF EXISTS backfill_connections_batch(int);

--------------------------------------------------------------------
-- 3. Harden match_thoughts with explicit search_path
--------------------------------------------------------------------

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
    1 - (thoughts.embedding <=> query_embedding) AS similarity
  FROM thoughts
  WHERE thoughts.embedding <=> query_embedding < 1 - match_threshold
  ORDER BY thoughts.embedding <=> query_embedding ASC
  LIMIT LEAST(match_count, 200);
$$;
