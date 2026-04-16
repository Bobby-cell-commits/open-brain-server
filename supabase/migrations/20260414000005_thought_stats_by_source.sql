-- Add by_source aggregation to thought_stats RPC
SET search_path = 'public';

CREATE OR REPLACE FUNCTION thought_stats(
  p_brain_id uuid,
  days_back integer DEFAULT NULL
)
RETURNS json
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  SELECT json_build_object(
    'total_thoughts', (
      SELECT count(*) FROM thoughts
      WHERE brain_id = p_brain_id
        AND archived_at IS NULL
        AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
    ),
    'by_type', coalesce(
      (
        SELECT json_object_agg(t, cnt) FROM (
          SELECT metadata->>'type' AS t, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND archived_at IS NULL
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
          GROUP BY metadata->>'type'
        ) sub
      ),
      '{}'::json
    ),
    'by_theme', coalesce(
      (
        SELECT json_object_agg(th, cnt) FROM (
          SELECT metadata->>'theme' AS th, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND archived_at IS NULL
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
            AND metadata->>'theme' IS NOT NULL
          GROUP BY metadata->>'theme'
        ) sub
      ),
      '{}'::json
    ),
    'by_source', coalesce(
      (
        SELECT json_object_agg(s, cnt) FROM (
          SELECT source AS s, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND archived_at IS NULL
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
          GROUP BY source
        ) sub
      ),
      '{}'::json
    ),
    'top_topics', coalesce(
      (
        SELECT json_agg(json_build_object('topic', topic, 'count', cnt) ORDER BY cnt DESC)
        FROM (
          SELECT jsonb_array_elements_text(metadata->'topics') AS topic, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND archived_at IS NULL
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
          GROUP BY 1
          ORDER BY cnt DESC
          LIMIT 20
        ) sub
      ),
      '[]'::json
    ),
    'top_people', coalesce(
      (
        SELECT json_agg(json_build_object('person', person, 'count', cnt) ORDER BY cnt DESC)
        FROM (
          SELECT jsonb_array_elements_text(metadata->'people') AS person, count(*) AS cnt
          FROM thoughts
          WHERE brain_id = p_brain_id
            AND archived_at IS NULL
            AND (days_back IS NULL OR created_at >= now() - (days_back || ' days')::interval)
          GROUP BY 1
          ORDER BY cnt DESC
          LIMIT 20
        ) sub
      ),
      '[]'::json
    )
  );
$$;
