/*
  # Work Session Auto Integrity System

  ## Purpose
  Automatically detect and fix work session time calculation errors.

  ## Features
  1. Periodic auto-repair function that syncs work_sessions with dispatch_sessions
  2. Validation trigger on work_sessions to prevent invalid data
  3. Function to detect anomalies (work time > dispatch time)
  4. Auto-close stale sessions daily

  ## Security
  - All functions use SECURITY DEFINER with explicit search_path
*/

-- 1. Create function to auto-repair work session mismatches
CREATE OR REPLACE FUNCTION repair_work_session_mismatches()
RETURNS TABLE(
  user_id uuid,
  old_work_minutes numeric,
  new_work_minutes numeric,
  fixed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH mismatched_sessions AS (
    SELECT 
      ws.id as ws_id,
      ws.user_id,
      ws.start_time,
      ws.end_time as old_end_time,
      ds.ended_at as correct_end_time,
      EXTRACT(EPOCH FROM (COALESCE(ws.end_time, NOW()) - ws.start_time)) / 60 as old_minutes,
      EXTRACT(EPOCH FROM (ds.ended_at - ds.started_at)) / 60 as correct_minutes
    FROM work_sessions ws
    JOIN dispatch_sessions ds ON 
      ws.user_id = ds.user_id 
      AND ws.start_time >= ds.started_at - interval '5 seconds'
      AND ws.start_time <= ds.started_at + interval '5 seconds'
    WHERE ds.ended_at IS NOT NULL
      AND (
        ws.end_time IS NULL 
        OR ABS(EXTRACT(EPOCH FROM (ws.end_time - ds.ended_at))) > 60
      )
  ),
  fixed_sessions AS (
    UPDATE work_sessions ws
    SET 
      end_time = ms.correct_end_time,
      duration_minutes = ms.correct_minutes
    FROM mismatched_sessions ms
    WHERE ws.id = ms.ws_id
    RETURNING ws.user_id, ms.old_minutes, ms.correct_minutes
  )
  SELECT 
    fs.user_id,
    ROUND(fs.old_minutes::numeric, 2) as old_work_minutes,
    ROUND(fs.correct_minutes::numeric, 2) as new_work_minutes,
    true as fixed
  FROM fixed_sessions fs;
END;
$$;

-- 2. Create function to detect work time anomalies
CREATE OR REPLACE FUNCTION detect_work_time_anomalies(p_threshold_minutes integer DEFAULT 30)
RETURNS TABLE(
  user_id uuid,
  username text,
  work_session_id uuid,
  work_minutes numeric,
  dispatch_minutes numeric,
  difference_minutes numeric,
  anomaly_type text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ws.user_id,
    u.username,
    ws.id as work_session_id,
    ROUND(EXTRACT(EPOCH FROM (COALESCE(ws.end_time, NOW()) - ws.start_time)) / 60, 2) as work_minutes,
    ROUND(EXTRACT(EPOCH FROM (COALESCE(ds.ended_at, NOW()) - ds.started_at)) / 60, 2) as dispatch_minutes,
    ROUND(ABS(EXTRACT(EPOCH FROM (COALESCE(ws.end_time, NOW()) - ws.start_time)) - 
              EXTRACT(EPOCH FROM (COALESCE(ds.ended_at, NOW()) - ds.started_at))) / 60, 2) as difference_minutes,
    CASE 
      WHEN ws.end_time IS NULL AND ds.ended_at IS NOT NULL THEN 'work_session_not_closed'
      WHEN EXTRACT(EPOCH FROM (COALESCE(ws.end_time, NOW()) - ws.start_time)) > 
           EXTRACT(EPOCH FROM (COALESCE(ds.ended_at, NOW()) - ds.started_at)) + p_threshold_minutes * 60 
      THEN 'work_time_exceeds_dispatch'
      ELSE 'time_mismatch'
    END as anomaly_type
  FROM work_sessions ws
  JOIN users u ON u.id = ws.user_id
  LEFT JOIN dispatch_sessions ds ON 
    ws.user_id = ds.user_id 
    AND ws.start_time >= ds.started_at - interval '5 seconds'
    AND ws.start_time <= ds.started_at + interval '5 seconds'
  WHERE 
    ws.start_time >= NOW() - interval '7 days'
    AND (
      (ws.end_time IS NULL AND ds.ended_at IS NOT NULL)
      OR ABS(EXTRACT(EPOCH FROM (COALESCE(ws.end_time, NOW()) - ws.start_time)) - 
             EXTRACT(EPOCH FROM (COALESCE(ds.ended_at, NOW()) - ds.started_at))) > p_threshold_minutes * 60
    )
  ORDER BY difference_minutes DESC;
END;
$$;

-- 3. Create validation trigger to prevent invalid work sessions
CREATE OR REPLACE FUNCTION validate_work_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dispatch_ended_at timestamptz;
BEGIN
  -- Check if there's a corresponding dispatch session that has ended
  SELECT ended_at INTO v_dispatch_ended_at
  FROM dispatch_sessions
  WHERE user_id = NEW.user_id
    AND started_at >= NEW.start_time - interval '5 seconds'
    AND started_at <= NEW.start_time + interval '5 seconds'
  ORDER BY started_at DESC
  LIMIT 1;

  -- If dispatch session has ended but work session end_time is missing or wrong
  IF v_dispatch_ended_at IS NOT NULL AND (NEW.end_time IS NULL OR NEW.end_time > v_dispatch_ended_at + interval '1 minute') THEN
    NEW.end_time := v_dispatch_ended_at;
    NEW.duration_minutes := EXTRACT(EPOCH FROM (v_dispatch_ended_at - NEW.start_time)) / 60;
  END IF;

  RETURN NEW;
END;
$$;

-- Create trigger (drop if exists first)
DROP TRIGGER IF EXISTS trigger_validate_work_session ON work_sessions;
CREATE TRIGGER trigger_validate_work_session
  BEFORE INSERT OR UPDATE ON work_sessions
  FOR EACH ROW
  EXECUTE FUNCTION validate_work_session();

-- 4. Create scheduled cleanup function (can be called by cron)
CREATE OR REPLACE FUNCTION auto_repair_work_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fixed_count integer;
  v_anomaly_count integer;
BEGIN
  -- Run repair
  SELECT COUNT(*) INTO v_fixed_count
  FROM repair_work_session_mismatches();

  -- Count remaining anomalies
  SELECT COUNT(*) INTO v_anomaly_count
  FROM detect_work_time_anomalies(30);

  RETURN jsonb_build_object(
    'timestamp', NOW(),
    'sessions_fixed', v_fixed_count,
    'remaining_anomalies', v_anomaly_count,
    'status', CASE WHEN v_anomaly_count = 0 THEN 'healthy' ELSE 'needs_attention' END
  );
END;
$$;

-- 5. Improve the original sync function with better error handling
CREATE OR REPLACE FUNCTION sync_dispatch_session_end()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_duration_minutes integer;
  v_work_session_id uuid;
BEGIN
  -- Only process if status changed to 'offline' and ended_at is set
  IF NEW.status = 'offline' AND NEW.ended_at IS NOT NULL AND (OLD.ended_at IS NULL OR OLD.status != 'offline') THEN
    -- Calculate duration in minutes
    v_duration_minutes := EXTRACT(EPOCH FROM (NEW.ended_at - NEW.started_at)) / 60;

    -- Find and update the matching work session
    SELECT id INTO v_work_session_id
    FROM work_sessions
    WHERE user_id = NEW.user_id
      AND start_time >= NEW.started_at - interval '5 seconds'
      AND start_time <= NEW.started_at + interval '5 seconds'
    ORDER BY start_time DESC
    LIMIT 1;

    IF v_work_session_id IS NOT NULL THEN
      UPDATE work_sessions
      SET 
        end_time = NEW.ended_at,
        duration_minutes = v_duration_minutes
      WHERE id = v_work_session_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Add comments
COMMENT ON FUNCTION repair_work_session_mismatches IS 'Automatically repairs work sessions that are out of sync with dispatch sessions';
COMMENT ON FUNCTION detect_work_time_anomalies IS 'Detects work time calculation anomalies for monitoring';
COMMENT ON FUNCTION validate_work_session IS 'Validates and auto-corrects work session data on insert/update';
COMMENT ON FUNCTION auto_repair_work_sessions IS 'Scheduled function to auto-repair work sessions and report status';
