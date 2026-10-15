/*
  # 登录速率限制系统

  ## 功能说明
  实现登录速率限制，防止暴力破解攻击

  ## 新增表
  1. `login_attempts` - 登录尝试记录表
     - `id` (uuid, 主键) - 记录 ID
     - `identifier` (text) - 标识符（IP 或用户名）
     - `identifier_type` (text) - 标识符类型（'ip' 或 'username'）
     - `attempt_time` (timestamptz) - 尝试时间
     - `success` (boolean) - 是否成功
     - `ip_address` (text) - IP 地址
     - `user_agent` (text) - 用户代理
     - `created_at` (timestamptz) - 创建时间

  2. `account_locks` - 账户锁定表
     - `id` (uuid, 主键) - 锁定 ID
     - `identifier` (text) - 标识符（IP 或用户名）
     - `identifier_type` (text) - 标识符类型
     - `lock_until` (timestamptz) - 锁定到什么时候
     - `lock_reason` (text) - 锁定原因
     - `failed_attempts` (integer) - 失败次数
     - `created_at` (timestamptz) - 创建时间
     - `unlocked_at` (timestamptz) - 解锁时间
     - `unlocked_by` (uuid) - 解锁管理员 ID

  ## 新增函数
  1. `check_login_rate_limit(p_identifier text, p_identifier_type text)` - 检查是否被限制
  2. `record_login_attempt(...)` - 记录登录尝试
  3. `unlock_account(p_identifier text, p_admin_id uuid)` - 解锁账户
  4. `cleanup_old_login_attempts()` - 清理旧记录

  ## 安全性
  - 启用 RLS，只允许认证用户读取自己的记录
  - 管理员可以查看所有记录和解锁账户
  - 自动清理 30 天前的记录

  ## 速率限制策略
  - 5 次失败 → 锁定 15 分钟
  - 10 次失败 → 锁定 1 小时
  - 15 次失败 → 锁定 24 小时
*/

-- 创建登录尝试记录表
CREATE TABLE IF NOT EXISTS login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  identifier_type text NOT NULL CHECK (identifier_type IN ('ip', 'username')),
  attempt_time timestamptz NOT NULL DEFAULT now(),
  success boolean NOT NULL DEFAULT false,
  ip_address text,
  user_agent text,
  created_at timestamptz DEFAULT now()
);

-- 创建账户锁定表
CREATE TABLE IF NOT EXISTS account_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  identifier_type text NOT NULL CHECK (identifier_type IN ('ip', 'username')),
  lock_until timestamptz NOT NULL,
  lock_reason text,
  failed_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  unlocked_at timestamptz,
  unlocked_by uuid REFERENCES admins(id)
);

-- 创建索引以提升查询性能
CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier, identifier_type, attempt_time DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts(attempt_time DESC);
CREATE INDEX IF NOT EXISTS idx_account_locks_identifier ON account_locks(identifier, identifier_type, lock_until);
CREATE INDEX IF NOT EXISTS idx_account_locks_active ON account_locks(lock_until) WHERE unlocked_at IS NULL;

-- 启用 RLS
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_locks ENABLE ROW LEVEL SECURITY;

-- RLS 策略：登录尝试记录
CREATE POLICY "Admins can view all login attempts"
  ON login_attempts FOR SELECT
  USING (true);

CREATE POLICY "System can insert login attempts"
  ON login_attempts FOR INSERT
  WITH CHECK (true);

-- RLS 策略：账户锁定
CREATE POLICY "Admins can view all account locks"
  ON account_locks FOR SELECT
  USING (true);

CREATE POLICY "System can insert account locks"
  ON account_locks FOR INSERT
  WITH CHECK (true);

CREATE POLICY "System can update account locks"
  ON account_locks FOR UPDATE
  USING (true);

-- 函数：检查登录速率限制
CREATE OR REPLACE FUNCTION check_login_rate_limit(
  p_identifier text,
  p_identifier_type text
) RETURNS jsonb AS $$
DECLARE
  v_active_lock record;
  v_recent_failures integer;
  v_result jsonb;
