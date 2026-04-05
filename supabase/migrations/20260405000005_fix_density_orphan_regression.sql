-- Fix analysis_connection_density: restore LEFT JOIN LATERAL ... ON TRUE
-- to include orphan thoughts (zero neighbors) in density stats.
--
-- The graph_analysis_cache migration (20260405000003) rewrote this function
-- with CROSS JOIN LATERAL, regressing the orphan fix from 20260404000002.
-- Orphan thoughts were silently dropped from results, making zero_links
-- always report 0.

CREATE OR REPLACE FUNCTION analysis_connection_density(
  p_brain_id uuid
)
RETURNS TABLE(threshold text, thoughts bigint, avg_links numeric, median_links int, zero_links bigint, ten_plus_links bigint, max_links bigint)
LANGUAGE sql
STABLE
SET statement_timeout = '300s'
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
        AND archived_at IS NULL
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.70
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 20
    ) m ON TRUE
    WHERE t.brain_id = p_brain_id
      AND t.archived_at IS NULL
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
