-- Step 1: Fix the connection density query (CROSS JOIN → LEFT JOIN LATERAL ... ON TRUE)
-- Step 2: Retroactive merge of RSS↔MCP newsletter duplicates
-- Step 3: Backfill thought_connections for all existing thoughts

-- ==========================================================================
-- STEP 1: Fix analysis_connection_density — include zero-neighbor thoughts
-- ==========================================================================
CREATE OR REPLACE FUNCTION analysis_connection_density()
RETURNS TABLE(threshold text, thoughts bigint, avg_links numeric, median_links int, zero_links bigint, ten_plus_links bigint, max_links bigint)
LANGUAGE sql STABLE
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


-- ==========================================================================
-- STEP 2: Retroactive merge of RSS↔MCP newsletter duplicates
-- For each RSS thought, find the MCP duplicate (>= 0.92 similarity).
-- Keep the older thought (MCP, captured first), merge the newer (RSS) into it.
-- Then delete the RSS duplicate.
-- ==========================================================================
DO $$
DECLARE
  rss_rec RECORD;
  mcp_match RECORD;
  merge_count_total INT := 0;
BEGIN
  FOR rss_rec IN
    SELECT id, content, source, source_event_id, embedding, created_at
    FROM thoughts
    WHERE source = 'rss' AND embedding IS NOT NULL
  LOOP
    -- Find the best MCP match above dedup threshold
    SELECT t.id, t.created_at,
           1 - (t.embedding <=> rss_rec.embedding) AS similarity
    INTO mcp_match
    FROM thoughts t
    WHERE t.source = 'mcp'
      AND t.embedding IS NOT NULL
      AND t.id != rss_rec.id
      AND 1 - (t.embedding <=> rss_rec.embedding) >= 0.92
    ORDER BY t.embedding <=> rss_rec.embedding ASC
    LIMIT 1;

    IF mcp_match IS NOT NULL THEN
      -- Merge into whichever was captured first (keep older)
      IF mcp_match.created_at <= rss_rec.created_at THEN
        -- MCP is older, merge RSS into MCP
        UPDATE thoughts
        SET merge_count = thoughts.merge_count + 1,
            metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{merged_from}',
              COALESCE(metadata->'merged_from', '[]'::jsonb) ||
              jsonb_build_object(
                'source', rss_rec.source,
                'source_event_id', rss_rec.source_event_id,
                'similarity', mcp_match.similarity,
                'content', left(rss_rec.content, 2000),
                'timestamp', now()::text,
                'backfill', true
              )
            )
        WHERE thoughts.id = mcp_match.id;

        -- Delete the RSS duplicate (CASCADE removes its connections)
        DELETE FROM thoughts WHERE id = rss_rec.id;
      ELSE
        -- RSS is older (unlikely but handle), merge MCP into RSS
        UPDATE thoughts
        SET merge_count = thoughts.merge_count + 1,
            metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{merged_from}',
              COALESCE(metadata->'merged_from', '[]'::jsonb) ||
              jsonb_build_object(
                'source', 'mcp',
                'similarity', mcp_match.similarity,
                'content', left((SELECT content FROM thoughts WHERE id = mcp_match.id), 2000),
                'timestamp', now()::text,
                'backfill', true
              )
            )
        WHERE thoughts.id = rss_rec.id;

        DELETE FROM thoughts WHERE id = mcp_match.id;
      END IF;

      merge_count_total := merge_count_total + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'RSS↔MCP dedup: merged % duplicate pairs', merge_count_total;
END $$;


-- ==========================================================================
-- STEP 3: Backfill thought_connections for all existing thoughts
-- Uses same logic as storeConnections: threshold 0.75, top 3 per thought
-- ON CONFLICT DO NOTHING: safe to re-run, skips existing edges
-- ==========================================================================
DO $$
DECLARE
  t RECORD;
  m RECORD;
  conn_count INT := 0;
  thought_count INT := 0;
BEGIN
  FOR t IN SELECT id, embedding FROM thoughts WHERE embedding IS NOT NULL
  LOOP
    thought_count := thought_count + 1;
    FOR m IN
      SELECT id AS match_id,
             1 - (embedding <=> t.embedding) AS similarity
      FROM thoughts
      WHERE id != t.id
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> t.embedding) >= 0.75
      ORDER BY embedding <=> t.embedding ASC
      LIMIT 3
    LOOP
      INSERT INTO thought_connections (source_thought_id, target_thought_id, similarity, link_type)
      VALUES (t.id, m.match_id, m.similarity, 'semantic_similarity')
      ON CONFLICT (source_thought_id, target_thought_id) DO NOTHING;
      conn_count := conn_count + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Backfill: processed % thoughts, created up to % connection edges', thought_count, conn_count;
END $$;
