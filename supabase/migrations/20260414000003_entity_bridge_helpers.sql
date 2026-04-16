-- Helper RPCs for ingest-time entity bridge creation.
-- Called by storeEntityBridges() in auto-link.ts after entity extraction.
SET search_path = 'public';

-- Returns entity IDs and df counts for a given thought's entities
CREATE OR REPLACE FUNCTION get_thought_entity_ids(
  p_brain_id uuid,
  p_thought_id uuid
)
RETURNS TABLE(entity_id uuid, entity_name text, df bigint)
LANGUAGE sql STABLE
SET search_path = 'public'
AS $$
  SELECT
    te.entity_id,
    e.name AS entity_name,
    ef.df
  FROM thought_entities te
  JOIN entities e ON e.id = te.entity_id
  JOIN (
    SELECT te2.entity_id, COUNT(DISTINCT te2.thought_id) AS df
    FROM thought_entities te2
    JOIN thoughts t ON t.id = te2.thought_id
      AND t.archived_at IS NULL AND t.brain_id = p_brain_id
    GROUP BY te2.entity_id
  ) ef ON ef.entity_id = te.entity_id
  WHERE te.thought_id = p_thought_id
    AND ef.df >= 2;
$$;

-- Returns all thoughts that share entities with the given thought, along with
-- the shared entity names and pre-computed raw Newman score.
CREATE OR REPLACE FUNCTION find_entity_overlaps(
  p_brain_id uuid,
  p_thought_id uuid
)
RETURNS TABLE(thought_id uuid, shared_entities text[], raw_score double precision)
LANGUAGE sql STABLE
SET search_path = 'public'
AS $$
  WITH thought_ents AS (
    SELECT te.entity_id
    FROM thought_entities te
    JOIN thoughts t ON t.id = te.thought_id
      AND t.archived_at IS NULL AND t.brain_id = p_brain_id
    WHERE te.thought_id = p_thought_id
  ),
  entity_freq AS (
    SELECT te.entity_id, COUNT(DISTINCT te.thought_id) AS df
    FROM thought_entities te
    JOIN thoughts t ON t.id = te.thought_id
      AND t.archived_at IS NULL AND t.brain_id = p_brain_id
    WHERE te.entity_id IN (SELECT entity_id FROM thought_ents)
    GROUP BY te.entity_id
    HAVING COUNT(DISTINCT te.thought_id) >= 2
  )
  SELECT
    te2.thought_id,
    array_agg(DISTINCT e.name ORDER BY e.name) AS shared_entities,
    SUM(1.0 / (ef.df - 1)) AS raw_score
  FROM thought_ents te1
  JOIN entity_freq ef ON ef.entity_id = te1.entity_id
  JOIN thought_entities te2 ON te2.entity_id = te1.entity_id
    AND te2.thought_id != p_thought_id
  JOIN thoughts t2 ON t2.id = te2.thought_id
    AND t2.archived_at IS NULL AND t2.brain_id = p_brain_id
  JOIN entities e ON e.id = te1.entity_id
  GROUP BY te2.thought_id;
$$;
