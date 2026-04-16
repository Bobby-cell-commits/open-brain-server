-- Clean up LongMemEval benchmark data from production.
--
-- The benchmark (python -m benchmark longmemeval) loaded 21K thoughts across
-- 500+ brains, bloating the HNSW index and causing graph analysis RPCs to
-- timeout. The benchmark tool reimports fresh data on each run.

SET statement_timeout = '600s';

-- Remove benchmark thoughts (cascades to connections, entities, etc.)
DELETE FROM thoughts WHERE source = 'benchmark';

-- Remove benchmark brain references
DELETE FROM retrieval_sessions WHERE brain_id IN (SELECT id FROM brains WHERE name LIKE 'longmemeval-%');
DELETE FROM brain_api_keys WHERE brain_id IN (SELECT id FROM brains WHERE name LIKE 'longmemeval-%');
DELETE FROM brains WHERE name LIKE 'longmemeval-%';

-- Rebuild HNSW index clean
DROP INDEX IF EXISTS thoughts_embedding_idx;
CREATE INDEX thoughts_embedding_idx
  ON thoughts USING hnsw (embedding vector_cosine_ops);
