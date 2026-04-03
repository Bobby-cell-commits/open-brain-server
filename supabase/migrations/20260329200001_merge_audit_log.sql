-- Merge audit log: track every irreversible merge operation for debugging and rollback.
-- Records what was merged, into what, similarity, merge type, and lost content.

SET search_path = 'public';

-- 1. Audit log table
CREATE TABLE merge_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survivor_id uuid REFERENCES thoughts(id) ON DELETE SET NULL,
  loser_id uuid,
  similarity float NOT NULL,
  merge_type text NOT NULL,
  loser_content text NOT NULL,
  loser_source text NOT NULL,
  loser_source_event_id text,
  llm_reason text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_merge_audit_created ON merge_audit_log(created_at DESC);
CREATE INDEX idx_merge_audit_survivor ON merge_audit_log(survivor_id);

-- RLS: service role only (matches thoughts table pattern)
ALTER TABLE merge_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role has full access" ON merge_audit_log FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 2. Log a merge operation
CREATE OR REPLACE FUNCTION log_merge(
  p_survivor_id uuid,
  p_loser_id uuid,
  p_similarity float,
  p_merge_type text,
  p_loser_content text,
  p_loser_source text,
  p_loser_source_event_id text DEFAULT NULL,
  p_llm_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = 'public'
AS $$
  INSERT INTO merge_audit_log (
    survivor_id, loser_id, similarity, merge_type,
    loser_content, loser_source, loser_source_event_id, llm_reason
  )
  VALUES (
    p_survivor_id, p_loser_id, p_similarity, p_merge_type,
    p_loser_content, p_loser_source, p_loser_source_event_id, p_llm_reason
  );
$$;

-- 3. Query merge history with filters
CREATE OR REPLACE FUNCTION get_merge_history(
  p_days int DEFAULT 7,
  p_merge_type text DEFAULT NULL,
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  survivor_id uuid,
  survivor_content_preview text,
  loser_id uuid,
  loser_content_preview text,
  loser_source text,
  similarity float,
  merge_type text,
  llm_reason text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  SELECT
    m.id,
    m.survivor_id,
    LEFT(t.content, 200) AS survivor_content_preview,
    m.loser_id,
    LEFT(m.loser_content, 200) AS loser_content_preview,
    m.loser_source,
    m.similarity,
    m.merge_type,
    m.llm_reason,
    m.created_at
  FROM merge_audit_log m
  LEFT JOIN thoughts t ON t.id = m.survivor_id
  WHERE m.created_at >= now() - make_interval(days => p_days)
    AND (p_merge_type IS NULL OR m.merge_type = p_merge_type)
  ORDER BY m.created_at DESC
  LIMIT LEAST(p_limit, 100);
$$;
