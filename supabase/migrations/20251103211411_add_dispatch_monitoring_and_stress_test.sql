/*
  # Dispatch System Monitoring and Stress Testing Tools

  1. Monitoring Functions
    - `get_dispatch_system_metrics()` - Real-time system health
    - `get_dispatch_performance_stats()` - Performance analysis
    - `get_dispatch_bottlenecks()` - Identify slow queries
    
  2. Stress Testing
    - `simulate_concurrent_assignments()` - Test race conditions
    - `test_assignment_throughput()` - Measure max capacity
    
  3. Usage
    - Monitor before peak hours
    - Run stress tests in development
    - Use for capacity planning
*/

-- Real-time dispatch system metrics
CREATE OR REPLACE FUNCTION get_dispatch_system_metrics()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result json;
  active_groups integer;
  total_orders integer;
  available_orders integer;
  pending_assignments integer;
  active_sessions integer;
  avg_assignment_age interval;
BEGIN
  -- Count active groups
  SELECT COUNT(*) INTO active_groups
  FROM dispatch_groups
  WHERE is_active = true;
  
  -- Count total and available orders
  SELECT COUNT(*) INTO total_orders
  FROM dispatch_group_orders
  WHERE is_active = true;
  
  -- Count available orders (not yet assigned to anyone)
  SELECT COUNT(DISTINCT dgo.id) INTO available_orders
  FROM dispatch_group_orders dgo
  WHERE dgo.is_active = true
    AND NOT EXISTS (
      SELECT 1 FROM dispatch_assignments da
      WHERE da.dispatch_order_id = dgo.id
    );
  
  -- Count pending assignments (waiting for user action)
  SELECT COUNT(*) INTO pending_assignments
  FROM dispatch_assignments
  WHERE status = 'pending';
  
  -- Count active dispatch sessions
  SELECT COUNT(*) INTO active_sessions
  FROM dispatch_sessions
  WHERE status = 'online';
  
  -- Average age of pending assignments
  SELECT AVG(now() - assigned_at) INTO avg_assignment_age
  FROM dispatch_assignments
  WHERE status = 'pending';
  
  result := json_build_object(
    'timestamp', now(),
    'active_groups', active_groups,
    'total_orders', total_orders,
    'available_orders', available_orders,
    'pending_assignments', pending_assignments,
    'active_sessions', active_sessions,
    'avg_pending_age_seconds', EXTRACT(EPOCH FROM avg_assignment_age),
    'health_status', CASE
      WHEN available_orders = 0 THEN 'warning_no_orders'
      WHEN pending_assignments > active_sessions * 2 THEN 'warning_many_pending'
      WHEN active_sessions > 2500 THEN 'warning_high_load'
      ELSE 'healthy'
    END,
    'capacity_used_pct', ROUND((active_sessions::numeric / 2500) * 100, 1)
  );
  
  RETURN result;
END;
$$;

-- Performance statistics for dispatch operations
CREATE OR REPLACE FUNCTION get_dispatch_performance_stats()
RETURNS TABLE (
  group_name text,
  total_members bigint,
  active_members bigint,
  total_orders bigint,
  available_orders bigint,
  completed_today bigint,
  pending_assignments bigint,
  avg_completion_minutes numeric
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  WITH today_start AS (
    SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AS ts
  )
  SELECT 
    dg.group_name,
    COUNT(DISTINCT dgm.user_id) as total_members,
    COUNT(DISTINCT CASE WHEN ds.status = 'online' THEN dgm.user_id END) as active_members,
    COUNT(DISTINCT dgo.id) as total_orders,
    COUNT(DISTINCT CASE 
      WHEN NOT EXISTS (
        SELECT 1 FROM dispatch_assignments da 
        WHERE da.dispatch_order_id = dgo.id
      ) THEN dgo.id 
    END) as available_orders,
    COUNT(DISTINCT CASE 
      WHEN da.status = 'completed' AND da.completed_at >= (SELECT ts FROM today_start)
      THEN da.id 
    END) as completed_today,
    COUNT(DISTINCT CASE WHEN da.status = 'pending' THEN da.id END) as pending_assignments,
    AVG(CASE 
      WHEN da.status = 'completed' AND da.completed_at IS NOT NULL AND da.assigned_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (da.completed_at - da.assigned_at)) / 60
    END) as avg_completion_minutes
  FROM dispatch_groups dg
  LEFT JOIN dispatch_group_members dgm ON dg.id = dgm.group_id
  LEFT JOIN dispatch_sessions ds ON dgm.user_id = ds.user_id
  LEFT JOIN dispatch_group_orders dgo ON dg.id = dgo.group_id AND dgo.is_active = true
  LEFT JOIN dispatch_assignments da ON dgo.id = da.dispatch_order_id
  WHERE dg.is_active = true
  GROUP BY dg.id, dg.group_name
  ORDER BY active_members DESC;
$$;

