-- Wrap deduped connections in a subquery so final output sorts by similarity DESC.

CREATE OR REPLACE FUNCTION get_thought_connections(p_thought_id uuid)
RETURNS TABLE(
  connected_thought_id uuid,
  content text,
  similarity float,
  link_type text,
  created_at timestamptz
) AS $$
  SELECT * FROM (
    SELECT DISTINCT ON (peer_id) peer_id, t.content, tc.similarity, tc.link_type, tc.created_at
    FROM thought_connections tc
    CROSS JOIN LATERAL (
      SELECT CASE WHEN tc.source_thought_id = p_thought_id
                  THEN tc.target_thought_id
                  ELSE tc.source_thought_id END AS peer_id
    ) peers
    JOIN thoughts t ON t.id = peer_id
    WHERE tc.source_thought_id = p_thought_id
       OR tc.target_thought_id = p_thought_id
    ORDER BY peer_id, tc.similarity DESC
  ) deduped
  ORDER BY similarity DESC;
$$ LANGUAGE sql STABLE;
