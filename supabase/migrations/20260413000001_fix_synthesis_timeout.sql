-- Fix find_synthesis_candidates timeout: the recursive CTE walks all connected
-- components (~7.4s at 3,900 thoughts) and races against the authenticator
-- role's 8s statement_timeout when called via PostgREST from Edge Functions.
-- Add function-level timeout override to prevent silent failures.

SET search_path = 'public';

CREATE OR REPLACE FUNCTION find_synthesis_candidates(
  p_brain_id uuid,
  p_min_cluster_size int DEFAULT 3,
  p_max_cluster_size int DEFAULT 12,
  p_similarity_threshold float DEFAULT 0.75,
  p_limit int DEFAULT 10
)
RETURNS TABLE(
  component_id uuid,
  member_ids uuid[],
  cluster_size int,
  newest_thought_at timestamptz,
  dominant_theme text
)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
SET statement_timeout = '30s'
AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE eligible_thoughts AS (
    SELECT t.id, t.created_at, t.metadata->>'theme' AS theme
    FROM thoughts t
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
      AND t.source != 'dream'
      AND t.embedding IS NOT NULL
  ),
  eligible_edges AS (
    SELECT tc.source_thought_id AS node_a, tc.target_thought_id AS node_b
    FROM thought_connections tc
    JOIN eligible_thoughts ea ON ea.id = tc.source_thought_id
    JOIN eligible_thoughts eb ON eb.id = tc.target_thought_id
    WHERE tc.similarity >= p_similarity_threshold
  ),
  seeds AS (
    SELECT id AS node, id AS comp FROM eligible_thoughts
  ),
  walked AS (
    SELECT node, comp FROM seeds
    UNION
    SELECT
      CASE WHEN e.node_a = w.node THEN e.node_b ELSE e.node_a END AS node,
      w.comp
    FROM walked w
    JOIN eligible_edges e ON (e.node_a = w.node OR e.node_b = w.node)
    WHERE CASE WHEN e.node_a = w.node THEN e.node_b ELSE e.node_a END != w.comp
  ),
  node_components AS (
    SELECT node, MIN(comp::text)::uuid AS comp
    FROM walked
    GROUP BY node
  ),
  components AS (
    SELECT
      nc.comp AS comp_id,
      array_agg(nc.node ORDER BY nc.node) AS members,
      count(*)::int AS sz,
      max(et.created_at) AS newest,
      (SELECT theme FROM (
        SELECT et2.theme, count(*) AS cnt
        FROM node_components nc2
        JOIN eligible_thoughts et2 ON et2.id = nc2.node
        WHERE nc2.comp = nc.comp AND et2.theme IS NOT NULL
        GROUP BY et2.theme
        ORDER BY cnt DESC, et2.theme ASC
        LIMIT 1
      ) sub) AS dom_theme
    FROM node_components nc
    JOIN eligible_thoughts et ON et.id = nc.node
    GROUP BY nc.comp
    HAVING count(*) >= p_min_cluster_size
       AND count(*) <= p_max_cluster_size
  ),
  already_synthesized AS (
    SELECT DISTINCT unnest(c.members) AS member_id
    FROM components c
    JOIN thought_connections tc ON tc.target_thought_id = ANY(c.members)
    JOIN thoughts t ON t.id = tc.source_thought_id
    WHERE t.source = 'dream'
      AND t.brain_id = p_brain_id
      AND t.archived_at IS NULL
      AND tc.link_type = 'synthesizes'
  )
  SELECT
    c.comp_id AS component_id,
    c.members AS member_ids,
    c.sz AS cluster_size,
    c.newest AS newest_thought_at,
    c.dom_theme AS dominant_theme
  FROM components c
  WHERE NOT EXISTS (
    SELECT 1 FROM already_synthesized a
    WHERE a.member_id = ANY(c.members)
  )
  ORDER BY c.sz DESC, c.newest DESC
  LIMIT p_limit;
END;
$$;
