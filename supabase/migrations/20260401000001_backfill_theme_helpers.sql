-- Migration: Helper RPCs for theme backfill
-- get_null_theme_thoughts: returns thoughts missing theme metadata
-- set_thought_theme: updates a single thought's theme in metadata JSONB

create or replace function get_null_theme_thoughts(batch_size integer default 50)
returns table(id uuid, content text)
language sql
stable
set search_path = 'public'
as $$
  select t.id, t.content
  from thoughts t
  where t.metadata->>'theme' is null
  order by t.created_at desc
  limit batch_size;
$$;

create or replace function set_thought_theme(thought_id uuid, new_theme text)
returns void
language sql
volatile
set search_path = 'public'
as $$
  update thoughts
  set metadata = metadata || jsonb_build_object('theme', new_theme)
  where id = thought_id;
$$;
