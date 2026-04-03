-- Row Level Security: blanket "service_role only" on all tables.
-- All access goes through Edge Functions (service role key).
-- This ensures even with the anon key, no direct data access is possible.

-- thoughts
ALTER TABLE thoughts ENABLE ROW LEVEL SECURITY;
ALTER TABLE thoughts FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON thoughts
  FOR ALL USING (current_setting('role') = 'service_role');

-- thought_connections
ALTER TABLE thought_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE thought_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON thought_connections
  FOR ALL USING (current_setting('role') = 'service_role');

-- entities
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON entities
  FOR ALL USING (current_setting('role') = 'service_role');

-- thought_entities
ALTER TABLE thought_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE thought_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON thought_entities
  FOR ALL USING (current_setting('role') = 'service_role');

-- brains
ALTER TABLE brains ENABLE ROW LEVEL SECURITY;
ALTER TABLE brains FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON brains
  FOR ALL USING (current_setting('role') = 'service_role');

-- brain_api_keys
ALTER TABLE brain_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE brain_api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON brain_api_keys
  FOR ALL USING (current_setting('role') = 'service_role');

-- merge_audit_log
ALTER TABLE merge_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON merge_audit_log
  FOR ALL USING (current_setting('role') = 'service_role');

-- pipeline_runs
ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON pipeline_runs
  FOR ALL USING (current_setting('role') = 'service_role');

-- pipeline_processed
ALTER TABLE pipeline_processed ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_processed FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON pipeline_processed
  FOR ALL USING (current_setting('role') = 'service_role');