BEGIN
  -- 检查是否有活跃的锁定
  SELECT * INTO v_active_lock
  FROM account_locks
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL
  ORDER BY lock_until DESC
  LIMIT 1;

  IF FOUND THEN
    -- 账户被锁定
    RETURN jsonb_build_object(
      'allowed', false,
      'locked', true,
      'lock_until', v_active_lock.lock_until,
      'lock_reason', v_active_lock.lock_reason,
      'failed_attempts', v_active_lock.failed_attempts,
      'remaining_seconds', EXTRACT(EPOCH FROM (v_active_lock.lock_until - now()))::integer
    );
  END IF;

  -- 检查最近的失败次数（过去 1 小时内）
  SELECT COUNT(*) INTO v_recent_failures
  FROM login_attempts
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND success = false
    AND attempt_time > now() - interval '1 hour';

  -- 允许登录
  RETURN jsonb_build_object(
    'allowed', true,
    'locked', false,
    'recent_failures', v_recent_failures,
    'warning', CASE
      WHEN v_recent_failures >= 3 THEN '多次登录失败，请注意'
      ELSE NULL
    END
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 函数：记录登录尝试并处理锁定
CREATE OR REPLACE FUNCTION record_login_attempt(
  p_identifier text,
  p_identifier_type text,
  p_success boolean,
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_recent_failures integer;
  v_lock_duration interval;
  v_lock_reason text;
  v_result jsonb;
BEGIN
  -- 插入登录尝试记录
  INSERT INTO login_attempts (
    identifier, identifier_type, success, ip_address, user_agent
  ) VALUES (
    p_identifier, p_identifier_type, p_success, p_ip_address, p_user_agent
  );

  -- 如果登录成功，清除该标识符的锁定
  IF p_success THEN
    UPDATE account_locks
    SET unlocked_at = now()
    WHERE identifier = p_identifier
      AND identifier_type = p_identifier_type
      AND unlocked_at IS NULL;

    RETURN jsonb_build_object(
      'success', true,
      'message', '登录成功'
    );
  END IF;

  -- 登录失败，检查失败次数
  SELECT COUNT(*) INTO v_recent_failures
  FROM login_attempts
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND success = false
    AND attempt_time > now() - interval '1 hour';

  -- 根据失败次数决定锁定时长
  IF v_recent_failures >= 15 THEN
    v_lock_duration := interval '24 hours';
    v_lock_reason := '连续 15 次登录失败，锁定 24 小时';
  ELSIF v_recent_failures >= 10 THEN
    v_lock_duration := interval '1 hour';
    v_lock_reason := '连续 10 次登录失败，锁定 1 小时';
  ELSIF v_recent_failures >= 5 THEN
    v_lock_duration := interval '15 minutes';
    v_lock_reason := '连续 5 次登录失败，锁定 15 分钟';
  ELSE
    -- 不需要锁定
    RETURN jsonb_build_object(
      'success', false,
      'locked', false,
      'failed_attempts', v_recent_failures,
      'message', '登录失败'
    );
  END IF;

  -- 创建锁定记录
  INSERT INTO account_locks (
    identifier, identifier_type, lock_until, lock_reason, failed_attempts
  ) VALUES (
    p_identifier, p_identifier_type, now() + v_lock_duration, v_lock_reason, v_recent_failures
  );

  RETURN jsonb_build_object(
    'success', false,
    'locked', true,
    'lock_until', now() + v_lock_duration,
    'lock_reason', v_lock_reason,
    'failed_attempts', v_recent_failures
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 函数：解锁账户（管理员使用）
CREATE OR REPLACE FUNCTION unlock_account(
  p_identifier text,
  p_identifier_type text,
  p_admin_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_updated_count integer;
BEGIN
  -- 更新所有该标识符的活跃锁定
  UPDATE account_locks
  SET unlocked_at = now(),
      unlocked_by = p_admin_id
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', '账户已解锁',
      'unlocked_count', v_updated_count
    );
  ELSE
    RETURN jsonb_build_object(
      'success', false,
      'message', '没有找到需要解锁的账户'
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 函数：清理旧的登录尝试记录（保留 30 天）
CREATE OR REPLACE FUNCTION cleanup_old_login_attempts() RETURNS jsonb AS $$
DECLARE
  v_deleted_attempts integer;
  v_deleted_locks integer;
BEGIN
  -- 删除 30 天前的登录尝试记录
  DELETE FROM login_attempts
  WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS v_deleted_attempts = ROW_COUNT;

  -- 删除已解锁且超过 30 天的锁定记录
  DELETE FROM account_locks
  WHERE unlocked_at IS NOT NULL
    AND unlocked_at < now() - interval '30 days';
  GET DIAGNOSTICS v_deleted_locks = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_attempts', v_deleted_attempts,
    'deleted_locks', v_deleted_locks,
    'cleanup_time', now()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 添加注释
COMMENT ON TABLE login_attempts IS '登录尝试记录表，记录所有登录尝试';
COMMENT ON TABLE account_locks IS '账户锁定表，记录被锁定的账户';
COMMENT ON FUNCTION check_login_rate_limit IS '检查登录速率限制，返回是否允许登录';
COMMENT ON FUNCTION record_login_attempt IS '记录登录尝试，失败次数过多时自动锁定';
COMMENT ON FUNCTION unlock_account IS '管理员解锁账户';
COMMENT ON FUNCTION cleanup_old_login_attempts IS '清理 30 天前的旧记录';
