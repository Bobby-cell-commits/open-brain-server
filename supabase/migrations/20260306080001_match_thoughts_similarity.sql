-- Migration 003: Add similarity score to match_thoughts
-- Replaces the existing match_thoughts function to return a custom table type
-- that includes a similarity float column alongside all thoughts columns.
-- The ORDER BY uses the distance operator directly to preserve HNSW index usage.

drop function if exists match_thoughts;

create or replace function match_thoughts(
  query_embedding vector(1536),
  match_threshold float default 0.7,
  match_count int default 10,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  embedding vector(1536),
  metadata jsonb,
  source text,
  source_event_id text,
  created_at timestamptz,
  updated_at timestamptz,
  similarity float
)
language sql
stable
as $$
  select
    thoughts.id,
    thoughts.content,
    thoughts.embedding,
    thoughts.metadata,
    thoughts.source,
    thoughts.source_event_id,
    thoughts.created_at,
    thoughts.updated_at,
    1 - (thoughts.embedding <=> query_embedding) as similarity
  from thoughts
  where thoughts.embedding <=> query_embedding < 1 - match_threshold
  order by thoughts.embedding <=> query_embedding asc
  limit least(match_count, 200);
$$;
