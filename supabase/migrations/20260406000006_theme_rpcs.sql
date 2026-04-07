-- Dream Phase B: All RPC functions for theme tracking.
-- Query RPCs: get_theme_stats, get_theme_timeline (used by MCP tools)
-- Helper RPCs: populate_theme_thoughts, count_new_theme_thoughts,
--              update_theme_centroid, fill_snapshot_averages (used by dream-themes.ts)

SET search_path = 'public';

-- ============================================================
-- get_theme_stats: All themes with current state for a brain
-- ============================================================

CREATE OR REPLACE FUNCTION get_theme_stats(p_brain_id uuid)
RETURNS TABLE (
  name text,
  description text,
  lifecycle_state text,
  velocity float,
  thought_count int,
  centroid_drift float,
  latest_snapshot_date date
)
LANGUAGE sql STABLE
SET search_path = 'public'
AS $$
  SELECT
    t.name,
    t.description,
    t.lifecycle_state,
    t.velocity,
    t.thought_count,
    s.centroid_drift,
    s.snapshot_date as latest_snapshot_date
  FROM themes t
  LEFT JOIN LATERAL (
    SELECT centroid_drift, snapshot_date
    FROM theme_snapshots
    WHERE theme_id = t.id
    ORDER BY snapshot_date DESC
    LIMIT 1
  ) s ON true
  WHERE t.brain_id = p_brain_id
  ORDER BY t.thought_count DESC;
$$;

-- ============================================================
-- get_theme_timeline: Snapshot history for one theme
-- ============================================================

CREATE OR REPLACE FUNCTION get_theme_timeline(
  p_brain_id uuid,
  p_theme_name text,
  p_days int DEFAULT 90
)
RETURNS TABLE (
  snapshot_date date,
  thought_count int,
  new_thoughts int,
  avg_quality float,
  avg_salience float,
  velocity float,
  centroid_drift float,
  lifecycle_state text
)
LANGUAGE sql STABLE
SET search_path = 'public'
AS $$
  SELECT
    s.snapshot_date,
    s.thought_count,
    s.new_thoughts,
    s.avg_quality,
    s.avg_salience,
    s.velocity,
    s.centroid_drift,
    s.lifecycle_state
  FROM theme_snapshots s
  JOIN themes t ON t.id = s.theme_id
  WHERE t.brain_id = p_brain_id
    AND t.name = p_theme_name
    AND s.snapshot_date >= CURRENT_DATE - p_days
  ORDER BY s.snapshot_date;
$$;

-- ============================================================
-- populate_theme_thoughts: Insert junction rows for new thoughts
-- Returns count of rows inserted.
-- ============================================================

CREATE OR REPLACE FUNCTION populate_theme_thoughts(
  p_brain_id uuid,
  p_since_date date DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  v_count int;
BEGIN
  INSERT INTO theme_thoughts (theme_id, thought_id, confidence, assigned_at)
  SELECT t.id, th.id, 1.0, th.created_at
  FROM thoughts th
  JOIN themes t ON t.brain_id = th.brain_id
    AND t.name = th.metadata->>'theme'
  WHERE th.brain_id = p_brain_id
    AND th.archived_at IS NULL
    AND th.metadata->>'theme' IS NOT NULL
    AND (p_since_date IS NULL OR th.created_at > p_since_date::timestamptz)
    AND NOT EXISTS (
      SELECT 1 FROM theme_thoughts tt WHERE tt.thought_id = th.id
    )
  ON CONFLICT (theme_id, thought_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ============================================================
-- count_new_theme_thoughts: Count new thoughts per theme since date
-- ============================================================

CREATE OR REPLACE FUNCTION count_new_theme_thoughts(
  p_brain_id uuid,
  p_since_date date DEFAULT NULL
)
RETURNS TABLE (theme_name text, cnt int)
LANGUAGE sql STABLE
SET search_path = 'public'
AS $$
  SELECT t.name as theme_name, COUNT(tt.thought_id)::int as cnt
  FROM themes t
  LEFT JOIN theme_thoughts tt ON tt.theme_id = t.id
    AND (p_since_date IS NULL OR tt.assigned_at > p_since_date::timestamptz)
  WHERE t.brain_id = p_brain_id
  GROUP BY t.name;
$$;

-- ============================================================
-- update_theme_centroid: Weighted centroid update with drift calc.
-- Returns cosine drift (float) or NULL if no new embeddings.
-- ============================================================

CREATE OR REPLACE FUNCTION update_theme_centroid(
  p_theme_id uuid,
  p_since_date date DEFAULT NULL,
  p_old_weight float DEFAULT 0.7,
  p_new_weight float DEFAULT 0.3
)
RETURNS float
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  v_old_centroid vector(1536);
  v_batch_mean vector(1536);
  v_new_centroid vector(1536);
  v_drift float;
BEGIN
  -- Get current centroid
  SELECT centroid INTO v_old_centroid FROM themes WHERE id = p_theme_id;

  -- Compute batch mean of new thoughts' embeddings
  SELECT AVG(th.embedding) INTO v_batch_mean
  FROM theme_thoughts tt
  JOIN thoughts th ON th.id = tt.thought_id
  WHERE tt.theme_id = p_theme_id
    AND th.embedding IS NOT NULL
    AND (p_since_date IS NULL OR tt.assigned_at > p_since_date::timestamptz);

  -- No new embeddings
  IF v_batch_mean IS NULL THEN
    RETURN NULL;
  END IF;

  -- First centroid (no existing)
  IF v_old_centroid IS NULL THEN
    UPDATE themes SET centroid = v_batch_mean WHERE id = p_theme_id;
    RETURN 0;
  END IF;

  -- Weighted update: old * weight + new * weight
  v_new_centroid := (v_old_centroid * p_old_weight) + (v_batch_mean * p_new_weight);

  -- Compute drift (cosine distance)
  v_drift := v_old_centroid <=> v_new_centroid;

  -- Write new centroid
  UPDATE themes SET centroid = v_new_centroid WHERE id = p_theme_id;

  RETURN v_drift;
END;
$$;

-- ============================================================
-- fill_snapshot_averages: Populate avg_quality/avg_salience for a date
-- ============================================================

CREATE OR REPLACE FUNCTION fill_snapshot_averages(p_snapshot_date date)
RETURNS void
LANGUAGE sql
SET search_path = 'public'
AS $$
  UPDATE theme_snapshots s
  SET
    avg_quality = sub.avg_q,
    avg_salience = sub.avg_s
  FROM (
    SELECT
      tt.theme_id,
      AVG((th.metadata->>'quality')::float) as avg_q,
      AVG(th.salience) as avg_s
    FROM theme_thoughts tt
    JOIN thoughts th ON th.id = tt.thought_id
    GROUP BY tt.theme_id
  ) sub
  WHERE s.theme_id = sub.theme_id
    AND s.snapshot_date = p_snapshot_date;
$$;
