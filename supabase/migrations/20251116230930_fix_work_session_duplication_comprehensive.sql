/*
  # 综合修复工作会话重复问题
  
  ## 发现的问题
  
  1. **重复会话创建**
     - 用户dadada在今天创建了42个会话，其中16个是0秒时长的重复会话（38%）
     - 同一时间点创建了多个会话（例如22:58:02有两个会话）
     - 原因：dispatch_sessions触发器和start_work_session函数都在创建work_sessions
  
  2. **时长计算虚高**
     - 所有重复会话都被计入总时长
     - 实际工作时长被严重高估
     - dadada今天实际可能只工作了30-60分钟，但显示为120分钟
  
  3. **0秒会话**
     - 大量0秒或极短时长的会话（0-2秒）
     - 这些是重复创建导致的
  
  ## 解决方案
  
  1. **防止重复创建**
     - 修改start_work_session函数，确保只返回活动会话
     - 添加唯一约束防止同一用户有多个活动会话
  
  2. **清理历史重复数据**
     - 删除0秒时长的重复会话
     - 合并重叠的会话
  
  3. **添加验证和清理触发器**
     - 自动检测并清理异常会话
     - 防止未来出现重复
*/

-- Step 1: 添加唯一索引防止同一用户同时有多个活动会话
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_sessions_active_user 
ON work_sessions (user_id) 
WHERE end_time IS NULL;

-- Step 2: 删除0秒时长的重复会话（保留第一个）
WITH duplicate_sessions AS (
  SELECT 
    id,
    user_id,
    start_time,
    end_time,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, DATE_TRUNC('second', start_time)
      ORDER BY created_at ASC, id ASC
    ) as rn,
    EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time))::integer as duration_seconds
  FROM work_sessions
  WHERE start_time >= CURRENT_DATE - INTERVAL '7 days'
)
DELETE FROM work_sessions
WHERE id IN (
  SELECT id FROM duplicate_sessions
  WHERE (rn > 1 AND duration_seconds <= 5) OR duration_seconds = 0
);

-- Step 3: 修复start_work_session函数，防止重复创建
CREATE OR REPLACE FUNCTION start_work_session(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_active_session_id uuid;
  v_session_id uuid;
BEGIN
  -- 首先检查是否存在活动会话（未关闭的会话）
  SELECT id INTO v_active_session_id
  FROM work_sessions
  WHERE user_id = p_user_id
    AND end_time IS NULL
  ORDER BY start_time DESC
  LIMIT 1;
  
  -- 如果存在活动会话，直接返回
  IF v_active_session_id IS NOT NULL THEN
    RETURN v_active_session_id;
  END IF;
  
  -- 只有在没有活动会话时才创建新会话
  INSERT INTO work_sessions (user_id, start_time)
  VALUES (p_user_id, now())
  ON CONFLICT ON CONSTRAINT idx_work_sessions_active_user DO NOTHING
  RETURNING id INTO v_session_id;
  
  -- 如果插入因冲突而失败（极端并发情况），再次查询活动会话
  IF v_session_id IS NULL THEN
    SELECT id INTO v_session_id
    FROM work_sessions
    WHERE user_id = p_user_id
      AND end_time IS NULL
    LIMIT 1;
  END IF;
  
  RETURN v_session_id;
END;
$$;

-- Step 4: 修复sync_dispatch_session_start触发器，避免重复创建
CREATE OR REPLACE FUNCTION sync_dispatch_session_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing_session uuid;
BEGIN
  -- 只在dispatch session变为online时处理
  IF NEW.status = 'online' AND NEW.started_at IS NOT NULL THEN
    -- 检查是否已存在活动的work_session
    SELECT id INTO v_existing_session
    FROM work_sessions
    WHERE user_id = NEW.user_id
      AND end_time IS NULL
    LIMIT 1;
    
    -- 如果已存在活动会话，不创建新的
    IF v_existing_session IS NOT NULL THEN
      RETURN NEW;
    END IF;
    
    -- 只有在没有活动会话时才创建
    INSERT INTO work_sessions (id, user_id, start_time)
    VALUES (NEW.id, NEW.user_id, NEW.started_at)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Step 5: 添加自动清理异常会话的触发器
CREATE OR REPLACE FUNCTION cleanup_duplicate_work_sessions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_other_active_sessions integer;
BEGIN
  -- 如果插入的是新的活动会话（end_time为NULL）
  IF NEW.end_time IS NULL THEN
    -- 检查是否还有其他活动会话
    SELECT COUNT(*) INTO v_other_active_sessions
    FROM work_sessions
    WHERE user_id = NEW.user_id
      AND end_time IS NULL
      AND id != NEW.id;
    
    -- 如果存在其他活动会话，关闭最旧的那些
    IF v_other_active_sessions > 0 THEN
      UPDATE work_sessions
      SET end_time = NEW.start_time,
          duration_minutes = EXTRACT(EPOCH FROM (NEW.start_time - start_time)) / 60
      WHERE user_id = NEW.user_id
        AND end_time IS NULL
        AND id != NEW.id
        AND start_time < NEW.start_time;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- 创建触发器
DROP TRIGGER IF EXISTS trigger_cleanup_duplicate_sessions ON work_sessions;
CREATE TRIGGER trigger_cleanup_duplicate_sessions
  AFTER INSERT ON work_sessions
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_duplicate_work_sessions();

-- Step 6: 添加定期清理作业（清理异常数据）
CREATE OR REPLACE FUNCTION cleanup_zero_duration_sessions()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- 删除已完成但时长为0的会话（明显的重复）
  DELETE FROM work_sessions
  WHERE end_time IS NOT NULL
    AND EXTRACT(EPOCH FROM (end_time - start_time)) <= 1
    AND start_time >= CURRENT_DATE - INTERVAL '7 days';
    
  -- 关闭超过48小时未关闭的会话
  UPDATE work_sessions
  SET end_time = start_time + INTERVAL '8 hours',
      duration_minutes = 480
  WHERE end_time IS NULL
    AND start_time < now() - INTERVAL '48 hours';
END;
$$;

-- 立即执行一次清理
SELECT cleanup_zero_duration_sessions();

-- 创建索引以优化查询
CREATE INDEX IF NOT EXISTS idx_work_sessions_user_start_time 
ON work_sessions (user_id, start_time DESC);

CREATE INDEX IF NOT EXISTS idx_work_sessions_user_end_time 
ON work_sessions (user_id, end_time) 
WHERE end_time IS NOT NULL;

-- 添加注释
COMMENT ON FUNCTION start_work_session IS '启动工作会话 - 防止重复创建，确保每个用户同时只有一个活动会话';
COMMENT ON FUNCTION cleanup_duplicate_work_sessions IS '自动清理重复的工作会话 - 在插入新会话时关闭旧的活动会话';
COMMENT ON FUNCTION cleanup_zero_duration_sessions IS '清理0时长和异常的工作会话';
COMMENT ON INDEX idx_work_sessions_active_user IS '唯一索引：确保每个用户同时只有一个活动会话（end_time为NULL）';
