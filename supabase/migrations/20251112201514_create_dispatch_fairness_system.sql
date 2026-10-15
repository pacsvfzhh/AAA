/*
  # 创建订单分配公平性系统
  
  1. 新增视图
    - `dispatch_fairness_stats` - 员工分配统计视图
      - 总分配数、今日分配数、完成数
      - 距离上次分配的时间
      - 用于评估分配公平性
  
  2. 新增函数
    - `assign_with_fairness()` - 带公平性检查的分配函数
      - 检查用户今天的分配数是否远超平均值
      - 如果超过1.5倍平均值，建议等待
      - 记录节流事件日志
  
  3. 目的
    - 防止random模式下某些员工运气太好/太差
    - 确保订单分配相对公平
    - 提升员工满意度
  
  注意：这是可选功能，不影响核心业务
*/

-- 创建员工分配统计视图
CREATE OR REPLACE VIEW dispatch_fairness_stats AS
SELECT
  u.id as user_id,
  u.username,
  COUNT(da.id) as total_assignments,
  COUNT(CASE WHEN da.status = 'completed' THEN 1 END) as completed_count,
  COUNT(CASE WHEN da.assigned_at >= date_trunc('day', now()) THEN 1 END) as today_assignments,
  MAX(da.assigned_at) as last_assignment_at,
  COALESCE(
    EXTRACT(EPOCH FROM (now() - MAX(da.assigned_at)))/60,
    999999
  ) as minutes_since_last_assignment
FROM users u
LEFT JOIN dispatch_assignments da ON da.user_id = u.id
WHERE u.is_active = true
GROUP BY u.id, u.username;

-- 带公平性检查的分配函数
CREATE OR REPLACE FUNCTION assign_with_fairness(
  p_user_id uuid,
  p_group_id uuid,
  p_dispatch_mode text DEFAULT 'random',
  p_enable_fairness_check boolean DEFAULT true
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_assignments int;
  v_avg_assignments numeric;
  v_should_throttle boolean;
  v_fairness_threshold numeric := 1.5; -- 超过平均值的1.5倍才节流
BEGIN
  -- 如果不启用公平性检查，直接分配
  IF NOT p_enable_fairness_check THEN
    RETURN assign_next_dispatch_order(p_user_id, p_group_id, p_dispatch_mode);
  END IF;

  -- 检查用户今天的分配数量
  SELECT today_assignments INTO v_user_assignments
  FROM dispatch_fairness_stats
  WHERE user_id = p_user_id;

  -- 如果用户今天还没有分配记录，直接分配
  IF v_user_assignments IS NULL OR v_user_assignments = 0 THEN
    RETURN assign_next_dispatch_order(p_user_id, p_group_id, p_dispatch_mode);
  END IF;

  -- 计算今天的平均分配数（只统计有分配的用户）
  SELECT AVG(today_assignments) INTO v_avg_assignments
  FROM dispatch_fairness_stats
  WHERE today_assignments > 0;

  -- 如果平均值为空或为0，说明系统刚启动，直接分配
  IF v_avg_assignments IS NULL OR v_avg_assignments = 0 THEN
    RETURN assign_next_dispatch_order(p_user_id, p_group_id, p_dispatch_mode);
  END IF;

  -- 如果用户今天的分配数远超平均值，考虑节流
  v_should_throttle := (v_user_assignments > v_avg_assignments * v_fairness_threshold);

  IF v_should_throttle THEN
    -- 记录节流事件
    INSERT INTO dispatch_system_logs (
      log_type, user_id, event_name, event_data
    ) VALUES (
      'assignment',
      p_user_id,
      'fairness_throttle',
      jsonb_build_object(
        'user_assignments', v_user_assignments,
        'avg_assignments', v_avg_assignments,
        'threshold', v_fairness_threshold,
        'message', 'User has received more orders than average today'
      )
    );

    -- 返回提示信息
    RETURN json_build_object(
      'success', false,
      'message', 'Please wait a moment to allow other employees to receive orders',
      'assignment', null,
      'throttle_info', json_build_object(
        'your_orders', v_user_assignments,
        'average_orders', round(v_avg_assignments, 2),
        'retry_after_seconds', 60
      )
    );
  END IF;

  -- 正常分配
  RETURN assign_next_dispatch_order(p_user_id, p_group_id, p_dispatch_mode);
END;
$$;

-- 创建获取公平性统计的便捷函数
CREATE OR REPLACE FUNCTION get_fairness_summary()
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_result json;
BEGIN
  SELECT json_build_object(
    'timestamp', now(),
    'total_active_users', COUNT(*),
    'users_with_assignments_today', COUNT(*) FILTER (WHERE today_assignments > 0),
    'avg_assignments_per_user', ROUND(AVG(today_assignments), 2),
    'max_assignments', MAX(today_assignments),
    'min_assignments', MIN(today_assignments) FILTER (WHERE today_assignments > 0),
    'std_dev', ROUND(STDDEV(today_assignments), 2),
    'top_users', (
      SELECT json_agg(
        json_build_object(
          'username', username,
          'today_assignments', today_assignments,
          'completed_count', completed_count
        )
      )
      FROM (
        SELECT username, today_assignments, completed_count
        FROM dispatch_fairness_stats
        WHERE today_assignments > 0
        ORDER BY today_assignments DESC
        LIMIT 5
      ) top
    )
  ) INTO v_result
  FROM dispatch_fairness_stats;

  RETURN v_result;
END;
$$;

-- 验证创建成功
DO $$
BEGIN
  RAISE NOTICE '✅ 订单分配公平性系统创建完成';
  RAISE NOTICE '   - dispatch_fairness_stats: 员工分配统计视图';
  RAISE NOTICE '   - assign_with_fairness(): 带公平性检查的分配函数';
  RAISE NOTICE '   - get_fairness_summary(): 公平性统计摘要';
  RAISE NOTICE '   - 默认阈值: 1.5倍平均值';
  RAISE NOTICE '   ';
  RAISE NOTICE '💡 使用方法:';
  RAISE NOTICE '   - 启用公平性: SELECT assign_with_fairness(user_id, group_id, ''random'', true)';
  RAISE NOTICE '   - 禁用公平性: SELECT assign_with_fairness(user_id, group_id, ''random'', false)';
  RAISE NOTICE '   - 查看统计: SELECT get_fairness_summary()';
END $$;
