
-- The previous REVOKE from anon/authenticated was ineffective because
-- PostgreSQL defaults EXECUTE to PUBLIC (which all roles inherit).
-- Must REVOKE from PUBLIC, then re-GRANT only to roles that need access.

-- Step 1: Revoke EXECUTE from PUBLIC on ALL security definer functions in public schema
DO $$
DECLARE
  func_record RECORD;
BEGIN
  FOR func_record IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.prosecdef = true
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated',
      func_record.proname, func_record.args);
  END LOOP;
END $$;

-- Step 2: Re-grant EXECUTE to anon for functions that the client app needs
-- (these are the 35 functions called via RPC from the frontend)

-- Login/session functions
GRANT EXECUTE ON FUNCTION public.check_login_rate_limit(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_login_attempt(text, text, boolean, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.should_lock_account(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_employee_session(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_employee_session(uuid, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_employee_session(uuid, uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_employee_session(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_employee_session(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_employee_login(uuid, text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_employee_logout(uuid, text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_account_with_permission_check(text, text, uuid) TO anon, authenticated;

-- Work session functions
GRANT EXECUTE ON FUNCTION public.start_work_session(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_work_session(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_work_session_by_user(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_session_heartbeat(uuid) TO anon, authenticated;

-- Order/dispatch functions
GRANT EXECUTE ON FUNCTION public.process_pending_orders() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_daily_order_stats(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_overall_order_stats(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_completed_orders_count(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.batch_delete_dispatch_orders(uuid, integer) TO anon, authenticated;

-- Admin management functions (called from admin panel via anon key)
GRANT EXECUTE ON FUNCTION public.adjust_wallet_balance(uuid, numeric, text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_messages(uuid[], uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_all_messages_for_admin(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_account_locks_for_admin(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_login_summary(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_login_history(uuid, uuid, integer, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_groups_for_customer_service() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_employees(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.batch_delete_valid_order_data(integer) TO anon, authenticated;

-- Cleanup functions (called from admin cleanup panel)
GRANT EXECUTE ON FUNCTION public.execute_cleanup(text, integer, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_cleanup(text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_all_stale_sessions() TO anon, authenticated;

-- RLS policy dependency (used in withdrawals WITH CHECK)
GRANT EXECUTE ON FUNCTION public.check_withdrawal_eligibility(uuid) TO anon, authenticated;
