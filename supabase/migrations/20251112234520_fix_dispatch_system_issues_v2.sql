/*
  # Fix Dispatch System Issues Found in Testing
  
  ## Issues Discovered
  1. ❌ Invalid user handling causes foreign key error in error logging
  2. ⚠️ Found zombie orders that need cleanup
  3. ⚠️ Missing dispatch_mode in dispatch_config
  
  ## Fixes Applied
  1. Improve error handling for invalid users
  2. Add better validation
  3. Add missing configuration
  4. Enhance robustness
*/

-- ============================================================================
-- FIX 1: Improve error handling for invalid user_id
-- ============================================================================

CREATE OR REPLACE FUNCTION assign_next_dispatch_order(
  p_user_id uuid,
  p_group_id uuid,
  p_dispatch_mode text DEFAULT 'random'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id uuid;
  v_order_content text;
  v_assignment_id uuid;
  v_assigned_at timestamptz;
  v_start_time timestamptz;
  v_end_time timestamptz;
  v_execution_ms numeric;
  v_available_orders_count int;
  v_total_orders_in_pool int;
  v_user_completed_count int;
  v_failure_reason text;
  v_user_exists boolean;
  v_group_exists boolean;
  result json;
BEGIN
  v_start_time := clock_timestamp();

  -- Validate user exists
  SELECT EXISTS(SELECT 1 FROM users WHERE id = p_user_id) INTO v_user_exists;
  IF NOT v_user_exists THEN
    result := json_build_object(
      'success', false,
      'message', 'Invalid user ID',
      'assignment', null
    );
    RETURN result;
  END IF;

  -- Validate group exists
  SELECT EXISTS(SELECT 1 FROM dispatch_groups WHERE id = p_group_id) INTO v_group_exists;
  IF NOT v_group_exists THEN
    result := json_build_object(
      'success', false,
      'message', 'Invalid group ID',
      'assignment', null
    );
    RETURN result;
  END IF;

  -- Count total orders in pool
  SELECT COUNT(*) INTO v_total_orders_in_pool
  FROM dispatch_group_orders dgo
  WHERE dgo.group_id = p_group_id
    AND dgo.is_active = true;

  -- Count orders user has completed
  SELECT COUNT(*) INTO v_user_completed_count
  FROM dispatch_assignments da
  WHERE da.user_id = p_user_id
    AND EXISTS (
      SELECT 1 FROM dispatch_group_orders dgo
      WHERE dgo.id = da.dispatch_order_id
        AND dgo.group_id = p_group_id
        AND dgo.is_active = true
    );

  -- Count available orders
  v_available_orders_count := v_total_orders_in_pool - v_user_completed_count;

  -- Try to assign order
  IF p_dispatch_mode = 'sequential' THEN
    WITH user_assigned_orders AS (
      SELECT dispatch_order_id FROM dispatch_assignments WHERE user_id = p_user_id
    )
    SELECT dgo.id, dgo.order_content
    INTO v_order_id, v_order_content
    FROM dispatch_group_orders dgo
    WHERE dgo.group_id = p_group_id
      AND dgo.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM user_assigned_orders uao WHERE uao.dispatch_order_id = dgo.id
      )
    ORDER BY dgo.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  ELSE
    WITH user_assigned_orders AS (
      SELECT dispatch_order_id FROM dispatch_assignments WHERE user_id = p_user_id
    )
    SELECT dgo.id, dgo.order_content
    INTO v_order_id, v_order_content
    FROM dispatch_group_orders dgo
    WHERE dgo.group_id = p_group_id
      AND dgo.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM user_assigned_orders uao WHERE uao.dispatch_order_id = dgo.id
      )
    ORDER BY random()
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  END IF;

  v_end_time := clock_timestamp();
  v_execution_ms := EXTRACT(MILLISECONDS FROM (v_end_time - v_start_time));

  -- If no order found
  IF v_order_id IS NULL THEN
    IF v_total_orders_in_pool = 0 THEN
      v_failure_reason := 'No active orders in pool';
    ELSIF v_available_orders_count = 0 THEN
      v_failure_reason := 'User has completed all available orders';
    ELSE
      v_failure_reason := 'All available orders currently locked';
    END IF;

    -- Log failure
    INSERT INTO dispatch_system_logs (
      log_type, user_id, event_name, event_data, execution_time_ms
    ) VALUES (
      'assignment', p_user_id, 'no_orders_available',
      jsonb_build_object(
        'group_id', p_group_id,
        'dispatch_mode', p_dispatch_mode,
        'total_orders_in_pool', v_total_orders_in_pool,
        'user_completed_count', v_user_completed_count,
        'available_orders_count', v_available_orders_count,
        'reason', v_failure_reason
      ),
      v_execution_ms
    );

    result := json_build_object(
      'success', false,
      'message', v_failure_reason,
      'details', json_build_object(
        'total_orders', v_total_orders_in_pool,
        'completed_by_user', v_user_completed_count,
        'available', v_available_orders_count
      ),
      'assignment', null
    );
    RETURN result;
  END IF;

  -- Create assignment
  v_assigned_at := now();
  INSERT INTO dispatch_assignments (
    dispatch_order_id, user_id, status, assigned_at
  ) VALUES (
    v_order_id, p_user_id, 'pending', v_assigned_at
  )
  RETURNING id INTO v_assignment_id;

  -- Log success
  INSERT INTO dispatch_system_logs (
    log_type, user_id, assignment_id, event_name, event_data, execution_time_ms
  ) VALUES (
    'assignment', p_user_id, v_assignment_id, 'order_assigned',
    jsonb_build_object(
      'order_id', v_order_id,
      'group_id', p_group_id,
      'dispatch_mode', p_dispatch_mode,
      'available_orders_remaining', v_available_orders_count - 1
    ),
    v_execution_ms
  );

  -- Record performance
  INSERT INTO dispatch_performance_metrics (
    metric_name, metric_value, metric_unit, metadata
  ) VALUES (
    'assignment_latency', v_execution_ms, 'milliseconds',
    jsonb_build_object(
      'user_id', p_user_id,
      'group_id', p_group_id,
      'dispatch_mode', p_dispatch_mode
    )
  );

  result := json_build_object(
    'success', true,
    'assignment', json_build_object(
      'id', v_assignment_id,
      'dispatch_order_id', v_order_id,
      'order_content', v_order_content,
      'status', 'pending',
      'assigned_at', v_assigned_at
    )
  );

  RETURN result;

