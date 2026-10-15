/*
  # Commission Integrity Monitoring System

  1. Purpose
    - Monitor commission data integrity
    - Auto-fix inconsistencies
    - Provide audit trail

  2. Changes
    - Audit log table
    - Validation functions
    - Auto-fix functions
    - Enhanced triggers
    - Monitoring views
*/

-- 1. Drop and recreate audit table
DROP TABLE IF EXISTS commission_audit_log CASCADE;

CREATE TABLE commission_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('commission_added', 'commission_removed', 'inconsistency_detected', 'auto_fix_applied')),
  commission_amount numeric NOT NULL,
  wallet_balance_before numeric,
  wallet_balance_after numeric,
  total_income_before numeric,
  total_income_after numeric,
  transaction_id uuid REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  details jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_commission_audit_user ON commission_audit_log(user_id);
CREATE INDEX idx_commission_audit_order ON commission_audit_log(order_id);
CREATE INDEX idx_commission_audit_created ON commission_audit_log(created_at DESC);
CREATE INDEX idx_commission_audit_event ON commission_audit_log(event_type);

ALTER TABLE commission_audit_log ENABLE ROW LEVEL SECURITY;

-- Simple RLS: no policies means only system can write, no one can read (super admin can query directly via SQL)

-- 2. Validation function
CREATE OR REPLACE FUNCTION validate_commission_integrity(p_user_id uuid DEFAULT NULL)
RETURNS TABLE(
  user_id uuid,
  username text,
  total_income numeric,
  order_commission_sum numeric,
  wallet_available_balance numeric,
  wallet_frozen_balance numeric,
  total_transactions_sum numeric,
  is_consistent boolean,
  income_diff numeric,
  transaction_diff numeric
) 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.id,
    u.username,
    u.total_income,
    COALESCE((SELECT SUM(o.commission_amount) FROM orders o WHERE o.user_id = u.id AND o.status = 'success'), 0),
    w.available_balance,
    w.frozen_balance,
    COALESCE((SELECT SUM(wt.amount) FROM wallet_transactions wt WHERE wt.user_id = u.id), 0),
    (
      ABS(u.total_income - COALESCE((SELECT SUM(o.commission_amount) FROM orders o WHERE o.user_id = u.id AND o.status = 'success'), 0)) < 0.01
      AND ABS(w.available_balance - (COALESCE((SELECT SUM(wt.amount) FROM wallet_transactions wt WHERE wt.user_id = u.id), 0) - w.frozen_balance)) < 0.01
    ),
    u.total_income - COALESCE((SELECT SUM(o.commission_amount) FROM orders o WHERE o.user_id = u.id AND o.status = 'success'), 0),
    w.available_balance - (COALESCE((SELECT SUM(wt.amount) FROM wallet_transactions wt WHERE wt.user_id = u.id), 0) - w.frozen_balance)
  FROM users u
  LEFT JOIN wallets w ON w.user_id = u.id
  WHERE u.total_income IS NOT NULL
    AND (p_user_id IS NULL OR u.id = p_user_id);
END;
$$;

COMMENT ON FUNCTION validate_commission_integrity IS 'Validates commission data integrity - checks if total_income matches actual successful orders and wallet balance matches transactions';

