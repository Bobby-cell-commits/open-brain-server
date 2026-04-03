-- Enable pgvector extension
create extension if not exists vector;

-- Create thoughts table
create table if not exists thoughts (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding vector(1536),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- HNSW index for vector similarity search (cosine distance)
create index if not exists thoughts_embedding_idx
  on thoughts using hnsw (embedding vector_cosine_ops);

-- GIN index for JSONB metadata queries
create index if not exists thoughts_metadata_idx
  on thoughts using gin (metadata);

-- B-tree index for time-based queries
create index if not exists thoughts_created_at_idx
  on thoughts (created_at desc);

-- RLS: service role only
alter table thoughts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'thoughts' and policyname = 'Service role has full access'
  ) then
    create policy "Service role has full access"
      on thoughts for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;
end $$;

-- Vector similarity search RPC (v1 — superseded by migration 003)
-- Skipped on re-run: later migration changed the return type
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'match_thoughts') then
    create function match_thoughts(
      query_embedding vector(1536),
      match_threshold float default 0.7,
      match_count int default 10,
      filter jsonb default '{}'::jsonb
    )
    returns setof thoughts
    language sql
    stable
    as $fn$
      select *
      from thoughts
      where thoughts.embedding <=> query_embedding < 1 - match_threshold
      order by thoughts.embedding <=> query_embedding asc
      limit least(match_count, 200);
    $fn$;
  end if;
end $$;
