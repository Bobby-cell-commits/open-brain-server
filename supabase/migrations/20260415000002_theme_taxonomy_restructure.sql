-- Theme Taxonomy Restructure: 8 → 11 domain themes + activity label index
-- New themes: hardware-systems, tech-economics, security, scientific-computing, regulation-policy
-- Archived themes: side-projects, personal (become activity labels)
-- New index: metadata->>'activity' for filter performance
-- Updated thought_stats RPC: adds by_activity aggregation

SET search_path = 'public';

-- ============================================================
-- 1. Insert new theme rows (for all brains)
-- ============================================================

INSERT INTO themes (id, brain_id, name, description, lifecycle_state, velocity, thought_count, created_at, updated_at)
SELECT
  gen_random_uuid(),
  b.id,
  t.name,
  t.description,
  'active',
  0,
  0,
  now(),
  now()
FROM brains b
CROSS JOIN (VALUES
  ('hardware-systems', 'Chip architecture, embedded systems, FPGA, semiconductors, electronics engineering'),
  ('tech-economics', 'Structural technology analysis, compute economics, business models, market sizing'),
  ('security', 'Vulnerability research, cryptography, privacy, threat modeling, reverse engineering'),
  ('scientific-computing', 'Bioinformatics, statistical computing, scientific workflows, Julia/R ecosystem'),
  ('regulation-policy', 'AI regulation, privacy law, tech policy, compliance, governance')
) AS t(name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM themes th WHERE th.brain_id = b.id AND th.name = t.name
);

-- ============================================================
-- 2. Add 'archived' to lifecycle_state check constraint, then archive old theme rows
-- ============================================================

ALTER TABLE themes DROP CONSTRAINT themes_lifecycle_state_check;
ALTER TABLE themes ADD CONSTRAINT themes_lifecycle_state_check
  CHECK (lifecycle_state = ANY (ARRAY['emerging', 'active', 'mature', 'declining', 'dormant', 'archived']));

UPDATE themes
SET lifecycle_state = 'archived', updated_at = now()
WHERE name IN ('side-projects', 'personal')
  AND lifecycle_state != 'archived';

-- ============================================================
-- 3. Expression index on activity for filter performance
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_thoughts_activity
  ON thoughts ((metadata->>'activity'));

-- ============================================================
-- 4. Updated thought_stats RPC with by_activity
-- ============================================================

CREATE OR REPLACE FUNCTION thought_stats(
  p_brain_id uuid,
  days_back integer DEFAULT NULL
)
RETURNS json
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  SELECT json_build_object(
    'total_thoughts', (
      SELECT count(*) FROM thoughts
      WHERE brain_id = p_brain_id
        AND archived_at IS NULL
        AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
    ),
    'by_type', coalesce(
      (
        SELECT json_object_agg(t, cnt) FROM (
          SELECT metadata->>'type' AS t, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND archived_at IS NULL
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
          GROUP BY metadata->>'type'
        ) sub
      ),
      '{}'::json
    ),
    'by_theme', coalesce(
      (
        SELECT json_object_agg(th, cnt) FROM (
          SELECT metadata->>'theme' AS th, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND archived_at IS NULL
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
            AND metadata->>'theme' IS NOT NULL
          GROUP BY metadata->>'theme'
        ) sub
      ),
      '{}'::json
    ),
    'by_activity', coalesce(
      (
        SELECT json_object_agg(a, cnt) FROM (
          SELECT metadata->>'activity' AS a, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND archived_at IS NULL
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
            AND metadata->>'activity' IS NOT NULL
          GROUP BY metadata->>'activity'
        ) sub
      ),
      '{}'::json
    ),
    'by_source', coalesce(
      (
        SELECT json_object_agg(s, cnt) FROM (
          SELECT source AS s, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND archived_at IS NULL
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
          GROUP BY source
        ) sub
      ),
      '{}'::json
    ),
    'top_topics', coalesce(
      (
        SELECT json_agg(json_build_object('topic', topic, 'count', cnt) ORDER BY cnt DESC)
        FROM (
          SELECT jsonb_array_elements_text(metadata->'topics') AS topic, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND archived_at IS NULL
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
          GROUP BY 1
          ORDER BY cnt DESC
          LIMIT 20
        ) sub
      ),
      '[]'::json
    ),
    'top_people', coalesce(
      (
        SELECT json_agg(json_build_object('person', person, 'count', cnt) ORDER BY cnt DESC)
        FROM (
          SELECT jsonb_array_elements_text(metadata->'people') AS person, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND archived_at IS NULL
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
          GROUP BY 1
          ORDER BY cnt DESC
          LIMIT 20
        ) sub
      ),
      '[]'::json
    )
  );
$$;