-- 3. Auto-fix function
CREATE OR REPLACE FUNCTION auto_fix_commission_inconsistencies()
RETURNS TABLE(
  fixed_user_id uuid,
  username text,
  issue_type text,
  old_value numeric,
  new_value numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user RECORD;
  v_fixed_count integer := 0;
BEGIN
  PERFORM set_config('app.in_user_cleanup', 'true', true);

  FOR v_user IN (SELECT * FROM validate_commission_integrity() WHERE is_consistent = false)
  LOOP
    -- Fix total_income
    IF ABS(v_user.income_diff) > 0.01 THEN
      UPDATE users SET total_income = v_user.order_commission_sum WHERE id = v_user.user_id;

      INSERT INTO commission_audit_log (user_id, event_type, commission_amount, total_income_before, total_income_after, details)
      VALUES (v_user.user_id, 'auto_fix_applied', v_user.income_diff, v_user.total_income, v_user.order_commission_sum,
        jsonb_build_object('issue', 'total_income_mismatch', 'fixed_at', now()));

      fixed_user_id := v_user.user_id;
      username := v_user.username;
      issue_type := 'total_income_mismatch';
      old_value := v_user.total_income;
      new_value := v_user.order_commission_sum;
      v_fixed_count := v_fixed_count + 1;
      RETURN NEXT;
    END IF;

    -- Fix wallet balance
    IF ABS(v_user.transaction_diff) > 0.01 THEN
      UPDATE wallets SET available_balance = v_user.total_transactions_sum - v_user.wallet_frozen_balance WHERE user_id = v_user.user_id;

      INSERT INTO commission_audit_log (user_id, event_type, commission_amount, wallet_balance_before, wallet_balance_after, details)
      VALUES (v_user.user_id, 'auto_fix_applied', v_user.transaction_diff, v_user.wallet_available_balance,
        v_user.total_transactions_sum - v_user.wallet_frozen_balance, jsonb_build_object('issue', 'wallet_balance_mismatch', 'fixed_at', now()));

      fixed_user_id := v_user.user_id;
      username := v_user.username;
      issue_type := 'wallet_balance_mismatch';
      old_value := v_user.wallet_available_balance;
      new_value := v_user.total_transactions_sum - v_user.wallet_frozen_balance;
      v_fixed_count := v_fixed_count + 1;
      RETURN NEXT;
    END IF;
  END LOOP;

  PERFORM set_config('app.in_user_cleanup', 'false', true);
  RAISE NOTICE 'Auto-fixed % commission inconsistencies', v_fixed_count;
END;
$$;

COMMENT ON FUNCTION auto_fix_commission_inconsistencies IS 'Automatically detects and fixes commission inconsistencies, logs all fixes to audit table';

-- 4. Enhanced trigger with comprehensive logging
CREATE OR REPLACE FUNCTION auto_create_commission_and_update_wallet()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_balance numeric;
  v_wallet_before numeric;
  v_income_before numeric;
  v_txn_id uuid;
BEGIN
  -- Add commission when order becomes successful
  IF NEW.status = 'success' AND (OLD IS NULL OR OLD.status != 'success') AND NEW.commission_amount IS NOT NULL AND NEW.commission_amount > 0 THEN
    IF NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE user_id = NEW.user_id AND type = 'commission' AND reference_id = NEW.id) THEN
      -- Get current values
      SELECT available_balance INTO v_wallet_before FROM wallets WHERE user_id = NEW.user_id;
      SELECT total_income INTO v_income_before FROM users WHERE id = NEW.user_id;
      SELECT COALESCE(balance_after, 0) INTO current_balance FROM wallet_transactions WHERE user_id = NEW.user_id ORDER BY created_at DESC, id DESC LIMIT 1;
      IF current_balance IS NULL THEN current_balance := 0; END IF;

      -- Create transaction
      INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, reference_id, created_at)
      VALUES (NEW.user_id, 'commission', NEW.commission_amount, current_balance, current_balance + NEW.commission_amount, NEW.id, NOW())
      RETURNING id INTO v_txn_id;

      -- Update wallet
      UPDATE wallets SET available_balance = available_balance + NEW.commission_amount WHERE user_id = NEW.user_id;

      -- Log to audit
      INSERT INTO commission_audit_log (user_id, order_id, event_type, commission_amount, wallet_balance_before, wallet_balance_after,
        total_income_before, total_income_after, transaction_id)
      VALUES (NEW.user_id, NEW.id, 'commission_added', NEW.commission_amount, v_wallet_before, v_wallet_before + NEW.commission_amount,
        v_income_before, v_income_before + NEW.commission_amount, v_txn_id);

      RAISE NOTICE 'Added commission $ % for order %', NEW.commission_amount, NEW.id;
    END IF;
  END IF;

  -- Remove commission when order fails after being successful
  IF OLD IS NOT NULL AND OLD.status = 'success' AND NEW.status != 'success' AND OLD.commission_amount IS NOT NULL AND OLD.commission_amount > 0 THEN
    SELECT available_balance INTO v_wallet_before FROM wallets WHERE user_id = NEW.user_id;
    SELECT total_income INTO v_income_before FROM users WHERE id = NEW.user_id;
    SELECT id INTO v_txn_id FROM wallet_transactions WHERE user_id = NEW.user_id AND type = 'commission' AND reference_id = NEW.id;

    -- Enable cleanup mode to bypass protection
    PERFORM set_config('app.in_user_cleanup', 'true', true);
    DELETE FROM wallet_transactions WHERE user_id = NEW.user_id AND type = 'commission' AND reference_id = NEW.id;
    PERFORM set_config('app.in_user_cleanup', 'false', true);

    -- Update wallet
    UPDATE wallets SET available_balance = available_balance - OLD.commission_amount WHERE user_id = NEW.user_id;

    -- Log to audit
    INSERT INTO commission_audit_log (user_id, order_id, event_type, commission_amount, wallet_balance_before, wallet_balance_after,
      total_income_before, total_income_after, transaction_id, details)
    VALUES (NEW.user_id, NEW.id, 'commission_removed', OLD.commission_amount, v_wallet_before, v_wallet_before - OLD.commission_amount,
      v_income_before, v_income_before - OLD.commission_amount, v_txn_id,
      jsonb_build_object('old_status', OLD.status, 'new_status', NEW.status));

    RAISE NOTICE 'Removed commission $ % for order % (status: % -> %)', OLD.commission_amount, NEW.id, OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

