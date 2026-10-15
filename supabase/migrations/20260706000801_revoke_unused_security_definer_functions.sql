
-- Revoke EXECUTE from anon and authenticated on SECURITY DEFINER functions
-- that are NEVER called from the client (internal/maintenance/monitoring only).
-- These should only be callable via service_role or postgres.

-- Cleanup/Maintenance functions (automated tasks, never client-triggered)
REVOKE EXECUTE ON FUNCTION public.auto_cleanup_all_tables() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_cleanup_stale_sessions_fast() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_create_commission_and_update_wallet() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_fix_commission_inconsistencies() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_repair_work_sessions() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_all_practice_data() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_inactive_sessions() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_dispatch_assignments() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_login_attempts() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_messages() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_stale_dispatch_sessions() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_stale_work_sessions() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_stale_work_sessions_optimized() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_used_order_data(integer, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_user_data() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_user_storage_files() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_zombie_dispatch_orders() FROM anon, authenticated;

-- Monitoring/Diagnostics functions (admin dashboard metrics, not client-called)
REVOKE EXECUTE ON FUNCTION public.count_commission_issues() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.daily_commission_integrity_check() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.detect_valid_data_bottlenecks() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.detect_work_time_anomalies(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_dispatch_bottlenecks() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_dispatch_performance_stats() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_dispatch_system_health() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_dispatch_system_metrics() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_empty_dispatch_groups() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_heartbeat_distribution() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_hot_valid_data(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_money_protection_audit_log(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_practice_data_stats() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_stale_session_report() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_system_health_metrics() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_table_record_count(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_table_size(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_valid_data_pool_status() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_valid_data_system_metrics() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_valid_data_usage_stats() FROM anon, authenticated;

-- Data integrity/repair functions (automated, never client-triggered)
REVOKE EXECUTE ON FUNCTION public.protect_money_data() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recalculate_all_users_total_income() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recalculate_user_total_income(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.repair_work_session_mismatches() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_commission_integrity(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_work_session() FROM anon, authenticated;

-- Dispatch system internal functions (called by triggers/system, not client)
REVOKE EXECUTE ON FUNCTION public.assign_next_dispatch_order(uuid, uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assign_with_fairness(uuid, uuid, text, boolean) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assign_with_rate_limit(uuid, uuid, text, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_dispatch_session_end() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.test_assignment_race_condition(uuid, integer) FROM anon, authenticated;

-- Trigger functions (called by DB triggers, not client)
REVOKE EXECUTE ON FUNCTION public.create_wallet_for_new_user() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_user_total_income_on_order_success() FROM anon, authenticated;

-- Admin-only configuration (should be service_role only)
REVOKE EXECUTE ON FUNCTION public.update_ios_config(jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_ios_config() FROM anon, authenticated;

-- Broadcast/messaging internal function
REVOKE EXECUTE ON FUNCTION public.send_broadcast_message(uuid, text, text, text, text, uuid, uuid[]) FROM anon, authenticated;

-- Session management internal
REVOKE EXECUTE ON FUNCTION public.end_work_session_by_user(uuid) FROM anon, authenticated;

-- Other admin functions not called from client
REVOKE EXECUTE ON FUNCTION public.get_admin_customer_conversations(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_employees_by_admin() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_employee_unread_customer_messages_count(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_today_commission(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_today_commission_by_user(uuid[]) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_unread_message_count(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_user_work_days_count(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_withdrawal_eligibility(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_login_popup_as_shown(uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_message_as_read(uuid, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.unlock_account(text, text, uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_employee_heartbeat(uuid, uuid) FROM anon, authenticated;
