/*
  # Improve Work Time Date Handling and Auto-Reset

  1. Issues
    - Mixed use of local time (frontend) and UTC time (database)
    - Work time doesn't automatically reset at start of new day
    - Time zone inconsistencies between different employees in different regions

  2. Solution
    - Standardize all date comparisons to use UTC
    - Database function already uses UTC (now() and date_trunc)
    - This is the correct approach for multi-timezone support
    - Frontend just needs to display correctly, calculations stay in UTC

  3. Benefits
    - Employees in different time zones see correct daily work time
    - Automatic reset at midnight UTC for all users
    - Consistent behavior across all regions
    - Server-side time prevents client manipulation

  4. Notes
    - The get_user_work_time_today function already uses UTC correctly
    - It calculates from date_trunc('day', now()) which is midnight UTC today
    - This means work time auto-resets at midnight UTC every day
    - No changes needed to the function itself
*/

-- Verify the function is correct (it already is, but let's document it)
-- This function automatically handles new day by using date_trunc('day', now())
-- which always represents the start of TODAY in UTC

COMMENT ON FUNCTION get_user_work_time_today(uuid) IS 
'Calculates total work time in seconds for a user on the current UTC day. 
Automatically resets at midnight UTC. Includes both completed sessions 
(with end_time) and the current active session (without end_time).';

-- Add a helper function to get work time for a specific date
CREATE OR REPLACE FUNCTION get_user_work_time_by_date(
  p_user_id uuid,
  p_date date
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_total_seconds integer := 0;
BEGIN
  -- Convert date to UTC timestamp range
  v_day_start := p_date::timestamptz;
  v_day_end := v_day_start + interval '1 day';

  -- Get all completed sessions for this date
  SELECT COALESCE(SUM(ws.duration_minutes * 60), 0)
  INTO v_total_seconds
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NOT NULL
    AND ws.duration_minutes IS NOT NULL
    AND ws.start_time >= v_day_start
    AND ws.start_time < v_day_end;

  RETURN COALESCE(v_total_seconds, 0);
END;
$$;

COMMENT ON FUNCTION get_user_work_time_by_date(uuid, date) IS 
'Calculates total work time in seconds for a user on a specific UTC date. 
Only includes completed sessions. Used for historical work time reports.';

-- Create a view for daily work time statistics (useful for admin dashboard)
CREATE OR REPLACE VIEW daily_work_time_stats AS
SELECT 
  ws.user_id,
  date_trunc('day', ws.start_time)::date as work_date,
  COUNT(*) as session_count,
  SUM(COALESCE(ws.duration_minutes, 0)) as total_minutes,
  SUM(COALESCE(ws.duration_minutes, 0)) * 60 as total_seconds,
  MIN(ws.start_time) as first_session_start,
  MAX(COALESCE(ws.end_time, now())) as last_session_end
FROM work_sessions ws
WHERE ws.end_time IS NOT NULL
GROUP BY ws.user_id, date_trunc('day', ws.start_time)::date;

COMMENT ON VIEW daily_work_time_stats IS 
'Aggregated daily work time statistics per user. 
All dates are in UTC. Used for admin reporting and analytics.';
