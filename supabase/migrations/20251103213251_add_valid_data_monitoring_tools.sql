/*
  # Valid Data System Monitoring and Analytics Tools

  1. Monitoring Functions
    - `get_valid_data_system_metrics()` - Real-time system health
    - `get_valid_data_pool_status()` - Data pool utilization
    - `get_valid_data_usage_stats()` - Usage statistics and patterns
    
  2. Analytics Functions
    - `get_hot_valid_data()` - Most frequently used data
    - `detect_valid_data_bottlenecks()` - Identify issues
    
  3. Usage
    - Monitor data pool capacity
    - Identify popular transaction patterns
    - Plan data additions
*/

-- Real-time system metrics
CREATE OR REPLACE FUNCTION get_valid_data_system_metrics()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result json;
  total_valid_data integer;
  active_valid_data integer;
  total_submissions_today integer;
  unique_users_today integer;
  avg_submissions_per_user numeric;
  data_reuse_rate numeric;
BEGIN
  -- Count total and active valid data
  SELECT COUNT(*) INTO total_valid_data FROM valid_order_data;
  SELECT COUNT(*) INTO active_valid_data FROM valid_order_data WHERE is_active = true;
  
  -- Count today's submissions
  SELECT COUNT(*) INTO total_submissions_today
  FROM used_order_data
  WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC');
  
  -- Count unique users today
  SELECT COUNT(DISTINCT user_id) INTO unique_users_today
  FROM used_order_data
  WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC');
  
  -- Average submissions per user today
  IF unique_users_today > 0 THEN
    avg_submissions_per_user := total_submissions_today::numeric / unique_users_today;
  ELSE
    avg_submissions_per_user := 0;
  END IF;
  
  -- Data reuse rate (how many times each valid_order_data is used on average)
  SELECT AVG(usage_count) INTO data_reuse_rate
  FROM (
    SELECT valid_order_data_id, COUNT(*) as usage_count
    FROM used_order_data
    GROUP BY valid_order_data_id
  ) subq;
  
  result := json_build_object(
    'timestamp', now(),
    'total_valid_data', total_valid_data,
    'active_valid_data', active_valid_data,
    'inactive_valid_data', total_valid_data - active_valid_data,
    'submissions_today', total_submissions_today,
    'unique_users_today', unique_users_today,
    'avg_submissions_per_user', ROUND(avg_submissions_per_user, 2),
    'data_reuse_rate', ROUND(data_reuse_rate, 2),
    'health_status', CASE
      WHEN active_valid_data = 0 THEN 'critical_no_data'
      WHEN active_valid_data < 100 THEN 'warning_low_data'
      WHEN total_submissions_today > active_valid_data * 10 THEN 'warning_high_reuse'
      ELSE 'healthy'
    END
  );
  
  RETURN result;
END;
$$;

-- Data pool status (shows how much data is available)
CREATE OR REPLACE FUNCTION get_valid_data_pool_status()
RETURNS TABLE (
  transaction_id text,
  product_value numeric,
  total_usage_count bigint,
  unique_users_used bigint,
  is_active boolean,
  created_at timestamptz,
  last_used_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 
    vod.transaction_id,
    vod.product_value,
    COUNT(uod.id) as total_usage_count,
    COUNT(DISTINCT uod.user_id) as unique_users_used,
    vod.is_active,
    vod.created_at,
    MAX(uod.created_at) as last_used_at
  FROM valid_order_data vod
  LEFT JOIN used_order_data uod ON vod.id = uod.valid_order_data_id
  GROUP BY vod.id, vod.transaction_id, vod.product_value, vod.is_active, vod.created_at
  ORDER BY total_usage_count DESC, vod.created_at DESC
  LIMIT 100;
$$;

-- Usage statistics (shows submission patterns)
CREATE OR REPLACE FUNCTION get_valid_data_usage_stats()
RETURNS TABLE (
  date date,
  total_submissions bigint,
  unique_users bigint,
  unique_valid_data bigint,
  avg_submissions_per_user numeric,
  data_reuse_rate numeric
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 
    DATE(uod.created_at AT TIME ZONE 'UTC') as date,
    COUNT(*) as total_submissions,
    COUNT(DISTINCT uod.user_id) as unique_users,
    COUNT(DISTINCT uod.valid_order_data_id) as unique_valid_data,
    ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT uod.user_id), 0), 2) as avg_submissions_per_user,
    ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT uod.valid_order_data_id), 0), 2) as data_reuse_rate
  FROM used_order_data uod
  WHERE uod.created_at >= now() - interval '30 days'
  GROUP BY DATE(uod.created_at AT TIME ZONE 'UTC')
  ORDER BY date DESC;
