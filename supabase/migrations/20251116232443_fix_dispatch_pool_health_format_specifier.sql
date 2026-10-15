/*
  # Fix format() specifier in check_dispatch_pool_health function
  
  ## Problem
  - Using printf-style format specifiers (%.2f) which are not supported by PostgreSQL's format()
  - PostgreSQL format() uses %s for strings and %I/%L for identifiers/literals
  - Need to use ROUND() and cast to text instead
  
  ## Solution
  - Replace format('%.2f', value) with ROUND(value, 2)::text
  - Or use concatenation instead of format()
*/

CREATE OR REPLACE FUNCTION check_dispatch_pool_health(p_group_id uuid)
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_total_orders int;
  v_active_orders int;
  v_completed_assignments int;
  v_active_employees int;
  v_orders_per_employee numeric;
  v_health_status text;
  v_recommendations text[];
BEGIN
  -- 统计订单池信息
  SELECT COUNT(*) INTO v_total_orders
  FROM dispatch_group_orders
  WHERE group_id = p_group_id;

  SELECT COUNT(*) INTO v_active_orders
  FROM dispatch_group_orders
  WHERE group_id = p_group_id AND is_active = true;

  -- 统计已完成的分配数
  SELECT COUNT(DISTINCT user_id || '-' || dispatch_order_id) INTO v_completed_assignments
  FROM dispatch_assignments da
  JOIN dispatch_group_orders dgo ON dgo.id = da.dispatch_order_id
  WHERE dgo.group_id = p_group_id;

  -- 统计活跃员工数（最近1小时有活动的）
  SELECT COUNT(DISTINCT user_id) INTO v_active_employees
  FROM dispatch_sessions
  WHERE status = 'online'
    OR (status = 'offline' AND last_activity_at > now() - interval '1 hour');

  -- 计算每个员工的平均可用订单数
  IF v_active_employees > 0 THEN
    v_orders_per_employee := v_active_orders::numeric / v_active_employees;
  ELSE
    v_orders_per_employee := v_active_orders;
  END IF;

  -- 评估健康状态
  IF v_active_orders = 0 THEN
    v_health_status := 'CRITICAL';
    v_recommendations := ARRAY['⚠️ No active orders in pool - add new orders immediately'];
  ELSIF v_orders_per_employee < 2 THEN
    v_health_status := 'WARNING';
    v_recommendations := ARRAY[
      '⚠️ Low orders per employee (< 2)',
      'Consider adding more orders to the pool',
      'Current ratio: ' || ROUND(v_orders_per_employee, 2)::text || ' orders per employee'
    ];
  ELSIF v_orders_per_employee < 5 THEN
    v_health_status := 'CAUTION';
    v_recommendations := ARRAY[
      '⚡ Moderate orders per employee (' || ROUND(v_orders_per_employee, 2)::text || ')',
      'Monitor closely and prepare to add more orders'
    ];
  ELSE
    v_health_status := 'HEALTHY';
    v_recommendations := ARRAY[
      '✅ Good orders per employee (' || ROUND(v_orders_per_employee, 2)::text || ')'
    ];
  END IF;

  RETURN json_build_object(
    'health_status', v_health_status,
    'total_orders', v_total_orders,
    'active_orders', v_active_orders,
    'active_employees', v_active_employees,
    'orders_per_employee', ROUND(v_orders_per_employee, 2),
    'recommendations', v_recommendations,
    'checked_at', now()
  );
END;
$$;

COMMENT ON FUNCTION check_dispatch_pool_health(uuid) IS 'Check dispatch pool health status - uses string concatenation instead of format() for numeric values';
