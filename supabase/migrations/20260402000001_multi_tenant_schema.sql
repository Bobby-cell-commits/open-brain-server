-- Migration: Multi-tenant schema foundation
-- Creates brains + brain_api_keys tables, adds brain_id to all product tables,
-- backfills existing data to the default brain, and adjusts constraints/indexes.

SET search_path = 'public';

-- ============================================================================
-- 1. Brains table
-- ============================================================================

CREATE TABLE IF NOT EXISTS brains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_email text,
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);

ALTER TABLE brains ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'brains' AND policyname = 'Service role has full access'
  ) THEN
    CREATE POLICY "Service role has full access"
      ON brains FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ============================================================================
-- 2. Brain API keys table
-- ============================================================================

CREATE TABLE IF NOT EXISTS brain_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brain_id uuid NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  key_hash text NOT NULL,
  key_prefix text NOT NULL,
  label text,
  scope text NOT NULL DEFAULT 'read_write',
  created_at timestamptz DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Partial unique index: only one active (non-revoked) key per hash
CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_api_keys_hash_active
  ON brain_api_keys (key_hash) WHERE revoked_at IS NULL;

ALTER TABLE brain_api_keys ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'brain_api_keys' AND policyname = 'Service role has full access'
  ) THEN
    CREATE POLICY "Service role has full access"
      ON brain_api_keys FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ============================================================================
-- 3. Insert default brain (deterministic UUID, idempotent)
-- ============================================================================

INSERT INTO brains (id, name, plan)
VALUES ('00000000-0000-4000-a000-000000000001', 'default', 'pro')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 4. Add brain_id columns (nullable initially)
-- ============================================================================

ALTER TABLE thoughts
  ADD COLUMN IF NOT EXISTS brain_id uuid REFERENCES brains(id) ON DELETE CASCADE;

ALTER TABLE thought_connections
  ADD COLUMN IF NOT EXISTS brain_id uuid REFERENCES brains(id) ON DELETE CASCADE;

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS brain_id uuid REFERENCES brains(id) ON DELETE CASCADE;

ALTER TABLE thought_entities
  ADD COLUMN IF NOT EXISTS brain_id uuid REFERENCES brains(id) ON DELETE CASCADE;

ALTER TABLE merge_audit_log
  ADD COLUMN IF NOT EXISTS brain_id uuid REFERENCES brains(id) ON DELETE CASCADE;

-- ============================================================================
-- 5. Backfill all existing rows with the default brain UUID
-- ============================================================================

UPDATE thoughts
SET brain_id = '00000000-0000-4000-a000-000000000001'
WHERE brain_id IS NULL;

UPDATE thought_connections
SET brain_id = '00000000-0000-4000-a000-000000000001'
WHERE brain_id IS NULL;

UPDATE entities
SET brain_id = '00000000-0000-4000-a000-000000000001'
WHERE brain_id IS NULL;

UPDATE thought_entities
SET brain_id = '00000000-0000-4000-a000-000000000001'
WHERE brain_id IS NULL;

UPDATE merge_audit_log
SET brain_id = '00000000-0000-4000-a000-000000000001'
WHERE brain_id IS NULL;

-- ============================================================================
-- 6. Set NOT NULL on all brain_id columns
-- ============================================================================

ALTER TABLE thoughts
  ALTER COLUMN brain_id SET NOT NULL;

ALTER TABLE thought_connections
  ALTER COLUMN brain_id SET NOT NULL;

ALTER TABLE entities
  ALTER COLUMN brain_id SET NOT NULL;

ALTER TABLE thought_entities
  ALTER COLUMN brain_id SET NOT NULL;

ALTER TABLE merge_audit_log
  ALTER COLUMN brain_id SET NOT NULL;

-- ============================================================================
-- 7. Create indexes
-- ============================================================================

-- thoughts: brain_id standalone + composite with created_at
CREATE INDEX IF NOT EXISTS idx_thoughts_brain_id
  ON thoughts (brain_id);

CREATE INDEX IF NOT EXISTS idx_thoughts_brain_id_created_at
  ON thoughts (brain_id, created_at DESC);

-- thought_connections: brain_id
CREATE INDEX IF NOT EXISTS idx_thought_connections_brain_id
  ON thought_connections (brain_id);

-- entities: brain_id
CREATE INDEX IF NOT EXISTS idx_entities_brain_id
  ON entities (brain_id);

-- thought_entities: brain_id
CREATE INDEX IF NOT EXISTS idx_thought_entities_brain_id
  ON thought_entities (brain_id);

-- merge_audit_log: brain_id
CREATE INDEX IF NOT EXISTS idx_merge_audit_log_brain_id
  ON merge_audit_log (brain_id);

-- ============================================================================
-- 8. Replace entities unique constraint: (name, entity_type) → (brain_id, name, entity_type)
-- ============================================================================

ALTER TABLE entities
  DROP CONSTRAINT IF EXISTS entities_name_entity_type_key;

-- New tenant-scoped uniqueness (wrapped for idempotency — ADD CONSTRAINT has no IF NOT EXISTS)
DO $$ BEGIN
  ALTER TABLE entities
    ADD CONSTRAINT entities_brain_id_name_entity_type_key UNIQUE (brain_id, name, entity_type);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- Done. brain_id is now NOT NULL on all product tables, default brain seeded,
-- and new brains + brain_api_keys tables are ready for the auth middleware.
-- ============================================================================
