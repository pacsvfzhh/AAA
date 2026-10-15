
-- Convert ALL client-accessible SECURITY DEFINER functions to SECURITY INVOKER.
-- This is safe because all tables these functions access have RLS policies
-- with USING (true) / WITH CHECK (true) for anon,authenticated roles.
-- The functions don't need elevated privileges since RLS already allows the operations.

-- Read-only getter functions -> SECURITY INVOKER
ALTER FUNCTION public.get_account_locks_for_admin(uuid) SECURITY INVOKER;
ALTER FUNCTION public.get_admin_employees(uuid) SECURITY INVOKER;
ALTER FUNCTION public.get_admin_groups_for_customer_service() SECURITY INVOKER;
ALTER FUNCTION public.get_daily_order_stats(uuid) SECURITY INVOKER;
ALTER FUNCTION public.get_employee_login_history(uuid, uuid, integer, integer) SECURITY INVOKER;
ALTER FUNCTION public.get_employee_login_summary(uuid, text) SECURITY INVOKER;
ALTER FUNCTION public.get_overall_order_stats(uuid) SECURITY INVOKER;
ALTER FUNCTION public.get_user_completed_orders_count(uuid) SECURITY INVOKER;
ALTER FUNCTION public.check_login_rate_limit(text, text) SECURITY INVOKER;
ALTER FUNCTION public.should_lock_account(text) SECURITY INVOKER;
ALTER FUNCTION public.check_withdrawal_eligibility(uuid) SECURITY INVOKER;

-- Write functions that only write to tables with true RLS -> SECURITY INVOKER
ALTER FUNCTION public.adjust_wallet_balance(uuid, numeric, text, uuid) SECURITY INVOKER;
ALTER FUNCTION public.batch_delete_dispatch_orders(uuid, integer) SECURITY INVOKER;
ALTER FUNCTION public.batch_delete_valid_order_data(integer) SECURITY INVOKER;
ALTER FUNCTION public.cleanup_all_stale_sessions() SECURITY INVOKER;
ALTER FUNCTION public.clear_employee_session(uuid) SECURITY INVOKER;
ALTER FUNCTION public.delete_all_messages_for_admin(uuid, uuid) SECURITY INVOKER;
ALTER FUNCTION public.delete_messages(uuid[], uuid) SECURITY INVOKER;
ALTER FUNCTION public.end_work_session(uuid) SECURITY INVOKER;
ALTER FUNCTION public.end_work_session_by_user(uuid) SECURITY INVOKER;
ALTER FUNCTION public.execute_cleanup(text, integer, uuid) SECURITY INVOKER;
ALTER FUNCTION public.log_employee_login(uuid, text, text, text, text, text) SECURITY INVOKER;
ALTER FUNCTION public.log_employee_logout(uuid, text, text, text, text, text) SECURITY INVOKER;
ALTER FUNCTION public.preview_cleanup(text, integer) SECURITY INVOKER;
ALTER FUNCTION public.process_pending_orders() SECURITY INVOKER;
ALTER FUNCTION public.record_login_attempt(text, text, boolean, text, text) SECURITY INVOKER;
ALTER FUNCTION public.set_employee_session(uuid, uuid) SECURITY INVOKER;
ALTER FUNCTION public.start_work_session(uuid) SECURITY INVOKER;
ALTER FUNCTION public.unlock_account_with_permission_check(text, text, uuid) SECURITY INVOKER;
ALTER FUNCTION public.update_session_heartbeat(uuid) SECURITY INVOKER;

-- validate_employee_session (all 3 overloads)
ALTER FUNCTION public.validate_employee_session(uuid, uuid) SECURITY INVOKER;
ALTER FUNCTION public.validate_employee_session(uuid, text, text) SECURITY INVOKER;
ALTER FUNCTION public.validate_employee_session(uuid, uuid, text) SECURITY INVOKER;
