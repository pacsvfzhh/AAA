/*
  # 创建监控和告警查询系统
  
  1. 新增函数
    - `get_dispatch_system_health()` - 实时系统健康度
      - 活跃会话数、pending分配数、活跃订单数
      - 平均分配时间、错误率
      - 全面的系统状态概览
  
    - `check_system_alerts()` - 系统告警检查
      - 检查订单池即将耗尽
      - 检查高错误率
      - 检查慢查询
      - 检查长时间pending的订单
      - 返回所有告警信息
  
    - `get_dispatch_analytics()` - 派送分析报告
      - 今日统计、性能指标
      - 错误分析、用户活跃度
      - 完整的运营分析数据
  
  2. 目的
    - 实时监控系统状态
    - 主动发现问题
    - 支持运营决策
    - 提供数据分析
*/

-- 实时系统健康度
CREATE OR REPLACE FUNCTION get_dispatch_system_health()
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_result json;
BEGIN
  SELECT json_build_object(
    'timestamp', now(),
    'active_sessions', (
      SELECT COUNT(*) FROM dispatch_sessions WHERE status = 'online'
    ),
    'pending_assignments', (
      SELECT COUNT(*) FROM dispatch_assignments WHERE status = 'pending'
    ),
    'active_orders', (
      SELECT COUNT(*) FROM dispatch_group_orders WHERE is_active = true
    ),
    'active_groups', (
      SELECT COUNT(*) FROM dispatch_groups WHERE is_active = true
    ),
    'avg_assignment_time_ms', (
      SELECT ROUND(AVG(execution_time_ms), 2)
      FROM dispatch_system_logs
      WHERE log_type = 'assignment'
        AND event_name = 'order_assigned'
        AND created_at > now() - interval '1 hour'
    ),
    'assignments_last_hour', (
      SELECT COUNT(*)
      FROM dispatch_system_logs
      WHERE log_type = 'assignment'
        AND event_name = 'order_assigned'
        AND created_at > now() - interval '1 hour'
    ),
    'error_rate_last_hour', (
      SELECT
        ROUND(
          COUNT(*) FILTER (WHERE log_type = 'error')::numeric /
          NULLIF(COUNT(*), 0) * 100,
          2
        )
      FROM dispatch_system_logs
      WHERE created_at > now() - interval '1 hour'
    ),
    'system_status', CASE
      WHEN (SELECT COUNT(*) FROM dispatch_groups WHERE is_active = true) = 0 
        THEN 'NO_ACTIVE_GROUPS'
      WHEN (SELECT COUNT(*) FROM dispatch_group_orders WHERE is_active = true) = 0 
        THEN 'NO_ACTIVE_ORDERS'
      WHEN (SELECT COUNT(*) FROM dispatch_sessions WHERE status = 'online') = 0 
        THEN 'NO_ONLINE_USERS'
      ELSE 'HEALTHY'
    END
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- 告警检查函数
CREATE OR REPLACE FUNCTION check_system_alerts()
RETURNS TABLE(
  alert_level text,
  alert_type text,
  alert_message text,
  alert_data jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
  -- 检查1: 订单池即将耗尽
  RETURN QUERY
  SELECT
    'WARNING'::text,
    'low_orders'::text,
    format('Group "%s" has only %s active orders', group_name, active_count)::text,
    jsonb_build_object('group_id', id, 'active_orders', active_count)
  FROM (
    SELECT
      dg.id,
      dg.group_name,
      COUNT(dgo.id) as active_count
    FROM dispatch_groups dg
    LEFT JOIN dispatch_group_orders dgo ON dgo.group_id = dg.id AND dgo.is_active = true
    WHERE dg.is_active = true
    GROUP BY dg.id, dg.group_name
    HAVING COUNT(dgo.id) < 10
  ) low_orders;

  -- 检查2: 高错误率
  RETURN QUERY
  SELECT
    'CRITICAL'::text,
    'high_error_rate'::text,
    format('Error rate is %.2f%% in the last hour', error_rate)::text,
    jsonb_build_object('error_rate', error_rate, 'error_count', error_count)
  FROM (
    SELECT
      COUNT(CASE WHEN log_type = 'error' THEN 1 END) as error_count,
      COUNT(CASE WHEN log_type = 'error' THEN 1 END)::numeric /
        NULLIF(COUNT(*), 0) * 100 as error_rate
    FROM dispatch_system_logs
    WHERE created_at > now() - interval '1 hour'
  ) errors
  WHERE error_rate > 5; -- 错误率超过5%

  -- 检查3: 慢查询
  RETURN QUERY
  SELECT
    'WARNING'::text,
    'slow_assignments'::text,
    format('Average assignment time is %.2fms', avg_time)::text,
    jsonb_build_object('avg_time_ms', avg_time, 'p95_time_ms', p95_time)
  FROM (
    SELECT
      AVG(execution_time_ms) as avg_time,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY execution_time_ms) as p95_time
    FROM dispatch_system_logs
    WHERE log_type = 'assignment'
      AND event_name = 'order_assigned'
      AND created_at > now() - interval '1 hour'
  ) perf
  WHERE avg_time > 50 OR p95_time > 100; -- 平均>50ms或P95>100ms

  -- 检查4: 长时间pending的订单
  RETURN QUERY
  SELECT
    'WARNING'::text,
    'stale_pending'::text,
    format('%s orders have been pending for more than 5 minutes', stale_count)::text,
    jsonb_build_object('stale_count', stale_count, 'assignment_ids', assignment_ids)
  FROM (
    SELECT
      COUNT(*) as stale_count,
      array_agg(id) as assignment_ids
    FROM dispatch_assignments
    WHERE status = 'pending'
      AND assigned_at < now() - interval '5 minutes'
  ) stale
  WHERE stale_count > 0;

  -- 检查5: 无在线用户但有活跃订单
  RETURN QUERY
  SELECT
    'INFO'::text,
    'no_online_users'::text,
    format('No online users but %s active orders available', active_orders)::text,
    jsonb_build_object('active_orders', active_orders)
  FROM (
    SELECT COUNT(*) as active_orders
    FROM dispatch_group_orders
    WHERE is_active = true
  ) orders
  WHERE active_orders > 0
    AND NOT EXISTS (SELECT 1 FROM dispatch_sessions WHERE status = 'online');

END;
$$;

-- 派送分析报告
CREATE OR REPLACE FUNCTION get_dispatch_analytics(
  p_start_date timestamptz DEFAULT date_trunc('day', now()),
  p_end_date timestamptz DEFAULT now()
)
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_result json;
BEGIN
  SELECT json_build_object(
    'period', json_build_object(
      'start', p_start_date,
      'end', p_end_date,
      'duration_hours', ROUND(EXTRACT(EPOCH FROM (p_end_date - p_start_date))/3600, 2)
    ),
    'assignments', json_build_object(
      'total', (
        SELECT COUNT(*)
        FROM dispatch_assignments
        WHERE assigned_at BETWEEN p_start_date AND p_end_date
      ),
      'by_status', (
        SELECT jsonb_object_agg(status, count)
        FROM (
          SELECT status, COUNT(*) as count
          FROM dispatch_assignments
          WHERE assigned_at BETWEEN p_start_date AND p_end_date
          GROUP BY status
        ) s
      ),
      'completed_rate', (
        SELECT ROUND(
          COUNT(*) FILTER (WHERE status = 'completed')::numeric /
          NULLIF(COUNT(*), 0) * 100,
          2
        )
        FROM dispatch_assignments
        WHERE assigned_at BETWEEN p_start_date AND p_end_date
      )
    ),
    'performance', json_build_object(
      'avg_assignment_time_ms', (
        SELECT ROUND(AVG(execution_time_ms), 2)
        FROM dispatch_system_logs
        WHERE log_type = 'assignment'
          AND event_name = 'order_assigned'
          AND created_at BETWEEN p_start_date AND p_end_date
      ),
      'p50_assignment_time_ms', (
        SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY execution_time_ms), 2)
        FROM dispatch_system_logs
        WHERE log_type = 'assignment'
          AND event_name = 'order_assigned'
          AND created_at BETWEEN p_start_date AND p_end_date
      ),
      'p95_assignment_time_ms', (
        SELECT ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY execution_time_ms), 2)
        FROM dispatch_system_logs
        WHERE log_type = 'assignment'
          AND event_name = 'order_assigned'
          AND created_at BETWEEN p_start_date AND p_end_date
      )
    ),
    'errors', json_build_object(
      'total_errors', (
        SELECT COUNT(*)
        FROM dispatch_system_logs
        WHERE log_type = 'error'
          AND created_at BETWEEN p_start_date AND p_end_date
      ),
      'error_types', (
        SELECT jsonb_object_agg(event_name, count)
        FROM (
          SELECT event_name, COUNT(*) as count
          FROM dispatch_system_logs
          WHERE log_type = 'error'
            AND created_at BETWEEN p_start_date AND p_end_date
          GROUP BY event_name
        ) e
      )
    ),
    'users', json_build_object(
      'active_users', (
        SELECT COUNT(DISTINCT user_id)
        FROM dispatch_assignments
        WHERE assigned_at BETWEEN p_start_date AND p_end_date
      ),
      'top_users', (
        SELECT json_agg(
          json_build_object(
            'user_id', user_id,
            'assignments', assignment_count,
            'completed', completed_count
          )
        )
        FROM (
          SELECT
            user_id,
            COUNT(*) as assignment_count,
            COUNT(*) FILTER (WHERE status = 'completed') as completed_count
          FROM dispatch_assignments
          WHERE assigned_at BETWEEN p_start_date AND p_end_date
          GROUP BY user_id
          ORDER BY assignment_count DESC
          LIMIT 10
        ) top
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- 验证创建成功
DO $$
BEGIN
  RAISE NOTICE '✅ 监控和告警系统创建完成';
  RAISE NOTICE '   - get_dispatch_system_health(): 实时系统健康度';
  RAISE NOTICE '   - check_system_alerts(): 系统告警检查';
  RAISE NOTICE '   - get_dispatch_analytics(): 派送分析报告';
  RAISE NOTICE '   ';
  RAISE NOTICE '💡 使用方法:';
  RAISE NOTICE '   - 查看健康度: SELECT get_dispatch_system_health()';
  RAISE NOTICE '   - 检查告警: SELECT * FROM check_system_alerts()';
  RAISE NOTICE '   - 今日分析: SELECT get_dispatch_analytics()';
  RAISE NOTICE '   - 自定义时段: SELECT get_dispatch_analytics(''2025-01-01'', ''2025-01-31'')';
END $$;
