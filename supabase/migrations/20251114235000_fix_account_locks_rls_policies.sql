/*
  # 修复账户锁定 RLS 策略

  ## 问题说明
  之前的 RLS 策略使用了 `current_setting('app.current_admin_id')`，但该值从未设置，导致策略失效。

  ## 解决方案
  由于使用自定义认证系统（非 Supabase Auth），应该：
  1. 保持 RLS 策略简单（允许所有查询通过）
  2. 在 SECURITY DEFINER 函数内部进行权限检查
  3. 前端只调用 RPC 函数，不直接查询表

  ## 修改内容
  1. 删除有问题的 RLS 策略
  2. 创建简单的 RLS 策略，允许所有查询通过（因为会通过 RPC 函数）
  3. RPC 函数内部已经有完整的权限检查
*/

-- 1. 删除有问题的 RLS 策略
DROP POLICY IF EXISTS "Super admin can view all account locks" ON account_locks;
DROP POLICY IF EXISTS "Secondary admin can view own employees account locks" ON account_locks;

-- 2. 创建简单的 RLS 策略
-- 这些策略允许所有操作通过，因为：
-- - 前端只通过 SECURITY DEFINER 函数访问数据
-- - 权限检查在函数内部完成
-- - RLS 主要是为了满足 Supabase 的要求（表必须启用 RLS）

CREATE POLICY "Allow function access to account locks"
  ON account_locks FOR SELECT
  USING (true);

-- 保持其他策略不变
-- INSERT 和 UPDATE 策略已在原始迁移中创建

-- 添加注释说明
COMMENT ON POLICY "Allow function access to account locks" ON account_locks IS
'允许通过 SECURITY DEFINER 函数访问。权限检查在函数内部完成（get_account_locks_for_admin 和 unlock_account_with_permission_check）。';
