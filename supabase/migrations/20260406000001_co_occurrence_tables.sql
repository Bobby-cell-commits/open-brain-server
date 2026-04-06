-- Co-occurrence edge strengthening: retrieval session logging + adaptive edges
-- Spec: docs/superpowers/specs/2026-04-06-co-occurrence-edge-strengthening-design.md

-- Retrieval session audit log (append-only)
CREATE TABLE IF NOT EXISTS retrieval_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brain_id uuid NOT NULL REFERENCES brains(id),
  tool_name text NOT NULL,
  context text NOT NULL DEFAULT 'manual',
  query_text text,
  thought_ids uuid[] NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_retrieval_sessions_brain_created
  ON retrieval_sessions(brain_id, created_at DESC);

-- Co-occurrence edges (materialized, decaying weights)
CREATE TABLE IF NOT EXISTS co_occurrence_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brain_id uuid NOT NULL REFERENCES brains(id),
  thought_a uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  thought_b uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  raw_count int NOT NULL DEFAULT 1,
  weighted_count float NOT NULL DEFAULT 1.0,
  weight float NOT NULL DEFAULT 1.0,
  half_life_days float NOT NULL DEFAULT 7.0,
  last_co_occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(brain_id, thought_a, thought_b),
  CHECK (thought_a < thought_b)
);

CREATE INDEX IF NOT EXISTS idx_cooccurrence_thought_a ON co_occurrence_edges(brain_id, thought_a);
CREATE INDEX IF NOT EXISTS idx_cooccurrence_thought_b ON co_occurrence_edges(brain_id, thought_b);
CREATE INDEX IF NOT EXISTS idx_cooccurrence_weight ON co_occurrence_edges(brain_id, weight DESC);

-- RLS policies
ALTER TABLE retrieval_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE co_occurrence_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on retrieval_sessions"
  ON retrieval_sessions FOR ALL
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on co_occurrence_edges"
  ON co_occurrence_edges FOR ALL
  USING (true) WITH CHECK (true);
