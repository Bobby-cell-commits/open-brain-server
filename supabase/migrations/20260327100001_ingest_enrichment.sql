-- Migration: Ingest enrichment — entities, typed connections, quality score
-- Adds entities table, thought_entities junction, connection metadata column,
-- and resolve_entities RPC for atomic entity upsert + linking.

SET search_path = 'public';

-- 1. Entities table
CREATE TABLE entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  entity_type text NOT NULL,
  aliases text[] DEFAULT '{}',
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(name, entity_type)
);

CREATE INDEX idx_entities_type ON entities (entity_type);
CREATE INDEX idx_entities_aliases ON entities USING GIN (aliases);

-- RLS: match security posture of thoughts table
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role has full access" ON entities FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 2. Thought-entity junction table
CREATE TABLE thought_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thought_id uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  mention_type text DEFAULT 'mention',
  created_at timestamptz DEFAULT now(),
  UNIQUE(thought_id, entity_id, mention_type)
);

CREATE INDEX idx_thought_entities_thought ON thought_entities (thought_id);
CREATE INDEX idx_thought_entities_entity ON thought_entities (entity_id);

ALTER TABLE thought_entities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role has full access" ON thought_entities FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 3. Add metadata column to thought_connections for connection typing
ALTER TABLE thought_connections ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';

-- 4. RPC: resolve_entities — upsert entities + create junction links in one call
CREATE OR REPLACE FUNCTION resolve_entities(p_entities jsonb, p_thought_id uuid)
RETURNS void AS $$
DECLARE
  ent jsonb;
  ent_name text;
  ent_type text;
  ent_role text;
  resolved_id uuid;
BEGIN
  FOR ent IN SELECT * FROM jsonb_array_elements(p_entities)
  LOOP
    ent_name := ent->>'name';
    ent_type := ent->>'type';
    ent_role := COALESCE(ent->>'role', 'mention');

    IF ent_name IS NULL OR ent_type IS NULL THEN
      CONTINUE;
    END IF;

    -- Normalize: trim + collapse whitespace
    ent_name := regexp_replace(trim(ent_name), '\s+', ' ', 'g');

    -- Try exact match first
    SELECT id INTO resolved_id
    FROM entities
    WHERE name = ent_name AND entity_type = ent_type;

    -- If no exact match, check aliases (case-insensitive)
    IF resolved_id IS NULL THEN
      SELECT id INTO resolved_id
      FROM entities
      WHERE entity_type = ent_type
        AND EXISTS (
          SELECT 1 FROM unnest(aliases) AS a
          WHERE lower(a) = lower(ent_name)
        );
    END IF;

    -- If still no match, create new entity
    IF resolved_id IS NULL THEN
      INSERT INTO entities (name, entity_type)
      VALUES (ent_name, ent_type)
      ON CONFLICT (name, entity_type) DO NOTHING
      RETURNING id INTO resolved_id;

      -- Handle race condition: if DO NOTHING fired, fetch the existing id
      IF resolved_id IS NULL THEN
        SELECT id INTO resolved_id
        FROM entities
        WHERE name = ent_name AND entity_type = ent_type;
      END IF;
    ELSE
      -- Matched existing entity — add raw name as alias if different from canonical
      UPDATE entities
      SET aliases = array_append(aliases, ent_name),
          updated_at = now()
      WHERE id = resolved_id
        AND name != ent_name
        AND NOT (ent_name = ANY(aliases));
    END IF;

    -- Link thought to entity (ignore duplicates)
    INSERT INTO thought_entities (thought_id, entity_id, mention_type)
    VALUES (p_thought_id, resolved_id, ent_role)
    ON CONFLICT (thought_id, entity_id, mention_type) DO NOTHING;
  END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- 5. RPC: list_entities — entities sorted by thought count
CREATE OR REPLACE FUNCTION list_entities(
  p_entity_type text DEFAULT NULL,
  p_min_thoughts int DEFAULT 1,
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  name text,
  entity_type text,
  aliases text[],
  thought_count bigint
) AS $$
  SELECT
    e.id,
    e.name,
    e.entity_type,
    e.aliases,
    COUNT(te.thought_id) AS thought_count
  FROM entities e
  JOIN thought_entities te ON te.entity_id = e.id
  WHERE (p_entity_type IS NULL OR e.entity_type = p_entity_type)
  GROUP BY e.id, e.name, e.entity_type, e.aliases
  HAVING COUNT(te.thought_id) >= p_min_thoughts
  ORDER BY thought_count DESC
  LIMIT LEAST(p_limit, 100);
$$ LANGUAGE sql STABLE;

-- 6. Update get_thought_connections to include metadata (connection typing reason)
-- Must DROP first because return type is changing (adding connection_metadata, created_at)
DROP FUNCTION IF EXISTS get_thought_connections(uuid);
CREATE OR REPLACE FUNCTION get_thought_connections(p_thought_id uuid)
RETURNS TABLE(
  connected_thought_id uuid,
  content text,
  similarity float,
  link_type text,
  connection_metadata jsonb,
  created_at timestamptz
) AS $$
  SELECT
    CASE WHEN tc.source_thought_id = p_thought_id
         THEN tc.target_thought_id
         ELSE tc.source_thought_id END,
    t.content,
    tc.similarity,
    tc.link_type,
    tc.metadata,
    tc.created_at
  FROM thought_connections tc
  JOIN thoughts t ON t.id = CASE
    WHEN tc.source_thought_id = p_thought_id THEN tc.target_thought_id
    ELSE tc.source_thought_id END
  WHERE tc.source_thought_id = p_thought_id
     OR tc.target_thought_id = p_thought_id
  ORDER BY tc.similarity DESC;
$$ LANGUAGE sql STABLE;

-- 7. RPC: get_thought_entities — entities linked to a specific thought
CREATE OR REPLACE FUNCTION get_thought_entities(p_thought_id uuid)
RETURNS TABLE (
  entity_id uuid,
  name text,
  entity_type text,
  mention_type text
) AS $$
  SELECT e.id, e.name, e.entity_type, te.mention_type
  FROM thought_entities te
  JOIN entities e ON e.id = te.entity_id
  WHERE te.thought_id = p_thought_id
  ORDER BY e.entity_type, e.name;
$$ LANGUAGE sql STABLE;
