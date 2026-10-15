/*
  # 创建请求频率限制系统
  
  1. 新增表
    - `dispatch_rate_limits` - 请求频率跟踪表
      - `user_id` (uuid, primary key) - 用户ID
      - `request_count` (int) - 当前时间窗口内的请求数
      - `window_start` (timestamptz) - 时间窗口开始时间
      - `last_request_at` (timestamptz) - 最后请求时间
  
  2. 新增函数
    - `check_rate_limit()` - 检查用户请求频率
      - 滑动时间窗口（1分钟）
      - 默认限制：10次/分钟
      - 返回是否允许、剩余次数、重置时间
  
    - `assign_with_rate_limit()` - 带限流的分配函数
      - 先检查频率限制
      - 如果超限，返回错误
      - 否则正常分配订单
  
  3. 目的
    - 防止恶意刷请求
    - 保护系统资源
    - 确保公平性
    - 提高稳定性
  
  4. 限流标准
    - 默认：10次/分钟
    - 可配置：根据业务需求调整
*/

-- 创建请求频率跟踪表
CREATE TABLE IF NOT EXISTS dispatch_rate_limits (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  request_count int DEFAULT 0,
  window_start timestamptz DEFAULT now(),
  last_request_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window 
ON dispatch_rate_limits(window_start);

-- 启用RLS
ALTER TABLE dispatch_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own rate limits"
  ON dispatch_rate_limits FOR SELECT
  TO public
  USING (user_id::text = current_setting('request.jwt.claims', true)::json->>'sub');

-- 请求频率检查函数
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_user_id uuid,
  p_max_requests_per_minute int DEFAULT 10
)
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_count int;
  v_window_start timestamptz;
  v_is_allowed boolean;
BEGIN
  -- 获取或创建用户的限流记录
  SELECT request_count, window_start
  INTO v_current_count, v_window_start
  FROM dispatch_rate_limits
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    -- 首次请求，创建记录
    INSERT INTO dispatch_rate_limits (user_id, request_count, window_start, last_request_at)
    VALUES (p_user_id, 1, now(), now());

    RETURN json_build_object(
      'allowed', true,
      'remaining', p_max_requests_per_minute - 1,
      'reset_at', now() + interval '1 minute',
      'current_count', 1
    );
  END IF;

  -- 检查时间窗口是否过期
  IF v_window_start < now() - interval '1 minute' THEN
    -- 重置计数器
    UPDATE dispatch_rate_limits
    SET request_count = 1,
        window_start = now(),
        last_request_at = now()
    WHERE user_id = p_user_id;

    RETURN json_build_object(
      'allowed', true,
      'remaining', p_max_requests_per_minute - 1,
      'reset_at', now() + interval '1 minute',
      'current_count', 1
    );
  END IF;

  -- 检查是否超过限制
  IF v_current_count >= p_max_requests_per_minute THEN
    -- 记录限流日志
    INSERT INTO dispatch_system_logs (
      log_type, user_id, event_name, event_data
    ) VALUES (
      'assignment',
      p_user_id,
      'rate_limit_exceeded',
      jsonb_build_object(
        'request_count', v_current_count,
        'max_requests', p_max_requests_per_minute,
        'window_start', v_window_start
      )
    );

    RETURN json_build_object(
      'allowed', false,
      'remaining', 0,
      'reset_at', v_window_start + interval '1 minute',
      'current_count', v_current_count,
      'message', 'Too many requests. Please wait before trying again.'
    );
  END IF;

  -- 增加计数器
  UPDATE dispatch_rate_limits
  SET request_count = request_count + 1,
      last_request_at = now()
  WHERE user_id = p_user_id;

  RETURN json_build_object(
    'allowed', true,
    'remaining', p_max_requests_per_minute - v_current_count - 1,
    'reset_at', v_window_start + interval '1 minute',
    'current_count', v_current_count + 1
  );
END;
$$;

-- 带限流检查的分配函数
CREATE OR REPLACE FUNCTION assign_with_rate_limit(
  p_user_id uuid,
  p_group_id uuid,
  p_dispatch_mode text DEFAULT 'random',
  p_max_requests_per_minute int DEFAULT 10
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rate_limit_check json;
  v_is_allowed boolean;
BEGIN
  -- 检查请求频率
  v_rate_limit_check := check_rate_limit(p_user_id, p_max_requests_per_minute);
  v_is_allowed := (v_rate_limit_check->>'allowed')::boolean;

  IF NOT v_is_allowed THEN
    RETURN v_rate_limit_check;
  END IF;

  -- 正常分配订单
  RETURN assign_next_dispatch_order(p_user_id, p_group_id, p_dispatch_mode);
END;
$$;

-- 获取限流统计
CREATE OR REPLACE FUNCTION get_rate_limit_stats()
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_result json;
BEGIN
  SELECT json_build_object(
    'total_users_tracked', COUNT(*),
    'active_users_last_minute', COUNT(*) FILTER (WHERE last_request_at > now() - interval '1 minute'),
    'users_at_limit', COUNT(*) FILTER (WHERE request_count >= 10 AND window_start > now() - interval '1 minute'),
    'avg_requests_per_user', ROUND(AVG(request_count), 2),
    'max_requests', MAX(request_count),
    'top_requesters', (
      SELECT json_agg(
        json_build_object(
          'user_id', user_id,
          'request_count', request_count,
          'last_request', last_request_at
        )
      )
      FROM (
        SELECT user_id, request_count, last_request_at
        FROM dispatch_rate_limits
        WHERE window_start > now() - interval '1 minute'
        ORDER BY request_count DESC
        LIMIT 5
      ) top
    )
  ) INTO v_result
  FROM dispatch_rate_limits
  WHERE window_start > now() - interval '5 minutes';

  RETURN v_result;
END;
$$;

-- 清理旧的限流记录（保留最近5分钟）
CREATE OR REPLACE FUNCTION cleanup_old_rate_limits()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count int;
BEGIN
  DELETE FROM dispatch_rate_limits
  WHERE window_start < now() - interval '5 minutes'
  AND last_request_at < now() - interval '5 minutes';

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN v_deleted_count;
END;
$$;

-- 验证创建成功
DO $$
BEGIN
  RAISE NOTICE '✅ 请求频率限制系统创建完成';
  RAISE NOTICE '   - dispatch_rate_limits: 频率跟踪表';
  RAISE NOTICE '   - check_rate_limit(): 检查频率限制';
  RAISE NOTICE '   - assign_with_rate_limit(): 带限流的分配函数';
  RAISE NOTICE '   - get_rate_limit_stats(): 限流统计';
  RAISE NOTICE '   - cleanup_old_rate_limits(): 清理旧记录';
  RAISE NOTICE '   ';
  RAISE NOTICE '⚡ 默认限制: 10次/分钟';
  RAISE NOTICE '   ';
  RAISE NOTICE '💡 使用方法:';
  RAISE NOTICE '   - 检查限流: SELECT check_rate_limit(user_id)';
  RAISE NOTICE '   - 带限流分配: SELECT assign_with_rate_limit(user_id, group_id)';
  RAISE NOTICE '   - 自定义限制: SELECT assign_with_rate_limit(user_id, group_id, ''random'', 20)';
  RAISE NOTICE '   - 查看统计: SELECT get_rate_limit_stats()';
END $$;
