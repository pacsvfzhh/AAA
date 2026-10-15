/*
  # Drop Security Definer Views

  Drop all SECURITY DEFINER views to fix security issues.
  These views can be recreated later if needed with proper RLS policies.
*/

-- Drop all problematic SECURITY DEFINER views
DROP VIEW IF EXISTS dispatch_interval_accuracy CASCADE;
DROP VIEW IF EXISTS valid_data_health_dashboard CASCADE;
DROP VIEW IF EXISTS data_cleanup_schedule CASCADE;
DROP VIEW IF EXISTS withdrawals_readonly CASCADE;
DROP VIEW IF EXISTS valid_data_performance_metrics CASCADE;
DROP VIEW IF EXISTS wallet_transactions_readonly CASCADE;
DROP VIEW IF EXISTS user_work_time_today CASCADE;
DROP VIEW IF EXISTS dispatch_fairness_stats CASCADE;
DROP VIEW IF EXISTS valid_data_usage_stats CASCADE;
DROP VIEW IF EXISTS user_config_and_stats CASCADE;
DROP VIEW IF EXISTS history_cleanup_summary CASCADE;
DROP VIEW IF EXISTS valid_data_reusability_stats CASCADE;
DROP VIEW IF EXISTS orders_readonly CASCADE;
DROP VIEW IF EXISTS valid_data_usage_trend CASCADE;
DROP VIEW IF EXISTS wallets_readonly CASCADE;
DROP VIEW IF EXISTS commission_health_status CASCADE;
DROP VIEW IF EXISTS daily_work_time_stats CASCADE;
DROP VIEW IF EXISTS valid_data_by_value CASCADE;
