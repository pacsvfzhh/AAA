/*
  # 修复工作时长计算函数 V3 - 简化版本
  
  使用更简单直接的方式，避免复杂的类型转换问题。
*/

-- 删除旧函数并重新创建
DROP FUNCTION IF EXISTS get_user_work_time_today(uuid);

-- 重新创建 get_user_work_time_today 函数 - 简化版本
CREATE FUNCTION get_user_work_time_today(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    -- 已完成会话的秒数
    (SELECT SUM(EXTRACT(EPOCH FROM (end_time - start_time))::integer)
     FROM work_sessions
     WHERE user_id = p_user_id
       AND end_time IS NOT NULL
       AND start_time >= date_trunc('day', now())),
    0
  ) + COALESCE(
    -- 活动会话的秒数
    (SELECT EXTRACT(EPOCH FROM (now() - start_time))::integer
     FROM work_sessions
     WHERE user_id = p_user_id
       AND end_time IS NULL
       AND start_time >= date_trunc('day', now())
     LIMIT 1),
    0
  );
$$;

-- 重新创建 get_batch_work_time 函数 - 简化版本
DROP FUNCTION IF EXISTS get_batch_work_time(uuid[]);

CREATE FUNCTION get_batch_work_time(p_user_ids uuid[])
RETURNS TABLE(
  user_id uuid,
  total_work_minutes integer,
  today_work_minutes integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT 
    u.id as user_id,
    -- 总工作分钟数（所有已完成会话 + 活动会话）
    COALESCE(
      (SELECT ROUND(SUM(EXTRACT(EPOCH FROM (end_time - start_time))) / 60)::integer
       FROM work_sessions ws
       WHERE ws.user_id = u.id AND ws.end_time IS NOT NULL),
      0
    ) + COALESCE(
      (SELECT ROUND(EXTRACT(EPOCH FROM (now() - start_time)) / 60)::integer
       FROM work_sessions ws
       WHERE ws.user_id = u.id AND ws.end_time IS NULL
       LIMIT 1),
      0
    ) as total_work_minutes,
    -- 今天的工作分钟数（今天的已完成会话 + 今天开始的活动会话）
    COALESCE(
      (SELECT ROUND(SUM(EXTRACT(EPOCH FROM (end_time - start_time))) / 60)::integer
       FROM work_sessions ws
       WHERE ws.user_id = u.id 
         AND ws.end_time IS NOT NULL
         AND ws.start_time >= date_trunc('day', now())),
      0
    ) + COALESCE(
      (SELECT ROUND(EXTRACT(EPOCH FROM (now() - start_time)) / 60)::integer
       FROM work_sessions ws
       WHERE ws.user_id = u.id 
         AND ws.end_time IS NULL
         AND ws.start_time >= date_trunc('day', now())
       LIMIT 1),
      0
    ) as today_work_minutes
  FROM unnest(p_user_ids) u(id);
$$;
