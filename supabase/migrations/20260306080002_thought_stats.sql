-- Migration 004: Create thought_stats RPC for aggregate statistics
-- Returns a JSON object with total count, type breakdown, top topics, and top people.
-- All subqueries use COALESCE to handle empty tables gracefully.

create or replace function thought_stats()
returns json
language sql
stable
as $$
  select json_build_object(
    'total_thoughts', (select count(*) from thoughts),
    'by_type', coalesce(
      (
        select json_object_agg(t, cnt) from (
          select metadata->>'type' as t, count(*) as cnt
          from thoughts
          group by metadata->>'type'
        ) sub
      ),
      '{}'::json
    ),
    'top_topics', coalesce(
      (
        select json_agg(json_build_object('topic', topic, 'count', cnt) order by cnt desc)
        from (
          select jsonb_array_elements_text(metadata->'topics') as topic, count(*) as cnt
          from thoughts
          group by 1
          order by cnt desc
          limit 20
        ) sub
      ),
      '[]'::json
    ),
    'top_people', coalesce(
      (
        select json_agg(json_build_object('person', person, 'count', cnt) order by cnt desc)
        from (
          select jsonb_array_elements_text(metadata->'people') as person, count(*) as cnt
          from thoughts
          group by 1
          order by cnt desc
          limit 20
        ) sub
      ),
      '[]'::json
    )
  );
$$;
