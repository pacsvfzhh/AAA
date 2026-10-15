REVOKE INSERT, UPDATE, DELETE ON TABLE wallets FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE wallet_transactions FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE withdrawals FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE users FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE admins FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Users can insert wallets" ON wallets;
DROP POLICY IF EXISTS "Users can update wallets" ON wallets;
DROP POLICY IF EXISTS "Users can insert transactions" ON wallet_transactions;
DROP POLICY IF EXISTS "Users can insert withdrawals" ON withdrawals;
DROP POLICY IF EXISTS "Users can update withdrawals" ON withdrawals;
DROP POLICY IF EXISTS "Allow employee creation" ON users;
DROP POLICY IF EXISTS "Allow employee deletion" ON users;
DROP POLICY IF EXISTS "Employees can update own profile" ON users;
DROP POLICY IF EXISTS "Super admins can create secondary admins" ON admins;
DROP POLICY IF EXISTS "Super admins can delete secondary admins" ON admins;
DROP POLICY IF EXISTS "Admins can update own info" ON admins;

REVOKE SELECT ON TABLE users FROM PUBLIC, anon, authenticated;
REVOKE SELECT ON TABLE admins FROM PUBLIC, anon, authenticated;

GRANT SELECT (
  id,
  username,
  employee_id,
  is_verified,
  is_active,
  total_income,
  first_success_order_date,
  created_by,
  remarks,
  tags,
  is_pinned,
  current_session_token,
  session_created_at,
  last_heartbeat_at,
  current_tab_id,
  created_at,
  updated_at
) ON TABLE users TO anon, authenticated;

GRANT SELECT (
  id,
  username,
  role,
  parent_id,
  is_active,
  is_pinned,
  created_at,
  updated_at
) ON TABLE admins TO anon, authenticated;

DO $$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'adjust_wallet_balance',
        'process_customer_service_tip',
        'process_pending_orders',
        'safe_update_wallet_balance',
        'auto_fix_commission_inconsistencies',
        'auto_repair_commission_batch',
        'daily_commission_integrity_check',
        'validate_commission_integrity',
        'set_employee_session',
        'clear_employee_session',
        'update_employee_heartbeat',
        'recalculate_all_users_total_income',
        'recalculate_user_total_income'
      )
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      v_function.signature
    );
  END LOOP;
END;
$$;