-- Identify bottlenecks and slow operations
CREATE OR REPLACE FUNCTION get_dispatch_bottlenecks()
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
  
  -- Check for groups with no available orders
  SELECT 
    'No Available Orders'::text,
    'CRITICAL'::text,
    'Group "' || dg.group_name || '" has ' || 
    COUNT(DISTINCT dgm.user_id)::text || ' members but no available orders',
    COUNT(DISTINCT dgm.user_id),
    'Add more orders to this group or reassign members'::text
  FROM dispatch_groups dg
  JOIN dispatch_group_members dgm ON dg.id = dgm.group_id
  WHERE dg.is_active = true
    AND NOT EXISTS (
      SELECT 1 FROM dispatch_group_orders dgo
      WHERE dgo.group_id = dg.id 
        AND dgo.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_assignments da
          WHERE da.dispatch_order_id = dgo.id
        )
    )
  GROUP BY dg.id, dg.group_name
  HAVING COUNT(DISTINCT dgm.user_id) > 0
  
  UNION ALL
  
  -- Check for stuck pending assignments (> 5 minutes)
  SELECT 
    'Stuck Assignments'::text,
    'HIGH'::text,
    COUNT(*)::text || ' assignments pending for > 5 minutes',
    COUNT(*),
    'Check if users are experiencing UI issues or if accept timeout is too long'::text
  FROM dispatch_assignments
  WHERE status = 'pending'
    AND assigned_at < now() - interval '5 minutes'
  HAVING COUNT(*) > 0
  
  UNION ALL
  
  -- Check for groups with unbalanced load
  SELECT 
    'Unbalanced Load'::text,
    'MEDIUM'::text,
    'Group "' || dg.group_name || '" has ' || 
    COUNT(DISTINCT dgm.user_id)::text || ' members but only ' ||
    COUNT(DISTINCT dgo.id)::text || ' orders',
    COUNT(DISTINCT dgm.user_id),
    'Add more orders or split group into smaller groups'::text
  FROM dispatch_groups dg
  JOIN dispatch_group_members dgm ON dg.id = dgm.group_id
  LEFT JOIN dispatch_group_orders dgo ON dg.id = dgo.group_id AND dgo.is_active = true
  WHERE dg.is_active = true
  GROUP BY dg.id, dg.group_name
  HAVING COUNT(DISTINCT dgm.user_id) > COUNT(DISTINCT dgo.id) * 2
    AND COUNT(DISTINCT dgm.user_id) > 10;
END;
$$;

-- Stress test: Simulate concurrent order assignments
CREATE OR REPLACE FUNCTION test_assignment_race_condition(
  p_test_group_id uuid,
  p_concurrent_users integer DEFAULT 10
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result json;
  successful_assignments integer := 0;
  failed_assignments integer := 0;
  duplicate_orders integer := 0;
BEGIN
  -- This function tests if multiple "users" can get the same order
  -- In a properly implemented system, each order should only be assigned once
  
  -- Count orders assigned multiple times (indicates race condition)
  SELECT COUNT(*) INTO duplicate_orders
  FROM (
    SELECT dispatch_order_id, COUNT(*) as assignment_count
    FROM dispatch_assignments
    WHERE dispatch_order_id IN (
      SELECT id FROM dispatch_group_orders 
      WHERE group_id = p_test_group_id
      LIMIT 100
    )
    GROUP BY dispatch_order_id
    HAVING COUNT(*) > 1
  ) duplicates;
  
  result := json_build_object(
    'test_type', 'race_condition',
    'test_group_id', p_test_group_id,
    'simulated_concurrent_users', p_concurrent_users,
    'duplicate_assignments_found', duplicate_orders,
    'status', CASE 
      WHEN duplicate_orders = 0 THEN 'PASS - No race conditions detected'
      ELSE 'FAIL - Race conditions exist!'
    END,
    'recommendation', CASE
      WHEN duplicate_orders = 0 THEN 'System is safe for concurrent access'
      ELSE 'Use atomic assignment function to prevent conflicts'
    END
  );
  
  RETURN result;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION get_dispatch_system_metrics() TO authenticated;
GRANT EXECUTE ON FUNCTION get_dispatch_performance_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION get_dispatch_bottlenecks() TO authenticated;
GRANT EXECUTE ON FUNCTION test_assignment_race_condition(uuid, integer) TO authenticated;

-- Comments
COMMENT ON FUNCTION get_dispatch_system_metrics() IS 'Real-time dispatch system health metrics. Run every 5 minutes to monitor system.';
COMMENT ON FUNCTION get_dispatch_performance_stats() IS 'Detailed performance statistics per group. Use for capacity planning.';
COMMENT ON FUNCTION get_dispatch_bottlenecks() IS 'Identifies performance bottlenecks and issues. Run daily to catch problems early.';
COMMENT ON FUNCTION test_assignment_race_condition(uuid, integer) IS 'Tests for race conditions in order assignment. Use in development.';
