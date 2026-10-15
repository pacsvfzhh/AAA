/*
  # 全面修复钱包余额同步问题
  
  1. 问题分析
    - 部分用户的钱包余额与wallet_transactions不匹配
    - 成功订单缺少对应的wallet_transaction记录
    - wallet_transactions需要balance_before和balance_after字段
  
  2. 解决方案
    - 补充缺失的wallet_transaction记录（含balance_before/after）
    - 重新计算所有钱包余额
    - 创建触发器确保未来数据一致性
  
  3. 数据流
    订单成功 -> wallet_transaction + 钱包余额更新 -> 保持同步
*/

-- 1. 为缺失的订单补充wallet_transaction（计算正确的balance_before/after）
DO $$
DECLARE
  missing_order RECORD;
  current_balance numeric;
BEGIN
  FOR missing_order IN (
    SELECT 
      o.id,
      o.user_id,
      o.commission_amount,
      o.created_at
    FROM orders o
    WHERE o.status = 'success'
    AND o.commission_amount IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM wallet_transactions wt
      WHERE wt.user_id = o.user_id 
      AND wt.type = 'commission'
      AND ABS(wt.amount - o.commission_amount) < 0.0001
      AND wt.created_at BETWEEN o.created_at - INTERVAL '10 minutes' AND o.created_at + INTERVAL '10 minutes'
    )
    ORDER BY o.created_at
  )
  LOOP
    -- 获取该订单时间点之前的余额
    SELECT COALESCE(SUM(amount), 0)
    INTO current_balance
    FROM wallet_transactions
    WHERE user_id = missing_order.user_id
    AND created_at < missing_order.created_at;
    
    -- 插入transaction记录
    INSERT INTO wallet_transactions (
      user_id, 
      type, 
      amount, 
      balance_before, 
      balance_after, 
      created_at
    )
    VALUES (
      missing_order.user_id,
      'commission',
      missing_order.commission_amount,
      current_balance,
      current_balance + missing_order.commission_amount,
      missing_order.created_at
    );
    
    RAISE NOTICE 'Added commission transaction for order % (amount: %, balance: % -> %)', 
      missing_order.id,
      missing_order.commission_amount,
      current_balance,
      current_balance + missing_order.commission_amount;
  END LOOP;
END $$;

-- 2. 重新计算所有钱包的balance_before和balance_after
DO $$
DECLARE
  user_rec RECORD;
  txn_rec RECORD;
  running_balance numeric;
BEGIN
  FOR user_rec IN (SELECT DISTINCT user_id FROM wallet_transactions)
  LOOP
    running_balance := 0;
    
    FOR txn_rec IN (
      SELECT id, amount, balance_before, balance_after
      FROM wallet_transactions
      WHERE user_id = user_rec.user_id
      ORDER BY created_at, id
    )
    LOOP
      -- 更新balance_before和balance_after
      UPDATE wallet_transactions
      SET 
        balance_before = running_balance,
        balance_after = running_balance + txn_rec.amount
      WHERE id = txn_rec.id;
      
      running_balance := running_balance + txn_rec.amount;
    END LOOP;
  END LOOP;
  
  RAISE NOTICE 'Updated balance_before/balance_after for all transactions';
END $$;

-- 3. 重新计算所有钱包余额（基于wallet_transactions）
DO $$
DECLARE
  wallet_rec RECORD;
  calculated_balance numeric;
  old_balance numeric;
BEGIN
  FOR wallet_rec IN (
    SELECT 
      w.user_id,
      w.available_balance,
      w.frozen_balance,
      COALESCE(SUM(wt.amount), 0) as total_transactions
    FROM wallets w
    LEFT JOIN wallet_transactions wt ON w.user_id = wt.user_id
    GROUP BY w.user_id, w.available_balance, w.frozen_balance
  )
  LOOP
    old_balance := wallet_rec.available_balance + wallet_rec.frozen_balance;
    calculated_balance := wallet_rec.total_transactions;
    
    IF ABS(old_balance - calculated_balance) > 0.01 THEN
      UPDATE wallets
      SET available_balance = calculated_balance - frozen_balance
      WHERE user_id = wallet_rec.user_id;
      
      RAISE NOTICE 'Fixed wallet for user %: % -> % (diff: %)',
        wallet_rec.user_id,
        old_balance,
        calculated_balance,
        calculated_balance - old_balance;
    END IF;
  END LOOP;
END $$;

-- 4. 创建触发器函数：订单成功时自动创建wallet_transaction并更新余额
CREATE OR REPLACE FUNCTION auto_create_commission_and_update_wallet()
RETURNS TRIGGER AS $$
DECLARE
  current_balance numeric;
BEGIN
  -- 只在订单状态变为success时触发
  IF NEW.status = 'success' AND (OLD IS NULL OR OLD.status != 'success') AND NEW.commission_amount IS NOT NULL THEN
    -- 检查是否已有对应的transaction
    IF NOT EXISTS (
      SELECT 1 FROM wallet_transactions
      WHERE user_id = NEW.user_id
      AND type = 'commission'
      AND reference_id = NEW.id
    ) THEN
      -- 获取当前余额
      SELECT COALESCE(balance_after, 0)
      INTO current_balance
      FROM wallet_transactions
      WHERE user_id = NEW.user_id
      ORDER BY created_at DESC, id DESC
      LIMIT 1;
      
      IF current_balance IS NULL THEN
        current_balance := 0;
      END IF;
      
      -- 创建commission交易
      INSERT INTO wallet_transactions (
        user_id, 
        type, 
        amount, 
        balance_before, 
        balance_after,
        reference_id,
        created_at
      )
      VALUES (
        NEW.user_id, 
        'commission', 
        NEW.commission_amount,
        current_balance,
        current_balance + NEW.commission_amount,
        NEW.id,
        NEW.created_at
      );
      
      -- 更新钱包余额
      UPDATE wallets
      SET available_balance = available_balance + NEW.commission_amount
      WHERE user_id = NEW.user_id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. 替换旧触发器
DROP TRIGGER IF EXISTS trigger_auto_commission_transaction ON orders;
DROP TRIGGER IF EXISTS trigger_update_total_income_on_order ON orders;

CREATE TRIGGER trigger_sync_order_to_wallet
  AFTER INSERT OR UPDATE OF status ON orders
  FOR EACH ROW
  EXECUTE FUNCTION auto_create_commission_and_update_wallet();

CREATE TRIGGER trigger_update_total_income
  AFTER INSERT OR UPDATE OF status ON orders
  FOR EACH ROW
  EXECUTE FUNCTION update_user_total_income_on_order_success();
