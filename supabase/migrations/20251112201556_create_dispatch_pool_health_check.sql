/*
  # 创建订单池健康检查系统
  
  1. 新增函数
    - `check_dispatch_pool_health()` - 检查订单池健康度
      - 统计总订单数、活跃订单数、活跃员工数
      - 计算每个员工的平均可用订单数
      - 评估健康状态：HEALTHY, CAUTION, WARNING, CRITICAL
      - 提供优化建议
  
  2. 新增触发器
    - `auto_check_pool_health()` - 自动检查触发器
      - 当订单被标记为非活跃时触发
      - 如果状态是WARNING或CRITICAL，记录日志
  
  3. 健康状态评估标准
    - CRITICAL: 无活跃订单
    - WARNING: 每员工 < 2个订单
    - CAUTION: 每员工 2-5个订单
    - HEALTHY: 每员工 > 5个订单
  
  4. 目的
    - 主动发现订单不足问题
    - 管理员可以提前准备
    - 减少员工等待时间
*/

-- 订单池健康检查函数
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
      format('Current ratio: %.2f orders per employee', v_orders_per_employee)
    ];
  ELSIF v_orders_per_employee < 5 THEN
    v_health_status := 'CAUTION';
    v_recommendations := ARRAY[
      format('⚡ Moderate orders per employee (%.2f)', v_orders_per_employee),
      'Monitor closely and prepare to add more orders'
    ];
  ELSE
    v_health_status := 'HEALTHY';
    v_recommendations := ARRAY[
      format('✅ Good orders per employee (%.2f)', v_orders_per_employee)
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

-- 自动检查池健康度的触发器函数
CREATE OR REPLACE FUNCTION auto_check_pool_health()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_health json;
  v_health_status text;
BEGIN
  -- 检查订单池健康度
  v_health := check_dispatch_pool_health(NEW.group_id);
  v_health_status := v_health->>'health_status';

  -- 如果状态是WARNING或CRITICAL，记录日志
  IF v_health_status IN ('WARNING', 'CRITICAL') THEN
    INSERT INTO dispatch_system_logs (
      log_type, event_name, event_data
    ) VALUES (
      'health_check',
      'pool_health_alert',
      v_health::jsonb
    );
  END IF;

  RETURN NEW;
END;
$$;

-- 在订单被标记为非活跃时触发检查
DROP TRIGGER IF EXISTS trigger_check_pool_health_on_deactivate ON dispatch_group_orders;

CREATE TRIGGER trigger_check_pool_health_on_deactivate
AFTER UPDATE OF is_active ON dispatch_group_orders
FOR EACH ROW
WHEN (NEW.is_active = false AND OLD.is_active = true)
EXECUTE FUNCTION auto_check_pool_health();

-- 创建检查所有订单池的便捷函数
CREATE OR REPLACE FUNCTION check_all_pools_health()
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_result json;
BEGIN
  SELECT json_agg(
    json_build_object(
      'group_id', dg.id,
      'group_name', dg.group_name,
      'health', check_dispatch_pool_health(dg.id)
    )
  ) INTO v_result
  FROM dispatch_groups dg
  WHERE dg.is_active = true;

  RETURN COALESCE(v_result, '[]'::json);
END;
$$;

-- 验证创建成功
DO $$
BEGIN
  RAISE NOTICE '✅ 订单池健康检查系统创建完成';
  RAISE NOTICE '   - check_dispatch_pool_health(): 检查单个订单池';
  RAISE NOTICE '   - check_all_pools_health(): 检查所有活跃订单池';
  RAISE NOTICE '   - auto_check_pool_health(): 自动检查触发器';
  RAISE NOTICE '   ';
  RAISE NOTICE '📊 健康状态标准:';
  RAISE NOTICE '   - HEALTHY: > 5订单/员工';
  RAISE NOTICE '   - CAUTION: 2-5订单/员工';
  RAISE NOTICE '   - WARNING: < 2订单/员工';
  RAISE NOTICE '   - CRITICAL: 0个活跃订单';
  RAISE NOTICE '   ';
  RAISE NOTICE '💡 使用方法:';
  RAISE NOTICE '   - SELECT check_dispatch_pool_health(group_id)';
  RAISE NOTICE '   - SELECT check_all_pools_health()';
END $$;
