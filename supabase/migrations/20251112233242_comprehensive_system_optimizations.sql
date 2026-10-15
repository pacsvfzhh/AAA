/*
  # 🔴🟡 Comprehensive System Optimizations
  
  ## Changes Included
  1. 🔴 Zombie Order Cleanup + Auto Recovery
  2. 🟡 Empty Dispatch Group Cleanup
  3. 🟡 Improved User Notifications (Real order-taking environment)
  
  ## 1. Zombie Order Recovery
  - Automatically detect orders stuck in 'pending' for > 15 minutes
  - Mark as 'timeout_cancelled' to free them for reassignment
  - Log all recovery actions
  
  ## 2. Empty Group Cleanup  
  - Detect dispatch groups with no active orders
  - Optionally archive or flag for review
  
  ## 3. Improve assign_next_dispatch_order() messaging
  - Distinguish between "pool empty" vs "user completed all"
  - Return accurate, actionable messages
  - Support better frontend notifications
*/

-- ============================================================================
-- PART 1: Zombie Order Cleanup Functions
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_zombie_dispatch_orders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_zombie_orders RECORD;
  v_recovered_count int := 0;
  v_recovery_log jsonb := '[]'::jsonb;
BEGIN
  -- Find and recover zombie orders
  FOR v_zombie_orders IN
    SELECT 
      da.id as assignment_id,
      da.dispatch_order_id,
      da.user_id,
      da.assigned_at,
      EXTRACT(EPOCH FROM (NOW() - da.assigned_at))/60 as minutes_pending,
      u.username
    FROM dispatch_assignments da
    JOIN users u ON u.id = da.user_id
    LEFT JOIN dispatch_sessions ds ON ds.user_id = da.user_id
    WHERE da.status = 'pending'
      AND da.assigned_at < NOW() - INTERVAL '15 minutes'
      AND (ds.id IS NULL OR ds.status != 'online' OR ds.last_activity_at < NOW() - INTERVAL '2 minutes')
    ORDER BY da.assigned_at ASC
  LOOP
    -- Mark as timeout_cancelled
    UPDATE dispatch_assignments
    SET 
      status = 'timeout_cancelled',
      remarks = format(
        'Auto-recovered: Pending for %.1f minutes. System cancelled at %s.',
        v_zombie_orders.minutes_pending,
        NOW()
      )
    WHERE id = v_zombie_orders.assignment_id;
    
    -- Log recovery
    INSERT INTO dispatch_system_logs (
      log_type, user_id, assignment_id, event_name, event_data
    ) VALUES (
      'recovery', v_zombie_orders.user_id, v_zombie_orders.assignment_id,
      'zombie_order_recovered',
      jsonb_build_object(
        'dispatch_order_id', v_zombie_orders.dispatch_order_id,
        'username', v_zombie_orders.username,
        'minutes_pending', round(v_zombie_orders.minutes_pending::numeric, 1)
      )
    );
    
    -- Add to log
    v_recovery_log := v_recovery_log || jsonb_build_object(
      'assignment_id', v_zombie_orders.assignment_id,
      'username', v_zombie_orders.username,
      'minutes_pending', round(v_zombie_orders.minutes_pending::numeric, 1)
    );
    
    v_recovered_count := v_recovered_count + 1;
  END LOOP;
  
  RETURN jsonb_build_object(
    'success', true,
    'recovered_count', v_recovered_count,
    'recovered_orders', v_recovery_log,
    'recovery_timestamp', NOW()
  );
END;
$$;

-- ============================================================================
-- PART 2: Empty Group Detection
-- ============================================================================

CREATE OR REPLACE FUNCTION get_empty_dispatch_groups()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_empty_groups jsonb;
BEGIN
  SELECT jsonb_agg(
    jsonb_build_object(
      'group_id', dg.id,
      'group_name', dg.group_name,
      'is_default', dg.is_default,
      'created_at', dg.created_at,
      'member_count', (
        SELECT COUNT(*) FROM dispatch_group_members WHERE group_id = dg.id
      )
    )
  ) INTO v_empty_groups
  FROM dispatch_groups dg
  WHERE dg.is_default = false
    AND NOT EXISTS (
      SELECT 1 FROM dispatch_group_orders dgo
      WHERE dgo.group_id = dg.id AND dgo.is_active = true
    );
  
  RETURN jsonb_build_object(
    'empty_groups', COALESCE(v_empty_groups, '[]'::jsonb),
    'count', COALESCE(jsonb_array_length(v_empty_groups), 0)
  );
END;
$$;

-- ============================================================================
-- PART 3: Improve assign_next_dispatch_order() Error Messages
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
  result json;
BEGIN
  v_start_time := clock_timestamp();

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

  -- Count available orders (total - user completed)
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

  -- If no order found, determine reason
  IF v_order_id IS NULL THEN
    -- Determine precise failure reason
    IF v_total_orders_in_pool = 0 THEN
      v_failure_reason := 'No active orders in pool';
    ELSIF v_available_orders_count = 0 THEN
      v_failure_reason := 'User has completed all available orders';
    ELSE
      v_failure_reason := 'All available orders currently locked';
    END IF;

    -- Log failure with precise reason
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

  -- Record performance metric
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

    result := json_build_object(
      'success', false,
      'message', SQLERRM,
      'assignment', null
    );
    RETURN result;
END;
$$;

-- ============================================================================
-- Test Functions
-- ============================================================================

-- Test zombie cleanup
SELECT cleanup_zombie_dispatch_orders();

-- Test empty group detection
SELECT get_empty_dispatch_groups();
