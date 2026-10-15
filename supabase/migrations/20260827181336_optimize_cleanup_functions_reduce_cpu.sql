/*
# Optimize Cleanup Functions to Reduce CPU Usage

## Problem
- `cleanup_all_stale_sessions()` was being called by every connected client every 60 seconds
- With N users online, this caused N concurrent UPDATE queries per minute competing for locks
- The function uses dynamic interval casting `(v_stale_timeout_minutes || ' minutes')::interval`
  which prevents the query planner from using partial indexes efficiently
- No concurrency guard, so multiple executions pile up and block each other

## Solution
1. Add advisory lock to `cleanup_stale_work_sessions_optimized()` so only one runs at a time
2. Replace dynamic interval with a fixed `interval '3 minutes'` so the planner can use indexes
3. Add LIMIT to prevent scanning/updating too many rows in one pass
4. Optimize `cleanup_stale_dispatch_sessions()` similarly
5. Make `cleanup_all_stale_sessions()` skip gracefully if another call is already running

## Important Notes
1. The cron job (every 5 minutes) remains the primary cleanup mechanism
2. Frontend code no longer calls cleanup on intervals (removed from client code)
3. The one remaining on-page-load call will return immediately if another is running
4. No data changes — only function logic is updated
*/

-- 1. Optimized work sessions cleanup with advisory lock and fixed interval
CREATE OR REPLACE FUNCTION cleanup_stale_work_sessions_optimized()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  updated_count integer;
  result json;
BEGIN
  -- Advisory lock: skip if another cleanup is already running
  -- Lock ID 8675309 is arbitrary but unique to this function
  IF NOT pg_try_advisory_xact_lock(8675309) THEN
    RETURN json_build_object(
      'table', 'work_sessions',
      'skipped', true,
      'reason', 'another cleanup already running'
    );
  END IF;

  WITH stale_sessions AS (
    SELECT id
    FROM work_sessions
    WHERE end_time IS NULL
    AND (
      (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - interval '3 minutes')
      OR
      (last_heartbeat_at IS NULL AND start_time < now() - interval '3 minutes')
    )
    LIMIT 50
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE work_sessions ws
    SET 
      end_time = COALESCE(ws.last_heartbeat_at, ws.start_time) + interval '1 minute',
      duration_minutes = GREATEST(
        LEAST(
          EXTRACT(EPOCH FROM (
            COALESCE(ws.last_heartbeat_at, ws.start_time) + interval '1 minute' - ws.start_time
          )) / 60,
          480
        ),
        1
      )::integer
    FROM stale_sessions ss
    WHERE ws.id = ss.id
    RETURNING ws.id
  )
  SELECT COUNT(*) INTO updated_count FROM updated;

  result := json_build_object(
    'table', 'work_sessions',
    'sessions_closed', updated_count,
    'cleaned_at', now(),
    'method', 'heartbeat_based_duration'
  );

  RETURN result;
END;
$function$;

-- 2. Optimized dispatch sessions cleanup with advisory lock
CREATE OR REPLACE FUNCTION cleanup_stale_dispatch_sessions()
RETURNS TABLE (
  cleaned_session_id uuid,
  user_id uuid,
  started_at timestamptz,
  inactive_duration interval
) 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- Advisory lock: skip if already running
  IF NOT pg_try_advisory_xact_lock(8675310) THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE dispatch_sessions ds
  SET 
    status = 'offline',
    ended_at = ds.last_activity_at + interval '30 minutes'
  WHERE ds.status = 'online'
    AND ds.last_activity_at < now() - interval '30 minutes'
  RETURNING 
    ds.id,
    ds.user_id,
    ds.started_at,
    now() - ds.last_activity_at;
END;
$$;

-- 3. Update cleanup_all_stale_sessions to use advisory lock
CREATE OR REPLACE FUNCTION cleanup_all_stale_sessions()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  work_result json;
  dispatch_sessions_cleaned integer;
  result json;
BEGIN
  -- Top-level advisory lock: only one full cleanup runs at a time across all callers
  IF NOT pg_try_advisory_xact_lock(8675311) THEN
    RETURN json_build_object(
      'skipped', true,
      'reason', 'another cleanup already running',
      'cleaned_at', now()
    );
  END IF;

  -- Cleanup work sessions
  SELECT cleanup_stale_work_sessions_optimized() INTO work_result;
  
  -- Cleanup dispatch sessions
  SELECT COUNT(*) INTO dispatch_sessions_cleaned
  FROM cleanup_stale_dispatch_sessions();
  
  result := json_build_object(
    'work_sessions_result', work_result,
    'dispatch_sessions_cleaned', dispatch_sessions_cleaned,
    'cleaned_at', now()
  );
  
  RETURN result;
END;
$$;

-- 4. Also update the cron-called function to use the optimized version
CREATE OR REPLACE FUNCTION auto_cleanup_dispatch_system()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_recovered_orders integer;
  v_work_result json;
  v_dispatch_cleaned integer;
  result json;
BEGIN
  -- Advisory lock to prevent overlapping cron executions
  IF NOT pg_try_advisory_xact_lock(8675312) THEN
    RETURN json_build_object(
      'skipped', true,
      'reason', 'previous cron still running'
    );
  END IF;

  -- Recover stale pending orders (5 minute timeout)
  SELECT COUNT(*) INTO v_recovered_orders
  FROM auto_recover_stale_pending_orders(5);

  -- Use optimized work session cleanup (3-minute heartbeat timeout)
  SELECT cleanup_stale_work_sessions_optimized() INTO v_work_result;

  -- Cleanup stale dispatch sessions
  SELECT COUNT(*) INTO v_dispatch_cleaned
  FROM cleanup_stale_dispatch_sessions();

  result := json_build_object(
    'recovered_orders', v_recovered_orders,
    'work_sessions', v_work_result,
    'dispatch_sessions_cleaned', v_dispatch_cleaned,
    'executed_at', now()
  );
  
  RETURN result;
END;
$$;

-- 5. Create a covering index for the exact query pattern used by the optimized cleanup
-- This replaces the need for the planner to guess with dynamic intervals
CREATE INDEX IF NOT EXISTS idx_work_sessions_cleanup_scan
ON work_sessions (last_heartbeat_at, start_time)
WHERE end_time IS NULL;
