-- Add idempotency columns
alter table thoughts
  add column if not exists source text not null default 'unknown',
  add column if not exists source_event_id text;

-- Partial unique index: only enforce uniqueness when source_event_id is present
-- This allows MCP captures (source_event_id = null) while preventing Slack duplicates
create unique index if not exists thoughts_source_event_idx
  on thoughts (source, source_event_id)
  where source_event_id is not null;