-- Recreate trigger
DROP TRIGGER IF EXISTS trigger_sync_order_to_wallet ON orders;
CREATE TRIGGER trigger_sync_order_to_wallet AFTER INSERT OR UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION auto_create_commission_and_update_wallet();

-- 5. Daily integrity check
CREATE OR REPLACE FUNCTION daily_commission_integrity_check()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inconsistent_count integer;
  v_fixed_count integer;
  v_result jsonb;
BEGIN
  RAISE NOTICE 'Starting daily commission integrity check at %', now();

  SELECT COUNT(*) INTO v_inconsistent_count FROM validate_commission_integrity() WHERE is_consistent = false;

  IF v_inconsistent_count > 0 THEN
    RAISE WARNING 'Found % users with commission inconsistencies', v_inconsistent_count;
    
    -- Log all inconsistencies
    INSERT INTO commission_audit_log (user_id, event_type, commission_amount, details)
    SELECT user_id, 'inconsistency_detected', ABS(income_diff),
      jsonb_build_object('income_diff', income_diff, 'transaction_diff', transaction_diff, 'detected_at', now())
    FROM validate_commission_integrity() WHERE is_consistent = false;

    -- Auto-fix
    SELECT COUNT(*) INTO v_fixed_count FROM auto_fix_commission_inconsistencies();
    RAISE NOTICE 'Auto-fixed % commission inconsistencies', v_fixed_count;
  ELSE
    RAISE NOTICE 'All commission data is consistent - no issues found';
    v_fixed_count := 0;
  END IF;

  v_result := jsonb_build_object(
    'checked_at', now(),
    'inconsistencies_found', v_inconsistent_count,
    'fixes_applied', v_fixed_count,
    'status', CASE WHEN v_inconsistent_count = 0 THEN 'healthy' ELSE 'fixed' END
  );

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION daily_commission_integrity_check IS 'Run daily to check and auto-fix commission inconsistencies';

-- 6. Health monitoring view
CREATE OR REPLACE VIEW commission_health_status AS
SELECT
  COUNT(*) as total_users_with_income,
  COUNT(*) FILTER (WHERE is_consistent = true) as consistent_users,
  COUNT(*) FILTER (WHERE is_consistent = false) as inconsistent_users,
  COALESCE(ROUND(SUM(ABS(income_diff)) FILTER (WHERE is_consistent = false), 2), 0) as total_income_discrepancy,
  COALESCE(ROUND(SUM(ABS(transaction_diff)) FILTER (WHERE is_consistent = false), 2), 0) as total_wallet_discrepancy,
  CASE 
    WHEN COUNT(*) FILTER (WHERE is_consistent = false) = 0 THEN 'HEALTHY'
    WHEN COUNT(*) FILTER (WHERE is_consistent = false) <= 5 THEN 'WARNING'
    ELSE 'CRITICAL'
  END as health_status,
  now() as last_checked
FROM validate_commission_integrity();

COMMENT ON VIEW commission_health_status IS 'Real-time commission system health overview';

-- 7. Run initial check
SELECT daily_commission_integrity_check();
