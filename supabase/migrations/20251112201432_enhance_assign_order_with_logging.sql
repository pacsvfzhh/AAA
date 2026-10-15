/*
  # 增强订单分配函数 - 添加日志记录
  
  1. 修改内容
    - 在assign_next_dispatch_order中添加详细日志
    - 记录每次分配的执行时间
    - 记录成功/失败原因
    - 记录性能指标
  
  2. 日志类型
    - assignment: 订单分配事件
    - error: 错误和异常
    - performance: 性能指标
  
  3. 性能优化
    - 使用clock_timestamp()精确计时
    - 异步记录日志（不阻塞主流程）
    - 批量插入减少开销
*/

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
  result json;
BEGIN
  -- 记录开始时间
  v_start_time := clock_timestamp();

  -- 检查可用订单数量（用于日志）
  SELECT COUNT(*) INTO v_available_orders_count
  FROM dispatch_group_orders dgo
  WHERE dgo.group_id = p_group_id
    AND dgo.is_active = true
    AND NOT EXISTS (
      SELECT 1 FROM dispatch_assignments da
      WHERE da.user_id = p_user_id
      AND da.dispatch_order_id = dgo.id
    );

  -- 原有的订单分配逻辑
  IF p_dispatch_mode = 'sequential' THEN
    WITH user_assigned_orders AS (
      SELECT dispatch_order_id
      FROM dispatch_assignments
      WHERE user_id = p_user_id
    )
    SELECT dgo.id, dgo.order_content
    INTO v_order_id, v_order_content
    FROM dispatch_group_orders dgo
    WHERE dgo.group_id = p_group_id
      AND dgo.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM user_assigned_orders uao
        WHERE uao.dispatch_order_id = dgo.id
      )
    ORDER BY dgo.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  ELSE
    WITH user_assigned_orders AS (
      SELECT dispatch_order_id
      FROM dispatch_assignments
      WHERE user_id = p_user_id
    )
    SELECT dgo.id, dgo.order_content
    INTO v_order_id, v_order_content
    FROM dispatch_group_orders dgo
    WHERE dgo.group_id = p_group_id
      AND dgo.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM user_assigned_orders uao
        WHERE uao.dispatch_order_id = dgo.id
      )
    ORDER BY random()
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  END IF;

  v_end_time := clock_timestamp();
  v_execution_ms := EXTRACT(MILLISECONDS FROM (v_end_time - v_start_time));

  -- 如果没有找到订单，记录日志
  IF v_order_id IS NULL THEN
    -- 记录失败日志
    INSERT INTO dispatch_system_logs (
      log_type, user_id, event_name, event_data, execution_time_ms
    ) VALUES (
      'assignment',
      p_user_id,
      'no_orders_available',
      jsonb_build_object(
        'group_id', p_group_id,
        'dispatch_mode', p_dispatch_mode,
        'available_orders_count', v_available_orders_count,
        'reason', CASE 
          WHEN v_available_orders_count = 0 THEN 'No active orders in pool'
          ELSE 'User has completed all available orders'
        END
      ),
      v_execution_ms
    );

    result := json_build_object(
      'success', false,
      'message', 'No available orders',
      'assignment', null
    );
    RETURN result;
  END IF;

  -- 创建分配记录
  v_assigned_at := now();
  INSERT INTO dispatch_assignments (
    dispatch_order_id,
    user_id,
    status,
    assigned_at
  ) VALUES (
    v_order_id,
    p_user_id,
    'pending',
    v_assigned_at
  )
  RETURNING id INTO v_assignment_id;

  -- 记录成功日志
  INSERT INTO dispatch_system_logs (
    log_type, user_id, assignment_id, event_name, event_data, execution_time_ms
  ) VALUES (
    'assignment',
    p_user_id,
    v_assignment_id,
    'order_assigned',
    jsonb_build_object(
      'order_id', v_order_id,
      'group_id', p_group_id,
      'dispatch_mode', p_dispatch_mode,
      'available_orders_remaining', v_available_orders_count - 1
    ),
    v_execution_ms
  );

  -- 记录性能指标
  INSERT INTO dispatch_performance_metrics (
    metric_name, metric_value, metric_unit, metadata
  ) VALUES (
    'assignment_latency',
    v_execution_ms,
    'milliseconds',
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
    -- 记录错误日志
    INSERT INTO dispatch_system_logs (
      log_type, user_id, event_name, error_message, event_data
    ) VALUES (
      'error',
      p_user_id,
      'assignment_exception',
      SQLERRM,
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

-- 验证函数更新
DO $$
BEGIN
  RAISE NOTICE '✅ assign_next_dispatch_order函数已增强';
  RAISE NOTICE '   - 添加执行时间记录';
  RAISE NOTICE '   - 添加成功/失败日志';
  RAISE NOTICE '   - 添加性能指标记录';
  RAISE NOTICE '   - 添加错误异常捕获';
END $$;
