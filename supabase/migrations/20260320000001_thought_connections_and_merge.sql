-- Migration: thought connections + merge tracking for Wave 1 intelligence layer
-- Creates thought_connections table for auto-linking and adds merge_count for semantic dedup.

-- New table: bidirectional thought connections
CREATE TABLE thought_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_thought_id uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  target_thought_id uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  similarity float NOT NULL,
  link_type text NOT NULL DEFAULT 'semantic_similarity',
  created_at timestamptz DEFAULT now(),
  UNIQUE(source_thought_id, target_thought_id)
);

CREATE INDEX idx_connections_source ON thought_connections(source_thought_id);
CREATE INDEX idx_connections_target ON thought_connections(target_thought_id);

-- RLS: match security posture of thoughts table
ALTER TABLE thought_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role has full access" ON thought_connections FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Merge count on thoughts (for semantic dedup convergence tracking)
ALTER TABLE thoughts ADD COLUMN merge_count integer NOT NULL DEFAULT 0;

-- RPC: atomic merge — increments merge_count and appends to metadata.merged_from in one UPDATE
CREATE OR REPLACE FUNCTION perform_merge(p_id uuid, p_merge_entry jsonb)
RETURNS void AS $$
  UPDATE thoughts
  SET merge_count = merge_count + 1,
      metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{merged_from}',
        COALESCE(metadata->'merged_from', '[]'::jsonb) || p_merge_entry
      )
  WHERE id = p_id;
$$ LANGUAGE sql VOLATILE;

-- RPC: get connections for a thought (bidirectional lookup)
CREATE OR REPLACE FUNCTION get_thought_connections(p_thought_id uuid)
RETURNS TABLE(
  connected_thought_id uuid,
  content text,
  similarity float,
  link_type text,
  created_at timestamptz
) AS $$
  SELECT
    CASE WHEN tc.source_thought_id = p_thought_id
         THEN tc.target_thought_id
         ELSE tc.source_thought_id END,
    t.content,
    tc.similarity,
    tc.link_type,
    tc.created_at
  FROM thought_connections tc
  JOIN thoughts t ON t.id = CASE
    WHEN tc.source_thought_id = p_thought_id THEN tc.target_thought_id
    ELSE tc.source_thought_id END
  WHERE tc.source_thought_id = p_thought_id
     OR tc.target_thought_id = p_thought_id
  ORDER BY tc.similarity DESC;
$$ LANGUAGE sql STABLE;