$$;

-- Find most popular valid data (hot data)
CREATE OR REPLACE FUNCTION get_hot_valid_data(
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  transaction_id text,
  product_value numeric,
  usage_count bigint,
  unique_users bigint,
  first_used_at timestamptz,
  last_used_at timestamptz,
  is_active boolean
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 
    vod.transaction_id,
    vod.product_value,
    COUNT(uod.id) as usage_count,
    COUNT(DISTINCT uod.user_id) as unique_users,
    MIN(uod.created_at) as first_used_at,
    MAX(uod.created_at) as last_used_at,
    vod.is_active
  FROM valid_order_data vod
  JOIN used_order_data uod ON vod.id = uod.valid_order_data_id
  GROUP BY vod.id, vod.transaction_id, vod.product_value, vod.is_active
  ORDER BY usage_count DESC
  LIMIT p_limit;
$$;

-- Detect bottlenecks and issues
CREATE OR REPLACE FUNCTION detect_valid_data_bottlenecks()
RETURNS TABLE (
  issue_type text,
  severity text,
  description text,
  affected_count bigint,
  recommendation text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  
  -- Check if running out of active valid data
  SELECT 
    'Low Active Data'::text,
    'CRITICAL'::text,
    'Only ' || COUNT(*)::text || ' active valid_order_data records available',
    COUNT(*),
    'Add more valid_order_data records immediately to prevent submission failures'::text
  FROM valid_order_data
  WHERE is_active = true
  HAVING COUNT(*) < 100
  
  UNION ALL
  
  -- Check for overused valid data (might indicate insufficient variety)
  SELECT 
    'Overused Data'::text,
    'HIGH'::text,
    COUNT(*)::text || ' valid_order_data records used by 20+ different users',
    COUNT(*),
    'Add more variety to valid_order_data pool to distribute usage'::text
  FROM (
    SELECT valid_order_data_id, COUNT(DISTINCT user_id) as user_count
    FROM used_order_data
    GROUP BY valid_order_data_id
    HAVING COUNT(DISTINCT user_id) >= 20
  ) overused
  HAVING COUNT(*) > 0
  
  UNION ALL
  
  -- Check for users who cannot submit (exhausted all valid data)
  SELECT 
    'Users Out of Data'::text,
    'HIGH'::text,
    'Some users may have exhausted available valid_order_data',
    COUNT(DISTINCT uod.user_id),
    'Add more valid_order_data or review data pool size vs user count'::text
  FROM used_order_data uod
  WHERE (
    SELECT COUNT(DISTINCT valid_order_data_id)
    FROM used_order_data
    WHERE user_id = uod.user_id
  ) >= (
    SELECT COUNT(*)
    FROM valid_order_data
    WHERE is_active = true
  ) * 0.9
  HAVING COUNT(DISTINCT uod.user_id) > 0
  
  UNION ALL
  
  -- Check for submission spikes (potential abuse or testing)
  SELECT 
    'Submission Spike'::text,
    'MEDIUM'::text,
    u.username || ' submitted ' || COUNT(*)::text || ' orders in last hour',
    COUNT(*),
    'Verify if this is legitimate activity or implement rate limiting'::text
  FROM used_order_data uod
  JOIN users u ON uod.user_id = u.id
  WHERE uod.created_at >= now() - interval '1 hour'
  GROUP BY uod.user_id, u.username
  HAVING COUNT(*) > 20;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION get_valid_data_system_metrics() TO authenticated;
GRANT EXECUTE ON FUNCTION get_valid_data_pool_status() TO authenticated;
GRANT EXECUTE ON FUNCTION get_valid_data_usage_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION get_hot_valid_data(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION detect_valid_data_bottlenecks() TO authenticated;

-- Comments
COMMENT ON FUNCTION get_valid_data_system_metrics() IS 'Real-time valid data system health. Run every 5 minutes to monitor.';
COMMENT ON FUNCTION get_valid_data_pool_status() IS 'Shows all valid_order_data with usage statistics. Use for capacity planning.';
COMMENT ON FUNCTION get_valid_data_usage_stats() IS 'Daily submission trends over last 30 days. Identify patterns and peak times.';
COMMENT ON FUNCTION get_hot_valid_data(integer) IS 'Most frequently used valid_order_data. Helps identify popular patterns.';
COMMENT ON FUNCTION detect_valid_data_bottlenecks() IS 'Automatically detects issues. Run daily to catch problems early.';
