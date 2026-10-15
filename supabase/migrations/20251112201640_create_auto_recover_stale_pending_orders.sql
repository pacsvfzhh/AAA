/*
  # 创建自动恢复stale pending订单机制
  
  1. 新增函数
    - `auto_recover_stale_pending_orders()` - 自动恢复超时的pending订单
      - 查找超过指定时间（默认5分钟）的pending订单
      - 将其标记为timeout_cancelled
      - 记录恢复日志
      - 返回恢复结果统计
  
  2. 目的
    - 自动修复卡住的订单
    - 提高系统自愈能力
    - 减少人工干预
    - 改善员工体验
  
  3. 使用场景
    - 员工页面卡住
    - 网络断开
    - 浏览器崩溃
    - 其他异常情况
  
  4. 调用方式
    - 手动调用：SELECT auto_recover_stale_pending_orders()
    - 定时调用：通过edge function或前端定时器
    - 建议：每5-10分钟运行一次
*/

-- 自动恢复超时pending订单的函数
CREATE OR REPLACE FUNCTION auto_recover_stale_pending_orders(
  p_timeout_minutes int DEFAULT 5
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_recovered_count int;
  v_recovered_orders uuid[];
  v_recovered_details jsonb;
BEGIN
  -- 查找并更新超时的pending订单
  WITH stale_orders AS (
    SELECT 
      da.id,
      da.user_id,
      da.dispatch_order_id,
      da.assigned_at,
      EXTRACT(EPOCH FROM (now() - da.assigned_at))/60 as minutes_elapsed
    FROM dispatch_assignments da
    WHERE da.status = 'pending'
      AND da.assigned_at < now() - (p_timeout_minutes || ' minutes')::interval
  ),
  updated AS (
    UPDATE dispatch_assignments
    SET
      status = 'timeout_cancelled',
      remarks = 'Auto-recovered: pending timeout after ' || p_timeout_minutes || ' minutes',
      completed_at = now()
    WHERE id IN (SELECT id FROM stale_orders)
    RETURNING id, user_id, dispatch_order_id
  )
  SELECT
    COUNT(*),
    array_agg(id),
    jsonb_agg(
      jsonb_build_object(
        'assignment_id', id,
        'user_id', user_id,
        'dispatch_order_id', dispatch_order_id
      )
    )
  INTO v_recovered_count, v_recovered_orders, v_recovered_details
  FROM updated;

  -- 如果没有恢复任何订单，返回空结果
  IF v_recovered_count IS NULL THEN
    v_recovered_count := 0;
    v_recovered_orders := ARRAY[]::uuid[];
    v_recovered_details := '[]'::jsonb;
  END IF;

  -- 记录恢复日志
  IF v_recovered_count > 0 THEN
    INSERT INTO dispatch_system_logs (
      log_type, event_name, event_data
    ) VALUES (
      'assignment',
      'auto_recover_pending',
      jsonb_build_object(
        'recovered_count', v_recovered_count,
        'recovered_orders', v_recovered_orders,
        'timeout_minutes', p_timeout_minutes,
        'recovered_details', v_recovered_details
      )
    );
  END IF;

  RETURN json_build_object(
    'success', true,
    'recovered_count', v_recovered_count,
    'recovered_orders', v_recovered_orders,
    'timeout_minutes', p_timeout_minutes,
    'checked_at', now()
  );
END;
$$;

-- 创建检查当前pending订单状态的函数
CREATE OR REPLACE FUNCTION get_pending_orders_status()
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_result json;
BEGIN
  SELECT json_build_object(
    'total_pending', COUNT(*),
    'normal_pending', COUNT(*) FILTER (WHERE assigned_at > now() - interval '5 minutes'),
    'stale_pending', COUNT(*) FILTER (WHERE assigned_at <= now() - interval '5 minutes'),
    'oldest_pending', json_build_object(
      'assignment_id', (
        SELECT id FROM dispatch_assignments
        WHERE status = 'pending'
        ORDER BY assigned_at ASC
        LIMIT 1
      ),
      'minutes_elapsed', (
        SELECT ROUND(EXTRACT(EPOCH FROM (now() - assigned_at))/60, 2)
        FROM dispatch_assignments
        WHERE status = 'pending'
        ORDER BY assigned_at ASC
        LIMIT 1
      )
    ),
    'pending_by_duration', json_build_object(
      '0-2_minutes', COUNT(*) FILTER (WHERE assigned_at > now() - interval '2 minutes'),
      '2-5_minutes', COUNT(*) FILTER (WHERE assigned_at BETWEEN now() - interval '5 minutes' AND now() - interval '2 minutes'),
      '5-10_minutes', COUNT(*) FILTER (WHERE assigned_at BETWEEN now() - interval '10 minutes' AND now() - interval '5 minutes'),
      'over_10_minutes', COUNT(*) FILTER (WHERE assigned_at <= now() - interval '10 minutes')
    )
  ) INTO v_result
  FROM dispatch_assignments
  WHERE status = 'pending';

  RETURN v_result;
END;
$$;

-- 创建批量恢复和清理的便捷函数
CREATE OR REPLACE FUNCTION auto_cleanup_dispatch_system()
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_pending_recovery json;
  v_session_cleanup json;
  v_result json;
BEGIN
  -- 1. 恢复stale pending订单
  v_pending_recovery := auto_recover_stale_pending_orders(5);

  -- 2. 清理stale sessions
  v_session_cleanup := json_build_object(
    'work_sessions', cleanup_stale_work_sessions(),
    'dispatch_sessions', cleanup_stale_dispatch_sessions()
  );

  -- 组合结果
  v_result := json_build_object(
    'pending_recovery', v_pending_recovery,
    'session_cleanup', v_session_cleanup,
    'executed_at', now()
  );

  RETURN v_result;
END;
$$;

-- 验证创建成功
DO $$
BEGIN
  RAISE NOTICE '✅ 自动恢复stale pending订单机制创建完成';
  RAISE NOTICE '   - auto_recover_stale_pending_orders(): 恢复超时pending订单';
  RAISE NOTICE '   - get_pending_orders_status(): 查看pending订单状态';
  RAISE NOTICE '   - auto_cleanup_dispatch_system(): 一键清理全部';
  RAISE NOTICE '   ';
  RAISE NOTICE '⏱️ 默认超时时间: 5分钟';
  RAISE NOTICE '   ';
  RAISE NOTICE '💡 使用方法:';
  RAISE NOTICE '   - 手动恢复: SELECT auto_recover_stale_pending_orders()';
  RAISE NOTICE '   - 自定义超时: SELECT auto_recover_stale_pending_orders(10)';
  RAISE NOTICE '   - 查看状态: SELECT get_pending_orders_status()';
  RAISE NOTICE '   - 完整清理: SELECT auto_cleanup_dispatch_system()';
  RAISE NOTICE '   ';
  RAISE NOTICE '🔄 建议: 每5-10分钟运行一次auto_cleanup_dispatch_system()';
END $$;
