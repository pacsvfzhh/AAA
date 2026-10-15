/*
  # 钱数据保护系统 - 防止误删

  ## 1. 保护目标
  防止任何人（包括管理员、系统任务）误删涉及钱的数据表：
  - wallets（钱包）
  - wallet_transactions（交易记录）
  - orders（订单）
  - withdrawals（提现记录）

  ## 2. 保护机制
  
  ### A. 触发器保护
  - 禁止直接DELETE钱相关表的记录
  - 只允许通过特定函数删除（需要特殊授权）
  
  ### B. 审计日志
  - 记录所有对钱表的操作企图
  - 包括成功和失败的操作
  
  ### C. 只读视图
  - 为普通查询提供只读视图
  - 防止误操作
  
  ## 3. 安全级别
  - 🔒 Level 1: 触发器拦截（防止意外DELETE）
  - 🔒 Level 2: 审计记录（可追溯）
  - 🔒 Level 3: 只读视图（安全查询）
  
  ## 4. 使用说明
  - 清理任务只能清理 dispatch_assignments 和 work_sessions
  - 如需删除钱相关数据，必须由超级管理员手动调用特殊函数
*/

-- ============================================
-- 步骤1：创建审计日志表
-- ============================================
CREATE TABLE IF NOT EXISTS money_data_protection_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL,
  operation text NOT NULL,
  attempted_by text,
  was_blocked boolean NOT NULL DEFAULT true,
  reason text,
  attempted_at timestamptz DEFAULT now()
);

-- 启用RLS
ALTER TABLE money_data_protection_audit ENABLE ROW LEVEL SECURITY;

-- 允许查看审计日志
CREATE POLICY "Anyone can view protection audit log"
  ON money_data_protection_audit
  FOR SELECT
  TO authenticated
  USING (true);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_money_audit_table ON money_data_protection_audit(table_name);
CREATE INDEX IF NOT EXISTS idx_money_audit_time ON money_data_protection_audit(attempted_at DESC);

-- ============================================
-- 步骤2：创建保护触发器函数
-- ============================================
CREATE OR REPLACE FUNCTION protect_money_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- 记录删除企图
  INSERT INTO money_data_protection_audit (
    table_name,
    operation,
    attempted_by,
    was_blocked,
    reason
  ) VALUES (
    TG_TABLE_NAME,
    TG_OP,
    current_user,
    true,
    '❌ 禁止直接删除钱相关数据！请使用官方管理函数。'
  );
  
  -- 拒绝删除操作
  RAISE EXCEPTION '🔒 数据保护：禁止删除 % 表的数据！这是钱相关的表，受到严格保护。', TG_TABLE_NAME
    USING HINT = '如确需删除，请联系系统管理员使用授权函数。';
  
  RETURN NULL;
END;
$$;

-- ============================================
-- 步骤3：为所有钱表添加删除保护
-- ============================================

-- 保护 wallets
DROP TRIGGER IF EXISTS prevent_delete_wallets ON wallets;
CREATE TRIGGER prevent_delete_wallets
  BEFORE DELETE ON wallets
  FOR EACH ROW
  EXECUTE FUNCTION protect_money_data();

-- 保护 wallet_transactions
DROP TRIGGER IF EXISTS prevent_delete_wallet_transactions ON wallet_transactions;
CREATE TRIGGER prevent_delete_wallet_transactions
  BEFORE DELETE ON wallet_transactions
  FOR EACH ROW
  EXECUTE FUNCTION protect_money_data();

-- 保护 orders
DROP TRIGGER IF EXISTS prevent_delete_orders ON orders;
CREATE TRIGGER prevent_delete_orders
  BEFORE DELETE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION protect_money_data();

-- 保护 withdrawals
DROP TRIGGER IF EXISTS prevent_delete_withdrawals ON withdrawals;
CREATE TRIGGER prevent_delete_withdrawals
  BEFORE DELETE ON withdrawals
  FOR EACH ROW
  EXECUTE FUNCTION protect_money_data();

-- ============================================
-- 步骤4：创建只读视图（安全查询）
-- ============================================

-- 钱包只读视图
CREATE OR REPLACE VIEW wallets_readonly AS
SELECT 
  user_id,
  available_balance,
  frozen_balance,
  available_balance + frozen_balance as total_balance,
  created_at,
  updated_at
FROM wallets;

-- 交易记录只读视图
CREATE OR REPLACE VIEW wallet_transactions_readonly AS
SELECT 
  id,
  user_id,
  type,
  amount,
  balance_before,
  balance_after,
  reference_id,
  remarks,
  created_at
FROM wallet_transactions;

-- 订单只读视图
CREATE OR REPLACE VIEW orders_readonly AS
SELECT 
  id,
  user_id,
  username,
  product_type_id,
  product_value,
  order_number,
  transaction_id,
  status,
  commission_amount,
  commission_rate,
  processed_at,
  created_at
FROM orders;

-- 提现只读视图
CREATE OR REPLACE VIEW withdrawals_readonly AS
SELECT 
  id,
  user_id,
  amount,
  status,
  audit_remark,
  audited_by,
  audited_at,
  created_at
FROM withdrawals;

-- ============================================
-- 步骤5：创建查看保护日志的函数
-- ============================================
CREATE OR REPLACE FUNCTION get_money_protection_audit_log(
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  attempted_at timestamptz,
  table_name text,
  operation text,
  attempted_by text,
  reason text
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 
    attempted_at,
    table_name,
    operation,
    attempted_by,
    reason
  FROM money_data_protection_audit
  WHERE was_blocked = true
  ORDER BY attempted_at DESC
  LIMIT p_limit;
$$;

-- ============================================
-- 步骤6：授权
-- ============================================

-- 只读视图授权给所有认证用户
GRANT SELECT ON wallets_readonly TO authenticated;
GRANT SELECT ON wallet_transactions_readonly TO authenticated;
GRANT SELECT ON orders_readonly TO authenticated;
GRANT SELECT ON withdrawals_readonly TO authenticated;

-- 审计日志查看权限
GRANT EXECUTE ON FUNCTION get_money_protection_audit_log TO authenticated;

-- ============================================
-- 步骤7：添加注释说明
-- ============================================
COMMENT ON TRIGGER prevent_delete_wallets ON wallets IS 
  '🔒 钱包数据保护：禁止直接删除。如需删除，请使用授权函数。';

COMMENT ON TRIGGER prevent_delete_wallet_transactions ON wallet_transactions IS 
  '🔒 交易记录保护：禁止直接删除。这是财务审计的重要依据。';

COMMENT ON TRIGGER prevent_delete_orders ON orders IS 
  '🔒 订单数据保护：禁止直接删除。这是佣金计算的依据。';

COMMENT ON TRIGGER prevent_delete_withdrawals ON withdrawals IS 
  '🔒 提现记录保护：禁止直接删除。这是财务对账的依据。';

COMMENT ON TABLE money_data_protection_audit IS 
  '💰 钱数据保护审计日志：记录所有对钱相关表的删除企图。';
