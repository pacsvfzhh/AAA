/*
  # 修复数据一致性问题并建立自动同步机制
  
  1. 问题分析
    - users.total_income 字段未自动更新
    - 部分成功订单的佣金未记录到wallet_transactions
    - 多个数据源导致显示不一致
  
  2. 解决方案
    - 创建函数重新计算所有用户的total_income（基于orders表）
    - 创建触发器在订单完成时自动更新total_income
    - 确保使用统一的数据源（orders表作为真实数据源）
  
  3. 数据源统一
    - Total Earnings (总收益): 使用orders表的所有成功订单佣金总和
    - Total Revenue (总营收): 同上，确保一致
    - Today Commission (今日佣金): 使用orders表今天的成功订单
    - Wallet Balance (钱包余额): 使用wallets表的available_balance
*/

-- 1. 创建函数：重新计算用户的total_income（基于orders表）
CREATE OR REPLACE FUNCTION recalculate_user_total_income(p_user_id uuid)
RETURNS numeric AS $$
DECLARE
  v_total numeric;
BEGIN
  -- 计算该用户所有成功订单的佣金总和
  SELECT COALESCE(SUM(commission_amount), 0)
  INTO v_total
  FROM orders
  WHERE user_id = p_user_id
  AND status = 'success';
  
  -- 更新users表
  UPDATE users
  SET total_income = v_total
  WHERE id = p_user_id;
  
  RETURN v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. 创建函数：批量重新计算所有用户的total_income
CREATE OR REPLACE FUNCTION recalculate_all_users_total_income()
RETURNS TABLE(user_id uuid, old_total_income numeric, new_total_income numeric, difference numeric) AS $$
BEGIN
  RETURN QUERY
  WITH user_calculations AS (
    SELECT 
      u.id,
      u.total_income as old_income,
      COALESCE(SUM(o.commission_amount), 0) as new_income
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id AND o.status = 'success'
    GROUP BY u.id, u.total_income
  )
  UPDATE users u
  SET total_income = uc.new_income
  FROM user_calculations uc
  WHERE u.id = uc.id
  RETURNING u.id, uc.old_income, uc.new_income, (uc.new_income - uc.old_income) as difference;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. 创建触发器函数：当订单状态变为success时自动更新total_income
CREATE OR REPLACE FUNCTION update_user_total_income_on_order_success()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在订单状态变为success时触发
  IF NEW.status = 'success' AND (OLD IS NULL OR OLD.status != 'success') THEN
    -- 增加用户的total_income
    UPDATE users
    SET total_income = total_income + COALESCE(NEW.commission_amount, 0)
    WHERE id = NEW.user_id;
  END IF;
  
  -- 如果订单从success变为其他状态（不太可能但要处理）
  IF OLD IS NOT NULL AND OLD.status = 'success' AND NEW.status != 'success' THEN
    -- 减少用户的total_income
    UPDATE users
    SET total_income = total_income - COALESCE(OLD.commission_amount, 0)
    WHERE id = NEW.user_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. 创建触发器：在orders表上监听INSERT和UPDATE
DROP TRIGGER IF EXISTS trigger_update_total_income_on_order ON orders;
CREATE TRIGGER trigger_update_total_income_on_order
  AFTER INSERT OR UPDATE OF status ON orders
  FOR EACH ROW
  EXECUTE FUNCTION update_user_total_income_on_order_success();

-- 5. 立即修复所有现有用户的total_income数据
DO $$
DECLARE
  fix_result RECORD;
  total_users_fixed INTEGER := 0;
BEGIN
  RAISE NOTICE 'Starting to recalculate total_income for all users...';
  
  FOR fix_result IN 
    SELECT * FROM recalculate_all_users_total_income()
  LOOP
    IF fix_result.difference != 0 THEN
      RAISE NOTICE 'User %: % -> % (diff: %)', 
        fix_result.user_id, 
        fix_result.old_total_income, 
        fix_result.new_total_income,
        fix_result.difference;
      total_users_fixed := total_users_fixed + 1;
    END IF;
  END LOOP;
  
  RAISE NOTICE 'Completed! Fixed % users with incorrect total_income', total_users_fixed;
END $$;