EXCEPTION
  WHEN OTHERS THEN
    -- Safe error logging (only if user exists)
    IF v_user_exists THEN
      BEGIN
        INSERT INTO dispatch_system_logs (
          log_type, user_id, event_name, error_message, event_data
        ) VALUES (
          'error', p_user_id, 'assignment_exception', SQLERRM,
          jsonb_build_object(
            'group_id', p_group_id,
            'dispatch_mode', p_dispatch_mode,
            'sqlstate', SQLSTATE
          )
        );
      EXCEPTION
        WHEN OTHERS THEN
          NULL;
      END;
    END IF;

    result := json_build_object(
      'success', false,
      'message', SQLERRM,
      'assignment', null
    );
    RETURN result;
END;
$$;

-- ============================================================================
-- FIX 2: Add missing dispatch_mode config
-- ============================================================================

INSERT INTO dispatch_config (config_key, config_value)
VALUES ('dispatch_mode', 'random')
ON CONFLICT (config_key) DO NOTHING;

-- ============================================================================
-- FIX 3: Add comprehensive health check function
-- ============================================================================

DROP FUNCTION IF EXISTS get_dispatch_system_health();

CREATE FUNCTION get_dispatch_system_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_health jsonb;
  v_total_groups int;
  v_active_groups int;
  v_total_orders int;
  v_active_sessions int;
  v_pending_assignments int;
  v_zombie_orders int;
  v_avg_assignment_time numeric;
BEGIN
  SELECT COUNT(*) INTO v_total_groups FROM dispatch_groups;
  SELECT COUNT(*) INTO v_active_groups FROM dispatch_groups WHERE is_active = true;
  SELECT COUNT(*) INTO v_total_orders FROM dispatch_group_orders WHERE is_active = true;
  SELECT COUNT(*) INTO v_active_sessions FROM dispatch_sessions WHERE status = 'online';
  SELECT COUNT(*) INTO v_pending_assignments FROM dispatch_assignments WHERE status = 'pending';
  
  SELECT COUNT(*) INTO v_zombie_orders
  FROM dispatch_assignments da
  LEFT JOIN dispatch_sessions ds ON ds.user_id = da.user_id
  WHERE da.status = 'pending'
    AND da.assigned_at < NOW() - INTERVAL '15 minutes'
    AND (ds.id IS NULL OR ds.status != 'online' OR ds.last_activity_at < NOW() - INTERVAL '2 minutes');
  
  SELECT ROUND(AVG(execution_time_ms)::numeric, 2) INTO v_avg_assignment_time
  FROM dispatch_system_logs
  WHERE log_type = 'assignment'
    AND event_name = 'order_assigned'
    AND created_at > NOW() - INTERVAL '1 hour';
  
  v_health := jsonb_build_object(
    'timestamp', NOW(),
    'status', CASE 
      WHEN v_zombie_orders > 10 THEN 'unhealthy'
      WHEN v_zombie_orders > 0 THEN 'warning'
      ELSE 'healthy'
    END,
    'metrics', jsonb_build_object(
      'total_groups', v_total_groups,
      'active_groups', v_active_groups,
      'total_active_orders', v_total_orders,
      'active_sessions', v_active_sessions,
      'pending_assignments', v_pending_assignments,
      'zombie_orders', v_zombie_orders,
      'avg_assignment_time_ms', v_avg_assignment_time
    ),
    'recommendations', CASE 
      WHEN v_zombie_orders > 0 THEN jsonb_build_array('Run cleanup_zombie_dispatch_orders()')
      ELSE jsonb_build_array()
    END
  );
  
  RETURN v_health;
END;
$$;
