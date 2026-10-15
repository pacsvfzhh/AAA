CREATE OR REPLACE FUNCTION public.get_user_work_time_today(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
WITH bounds AS (
  SELECT date_trunc('day', now()) AS day_start
), normalized AS (
  SELECT
    ws.id,
    ws.start_time,
    CASE
      WHEN ws.end_time IS NOT NULL THEN ws.end_time
      WHEN ws.last_heartbeat_at IS NOT NULL THEN LEAST(now(), ws.last_heartbeat_at + interval '1 minute')
      ELSE LEAST(now(), ws.start_time + interval '1 minute')
    END AS effective_end
  FROM public.work_sessions ws
  WHERE ws.user_id = p_user_id
), valid AS (
  SELECT *
  FROM normalized
  WHERE effective_end > start_time
), ordered AS (
  SELECT
    valid.*,
    max(effective_end) OVER (
      ORDER BY start_time, effective_end, id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS previous_max_end
  FROM valid
), marked AS (
  SELECT
    ordered.*,
    CASE
      WHEN previous_max_end IS NULL OR start_time > previous_max_end THEN 1
      ELSE 0
    END AS starts_group
  FROM ordered
), grouped AS (
  SELECT
    marked.*,
    sum(starts_group) OVER (
      ORDER BY start_time, effective_end, id
      ROWS UNBOUNDED PRECEDING
    ) AS group_id
  FROM marked
), merged AS (
  SELECT
    min(start_time) AS start_time,
    max(effective_end) AS end_time
  FROM grouped
  GROUP BY group_id
)
SELECT COALESCE(
  round(sum(
    CASE
      WHEN merged.end_time > bounds.day_start
        AND merged.start_time < bounds.day_start + interval '1 day'
      THEN extract(epoch FROM (
        least(merged.end_time, bounds.day_start + interval '1 day')
        - greatest(merged.start_time, bounds.day_start)
      ))
      ELSE 0
    END
  ))::integer,
  0
)
FROM merged
CROSS JOIN bounds;
$$;

CREATE OR REPLACE FUNCTION public.get_batch_work_time(p_user_ids uuid[])
RETURNS TABLE(
  user_id uuid,
  total_work_minutes integer,
  today_work_minutes integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
WITH requested_users AS (
  SELECT DISTINCT id
  FROM unnest(p_user_ids) AS input(id)
), normalized AS (
  SELECT
    ws.id,
    ws.user_id,
    ws.start_time,
    CASE
      WHEN ws.end_time IS NOT NULL THEN ws.end_time
      WHEN ws.last_heartbeat_at IS NOT NULL THEN LEAST(now(), ws.last_heartbeat_at + interval '1 minute')
      ELSE LEAST(now(), ws.start_time + interval '1 minute')
    END AS effective_end
  FROM public.work_sessions ws
  JOIN requested_users requested ON requested.id = ws.user_id
), valid AS (
  SELECT *
  FROM normalized
  WHERE effective_end > start_time
), ordered AS (
  SELECT
    valid.*,
    max(effective_end) OVER (
      PARTITION BY user_id
      ORDER BY start_time, effective_end, id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS previous_max_end
  FROM valid
), marked AS (
  SELECT
    ordered.*,
    CASE
      WHEN previous_max_end IS NULL OR start_time > previous_max_end THEN 1
      ELSE 0
    END AS starts_group
  FROM ordered
), grouped AS (
  SELECT
    marked.*,
    sum(starts_group) OVER (
      PARTITION BY user_id
      ORDER BY start_time, effective_end, id
      ROWS UNBOUNDED PRECEDING
    ) AS group_id
  FROM marked
), merged AS (
  SELECT
    user_id,
    min(start_time) AS start_time,
    max(effective_end) AS end_time
  FROM grouped
  GROUP BY user_id, group_id
), bounds AS (
  SELECT date_trunc('day', now()) AS day_start
), totals AS (
  SELECT
    merged.user_id,
    round(sum(extract(epoch FROM (merged.end_time - merged.start_time))) / 60)::integer AS total_work_minutes,
    round(sum(
      CASE
        WHEN merged.end_time > bounds.day_start
          AND merged.start_time < bounds.day_start + interval '1 day'
        THEN extract(epoch FROM (
          least(merged.end_time, bounds.day_start + interval '1 day')
          - greatest(merged.start_time, bounds.day_start)
        ))
        ELSE 0
      END
    ) / 60)::integer AS today_work_minutes
  FROM merged
  CROSS JOIN bounds
  GROUP BY merged.user_id
)
SELECT
  requested_users.id AS user_id,
  COALESCE(totals.total_work_minutes, 0) AS total_work_minutes,
  COALESCE(totals.today_work_minutes, 0) AS today_work_minutes
FROM requested_users
LEFT JOIN totals ON totals.user_id = requested_users.id;
$$;

CREATE OR REPLACE FUNCTION public.end_work_session(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_session_id uuid;
  v_start_time timestamptz;
  v_last_heartbeat timestamptz;
  v_end_time timestamptz;
  v_duration integer;
BEGIN
  SELECT id, start_time, last_heartbeat_at
  INTO v_session_id, v_start_time, v_last_heartbeat
  FROM public.work_sessions
  WHERE user_id = p_user_id AND end_time IS NULL
  ORDER BY start_time DESC
  LIMIT 1;

  IF v_session_id IS NULL THEN
    RETURN false;
  END IF;

  v_end_time := CASE
    WHEN v_last_heartbeat IS NOT NULL
      AND v_last_heartbeat < now() - interval '2 minutes'
    THEN GREATEST(v_last_heartbeat + interval '1 minute', v_start_time)
    ELSE GREATEST(now(), v_start_time)
  END;
  v_duration := GREATEST(round(extract(epoch FROM (v_end_time - v_start_time)) / 60)::integer, 0);

  UPDATE public.work_sessions
  SET end_time = v_end_time,
      duration_minutes = v_duration
  WHERE id = v_session_id;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.end_work_session_by_user(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_session_id uuid;
  v_start_time timestamptz;
  v_last_heartbeat timestamptz;
  v_end_time timestamptz;
  v_duration integer;
BEGIN
  SELECT id, start_time, last_heartbeat_at
  INTO v_session_id, v_start_time, v_last_heartbeat
  FROM public.work_sessions
  WHERE user_id = p_user_id AND end_time IS NULL
  ORDER BY start_time DESC
  LIMIT 1;

  IF v_session_id IS NULL THEN
    RETURN json_build_object('success', false, 'reason', 'no_active_session');
  END IF;

  v_end_time := CASE
    WHEN v_last_heartbeat IS NOT NULL
      AND v_last_heartbeat < now() - interval '2 minutes'
    THEN GREATEST(v_last_heartbeat + interval '1 minute', v_start_time)
    ELSE GREATEST(now(), v_start_time)
  END;
  v_duration := GREATEST(round(extract(epoch FROM (v_end_time - v_start_time)) / 60)::integer, 0);

  UPDATE public.work_sessions
  SET end_time = v_end_time,
      duration_minutes = v_duration
  WHERE id = v_session_id;

  UPDATE public.dispatch_sessions
  SET status = 'offline',
      ended_at = v_end_time
  WHERE user_id = p_user_id
    AND status = 'online';

  RETURN json_build_object(
    'success', true,
    'session_id', v_session_id,
    'end_time', v_end_time,
    'duration_minutes', v_duration
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_stale_work_sessions_optimized()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  updated_count integer;
  result json;
  v_stale_timeout_minutes integer := 3;
BEGIN
  WITH stale_sessions AS (
    SELECT
      id,
      user_id,
      start_time,
      COALESCE(last_heartbeat_at, start_time) AS last_active,
      GREATEST(
        LEAST(
          extract(epoch FROM (COALESCE(last_heartbeat_at, start_time) + interval '1 minute' - start_time)) / 60,
          480
        ),
        0
      ) AS calculated_duration
    FROM public.work_sessions
    WHERE end_time IS NULL
      AND (
        (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - make_interval(mins => v_stale_timeout_minutes))
        OR (last_heartbeat_at IS NULL AND start_time < now() - make_interval(mins => v_stale_timeout_minutes))
      )
  ), updated AS (
    UPDATE public.work_sessions ws
    SET end_time = GREATEST(ss.last_active + interval '1 minute', ss.start_time),
        duration_minutes = round(ss.calculated_duration)::integer
    FROM stale_sessions ss
    WHERE ws.id = ss.id
    RETURNING ws.id
  )
  SELECT count(*) INTO updated_count FROM updated;

  result := json_build_object(
    'table', 'work_sessions',
    'stale_timeout_minutes', v_stale_timeout_minutes,
    'sessions_closed', updated_count,
    'cleaned_at', now(),
    'method', 'heartbeat_based_duration'
  );

  RETURN result;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.work_sessions'::regclass
      AND conname = 'work_sessions_valid_time_range'
  ) THEN
    ALTER TABLE public.work_sessions
      ADD CONSTRAINT work_sessions_valid_time_range
      CHECK (end_time IS NULL OR end_time >= start_time)
      NOT VALID;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_work_time_today(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_batch_work_time(uuid[]) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.end_work_session(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.end_work_session_by_user(uuid) TO anon, authenticated, service_role;
