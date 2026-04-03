-- Serendipity digest: returns 4 diverse thoughts for resurfacing.
-- 1) Random high-quality old thought (quality >= 0.7, older than 14 days)
-- 2) Orphan thought (zero connections)
-- 3) Thought from underrepresented theme (lowest theme count)
-- 4) Thought similar to a recent capture (last 3 days)

CREATE OR REPLACE FUNCTION serendipity_digest()
RETURNS TABLE (
  slot text,
  id uuid,
  content text,
  source text,
  theme text,
  quality float,
  created_at timestamptz,
  reason text
)
LANGUAGE sql STABLE
SET statement_timeout = '30s'
SET search_path = 'public'
AS $$
  -- Slot 1: Random high-quality old thought
  (
    SELECT
      'rediscovery' AS slot,
      t.id,
      left(t.content, 300) AS content,
      t.source,
      t.metadata->>'theme' AS theme,
      (t.metadata->>'quality')::float AS quality,
      t.created_at,
      'High-quality thought from ' || to_char(t.created_at, 'Mon DD') AS reason
    FROM thoughts t
    WHERE t.created_at < now() - interval '14 days'
      AND (t.metadata->>'quality')::float >= 0.7
      AND t.embedding IS NOT NULL
    ORDER BY random()
    LIMIT 1
  )

  UNION ALL

  -- Slot 2: Orphan thought (no connections)
  (
    SELECT
      'orphan' AS slot,
      t.id,
      left(t.content, 300) AS content,
      t.source,
      t.metadata->>'theme' AS theme,
      (t.metadata->>'quality')::float AS quality,
      t.created_at,
      'No connections — might link to something new' AS reason
    FROM thoughts t
    WHERE t.embedding IS NOT NULL
      AND (t.metadata->>'quality')::float >= 0.5
      AND NOT EXISTS (
        SELECT 1 FROM thought_connections tc
        WHERE tc.source_thought_id = t.id OR tc.target_thought_id = t.id
      )
    ORDER BY random()
    LIMIT 1
  )

  UNION ALL

  -- Slot 3: Underrepresented theme
  (
    SELECT
      'underrepresented' AS slot,
      t.id,
      left(t.content, 300) AS content,
      t.source,
      t.metadata->>'theme' AS theme,
      (t.metadata->>'quality')::float AS quality,
      t.created_at,
      'From underrepresented theme: ' || (t.metadata->>'theme') AS reason
    FROM thoughts t
    WHERE t.metadata->>'theme' = (
      SELECT metadata->>'theme'
      FROM thoughts
      WHERE metadata->>'theme' IS NOT NULL
      GROUP BY metadata->>'theme'
      ORDER BY count(*) ASC
      LIMIT 1
    )
    AND (t.metadata->>'quality')::float >= 0.5
    ORDER BY random()
    LIMIT 1
  )

  UNION ALL

  -- Slot 4: Related to recent captures (most similar to a random recent thought)
  (
    SELECT
      'echo' AS slot,
      older.id,
      left(older.content, 300) AS content,
      older.source,
      older.metadata->>'theme' AS theme,
      (older.metadata->>'quality')::float AS quality,
      older.created_at,
      'Echoes a recent capture' AS reason
    FROM thoughts recent
    CROSS JOIN LATERAL (
      SELECT t.*
      FROM thoughts t
      WHERE t.id != recent.id
        AND t.created_at < now() - interval '7 days'
        AND t.embedding IS NOT NULL
        AND 1 - (t.embedding <=> recent.embedding) >= 0.70
      ORDER BY t.embedding <=> recent.embedding ASC
      LIMIT 1
    ) older
    WHERE recent.created_at > now() - interval '3 days'
      AND recent.embedding IS NOT NULL
    ORDER BY random()
    LIMIT 1
  );
$$;
