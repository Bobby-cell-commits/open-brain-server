-- Dream Phase B: Backfill theme data from existing JSONB metadata.
-- Seeds 8 theme rows, populates junction table, computes initial centroids,
-- takes first snapshot.

SET search_path = 'public';

-- Owner brain ID (matches OWNER_BRAIN_ID in run-pipeline)
DO $$
DECLARE
  v_brain_id uuid := '00000000-0000-4000-a000-000000000001';
  v_theme_record RECORD;
BEGIN
  -- ============================================================
  -- Step 1: Seed 8 theme rows
  -- ============================================================

  INSERT INTO themes (brain_id, name, description) VALUES
    (v_brain_id, 'ml-research', 'Machine learning research, model architectures, training techniques, benchmarks'),
    (v_brain_id, 'developer-experience', 'Developer tools, workflows, productivity, DX improvements'),
    (v_brain_id, 'side-projects', 'Personal builds, side projects, product ideas'),
    (v_brain_id, 'ai-coding-tools', 'AI-assisted coding, code generation, IDE integrations'),
    (v_brain_id, 'industry-trends', 'AI industry news, funding, company strategy, market shifts'),
    (v_brain_id, 'personal', 'Personal reflections, catch-all for uncategorized thoughts'),
    (v_brain_id, 'knowledge-systems', 'Knowledge management, RAG, memory systems, PKM'),
    (v_brain_id, 'infrastructure', 'DevOps, deployment, platform engineering, databases')
  ON CONFLICT (brain_id, name) DO NOTHING;

  -- ============================================================
  -- Step 2: Populate theme_thoughts from JSONB metadata
  -- ============================================================

  INSERT INTO theme_thoughts (theme_id, thought_id, confidence, assigned_at)
  SELECT t.id, th.id, 1.0, th.created_at
  FROM thoughts th
  JOIN themes t ON t.brain_id = th.brain_id
    AND t.name = th.metadata->>'theme'
  WHERE th.brain_id = v_brain_id
    AND th.archived_at IS NULL
    AND th.metadata->>'theme' IS NOT NULL
  ON CONFLICT (theme_id, thought_id) DO NOTHING;

  -- ============================================================
  -- Step 3: Compute initial centroids via pgvector AVG
  -- ============================================================

  UPDATE themes t
  SET
    centroid = sub.avg_embedding,
    thought_count = sub.cnt
  FROM (
    SELECT tt.theme_id, AVG(th.embedding) as avg_embedding, COUNT(*)::int as cnt
    FROM theme_thoughts tt
    JOIN thoughts th ON th.id = tt.thought_id
    WHERE th.embedding IS NOT NULL
    GROUP BY tt.theme_id
  ) sub
  WHERE t.id = sub.theme_id;

  -- ============================================================
  -- Step 4: Take first snapshot
  -- ============================================================

  FOR v_theme_record IN
    SELECT t.id as theme_id, t.thought_count, t.lifecycle_state, t.velocity
    FROM themes t
    WHERE t.brain_id = v_brain_id
  LOOP
    INSERT INTO theme_snapshots (
      theme_id, snapshot_date, thought_count, new_thoughts,
      avg_quality, avg_salience, centroid_drift, lifecycle_state, velocity
    )
    SELECT
      v_theme_record.theme_id,
      CURRENT_DATE,
      v_theme_record.thought_count,
      0,  -- first snapshot, no "new" count
      AVG((th.metadata->>'quality')::float),
      AVG(th.salience),
      0,  -- no drift for first snapshot
      v_theme_record.lifecycle_state,
      v_theme_record.velocity
    FROM theme_thoughts tt
    JOIN thoughts th ON th.id = tt.thought_id
    WHERE tt.theme_id = v_theme_record.theme_id
    ON CONFLICT (theme_id, snapshot_date) DO NOTHING;
  END LOOP;
END $$;
