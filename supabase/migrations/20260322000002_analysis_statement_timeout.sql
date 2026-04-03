-- Bump statement_timeout for heavy analysis functions that do O(n²) similarity scans.
-- Supabase REST API default is ~10s; these need ~30-60s for 1000+ thoughts.
-- Function-level SET clause applies per-call, compatible with STABLE volatility.

CREATE OR REPLACE FUNCTION analysis_connection_density()
RETURNS TABLE(threshold text, thoughts bigint, avg_links numeric, median_links int, zero_links bigint, ten_plus_links bigint, max_links bigint)
LANGUAGE sql STABLE
SET statement_timeout = '60s'
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
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.70
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 20
    ) m ON TRUE
    WHERE t.embedding IS NOT NULL
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

-- analysis_rich_thoughts also needs timeout bump (same O(n²) pattern)
DROP FUNCTION IF EXISTS analysis_rich_thoughts();

CREATE FUNCTION analysis_rich_thoughts()
RETURNS TABLE(id uuid, source text, strong_matches bigint, preview text)
LANGUAGE sql STABLE
SET statement_timeout = '60s'
AS $$
  SELECT
    t.id,
    t.source,
    count(*) AS strong_matches,
    left(t.content, 80) AS preview
  FROM thoughts t
  CROSS JOIN LATERAL (
    SELECT embedding
    FROM thoughts
    WHERE id != t.id
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> t.embedding) >= 0.75
    ORDER BY embedding <=> t.embedding ASC
    LIMIT 20
  ) m
  WHERE t.embedding IS NOT NULL
  GROUP BY t.id, t.source, t.content
  HAVING count(*) >= 5
  ORDER BY count(*) DESC
  LIMIT 20;
$$;
