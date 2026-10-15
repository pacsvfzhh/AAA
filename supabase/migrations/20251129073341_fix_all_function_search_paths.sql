/*
  # Fix Function Search Paths for Security
  
  ## Security Improvements
  - Set explicit search_path = public, pg_temp for all 157 custom functions
  - Prevents SQL injection attacks via search_path manipulation
  - Essential security hardening for production databases
  
  ## Impact
  - All custom functions now have immutable search paths
  - Protects against privilege escalation attacks
  - No functional changes, only security improvements
*/

-- Core business logic functions
ALTER FUNCTION public.get_today_commission_by_user(user_ids uuid[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.batch_delete_dispatch_orders(p_group_id uuid, p_batch_size integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.batch_delete_valid_order_data(p_batch_size integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.check_withdrawal_eligibility(check_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.check_rate_limit(p_user_id uuid, p_max_requests_per_minute integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.assign_with_rate_limit(p_user_id uuid, p_group_id uuid, p_dispatch_mode text, p_max_requests_per_minute integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.recalculate_user_total_income(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.recalculate_all_users_total_income() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_user_total_income_on_order_success() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_rate_limit_stats() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_rate_limits() SET search_path = public, pg_temp;

-- Work session management
ALTER FUNCTION public.cleanup_duplicate_work_sessions() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_zero_duration_sessions() SET search_path = public, pg_temp;
ALTER FUNCTION public.merge_overlapping_work_sessions(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_user_work_time_today(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_batch_work_time(p_user_ids uuid[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.check_no_overlapping_sessions() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_user_work_days_count(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.end_work_session(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.start_work_session(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_active_work_session(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_total_work_time(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_today_work_time(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_user_work_time_by_date(p_user_id uuid, p_date date) SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_stale_work_sessions() SET search_path = public, pg_temp;

-- Commission and wallet functions
ALTER FUNCTION public.auto_create_commission_and_update_wallet() SET search_path = public, pg_temp;
ALTER FUNCTION public.count_commission_issues() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_today_commission(p_user_id uuid) SET search_path = public, pg_temp;

-- System monitoring and analytics
ALTER FUNCTION public.check_system_alerts() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_dispatch_analytics(p_start_date timestamp with time zone, p_end_date timestamp with time zone) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_dispatch_system_health() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_system_health_metrics() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_dispatch_system_metrics() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_dispatch_bottlenecks() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_dispatch_performance_stats() SET search_path = public, pg_temp;

-- Testing and diagnostics
ALTER FUNCTION public.stress_test_valid_data_lookups(p_concurrent_users integer, p_iterations integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.test_concurrent_dispatch(p_group_id uuid, iterations integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.verify_no_duplicate_valid_data() SET search_path = public, pg_temp;
ALTER FUNCTION public.test_valid_data_index_performance() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_stress_test_data() SET search_path = public, pg_temp;
ALTER FUNCTION public.generate_stress_test_report() SET search_path = public, pg_temp;
ALTER FUNCTION public.stress_test_order_submissions(p_test_users integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.test_assignment_race_condition(p_test_group_id uuid, p_concurrent_users integer) SET search_path = public, pg_temp;

-- Data protection and auditing
ALTER FUNCTION public.get_money_protection_audit_log(p_limit integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.protect_money_data() SET search_path = public, pg_temp;

-- Cleanup operations
ALTER FUNCTION public.cleanup_zombie_dispatch_orders() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_dispatch_assignments() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_all_practice_data() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_duplicate_active_sessions() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_user_storage_files() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_messages() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_all_stale_sessions() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_stale_dispatch_sessions() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_inactive_sessions() SET search_path = public, pg_temp;
ALTER FUNCTION public.auto_cleanup_dispatch_system() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_audit_logs() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_error_logs() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_query_performance() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_archived_data() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_valid_data(p_keep_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_used_order_data(p_days_to_keep integer, p_admin_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_old_login_attempts() SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_user_data() SET search_path = public, pg_temp;

-- Dispatch system
ALTER FUNCTION public.get_empty_dispatch_groups() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_valid_data_usage_stats() SET search_path = public, pg_temp;
ALTER FUNCTION public.auto_recover_stale_pending_orders(p_timeout_minutes integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.prevent_multiple_active_sessions() SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_dispatch_session_start() SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_dispatch_session_end() SET search_path = public, pg_temp;
ALTER FUNCTION public.prevent_duplicate_dispatch_sessions() SET search_path = public, pg_temp;
ALTER FUNCTION public.assign_next_dispatch_order(p_user_id uuid, p_group_id uuid, p_dispatch_mode text) SET search_path = public, pg_temp;
ALTER FUNCTION public.assign_with_fairness(p_user_id uuid, p_group_id uuid, p_dispatch_mode text, p_enable_fairness_check boolean) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_fairness_summary() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_pending_orders_status() SET search_path = public, pg_temp;

-- Pool health monitoring
ALTER FUNCTION public.auto_check_pool_health() SET search_path = public, pg_temp;
ALTER FUNCTION public.check_all_pools_health() SET search_path = public, pg_temp;
ALTER FUNCTION public.check_dispatch_pool_health(p_group_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_stale_session_report() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_heartbeat_distribution() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_session_heartbeat(p_session_id uuid) SET search_path = public, pg_temp;

-- Valid data management
ALTER FUNCTION public.get_valid_data_system_metrics() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_valid_data_pool_status() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_valid_data_usage_stats() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_hot_valid_data(p_limit integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.detect_valid_data_bottlenecks() SET search_path = public, pg_temp;
ALTER FUNCTION public.log_valid_data_changes() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_optimal_valid_data(p_user_id uuid, p_product_value numeric, p_limit integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.check_valid_data_capacity() SET search_path = public, pg_temp;
ALTER FUNCTION public.archive_old_valid_data(p_days_inactive integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_valid_data_audit_trail(p_valid_data_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.predict_data_exhaustion() SET search_path = public, pg_temp;
ALTER FUNCTION public.run_valid_data_maintenance() SET search_path = public, pg_temp;
ALTER FUNCTION public.log_valid_data_error(p_error_type text, p_error_severity text, p_error_message text, p_error_details jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.check_valid_data_consistency() SET search_path = public, pg_temp;
ALTER FUNCTION public.auto_fix_valid_data_issues() SET search_path = public, pg_temp;
ALTER FUNCTION public.find_available_valid_data(p_user_id uuid, p_product_value numeric, p_transaction_id text) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_validation_stats(p_days integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_detailed_valid_data_stats(p_days integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_valid_data_pool_stats() SET search_path = public, pg_temp;

-- Performance monitoring
ALTER FUNCTION public.track_query_performance(p_query_type text, p_execution_time_ms numeric, p_rows_affected integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.analyze_query_performance() SET search_path = public, pg_temp;
ALTER FUNCTION public.warm_valid_data_cache() SET search_path = public, pg_temp;
ALTER FUNCTION public.run_comprehensive_health_check() SET search_path = public, pg_temp;
ALTER FUNCTION public.run_daily_maintenance() SET search_path = public, pg_temp;
ALTER FUNCTION public.monitor_storage_usage() SET search_path = public, pg_temp;
ALTER FUNCTION public.run_comprehensive_cleanup(p_force boolean) SET search_path = public, pg_temp;
ALTER FUNCTION public.monitor_large_tables() SET search_path = public, pg_temp;

-- Statistics and reporting
ALTER FUNCTION public.update_system_configs_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.aggregate_monthly_statistics() SET search_path = public, pg_temp;
ALTER FUNCTION public.archive_old_orders(p_months_old integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.verify_user_config_params(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.execute_cleanup(p_table_name text, p_days_to_keep integer, p_admin_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.preview_cleanup(p_table_name text, p_days_to_keep integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.preview_cleanup_used_order_data(p_days_to_keep integer) SET search_path = public, pg_temp;

-- Order counting functions
ALTER FUNCTION public.count_orders_by_user(user_ids uuid[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.count_today_orders_by_user(user_ids uuid[], today_start timestamp with time zone) SET search_path = public, pg_temp;
ALTER FUNCTION public.count_failed_orders_by_user(user_ids uuid[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.count_today_completed_orders_by_user(user_ids uuid[], today_start timestamp with time zone) SET search_path = public, pg_temp;
ALTER FUNCTION public.count_today_valid_data_failed_orders_by_user(user_ids uuid[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.count_today_valid_data_failed_orders_by_user(user_ids uuid[], today_start timestamp with time zone) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_order_counts_by_user() SET search_path = public, pg_temp;

-- Message management
ALTER FUNCTION public.get_unread_message_count(user_id_param uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.mark_message_as_read(message_id_param uuid, user_id_param uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.mark_login_popup_as_shown(message_id_param uuid, user_id_param uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.delete_messages(message_ids uuid[], requesting_admin_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.delete_all_messages_for_admin(requesting_admin_id uuid, target_admin_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.send_broadcast_message(p_admin_id uuid, p_message_content text, p_message_type text, p_image_url text, p_target_type text, p_target_admin_id uuid, p_employee_ids uuid[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_employee_unread_customer_messages_count(p_employee_id uuid) SET search_path = public, pg_temp;

-- Customer service
ALTER FUNCTION public.set_service_ticket_number() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_or_create_service_session(p_customer_id uuid, p_employee_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.generate_service_ticket_number() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_practice_data_stats() SET search_path = public, pg_temp;
ALTER FUNCTION public.expire_old_rating_requests() SET search_path = public, pg_temp;
ALTER FUNCTION public.generate_customer_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.generate_super_customer_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.set_customer_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_admin_customer_conversations(p_admin_id uuid) SET search_path = public, pg_temp;

-- User wallet and triggers
ALTER FUNCTION public.create_wallet_for_new_user() SET search_path = public, pg_temp;

-- Session validation (multiple overloads)
ALTER FUNCTION public.validate_employee_session(user_id uuid, session_token text, tab_id text) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_employee_session(p_user_id uuid, p_session_token uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.validate_employee_session(p_user_id uuid, p_session_token uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_employee_heartbeat(p_user_id uuid, p_session_token uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.clear_employee_session(p_user_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.validate_employee_session(p_user_id uuid, p_session_token uuid, p_tab_id text) SET search_path = public, pg_temp;

-- Login and security
ALTER FUNCTION public.log_employee_login(p_user_id uuid, p_username text, p_employee_id text, p_ip_address text, p_user_agent text, p_session_id text) SET search_path = public, pg_temp;
ALTER FUNCTION public.log_employee_logout(p_user_id uuid, p_username text, p_employee_id text, p_ip_address text, p_user_agent text, p_session_id text) SET search_path = public, pg_temp;
ALTER FUNCTION public.check_login_rate_limit(p_identifier text, p_identifier_type text) SET search_path = public, pg_temp;
ALTER FUNCTION public.unlock_account(p_identifier text, p_identifier_type text, p_admin_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.record_login_attempt(p_identifier text, p_identifier_type text, p_success boolean, p_ip_address text, p_user_agent text) SET search_path = public, pg_temp;
ALTER FUNCTION public.unlock_account_with_permission_check(p_identifier text, p_identifier_type text, p_admin_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_account_locks_for_admin(p_admin_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.should_lock_account(p_username text) SET search_path = public, pg_temp;

-- Admin and employee management
ALTER FUNCTION public.get_employees_by_admin() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_admin_groups_for_customer_service() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_admin_employees(p_admin_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_employee_login_summary(p_admin_id uuid, p_search_term text) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_employee_login_history(p_admin_id uuid, p_user_id uuid, p_limit integer, p_offset integer) SET search_path = public, pg_temp;
