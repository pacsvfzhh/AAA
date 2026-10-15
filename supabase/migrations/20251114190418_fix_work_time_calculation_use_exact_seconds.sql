/*
  # 修复工作时长计算 - 使用精确秒数

  ## 问题
  当前的 `get_user_work_time_today` 和 `get_batch_work_time` 函数使用 `duration_minutes` 字段计算工作时长。
  但 `duration_minutes` 是四舍五入后的整数分钟，导致计算不精确。

  ## 示例问题
  - 实际工作 52秒 → duration_minutes = 1分钟 → 计算为 60秒 → 误差 -8秒
  - 实际工作 311秒 → duration_minutes = 5分钟 → 计算为 300秒 → 误差 +11秒
  - 实际工作 25秒 → duration_minutes = 0分钟 → 计算为 0秒 → 误差 +25秒

  ## 解决方案
  直接从 `start_time` 和 `end_time` 计算精确的秒数，而不是使用 `duration_minutes`。

  ## 影响
  - 员工端显示的工作时长会更精确
  - 管理端显示的工作时长会更精确
  - 两端显示的数据会完全一致
*/

-- 修复 get_user_work_time_today 函数 - 使用精确秒数计算
CREATE OR REPLACE FUNCTION get_user_work_time_today(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_today_start timestamptz;
  v_completed_seconds integer := 0;
  v_active_seconds integer := 0;
BEGIN
  v_today_start := date_trunc('day', now());

  -- 从 start_time 和 end_time 直接计算精确秒数（而不是使用 duration_minutes）
  SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ws.end_time - ws.start_time))::integer), 0)
  INTO v_completed_seconds
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NOT NULL
    AND ws.start_time >= v_today_start;

  -- 获取活动会话的精确时间
  SELECT COALESCE(EXTRACT(EPOCH FROM (now() - ws.start_time))::integer, 0)
  INTO v_active_seconds
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NULL
    AND ws.start_time >= v_today_start
  LIMIT 1;

  RETURN v_completed_seconds + v_active_seconds;
END;
$$;

-- 修复 get_batch_work_time 函数 - 使用精确秒数计算
CREATE OR REPLACE FUNCTION get_batch_work_time(p_user_ids uuid[])
RETURNS TABLE(
  user_id uuid,
  total_work_minutes integer,
  today_work_minutes integer
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_today_start timestamptz;
BEGIN
  v_today_start := date_trunc('day', now());
  
  RETURN QUERY
  WITH user_stats AS (
    SELECT 
      u.id as user_id,
      -- 总工作时间（已完成的会话）- 使用精确秒数
      COALESCE(SUM(
        CASE 
          WHEN ws.end_time IS NOT NULL 
          THEN EXTRACT(EPOCH FROM (ws.end_time - ws.start_time))
          ELSE 0 
        END
      ), 0) / 60 as completed_minutes,
      -- 今天的工作时间（已完成的会话）- 使用精确秒数
      COALESCE(SUM(
        CASE 
          WHEN ws.end_time IS NOT NULL AND ws.start_time >= v_today_start
          THEN EXTRACT(EPOCH FROM (ws.end_time - ws.start_time))
          ELSE 0 
        END
      ), 0) / 60 as today_completed_minutes,
      -- 活动会话的总时间（如果存在）
      COALESCE(MAX(
        CASE 
          WHEN ws.end_time IS NULL 
          THEN EXTRACT(EPOCH FROM (now() - ws.start_time)) / 60
          ELSE 0 
        END
      ), 0) as active_minutes,
      -- 活动会话的今天时间（如果今天开始的）
      COALESCE(MAX(
        CASE 
          WHEN ws.end_time IS NULL AND ws.start_time >= v_today_start
          THEN EXTRACT(EPOCH FROM (now() - ws.start_time)) / 60
          ELSE 0 
        END
      ), 0) as active_today_minutes
    FROM unnest(p_user_ids) u(id)
    LEFT JOIN work_sessions ws ON ws.user_id = u.id
    GROUP BY u.id
  )
  SELECT 
    user_stats.user_id,
    CAST((user_stats.completed_minutes + user_stats.active_minutes) AS integer) as total_work_minutes,
    CAST((user_stats.today_completed_minutes + user_stats.active_today_minutes) AS integer) as today_work_minutes
  FROM user_stats;
END;
$$;

-- 添加注释说明 duration_minutes 的用途
COMMENT ON COLUMN work_sessions.duration_minutes IS 'Rounded duration in minutes for quick reference. For precise calculations, use EXTRACT(EPOCH FROM (end_time - start_time)).';
