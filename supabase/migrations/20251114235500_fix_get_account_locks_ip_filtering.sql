/*
  # 修复 get_account_locks_for_admin 函数 - IP 锁定过滤问题

  ## 问题说明
  二级管理员查询时，WHERE 条件 `u.admin_id = p_admin_id` 会排除所有 IP 锁定记录，
  因为 IP 锁定的 user_id 为 NULL，导致 LEFT JOIN 后 u.admin_id 也是 NULL。

  ## 解决方案
  修改 WHERE 条件，让二级管理员也能看到 IP 锁定记录：
  - 用户名锁定：只显示自己名下的员工
  - IP 锁定：所有管理员都可以看到（因为 IP 不特定于某个员工）

  ## 修改内容
  更新 get_account_locks_for_admin 函数的查询逻辑
*/

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
    -- 二级管理员：返回自己名下员工的锁定记录 + 所有 IP 锁定记录
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
      AND (
        -- IP 锁定：所有管理员都可以看到
        al.identifier_type = 'ip'
        -- 用户名锁定：只显示自己名下的员工
        OR (al.identifier_type = 'username' AND u.admin_id = p_admin_id)
      )
    ORDER BY al.created_at DESC;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 更新注释
COMMENT ON FUNCTION get_account_locks_for_admin IS '根据管理员角色获取可见的账户锁定记录。超级管理员可见所有记录，二级管理员可见自己员工的用户名锁定和所有 IP 锁定。';
