-- Temporary analysis functions for auto-link threshold tuning.
-- Deploy with: supabase db push --linked
-- Remove after analysis with: 009_drop_analysis_functions.sql

-- 1. Baseline: thought counts per source
CREATE OR REPLACE FUNCTION analysis_baseline()
RETURNS TABLE(source text, total bigint, with_embedding bigint)
LANGUAGE sql STABLE
AS $$
  SELECT
    source,
    count(*) AS total,
    count(*) FILTER (WHERE embedding IS NOT NULL) AS with_embedding
  FROM thoughts
  GROUP BY source
  ORDER BY total DESC;
$$;

-- 2. Similarity histogram: top-10 neighbors per thought, bucketed
CREATE OR REPLACE FUNCTION analysis_similarity_histogram()
RETURNS TABLE(range_low numeric, range_high numeric, pair_count bigint)
LANGUAGE sql STABLE
AS $$
  WITH neighbors AS (
    SELECT 1 - (t.embedding <=> m.embedding) AS similarity
    FROM thoughts t
    CROSS JOIN LATERAL (
      SELECT embedding
      FROM thoughts
      WHERE id != t.id AND embedding IS NOT NULL
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 10
    ) m
    WHERE t.embedding IS NOT NULL
  )
  SELECT
    round(0.5 + (width_bucket(similarity, 0.5, 1.0, 20) - 1) * 0.025, 3) AS range_low,
    round(0.5 + width_bucket(similarity, 0.5, 1.0, 20) * 0.025, 3) AS range_high,
    count(*) AS pair_count
  FROM neighbors
  GROUP BY width_bucket(similarity, 0.5, 1.0, 20)
  ORDER BY 1;
$$;

-- 3. Per-source top-1 similarity stats
CREATE OR REPLACE FUNCTION analysis_per_source_similarity()
RETURNS TABLE(source text, thoughts bigint, avg_top1_sim numeric, median_top1_sim numeric, min_top1_sim numeric, max_top1_sim numeric)
LANGUAGE sql STABLE
AS $$
  WITH top1 AS (
    SELECT
      t.id,
      t.source,
      max(1 - (t.embedding <=> m.embedding)) AS best_similarity
    FROM thoughts t
    CROSS JOIN LATERAL (
      SELECT embedding
      FROM thoughts
      WHERE id != t.id AND embedding IS NOT NULL
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 1
    ) m
    WHERE t.embedding IS NOT NULL
    GROUP BY t.id, t.source
  )
  SELECT
    source,
    count(*) AS thoughts,
    round(avg(best_similarity)::numeric, 4) AS avg_top1_sim,
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY best_similarity)::numeric, 4) AS median_top1_sim,
    round(min(best_similarity)::numeric, 4) AS min_top1_sim,
    round(max(best_similarity)::numeric, 4) AS max_top1_sim
  FROM top1
  GROUP BY source
  ORDER BY avg_top1_sim DESC;
$$;

-- 4. Dedup candidates: pairs >= 0.85 with previews
CREATE OR REPLACE FUNCTION analysis_dedup_candidates()
RETURNS TABLE(similarity numeric, source_a text, source_b text, preview_a text, preview_b text)
LANGUAGE sql STABLE
AS $$
  SELECT
    round((1 - (t.embedding <=> m.embedding))::numeric, 4) AS similarity,
    t.source AS source_a,
    m.source AS source_b,
    left(t.content, 80) AS preview_a,
    left(m.content, 80) AS preview_b
  FROM thoughts t
  CROSS JOIN LATERAL (
    SELECT id, source, content, embedding
    FROM thoughts
    WHERE id != t.id
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> t.embedding) >= 0.85
    ORDER BY embedding <=> t.embedding ASC
    LIMIT 5
  ) m
  WHERE t.embedding IS NOT NULL
    AND t.id < m.id
  ORDER BY 1 DESC
  LIMIT 50;
$$;

-- 5. Dedup zone breakdown: pair counts per high-similarity band
CREATE OR REPLACE FUNCTION analysis_dedup_zones()
RETURNS TABLE(band text, pair_count bigint)
LANGUAGE sql STABLE
AS $$
  WITH high_pairs AS (
    SELECT
      t.id AS id_a,
      m.id AS id_b,
      1 - (t.embedding <=> m.embedding) AS similarity
    FROM thoughts t
    CROSS JOIN LATERAL (
      SELECT id, embedding
      FROM thoughts
      WHERE id != t.id
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.85
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 5
    ) m
    WHERE t.embedding IS NOT NULL
      AND t.id < m.id
  )
  SELECT
    CASE
      WHEN similarity >= 0.95 THEN '0.95-1.00 (near-identical)'
      WHEN similarity >= 0.92 THEN '0.92-0.95 (current dedup threshold)'
      WHEN similarity >= 0.88 THEN '0.88-0.92 (borderline)'
      WHEN similarity >= 0.85 THEN '0.85-0.88 (near-miss zone)'
    END AS band,
    count(*) AS pair_count
  FROM high_pairs
  GROUP BY band
  ORDER BY band DESC;
$$;

-- 6. Connection density at various thresholds
CREATE OR REPLACE FUNCTION analysis_connection_density()
RETURNS TABLE(threshold text, thoughts bigint, avg_links numeric, median_links int, zero_links bigint, ten_plus_links bigint, max_links bigint)
LANGUAGE sql STABLE
AS $$
  WITH neighbor_counts AS (
    SELECT
      t.id,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.70) AS links_at_70,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.75) AS links_at_75,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.80) AS links_at_80,
      count(*) FILTER (WHERE 1 - (t.embedding <=> m.embedding) >= 0.85) AS links_at_85
    FROM thoughts t
    CROSS JOIN LATERAL (
      SELECT embedding
      FROM thoughts
      WHERE id != t.id
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.70
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 20
    ) m
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

-- 7. Rich thoughts: those with 5+ matches at 0.75
CREATE OR REPLACE FUNCTION analysis_rich_thoughts()
RETURNS TABLE(source text, strong_matches bigint, preview text)
LANGUAGE sql STABLE
AS $$
  SELECT
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

-- 8. Source-pair analysis: which source combos produce high similarity
CREATE OR REPLACE FUNCTION analysis_source_pairs()
RETURNS TABLE(source_1 text, source_2 text, pairs bigint, avg_sim numeric, max_sim numeric)
LANGUAGE sql STABLE
AS $$
  WITH high_pairs AS (
    SELECT
      least(t.source, m.source) AS source_1,
      greatest(t.source, m.source) AS source_2,
      1 - (t.embedding <=> m.embedding) AS similarity
    FROM thoughts t
    CROSS JOIN LATERAL (
      SELECT id, source, embedding
      FROM thoughts
      WHERE id != t.id
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.85
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 5
    ) m
    WHERE t.embedding IS NOT NULL
      AND t.id < m.id
  )
  SELECT
    source_1,
    source_2,
    count(*) AS pairs,
    round(avg(similarity)::numeric, 4) AS avg_sim,
    round(max(similarity)::numeric, 4) AS max_sim
  FROM high_pairs
  GROUP BY source_1, source_2
  ORDER BY pairs DESC;
$$;
