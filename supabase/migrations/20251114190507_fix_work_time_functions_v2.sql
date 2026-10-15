/*
  # 修复工作时长计算函数 V2
  
  修复函数返回 null 的问题，确保返回整数而不是 numeric。
*/

-- 修复 get_user_work_time_today 函数
CREATE OR REPLACE FUNCTION get_user_work_time_today(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_today_start timestamptz;
  v_completed_seconds bigint := 0;
  v_active_seconds bigint := 0;
BEGIN
  v_today_start := date_trunc('day', now());

  -- 从 start_time 和 end_time 直接计算精确秒数
  SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ws.end_time - ws.start_time))), 0)::bigint
  INTO v_completed_seconds
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NOT NULL
    AND ws.start_time >= v_today_start;

  -- 获取活动会话的精确时间
  SELECT COALESCE(EXTRACT(EPOCH FROM (now() - ws.start_time)), 0)::bigint
  INTO v_active_seconds
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NULL
    AND ws.start_time >= v_today_start
  LIMIT 1;

  RETURN (v_completed_seconds + v_active_seconds)::integer;
END;
$$;

-- 修复 get_batch_work_time 函数
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
      -- 总工作时间（已完成的会话）- 使用精确秒数然后转换为分钟
      COALESCE(SUM(
        CASE 
          WHEN ws.end_time IS NOT NULL 
          THEN EXTRACT(EPOCH FROM (ws.end_time - ws.start_time)) / 60
          ELSE 0 
        END
      ), 0) as completed_minutes,
      -- 今天的工作时间（已完成的会话）- 使用精确秒数然后转换为分钟
      COALESCE(SUM(
        CASE 
          WHEN ws.end_time IS NOT NULL AND ws.start_time >= v_today_start
          THEN EXTRACT(EPOCH FROM (ws.end_time - ws.start_time)) / 60
          ELSE 0 
        END
      ), 0) as today_completed_minutes,
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
    ROUND(user_stats.completed_minutes + user_stats.active_minutes)::integer as total_work_minutes,
    ROUND(user_stats.today_completed_minutes + user_stats.active_today_minutes)::integer as today_work_minutes
  FROM user_stats;
END;
$$;
