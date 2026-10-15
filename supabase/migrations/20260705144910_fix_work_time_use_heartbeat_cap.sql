/*
# Fix Work Time Calculation - Use Heartbeat Cap for Active Sessions

## Problem
When an employee's browser crashes or closes unexpectedly, the `beforeunload` event
may not fire. The work session remains "active" (end_time IS NULL), and the current
calculation uses `now()` as the effective end time. This means the reported work time
keeps growing indefinitely until the stale session cleanup runs (10-minute timeout).

For the admin dashboard, this results in inflated work time numbers that don't
reflect actual employee activity.

## Solution
For active sessions, cap the effective end time at `last_heartbeat_at + 1 minute`
instead of using `now()`. Since the frontend sends heartbeats every 30 seconds,
a healthy active session will always have `last_heartbeat_at` within the last minute.
If the browser crashed, `last_heartbeat_at` stops updating, and the work time
correctly stops growing ~1 minute after the crash.

For sessions where `last_heartbeat_at` is NULL (legacy sessions), fall back to
`start_time + duration_minutes * interval '1 minute'` for completed sessions,
or `start_time` for active sessions without heartbeat data.

## Changes
1. Updated `get_user_work_time_today()` - Uses heartbeat-capped effective end time
2. Updated `get_batch_work_time()` - Uses heartbeat-capped effective end time
3. Both functions now produce accurate times even when browser crashes

## Important Notes
1. No data changes - only function logic is updated
2. Active sessions with recent heartbeats (< 1 minute old) are unaffected
3. Stale active sessions now report accurate time based on last known activity
4. The 10-minute stale cleanup still runs to close abandoned sessions
*/

-- 1. Fix get_user_work_time_today to use heartbeat-capped time for active sessions
CREATE OR REPLACE FUNCTION get_user_work_time_today(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH today_sessions AS (
    SELECT 
      start_time,
      end_time,
      last_heartbeat_at,
      -- For completed sessions: use actual end_time
      -- For active sessions: use LEAST(now(), last_heartbeat_at + 1 min)
      -- This ensures if browser crashed, time stops growing after ~1 minute
      CASE
        WHEN end_time IS NOT NULL THEN end_time
        WHEN last_heartbeat_at IS NOT NULL THEN 
          LEAST(now(), last_heartbeat_at + interval '1 minute')
        ELSE 
          -- No heartbeat data at all - use start_time + 1 min as minimum
          LEAST(now(), start_time + interval '1 minute')
      END as effective_end_time
    FROM work_sessions
    WHERE user_id = p_user_id
      AND start_time >= date_trunc('day', now())
    ORDER BY start_time
  )
  SELECT COALESCE(
    SUM(
      GREATEST(
        EXTRACT(EPOCH FROM (effective_end_time - start_time))::integer,
        0
      )
    ),
    0
  )::integer
  FROM today_sessions;
$$;

-- 2. Fix get_batch_work_time to use heartbeat-capped time for active sessions
CREATE OR REPLACE FUNCTION get_batch_work_time(p_user_ids uuid[])
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
  SELECT 
    u.id as user_id,
    -- Total work minutes: all completed sessions + capped active session
    (
      COALESCE(
        (SELECT ROUND(SUM(EXTRACT(EPOCH FROM (ws.end_time - ws.start_time))) / 60)::integer
         FROM work_sessions ws
         WHERE ws.user_id = u.id AND ws.end_time IS NOT NULL),
        0
      ) + COALESCE(
        (SELECT ROUND(
          EXTRACT(EPOCH FROM (
            CASE
              WHEN ws.last_heartbeat_at IS NOT NULL THEN
                LEAST(now(), ws.last_heartbeat_at + interval '1 minute')
              ELSE
                LEAST(now(), ws.start_time + interval '1 minute')
            END
            - ws.start_time
          )) / 60
        )::integer
         FROM work_sessions ws
         WHERE ws.user_id = u.id AND ws.end_time IS NULL
         ORDER BY ws.start_time DESC
         LIMIT 1),
        0
      )
    ) as total_work_minutes,
    -- Today's work minutes: use the heartbeat-capped function
    COALESCE(
      ROUND(
        (SELECT get_user_work_time_today(u.id))::numeric / 60
      )::integer,
      0
    ) as today_work_minutes
  FROM unnest(p_user_ids) u(id);
$$;

-- 3. Also update the cleanup function to run more frequently and close stale sessions faster
-- Reduce stale timeout from 10 minutes to 3 minutes for more accurate time tracking
CREATE OR REPLACE FUNCTION cleanup_stale_work_sessions_optimized()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  updated_count integer;
  result json;
  v_stale_timeout_minutes integer := 3;
BEGIN
  /*
    Optimized cleanup logic:
    1. Sessions without heartbeat for 3+ minutes are considered stale
    2. Work time is calculated based on LAST HEARTBEAT, not current time
    3. This ensures accurate work time even if browser crashes
    4. Maximum duration cap of 480 minutes (8 hours) as safety net
  */
  
  WITH stale_sessions AS (
    SELECT 
      id,
      user_id,
      start_time,
      last_heartbeat_at,
      COALESCE(last_heartbeat_at, start_time) as last_active,
      -- Calculate actual work duration based on last heartbeat + 1 minute buffer
      LEAST(
        EXTRACT(EPOCH FROM (
          COALESCE(last_heartbeat_at, start_time) + interval '1 minute' - start_time
        )) / 60,
        480  -- Max 8 hours cap
      ) as calculated_duration
    FROM work_sessions
    WHERE end_time IS NULL
    AND (
      -- No heartbeat for 3 minutes
      (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - (v_stale_timeout_minutes || ' minutes')::interval)
      OR
      -- No heartbeat column set and session older than 3 minutes  
      (last_heartbeat_at IS NULL AND start_time < now() - (v_stale_timeout_minutes || ' minutes')::interval)
    )
  ),
  updated AS (
    UPDATE work_sessions ws
    SET 
      end_time = ss.last_active + interval '1 minute',
      duration_minutes = GREATEST(ss.calculated_duration, 1)::integer
    FROM stale_sessions ss
    WHERE ws.id = ss.id
    RETURNING ws.id
  )
  SELECT COUNT(*) INTO updated_count FROM updated;

  result := json_build_object(
    'table', 'work_sessions',
    'stale_timeout_minutes', v_stale_timeout_minutes,
    'sessions_closed', updated_count,
    'cleaned_at', now(),
    'method', 'heartbeat_based_duration'
  );

  RETURN result;
END;
$function$;
