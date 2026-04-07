-- Dream Phase C: Insight Synthesis
-- 1. find_synthesis_candidates RPC — connected components via recursive CTE
-- 2. Phase A dedup exclusion — prevent merging source='dream' thoughts

SET search_path = 'public';

-- ============================================================================
-- 1. find_synthesis_candidates
-- ============================================================================
-- Walks thought_connections at a similarity threshold, extracts connected
-- components, filters by size, excludes already-synthesized clusters,
-- ranks by size DESC then recency DESC.

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
AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE eligible_thoughts AS (
    -- All active, non-dream thoughts with embeddings
    SELECT t.id, t.created_at, t.metadata->>'theme' AS theme
    FROM thoughts t
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
      AND t.source != 'dream'
      AND t.embedding IS NOT NULL
  ),
  eligible_edges AS (
    -- Bidirectional edges above threshold between eligible thoughts
    SELECT tc.source_thought_id AS node_a, tc.target_thought_id AS node_b
    FROM thought_connections tc
    JOIN eligible_thoughts ea ON ea.id = tc.source_thought_id
    JOIN eligible_thoughts eb ON eb.id = tc.target_thought_id
    WHERE tc.similarity >= p_similarity_threshold
  ),
  -- Recursive CTE: walk connected components
  -- Each thought starts as its own component (identified by its own ID).
  -- We propagate the minimum ID through edges to label components.
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
  -- Each node may have been reached from multiple seeds; keep the minimum comp
  node_components AS (
    SELECT node, MIN(comp::text)::uuid AS comp
    FROM walked
    GROUP BY node
  ),
  -- Aggregate into components
  components AS (
    SELECT
      nc.comp AS comp_id,
      array_agg(nc.node ORDER BY nc.node) AS members,
      count(*)::int AS sz,
      max(et.created_at) AS newest,
      -- Dominant theme: mode, ties broken alphabetically
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
  -- Exclude clusters that already have a synthesis pointing to any member
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

-- ============================================================================
-- 2. Phase A dedup exclusion — exclude source='dream' from dedup scanning
-- ============================================================================
-- Recreate find_dedup_candidates with an added WHERE clause.
-- This prevents synthesis thoughts from being merged by Phase A.

CREATE OR REPLACE FUNCTION find_dedup_candidates(
  p_brain_id uuid,
  days_back integer DEFAULT 7,
  similarity_threshold float DEFAULT 0.92,
  max_candidates_per_thought integer DEFAULT 5
)
RETURNS TABLE(
  thought_a_id uuid,
  thought_a_content text,
  thought_a_source text,
  thought_a_source_event_id text,
  thought_a_merge_count integer,
  thought_a_created_at timestamptz,
  thought_b_id uuid,
  thought_b_content text,
  thought_b_source text,
  thought_b_source_event_id text,
  thought_b_merge_count integer,
  thought_b_created_at timestamptz,
  pair_similarity float
)
LANGUAGE plpgsql
VOLATILE
SET search_path = 'public'
AS $$
DECLARE
  recent record;
  match record;
  seen_pairs text[] := '{}';
  pair_key text;
BEGIN
  FOR recent IN
    SELECT t.id, t.content, t.embedding, t.source, t.source_event_id,
           t.merge_count, t.created_at
    FROM thoughts t
    WHERE t.brain_id = p_brain_id
      AND t.created_at > now() - make_interval(days => days_back)
      AND t.embedding IS NOT NULL
      AND t.archived_at IS NULL
      AND t.source != 'dream'  -- Phase C exclusion: don't dedup synthesis thoughts
    ORDER BY t.created_at DESC
  LOOP
    FOR match IN
      SELECT t.id, t.content, t.source, t.source_event_id,
             t.merge_count, t.created_at,
             1 - (t.embedding <=> recent.embedding) AS sim
      FROM thoughts t
      WHERE t.brain_id = p_brain_id
        AND t.id != recent.id
        AND t.embedding IS NOT NULL
        AND t.archived_at IS NULL
        AND t.source != 'dream'  -- Phase C exclusion: don't dedup synthesis thoughts
        AND 1 - (t.embedding <=> recent.embedding) >= similarity_threshold
      ORDER BY t.embedding <=> recent.embedding ASC
      LIMIT max_candidates_per_thought
    LOOP
      -- Normalize pair key to deduplicate symmetric pairs
      IF recent.id::text < match.id::text THEN
        pair_key := recent.id::text || '|' || match.id::text;
      ELSE
        pair_key := match.id::text || '|' || recent.id::text;
      END IF;

      IF NOT pair_key = ANY(seen_pairs) THEN
        seen_pairs := array_append(seen_pairs, pair_key);

        thought_a_id := recent.id;
        thought_a_content := recent.content;
        thought_a_source := recent.source;
        thought_a_source_event_id := recent.source_event_id;
        thought_a_merge_count := recent.merge_count;
        thought_a_created_at := recent.created_at;

        thought_b_id := match.id;
        thought_b_content := match.content;
        thought_b_source := match.source;
        thought_b_source_event_id := match.source_event_id;
        thought_b_merge_count := match.merge_count;
        thought_b_created_at := match.created_at;
        pair_similarity := match.sim;

        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
