
-- Convert remaining non-trigger SECURITY DEFINER functions to SECURITY INVOKER.
-- These functions already have anon/authenticated/PUBLIC revoked.
-- They're only called by pg_cron (as postgres) or by trigger functions,
-- so INVOKER is safe - postgres has full access regardless.

-- Trigger functions that MUST stay DEFINER (they need owner privileges in trigger context):
-- auto_create_commission_and_update_wallet, cleanup_user_data, cleanup_user_storage_files,
-- create_wallet_for_new_user, protect_money_data, sync_dispatch_session_end,
-- update_user_total_income_on_order_success, validate_work_session

-- Convert all non-trigger internal functions to INVOKER:
ALTER FUNCTION public.assign_next_dispatch_order(uuid, uuid, text) SECURITY INVOKER;
ALTER FUNCTION public.assign_with_fairness(uuid, uuid, text, boolean) SECURITY INVOKER;
ALTER FUNCTION public.assign_with_rate_limit(uuid, uuid, text, integer) SECURITY INVOKER;
ALTER FUNCTION public.auto_cleanup_all_tables() SECURITY INVOKER;
ALTER FUNCTION public.auto_cleanup_stale_sessions_fast() SECURITY INVOKER;
ALTER FUNCTION public.auto_fix_commission_inconsistencies() SECURITY INVOKER;
ALTER FUNCTION public.auto_repair_work_sessions() SECURITY INVOKER;
ALTER FUNCTION public.cleanup_all_practice_data() SECURITY INVOKER;
ALTER FUNCTION public.cleanup_inactive_sessions() SECURITY INVOKER;
ALTER FUNCTION public.cleanup_old_dispatch_assignments() SECURITY INVOKER;
ALTER FUNCTION public.cleanup_old_login_attempts() SECURITY INVOKER;
ALTER FUNCTION public.cleanup_old_messages() SECURITY INVOKER;
ALTER FUNCTION public.cleanup_stale_dispatch_sessions() SECURITY INVOKER;
ALTER FUNCTION public.cleanup_stale_work_sessions() SECURITY INVOKER;
ALTER FUNCTION public.cleanup_stale_work_sessions_optimized() SECURITY INVOKER;
ALTER FUNCTION public.cleanup_used_order_data(integer, uuid) SECURITY INVOKER;
ALTER FUNCTION public.cleanup_zombie_dispatch_orders() SECURITY INVOKER;
ALTER FUNCTION public.count_commission_issues() SECURITY INVOKER;
ALTER FUNCTION public.daily_commission_integrity_check() SECURITY INVOKER;
ALTER FUNCTION public.detect_valid_data_bottlenecks() SECURITY INVOKER;
ALTER FUNCTION public.detect_work_time_anomalies(integer) SECURITY INVOKER;
ALTER FUNCTION public.get_admin_customer_conversations(uuid) SECURITY INVOKER;
ALTER FUNCTION public.get_dispatch_bottlenecks() SECURITY INVOKER;
ALTER FUNCTION public.get_dispatch_performance_stats() SECURITY INVOKER;
ALTER FUNCTION public.get_dispatch_system_health() SECURITY INVOKER;
ALTER FUNCTION public.get_dispatch_system_metrics() SECURITY INVOKER;
ALTER FUNCTION public.get_employee_unread_customer_messages_count(uuid) SECURITY INVOKER;
ALTER FUNCTION public.get_employees_by_admin() SECURITY INVOKER;
ALTER FUNCTION public.get_empty_dispatch_groups() SECURITY INVOKER;
ALTER FUNCTION public.get_heartbeat_distribution() SECURITY INVOKER;
ALTER FUNCTION public.get_hot_valid_data(integer) SECURITY INVOKER;
ALTER FUNCTION public.get_ios_config() SECURITY INVOKER;
ALTER FUNCTION public.get_money_protection_audit_log(integer) SECURITY INVOKER;
ALTER FUNCTION public.get_practice_data_stats() SECURITY INVOKER;
ALTER FUNCTION public.get_stale_session_report() SECURITY INVOKER;
ALTER FUNCTION public.get_system_health_metrics() SECURITY INVOKER;
ALTER FUNCTION public.get_table_record_count(text) SECURITY INVOKER;
ALTER FUNCTION public.get_table_size(text) SECURITY INVOKER;
ALTER FUNCTION public.get_today_commission(uuid) SECURITY INVOKER;
ALTER FUNCTION public.get_today_commission_by_user(uuid[]) SECURITY INVOKER;
ALTER FUNCTION public.get_unread_message_count(uuid) SECURITY INVOKER;
ALTER FUNCTION public.get_user_work_days_count(uuid) SECURITY INVOKER;
ALTER FUNCTION public.get_valid_data_pool_status() SECURITY INVOKER;
ALTER FUNCTION public.get_valid_data_system_metrics() SECURITY INVOKER;
ALTER FUNCTION public.get_valid_data_usage_stats() SECURITY INVOKER;
ALTER FUNCTION public.mark_login_popup_as_shown(uuid, uuid) SECURITY INVOKER;
ALTER FUNCTION public.mark_message_as_read(uuid, uuid) SECURITY INVOKER;
ALTER FUNCTION public.recalculate_all_users_total_income() SECURITY INVOKER;
ALTER FUNCTION public.recalculate_user_total_income(uuid) SECURITY INVOKER;
ALTER FUNCTION public.repair_work_session_mismatches() SECURITY INVOKER;
ALTER FUNCTION public.send_broadcast_message(uuid, text, text, text, text, uuid, uuid[]) SECURITY INVOKER;
ALTER FUNCTION public.test_assignment_race_condition(uuid, integer) SECURITY INVOKER;
ALTER FUNCTION public.unlock_account(text, text, uuid) SECURITY INVOKER;
ALTER FUNCTION public.update_employee_heartbeat(uuid, uuid) SECURITY INVOKER;
ALTER FUNCTION public.update_ios_config(jsonb) SECURITY INVOKER;
ALTER FUNCTION public.validate_commission_integrity(uuid) SECURITY INVOKER;
