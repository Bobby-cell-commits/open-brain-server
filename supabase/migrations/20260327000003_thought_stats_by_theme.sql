-- Migration: Add by_theme breakdown to thought_stats RPC
-- Same pattern as by_type: json_object_agg on metadata->>'theme'

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
    'by_theme', coalesce(
      (
        select json_object_agg(th, cnt) from (
          select metadata->>'theme' as th, count(*) as cnt
          from thoughts
          where (days_back is null or created_at >= now() - (days_back || ' days')::interval)
            and metadata->>'theme' is not null
          group by metadata->>'theme'
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
