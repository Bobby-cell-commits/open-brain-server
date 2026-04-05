-- Fix analysis_connection_density: restore LEFT JOIN LATERAL ... ON TRUE
-- to include orphan thoughts (zero neighbors) in the count.
--
-- The multi-tenant migration (20260402000002) rewrote this function from
-- the original CROSS JOIN LATERAL version, losing the orphan fix from
-- 20260320100002. This restores the correct behavior.

DROP FUNCTION IF EXISTS analysis_connection_density(uuid);

CREATE OR REPLACE FUNCTION analysis_connection_density(
  p_brain_id uuid
)
RETURNS TABLE(threshold text, thoughts bigint, avg_links numeric, median_links int, zero_links bigint, ten_plus_links bigint, max_links bigint)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  WITH neighbor_counts AS (
    SELECT
      t.id,
      coalesce(count(*) FILTER (WHERE m.embedding IS NOT NULL AND 1 - (t.embedding <=> m.embedding) >= 0.70), 0) AS links_at_70,
      coalesce(count(*) FILTER (WHERE m.embedding IS NOT NULL AND 1 - (t.embedding <=> m.embedding) >= 0.75), 0) AS links_at_75,
      coalesce(count(*) FILTER (WHERE m.embedding IS NOT NULL AND 1 - (t.embedding <=> m.embedding) >= 0.80), 0) AS links_at_80,
      coalesce(count(*) FILTER (WHERE m.embedding IS NOT NULL AND 1 - (t.embedding <=> m.embedding) >= 0.85), 0) AS links_at_85
    FROM thoughts t
    LEFT JOIN LATERAL (
      SELECT embedding
      FROM thoughts
      WHERE id != t.id
        AND brain_id = p_brain_id
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.70
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 20
    ) m ON TRUE
    WHERE t.brain_id = p_brain_id
      AND t.embedding IS NOT NULL
    GROUP BY t.id
  )
  SELECT '0.70', count(*), round(avg(links_at_70), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_70)::int,
    count(*) FILTER (WHERE links_at_70 = 0),
    count(*) FILTER (WHERE links_at_70 >= 10),
    max(links_at_70)
  FROM neighbor_counts
  UNION ALL
  SELECT '0.75', count(*), round(avg(links_at_75), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_75)::int,
    count(*) FILTER (WHERE links_at_75 = 0),
    count(*) FILTER (WHERE links_at_75 >= 10),
    max(links_at_75)
  FROM neighbor_counts
  UNION ALL
  SELECT '0.80', count(*), round(avg(links_at_80), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_80)::int,
    count(*) FILTER (WHERE links_at_80 = 0),
    count(*) FILTER (WHERE links_at_80 >= 10),
    max(links_at_80)
  FROM neighbor_counts
  UNION ALL
  SELECT '0.85', count(*), round(avg(links_at_85), 1),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY links_at_85)::int,
    count(*) FILTER (WHERE links_at_85 = 0),
    count(*) FILTER (WHERE links_at_85 >= 10),
    max(links_at_85)
  FROM neighbor_counts
  ORDER BY 1;
$$;
