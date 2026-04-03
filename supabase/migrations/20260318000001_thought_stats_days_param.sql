-- Migration: Add days_back parameter to thought_stats
-- Allows time-windowed queries (e.g. "top topics in last 7 days").
-- days_back NULL (default) preserves all-time behavior.

create or replace function thought_stats(days_back integer DEFAULT NULL)
returns json
language sql
stable
as $$
  select json_build_object(
    'total_thoughts', (
      select count(*) from thoughts
      where days_back is null or created_at >= now() - (days_back || ' days')::interval
    ),
    'by_type', coalesce(
      (
        select json_object_agg(t, cnt) from (
          select metadata->>'type' as t, count(*) as cnt
          from thoughts
          where days_back is null or created_at >= now() - (days_back || ' days')::interval
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
          where days_back is null or created_at >= now() - (days_back || ' days')::interval
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
          where days_back is null or created_at >= now() - (days_back || ' days')::interval
          group by 1
          order by cnt desc
          limit 20
        ) sub
      ),
      '[]'::json
    )
  );
$$;
