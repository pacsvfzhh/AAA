/*
  # 企业级佣金保护系统 - 多层防护架构

  ## 设计理念：纵深防御 (Defense in Depth)

  1. **数据库约束层** - 第一道防线：物理阻止错误数据
  2. **触发器验证层** - 第二道防线：业务逻辑验证
  3. **审计日志层** - 第三道防线：完整记录所有变更
  4. **自动修复层** - 第四道防线：定期检查和修复不一致
  5. **监控告警层** - 第五道防线：实时监控异常

  ## 核心原则
  - 单一事实来源：orders表是唯一的真相
  - 不可变审计：所有变更都有完整日志
  - 自动对账：定期验证数据一致性
  - 故障自愈：发现问题自动修复
*/

-- ============================================================================
-- 第一层：数据库约束层 - 物理阻止错误数据
-- ============================================================================

-- 1.1 创建检查约束：确保commission只能与成功订单关联
ALTER TABLE wallet_transactions
DROP CONSTRAINT IF EXISTS check_commission_must_have_successful_order;

ALTER TABLE wallet_transactions
ADD CONSTRAINT check_commission_must_have_successful_order
CHECK (
  type != 'commission' OR reference_id IS NOT NULL
) NOT VALID;

-- 1.2 创建唯一索引：防止同一订单创建多个commission
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_commission_order_unique
ON wallet_transactions (user_id, reference_id)
WHERE type = 'commission';

-- 1.3 确保orders表的commission_amount与status一致
ALTER TABLE orders
DROP CONSTRAINT IF EXISTS check_commission_only_for_success;

ALTER TABLE orders
ADD CONSTRAINT check_commission_only_for_success
CHECK (
  (status = 'success' AND commission_amount IS NOT NULL AND commission_amount > 0) OR
  (status != 'success' AND (commission_amount IS NULL OR commission_amount = 0))
);

-- ============================================================================
-- 第二层：审计日志系统 - 完整记录所有变更
-- ============================================================================

-- 2.1 创建审计日志表
CREATE TABLE IF NOT EXISTS commission_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL, -- 'commission_created', 'commission_deleted', 'order_status_changed', 'balance_adjusted'
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  transaction_id uuid REFERENCES wallet_transactions(id) ON DELETE SET NULL,

  -- 变更前状态
  old_order_status text,
  old_commission_amount numeric(15,2),
  old_wallet_balance numeric(15,2),
  old_total_income numeric(15,2),

  -- 变更后状态
  new_order_status text,
  new_commission_amount numeric(15,2),
  new_wallet_balance numeric(15,2),
  new_total_income numeric(15,2),

  -- 元数据
  triggered_by text NOT NULL, -- 'edge_function', 'trigger', 'manual', 'auto_repair'
  reason text,
  metadata jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- 2.2 创建审计日志索引
CREATE INDEX IF NOT EXISTS idx_commission_audit_log_user_id ON commission_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_commission_audit_log_order_id ON commission_audit_log(order_id);
CREATE INDEX IF NOT EXISTS idx_commission_audit_log_event_type ON commission_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_commission_audit_log_created_at ON commission_audit_log(created_at DESC);

-- 2.3 启用审计日志表的RLS（只允许系统内部访问）
ALTER TABLE commission_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "System can manage audit logs"
  ON commission_audit_log
  FOR ALL
  USING (false); -- 不允许任何用户直接访问，只能通过函数

-- ============================================================================
-- 第三层：触发器验证层 - 业务逻辑验证和审计
-- ============================================================================

-- 3.1 订单状态变更审计触发器
CREATE OR REPLACE FUNCTION audit_order_status_change()
RETURNS TRIGGER AS $$
DECLARE
  v_wallet_balance numeric;
  v_total_income numeric;
BEGIN
  -- 获取当前钱包余额和总收入
  SELECT available_balance INTO v_wallet_balance
  FROM wallets WHERE user_id = NEW.user_id;

  SELECT total_income INTO v_total_income
  FROM users WHERE id = NEW.user_id;

  -- 记录审计日志
  INSERT INTO commission_audit_log (
    event_type,
    user_id,
    order_id,
    old_order_status,
    old_commission_amount,
    new_order_status,
    new_commission_amount,
    old_wallet_balance,
    new_wallet_balance,
    old_total_income,
    new_total_income,
    triggered_by,
    reason
  ) VALUES (
    'order_status_changed',
    NEW.user_id,
    NEW.id,
    OLD.status,
    OLD.commission_amount,
    NEW.status,
    NEW.commission_amount,
    v_wallet_balance,
    v_wallet_balance,
    v_total_income,
    v_total_income,
    'trigger',
    CASE
      WHEN OLD.status != NEW.status THEN 'Status changed from ' || OLD.status || ' to ' || NEW.status
      WHEN OLD.commission_amount IS DISTINCT FROM NEW.commission_amount THEN 'Commission changed'
      ELSE 'Order updated'
    END
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_audit_order_status ON orders;
CREATE TRIGGER trigger_audit_order_status
  AFTER UPDATE ON orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.commission_amount IS DISTINCT FROM NEW.commission_amount)
  EXECUTE FUNCTION audit_order_status_change();

