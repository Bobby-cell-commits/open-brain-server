-- Pipeline state tracking for server-side deduplication
create table if not exists pipeline_processed (
  id text primary key,                -- reddit fullname or rss guid
  source text not null,               -- 'reddit' | 'rss'
  feed text,                          -- subreddit name or feed URL
  processed_at timestamptz default now()
);

create index if not exists pipeline_processed_source_idx
  on pipeline_processed (source, processed_at desc);
