/*
  # Add Performance Monitoring Functions

  1. New Functions
    - `get_system_health_metrics()` - Overall system health statistics
    - `get_heartbeat_distribution()` - Shows heartbeat timing distribution
    - `get_session_age_report()` - Identifies stale sessions before cleanup
    
  2. Purpose
    - Monitor system performance at scale
    - Identify potential issues before they impact users
    - Track heartbeat efficiency
    - Optimize cleanup timing
    
  3. Usage
    - Call periodically to monitor system health
    - Use for capacity planning
    - Debug performance issues
*/

-- Function to get overall system health metrics
CREATE OR REPLACE FUNCTION get_system_health_metrics()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result json;
  online_count integer;
  active_work_sessions integer;
  avg_session_age interval;
  stale_sessions_count integer;
BEGIN
  -- Count online sessions
  SELECT COUNT(*) INTO online_count
  FROM dispatch_sessions
  WHERE status = 'online';
  
  -- Count active work sessions
  SELECT COUNT(*) INTO active_work_sessions
  FROM work_sessions
  WHERE end_time IS NULL;
  
  -- Average session age
  SELECT AVG(now() - started_at) INTO avg_session_age
  FROM dispatch_sessions
  WHERE status = 'online';
  
  -- Count sessions that will be cleaned up soon (> 2 minutes old)
  SELECT COUNT(*) INTO stale_sessions_count
  FROM dispatch_sessions
  WHERE status = 'online'
    AND last_activity_at < now() - interval '2 minutes';
  
  result := json_build_object(
    'timestamp', now(),
    'online_sessions', online_count,
    'active_work_sessions', active_work_sessions,
    'avg_session_age_minutes', EXTRACT(EPOCH FROM avg_session_age) / 60,
    'stale_sessions_count', stale_sessions_count,
    'health_status', CASE
      WHEN online_count > 2000 THEN 'warning_high_load'
      WHEN stale_sessions_count > online_count * 0.1 THEN 'warning_many_stale'
      ELSE 'healthy'
    END
  );
  
  RETURN result;
END;
$$;

-- Function to show heartbeat activity distribution
CREATE OR REPLACE FUNCTION get_heartbeat_distribution()
RETURNS TABLE (
  time_since_heartbeat text,
  session_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    CASE
      WHEN last_activity_at IS NULL THEN 'Never'
      WHEN last_activity_at > now() - interval '30 seconds' THEN '0-30s (Fresh)'
      WHEN last_activity_at > now() - interval '1 minute' THEN '30s-1m (Good)'
      WHEN last_activity_at > now() - interval '2 minutes' THEN '1-2m (OK)'
      WHEN last_activity_at > now() - interval '3 minutes' THEN '2-3m (Stale)'
      ELSE '3m+ (Will be cleaned)'
    END as time_since_heartbeat,
    COUNT(*) as session_count
  FROM dispatch_sessions
  WHERE status = 'online'
  GROUP BY 
    CASE
      WHEN last_activity_at IS NULL THEN 'Never'
      WHEN last_activity_at > now() - interval '30 seconds' THEN '0-30s (Fresh)'
      WHEN last_activity_at > now() - interval '1 minute' THEN '30s-1m (Good)'
      WHEN last_activity_at > now() - interval '2 minutes' THEN '1-2m (OK)'
      WHEN last_activity_at > now() - interval '3 minutes' THEN '2-3m (Stale)'
      ELSE '3m+ (Will be cleaned)'
    END
  ORDER BY 
    CASE
      WHEN last_activity_at IS NULL THEN 6
      WHEN last_activity_at > now() - interval '30 seconds' THEN 1
      WHEN last_activity_at > now() - interval '1 minute' THEN 2
      WHEN last_activity_at > now() - interval '2 minutes' THEN 3
      WHEN last_activity_at > now() - interval '3 minutes' THEN 4
      ELSE 5
    END;
END;
$$;

-- Function to identify sessions that need attention
CREATE OR REPLACE FUNCTION get_stale_session_report()
RETURNS TABLE (
  user_id uuid,
  username text,
  session_id uuid,
  started_at timestamptz,
  last_activity_at timestamptz,
  inactive_minutes numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ds.user_id,
    u.username,
    ds.id as session_id,
    ds.started_at,
    ds.last_activity_at,
    ROUND(EXTRACT(EPOCH FROM (now() - ds.last_activity_at)) / 60, 2) as inactive_minutes,
    ds.status
  FROM dispatch_sessions ds
  JOIN users u ON ds.user_id = u.id
  WHERE ds.status = 'online'
    AND ds.last_activity_at < now() - interval '2 minutes'
  ORDER BY ds.last_activity_at ASC
  LIMIT 50;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_system_health_metrics() TO authenticated;
GRANT EXECUTE ON FUNCTION get_heartbeat_distribution() TO authenticated;
GRANT EXECUTE ON FUNCTION get_stale_session_report() TO authenticated;

COMMENT ON FUNCTION get_system_health_metrics() IS 'Returns overall system health metrics. Monitor regularly to ensure system stability at scale.';
COMMENT ON FUNCTION get_heartbeat_distribution() IS 'Shows distribution of heartbeat timing. Use to verify heartbeat mechanism is working correctly.';
COMMENT ON FUNCTION get_stale_session_report() IS 'Lists sessions that will be cleaned up soon. Use for debugging and monitoring.';
