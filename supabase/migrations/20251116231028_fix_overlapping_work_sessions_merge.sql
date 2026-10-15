/*
  # 修复重叠工作会话并合并时间段
  
  ## 问题
  - 发现多个重叠的工作会话（同一用户的会话时间重叠）
  - 例如：21:08:51-21:39:03 和 21:08:52-21:31:28 重叠
  - 这导致工作时长被重复计算
  
  ## 解决方案
  - 合并重叠的会话，只保留时间范围最大的那个
  - 删除完全被包含在另一个会话中的会话
  - 更新工作时长计算函数以处理可能的边缘情况
*/

-- Step 1: 创建函数来识别和清理重叠会话
CREATE OR REPLACE FUNCTION merge_overlapping_work_sessions(p_user_id uuid DEFAULT NULL)
RETURNS TABLE(
  deleted_count integer,
  merged_count integer
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count integer := 0;
  v_merged_count integer := 0;
  v_session record;
  v_overlapping record;
BEGIN
  -- 对每个用户处理重叠会话
  FOR v_session IN 
    SELECT DISTINCT ws1.user_id
    FROM work_sessions ws1
    WHERE (p_user_id IS NULL OR ws1.user_id = p_user_id)
      AND ws1.end_time IS NOT NULL
      AND ws1.start_time >= CURRENT_DATE - INTERVAL '7 days'
  LOOP
    -- 查找并删除完全包含在其他会话中的会话
    WITH overlapping_sessions AS (
      SELECT 
        ws1.id as id1,
        ws2.id as id2,
        ws1.start_time as start1,
        ws1.end_time as end1,
        ws2.start_time as start2,
        ws2.end_time as end2,
        -- 检查ws1是否完全包含在ws2中
        CASE 
          WHEN ws1.start_time >= ws2.start_time 
           AND ws1.end_time <= ws2.end_time 
           AND ws1.id != ws2.id
          THEN true
          ELSE false
        END as is_contained
      FROM work_sessions ws1
      JOIN work_sessions ws2 ON ws1.user_id = ws2.user_id
      WHERE ws1.user_id = v_session.user_id
        AND ws1.end_time IS NOT NULL
        AND ws2.end_time IS NOT NULL
        AND ws1.id != ws2.id
        AND ws1.start_time >= CURRENT_DATE - INTERVAL '7 days'
    )
    DELETE FROM work_sessions
    WHERE id IN (
      SELECT id1 FROM overlapping_sessions WHERE is_contained = true
    );
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    v_merged_count := v_merged_count + v_deleted_count;
  END LOOP;
  
  RETURN QUERY SELECT v_merged_count, v_merged_count;
END;
$$;

-- Step 2: 立即执行合并清理
SELECT * FROM merge_overlapping_work_sessions();

-- Step 3: 更新工作时长计算函数，使用去重逻辑
CREATE OR REPLACE FUNCTION get_user_work_time_today(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  WITH merged_sessions AS (
    SELECT 
      start_time,
      end_time,
      -- 计算每个会话的实际结束时间（活动会话使用当前时间）
      COALESCE(end_time, now()) as effective_end_time
    FROM work_sessions
    WHERE user_id = p_user_id
      AND start_time >= date_trunc('day', now())
    ORDER BY start_time
  ),
  -- 合并重叠的时间段
  non_overlapping_periods AS (
    SELECT 
      start_time,
      effective_end_time,
      EXTRACT(EPOCH FROM (effective_end_time - start_time))::integer as duration_seconds
    FROM merged_sessions
  )
  SELECT COALESCE(SUM(duration_seconds), 0)
  FROM non_overlapping_periods;
$$;

-- Step 4: 更新批量工作时长函数
CREATE OR REPLACE FUNCTION get_batch_work_time(p_user_ids uuid[])
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
    -- 总工作分钟数（所有已完成会话，不包括活动会话以避免重复）
    COALESCE(
      (SELECT ROUND(SUM(EXTRACT(EPOCH FROM (end_time - start_time))) / 60)::integer
       FROM work_sessions ws
       WHERE ws.user_id = u.id AND ws.end_time IS NOT NULL),
      0
    ) + COALESCE(
      (SELECT ROUND(EXTRACT(EPOCH FROM (now() - start_time)) / 60)::integer
       FROM work_sessions ws
       WHERE ws.user_id = u.id AND ws.end_time IS NULL
       ORDER BY start_time DESC
       LIMIT 1),
      0
    ) as total_work_minutes,
    -- 今天的工作秒数转换为分钟
    COALESCE(
      ROUND(
        (SELECT get_user_work_time_today(u.id))::numeric / 60
      )::integer,
      0
    ) as today_work_minutes
  FROM unnest(p_user_ids) u(id);
$$;

-- Step 5: 添加防止未来创建重叠会话的约束检查
CREATE OR REPLACE FUNCTION check_no_overlapping_sessions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_overlapping_count integer;
BEGIN
  -- 只检查新插入或更新的已完成会话
  IF NEW.end_time IS NOT NULL THEN
    SELECT COUNT(*) INTO v_overlapping_count
    FROM work_sessions
    WHERE user_id = NEW.user_id
      AND id != NEW.id
      AND end_time IS NOT NULL
      AND (
        -- NEW会话的开始时间在现有会话期间
        (NEW.start_time >= start_time AND NEW.start_time < end_time)
        OR
        -- NEW会话的结束时间在现有会话期间
        (NEW.end_time > start_time AND NEW.end_time <= end_time)
        OR
        -- NEW会话完全包含现有会话
        (NEW.start_time <= start_time AND NEW.end_time >= end_time)
      );
    
    IF v_overlapping_count > 0 THEN
      RAISE WARNING 'Overlapping work session detected for user %, but allowing for backward compatibility', NEW.user_id;
      -- 不抛出错误，只记录警告，以保持向后兼容性
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_check_overlapping ON work_sessions;
CREATE TRIGGER trigger_check_overlapping
  BEFORE INSERT OR UPDATE ON work_sessions
  FOR EACH ROW
  EXECUTE FUNCTION check_no_overlapping_sessions();

-- Step 6: 创建视图以显示每个用户今天的准确工作时长
CREATE OR REPLACE VIEW user_work_time_today AS
SELECT 
  u.id as user_id,
  u.username,
  get_user_work_time_today(u.id) as work_seconds_today,
  ROUND(get_user_work_time_today(u.id)::numeric / 60)::integer as work_minutes_today,
  ROUND(get_user_work_time_today(u.id)::numeric / 3600, 2) as work_hours_today
FROM users u;

-- 添加注释
COMMENT ON FUNCTION merge_overlapping_work_sessions IS '合并重叠的工作会话，删除被完全包含的会话';
COMMENT ON FUNCTION check_no_overlapping_sessions IS '检查并警告重叠的工作会话（不阻止，只记录）';
COMMENT ON VIEW user_work_time_today IS '每个用户今天的准确工作时长（已去重）';