-- 3.2 钱包交易创建审计触发器
CREATE OR REPLACE FUNCTION audit_commission_transaction()
RETURNS TRIGGER AS $$
DECLARE
  v_order_status text;
  v_order_commission numeric;
BEGIN
  IF NEW.type = 'commission' THEN
    -- 验证订单状态
    SELECT status, commission_amount INTO v_order_status, v_order_commission
    FROM orders WHERE id = NEW.reference_id;

    -- 如果订单不是成功状态，记录错误并阻止
    IF v_order_status IS NULL THEN
      RAISE EXCEPTION 'Commission transaction references non-existent order: %', NEW.reference_id;
    END IF;

    IF v_order_status != 'success' THEN
      RAISE EXCEPTION 'Cannot create commission for non-successful order. Order % has status: %', NEW.reference_id, v_order_status;
    END IF;

    IF v_order_commission IS NULL OR v_order_commission <= 0 THEN
      RAISE EXCEPTION 'Order % has invalid commission amount: %', NEW.reference_id, v_order_commission;
    END IF;

    -- 验证金额匹配
    IF ABS(NEW.amount - v_order_commission) > 0.01 THEN
      RAISE EXCEPTION 'Commission amount mismatch. Transaction: %, Order: %', NEW.amount, v_order_commission;
    END IF;

    -- 记录审计日志
    INSERT INTO commission_audit_log (
      event_type,
      user_id,
      order_id,
      transaction_id,
      new_commission_amount,
      triggered_by,
      reason,
      metadata
    ) VALUES (
      'commission_created',
      NEW.user_id,
      NEW.reference_id,
      NEW.id,
      NEW.amount,
      'trigger',
      'Commission transaction created',
      jsonb_build_object(
        'order_status', v_order_status,
        'order_commission', v_order_commission,
        'transaction_amount', NEW.amount
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_audit_commission_transaction ON wallet_transactions;
CREATE TRIGGER trigger_audit_commission_transaction
  BEFORE INSERT ON wallet_transactions
  FOR EACH ROW
  EXECUTE FUNCTION audit_commission_transaction();

-- ============================================================================
-- 第四层：数据一致性检查和自动修复
-- ============================================================================

-- 4.1 检查数据一致性函数（返回所有不一致的记录）
CREATE OR REPLACE FUNCTION check_commission_consistency()
RETURNS TABLE(
  issue_type text,
  user_id uuid,
  username text,
  order_id uuid,
  transaction_id uuid,
  order_status text,
  order_commission numeric,
  transaction_amount numeric,
  wallet_balance numeric,
  total_income numeric,
  calculated_income numeric,
  description text
) AS $$
BEGIN
  -- 检查1：失败订单有commission记录
  RETURN QUERY
  SELECT
    'invalid_commission_for_failed_order'::text,
    wt.user_id,
    u.username,
    wt.reference_id,
    wt.id,
    o.status,
    o.commission_amount,
    wt.amount,
    w.available_balance,
    u.total_income,
    (SELECT COALESCE(SUM(o_income.commission_amount), 0) FROM orders AS o_income WHERE o_income.user_id = u.id AND o_income.status = 'success')::numeric,
    'Commission transaction exists for failed/non-existent order'::text
  FROM wallet_transactions wt
  JOIN users u ON wt.user_id = u.id
  LEFT JOIN orders o ON wt.reference_id = o.id
  LEFT JOIN wallets w ON wt.user_id = w.user_id
  WHERE wt.type = 'commission'
  AND (o.id IS NULL OR o.status != 'success');

  -- 检查2：成功订单没有commission记录
  RETURN QUERY
  SELECT
    'missing_commission_for_success_order'::text,
    o.user_id,
    u.username,
    o.id,
    NULL::uuid,
    o.status,
    o.commission_amount,
    NULL::numeric,
    w.available_balance,
    u.total_income,
    (SELECT COALESCE(SUM(o_income.commission_amount), 0) FROM orders AS o_income WHERE o_income.user_id = u.id AND o_income.status = 'success')::numeric,
    'Successful order missing commission transaction'::text
  FROM orders o
  JOIN users u ON o.user_id = u.id
  LEFT JOIN wallets w ON o.user_id = w.user_id
  WHERE o.status = 'success'
  AND o.commission_amount IS NOT NULL
  AND o.commission_amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM wallet_transactions wt
    WHERE wt.user_id = o.user_id
    AND wt.type = 'commission'
    AND wt.reference_id = o.id
  );

  -- 检查3：commission金额与订单不匹配
  RETURN QUERY
  SELECT
    'commission_amount_mismatch'::text,
    wt.user_id,
    u.username,
    o.id,
    wt.id,
    o.status,
    o.commission_amount,
    wt.amount,
    w.available_balance,
    u.total_income,
    (SELECT COALESCE(SUM(o_income.commission_amount), 0) FROM orders AS o_income WHERE o_income.user_id = u.id AND o_income.status = 'success')::numeric,
    'Commission amount does not match order commission'::text
  FROM wallet_transactions wt
  JOIN orders o ON wt.reference_id = o.id
  JOIN users u ON wt.user_id = u.id
  LEFT JOIN wallets w ON wt.user_id = w.user_id
  WHERE wt.type = 'commission'
  AND o.status = 'success'
  AND ABS(wt.amount - o.commission_amount) > 0.01;

  -- 检查4：total_income与订单不一致
  RETURN QUERY
  SELECT
    'total_income_mismatch'::text,
    u.id,
    u.username,
    NULL::uuid,
    NULL::uuid,
    NULL::text,
    NULL::numeric,
    NULL::numeric,
    w.available_balance,
    u.total_income,
    COALESCE(SUM(o.commission_amount), 0)::numeric,
    'User total_income does not match sum of successful orders'::text
  FROM users u
  LEFT JOIN orders o ON u.id = o.user_id AND o.status = 'success'
  LEFT JOIN wallets w ON u.id = w.user_id
  GROUP BY u.id, u.username, u.total_income, w.available_balance
  HAVING ABS(u.total_income - COALESCE(SUM(o.commission_amount), 0)) > 0.01;

  -- 检查5：钱包余额与交易记录不一致
  RETURN QUERY
  SELECT
    'wallet_balance_mismatch'::text,
    w.user_id,
    u.username,
    NULL::uuid,
    NULL::uuid,
    NULL::text,
    NULL::numeric,
    NULL::numeric,
    w.available_balance,
    u.total_income,
    (SELECT COALESCE(SUM(o_income.commission_amount), 0) FROM orders AS o_income WHERE o_income.user_id = u.id AND o_income.status = 'success')::numeric,
    'Wallet balance does not match transaction history'::text
  FROM wallets w
  JOIN users u ON w.user_id = u.id
  LEFT JOIN (
    SELECT wt_balance.user_id, COALESCE(SUM(wt_balance.amount), 0) as total_transactions
    FROM wallet_transactions AS wt_balance
    GROUP BY wt_balance.user_id
  ) t ON w.user_id = t.user_id
  WHERE ABS((w.available_balance + w.frozen_balance) - COALESCE(t.total_transactions, 0)) > 0.01;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4.2 自动修复函数
CREATE OR REPLACE FUNCTION auto_repair_commission_data()
RETURNS TABLE(
  action text,
  user_id uuid,
  order_id uuid,
  transaction_id uuid,
  amount numeric,
  result text
) AS $$
DECLARE
  v_record RECORD;
  v_deleted_count INTEGER := 0;
  v_fixed_count INTEGER := 0;
BEGIN
  -- 修复1：删除失败订单的commission
  FOR v_record IN (
    SELECT wt.id as txn_id, wt.user_id, wt.reference_id, wt.amount, o.status
    FROM wallet_transactions wt
    LEFT JOIN orders o ON wt.reference_id = o.id
    WHERE wt.type = 'commission'
    AND (o.id IS NULL OR o.status != 'success')
  )
  LOOP
    DELETE FROM wallet_transactions WHERE id = v_record.txn_id;

    INSERT INTO commission_audit_log (
      event_type, user_id, order_id, transaction_id,
      old_commission_amount, triggered_by, reason
    ) VALUES (
      'commission_deleted', v_record.user_id, v_record.reference_id, v_record.txn_id,
      v_record.amount, 'auto_repair', 'Removed commission for failed order'
    );

    v_deleted_count := v_deleted_count + 1;

    RETURN QUERY SELECT
      'deleted_invalid_commission'::text,
      v_record.user_id,
      v_record.reference_id,
      v_record.txn_id,
      v_record.amount,
      ('Deleted commission for ' || COALESCE(v_record.status, 'non-existent') || ' order')::text;
  END LOOP;

  -- 修复2：重新计算所有用户的total_income
  FOR v_record IN (
    SELECT u.id, u.total_income as old_income,
           COALESCE(SUM(o.commission_amount), 0) as new_income
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id AND o.status = 'success'
    GROUP BY u.id, u.total_income
    HAVING ABS(u.total_income - COALESCE(SUM(o.commission_amount), 0)) > 0.01
  )
  LOOP
    UPDATE users SET total_income = v_record.new_income WHERE id = v_record.id;

    INSERT INTO commission_audit_log (
      event_type, user_id, old_total_income, new_total_income,
      triggered_by, reason
    ) VALUES (
      'balance_adjusted', v_record.id, v_record.old_income, v_record.new_income,
      'auto_repair', 'Fixed total_income mismatch'
    );

    v_fixed_count := v_fixed_count + 1;

    RETURN QUERY SELECT
      'fixed_total_income'::text,
      v_record.id,
      NULL::uuid,
      NULL::uuid,
      (v_record.new_income - v_record.old_income)::numeric,
      'Updated total_income'::text;
  END LOOP;

  -- 修复3：重新计算钱包余额
  FOR v_record IN (
    SELECT w.user_id, w.available_balance as old_balance,
           (COALESCE(t.total_transactions, 0) - w.frozen_balance) as new_balance
    FROM wallets w
    LEFT JOIN (
      SELECT wt_balance.user_id, SUM(wt_balance.amount) as total_transactions
      FROM wallet_transactions AS wt_balance
      GROUP BY wt_balance.user_id
    ) t ON w.user_id = t.user_id
    WHERE ABS((w.available_balance + w.frozen_balance) - COALESCE(t.total_transactions, 0)) > 0.01
  )
  LOOP
    UPDATE wallets SET available_balance = v_record.new_balance WHERE user_id = v_record.user_id;

    INSERT INTO commission_audit_log (
      event_type, user_id, old_wallet_balance, new_wallet_balance,
      triggered_by, reason
    ) VALUES (
      'balance_adjusted', v_record.user_id, v_record.old_balance, v_record.new_balance,
      'auto_repair', 'Fixed wallet balance mismatch'
    );

    v_fixed_count := v_fixed_count + 1;

    RETURN QUERY SELECT
      'fixed_wallet_balance'::text,
      v_record.user_id,
      NULL::uuid,
      NULL::uuid,
      (v_record.new_balance - v_record.old_balance)::numeric,
      'Updated wallet balance'::text;
  END LOOP;

  -- 返回总结
  RETURN QUERY SELECT
    'summary'::text,
    NULL::uuid,
    NULL::uuid,
    NULL::uuid,
    NULL::numeric,
    ('Deleted ' || v_deleted_count || ' invalid commissions, Fixed ' || v_fixed_count || ' balance mismatches')::text;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION auto_repair_commission_data() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION check_commission_consistency() FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 第五层：定期自动检查和修复（Cron Job）
-- ============================================================================

-- 注意：Supabase支持pg_cron扩展，但需要在项目设置中启用
-- 这里提供函数，可以通过外部调度器或手动运行

-- 5.1 每日数据一致性检查报告
CREATE OR REPLACE FUNCTION daily_commission_health_check()
RETURNS jsonb AS $$
DECLARE
  v_issues_count INTEGER;
  v_report jsonb;
BEGIN
  -- 统计问题数量
  SELECT COUNT(*) INTO v_issues_count
  FROM check_commission_consistency();

  SELECT jsonb_build_object(
    'timestamp', now(),
    'issues_found', v_issues_count,
    'requires_manual_review', v_issues_count > 0,
    'details', (
      SELECT jsonb_agg(row_to_json(t))
      FROM check_commission_consistency() t
    )
  ) INTO v_report;

  RETURN v_report;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION daily_commission_health_check() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM check_commission_consistency()) THEN
    RAISE WARNING 'Commission inconsistencies require manual review.';
  ELSE
    RAISE NOTICE 'All commission data is consistent!';
  END IF;
END $$;
