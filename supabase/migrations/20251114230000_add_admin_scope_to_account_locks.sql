/*
  # 账户锁定管理 - 添加管理员权限范围

  ## 修改说明
  添加管理员权限范围控制，让二级管理员只能查看和管理自己名下员工的锁定记录

  ## 修改内容
  1. 在 `account_locks` 表中添加 `user_id` 字段
  2. 更新 RLS 策略，区分超级管理员和二级管理员
  3. 修改相关函数，支持管理员范围过滤

  ## 安全性
  - 超级管理员可以查看所有锁定记录
  - 二级管理员只能查看自己名下员工的锁定记录
  - 二级管理员只能解锁自己名下员工的账户
*/

-- 1. 添加 user_id 字段到 account_locks 表
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'account_locks' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE account_locks ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 2. 创建索引
CREATE INDEX IF NOT EXISTS idx_account_locks_user_id ON account_locks(user_id);

-- 3. 删除旧的 RLS 策略
DROP POLICY IF EXISTS "Admins can view all account locks" ON account_locks;

-- 4. 创建新的 RLS 策略
CREATE POLICY "Super admin can view all account locks"
  ON account_locks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.id = (current_setting('app.current_admin_id', true))::uuid
        AND admins.role = 'super'
    )
  );

CREATE POLICY "Secondary admin can view own employees account locks"
  ON account_locks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.id = (current_setting('app.current_admin_id', true))::uuid
        AND admins.role = 'secondary'
    )
    AND (
      user_id IN (
        SELECT id FROM users
        WHERE admin_id = (current_setting('app.current_admin_id', true))::uuid
      )
    )
  );

-- 5. 更新 record_login_attempt 函数，记录 user_id
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
  v_user_id uuid;
  v_result jsonb;
BEGIN
  -- 插入登录尝试记录
  INSERT INTO login_attempts (
    identifier, identifier_type, success, ip_address, user_agent
  ) VALUES (
    p_identifier, p_identifier_type, p_success, p_ip_address, p_user_agent
  );

  -- 如果是用户名登录，获取 user_id
  IF p_identifier_type = 'username' THEN
    SELECT id INTO v_user_id FROM users WHERE username = p_identifier;
  END IF;

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
    identifier, identifier_type, lock_until, lock_reason, failed_attempts, user_id
  ) VALUES (
    p_identifier, p_identifier_type, now() + v_lock_duration, v_lock_reason, v_recent_failures, v_user_id
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

-- 6. 创建函数：获取管理员可见的账户锁定
CREATE OR REPLACE FUNCTION get_account_locks_for_admin(p_admin_id uuid)
RETURNS TABLE (
  id uuid,
  identifier text,
  identifier_type text,
  lock_until timestamptz,
  lock_reason text,
  failed_attempts integer,
  created_at timestamptz,
  unlocked_at timestamptz,
  unlocked_by uuid,
  user_id uuid,
  username text,
  admin_username text
) AS $$
BEGIN
  -- 检查管理员角色
  IF EXISTS (SELECT 1 FROM admins WHERE admins.id = p_admin_id AND role = 'super') THEN
    -- 超级管理员：返回所有锁定记录
    RETURN QUERY
    SELECT
      al.id,
      al.identifier,
      al.identifier_type,
      al.lock_until,
      al.lock_reason,
      al.failed_attempts,
      al.created_at,
      al.unlocked_at,
      al.unlocked_by,
      al.user_id,
      u.username,
      a.username as admin_username
    FROM account_locks al
    LEFT JOIN users u ON al.user_id = u.id
    LEFT JOIN admins a ON u.admin_id = a.id
    WHERE al.unlocked_at IS NULL
      AND al.lock_until > now()
    ORDER BY al.created_at DESC;
  ELSE
    -- 二级管理员：只返回自己名下员工的锁定记录
    RETURN QUERY
    SELECT
      al.id,
      al.identifier,
      al.identifier_type,
      al.lock_until,
      al.lock_reason,
      al.failed_attempts,
      al.created_at,
      al.unlocked_at,
      al.unlocked_by,
      al.user_id,
      u.username,
      a.username as admin_username
    FROM account_locks al
    LEFT JOIN users u ON al.user_id = u.id
    LEFT JOIN admins a ON u.admin_id = a.id
    WHERE al.unlocked_at IS NULL
      AND al.lock_until > now()
      AND u.admin_id = p_admin_id
    ORDER BY al.created_at DESC;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. 创建函数：管理员解锁账户（带权限检查）
CREATE OR REPLACE FUNCTION unlock_account_with_permission_check(
  p_identifier text,
  p_identifier_type text,
  p_admin_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_admin_role text;
  v_lock_user_id uuid;
  v_user_admin_id uuid;
  v_updated_count integer;
BEGIN
  -- 获取管理员角色
  SELECT role INTO v_admin_role FROM admins WHERE id = p_admin_id;

  IF v_admin_role IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', '管理员不存在'
    );
  END IF;

  -- 获取锁定记录的 user_id
  SELECT user_id INTO v_lock_user_id
  FROM account_locks
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL
  LIMIT 1;

  -- 如果是二级管理员，检查权限
  IF v_admin_role = 'secondary' AND v_lock_user_id IS NOT NULL THEN
    SELECT admin_id INTO v_user_admin_id FROM users WHERE id = v_lock_user_id;

    IF v_user_admin_id IS NULL OR v_user_admin_id != p_admin_id THEN
      RETURN jsonb_build_object(
        'success', false,
        'message', '您没有权限解锁此账户'
      );
    END IF;
  END IF;

  -- 执行解锁
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

-- 添加注释
COMMENT ON COLUMN account_locks.user_id IS '被锁定的用户 ID（如果是用户名锁定）';
COMMENT ON FUNCTION get_account_locks_for_admin IS '根据管理员角色获取可见的账户锁定记录';
COMMENT ON FUNCTION unlock_account_with_permission_check IS '带权限检查的账户解锁功能';
