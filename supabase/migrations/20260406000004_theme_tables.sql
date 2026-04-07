-- Dream Phase B: Theme tracking tables
-- themes: first-class theme entities with centroids and lifecycle
-- theme_thoughts: junction linking thoughts to themes
-- theme_snapshots: weekly time-series for temporal tracking

SET search_path = 'public';

-- ============================================================
-- themes
-- ============================================================

CREATE TABLE themes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brain_id uuid NOT NULL REFERENCES brains(id),
  name text NOT NULL,
  description text,
  centroid vector(1536),
  lifecycle_state text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('emerging', 'active', 'mature', 'declining', 'dormant')),
  velocity float NOT NULL DEFAULT 0.0,
  thought_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(brain_id, name)
);

ALTER TABLE themes ENABLE ROW LEVEL SECURITY;

CREATE POLICY themes_brain_isolation ON themes
  USING (brain_id = current_setting('app.brain_id', true)::uuid);

-- Service role bypass (Edge Functions use service role key)
CREATE POLICY themes_service_role ON themes
  FOR ALL USING (current_setting('role', true) = 'service_role');

-- ============================================================
-- theme_thoughts
-- ============================================================

CREATE TABLE theme_thoughts (
  theme_id uuid NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  thought_id uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  confidence float NOT NULL DEFAULT 1.0,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (theme_id, thought_id)
);

-- Index for "which thoughts belong to this theme?" queries
CREATE INDEX idx_theme_thoughts_theme ON theme_thoughts(theme_id);
-- Index for "which theme does this thought belong to?" queries
CREATE INDEX idx_theme_thoughts_thought ON theme_thoughts(thought_id);

ALTER TABLE theme_thoughts ENABLE ROW LEVEL SECURITY;

CREATE POLICY theme_thoughts_brain_isolation ON theme_thoughts
  USING (theme_id IN (SELECT id FROM themes WHERE brain_id = current_setting('app.brain_id', true)::uuid));

CREATE POLICY theme_thoughts_service_role ON theme_thoughts
  FOR ALL USING (current_setting('role', true) = 'service_role');

-- ============================================================
-- theme_snapshots
-- ============================================================

CREATE TABLE theme_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theme_id uuid NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  thought_count int NOT NULL,
  new_thoughts int NOT NULL DEFAULT 0,
  avg_quality float,
  avg_salience float,
  centroid_drift float,
  lifecycle_state text NOT NULL,
  velocity float NOT NULL,
  UNIQUE(theme_id, snapshot_date)
);

-- Index for timeline queries (theme + date range)
CREATE INDEX idx_theme_snapshots_theme_date ON theme_snapshots(theme_id, snapshot_date DESC);

ALTER TABLE theme_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY theme_snapshots_brain_isolation ON theme_snapshots
  USING (theme_id IN (SELECT id FROM themes WHERE brain_id = current_setting('app.brain_id', true)::uuid));

CREATE POLICY theme_snapshots_service_role ON theme_snapshots
  FOR ALL USING (current_setting('role', true) = 'service_role');
