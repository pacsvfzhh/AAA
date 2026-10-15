CREATE OR REPLACE VIEW public.history_cleanup_summary
WITH (security_invoker = true)
AS
SELECT
  cfg.category,
  cfg.table_name,
  cfg.display_name,
  cfg.description,
  cfg.retention_days AS default_retention_days,
  cfg.min_retention_days,
  cfg.last_cleanup_at,
  cfg.last_cleanup_records,
  cfg.cleanup_priority,
  CASE
    WHEN cfg.auto_cleanup_enabled = false THEN 'disabled'
    WHEN public.history_cleanup_completed_today(cfg.table_name) THEN 'up_to_date'
    WHEN cfg.schedule_time_utc > (now() AT TIME ZONE 'UTC')::time THEN 'waiting'
    ELSE 'due'
  END AS cleanup_status,
  pg_size_pretty(pg_total_relation_size(format('public.%I', cfg.table_name)::regclass)) AS current_size,
  CASE cfg.table_name
    WHEN 'dispatch_assignments' THEN (SELECT count(*) FROM public.dispatch_assignments)
    WHEN 'dispatch_sessions' THEN (SELECT count(*) FROM public.dispatch_sessions)
    WHEN 'work_sessions' THEN (SELECT count(*) FROM public.work_sessions)
    WHEN 'customer_service_sessions' THEN (SELECT count(*) FROM public.customer_service_sessions)
    WHEN 'used_order_data' THEN (SELECT count(*) FROM public.used_order_data)
    WHEN 'valid_data_audit_log' THEN (SELECT count(*) FROM public.valid_data_audit_log)
    WHEN 'valid_data_error_log' THEN (SELECT count(*) FROM public.valid_data_error_log)
    WHEN 'dispatch_system_logs' THEN (SELECT count(*) FROM public.dispatch_system_logs)
    WHEN 'commission_audit_log' THEN (SELECT count(*) FROM public.commission_audit_log)
    WHEN 'money_data_protection_audit' THEN (SELECT count(*) FROM public.money_data_protection_audit)
    WHEN 'dispatch_performance_metrics' THEN (SELECT count(*) FROM public.dispatch_performance_metrics)
    WHEN 'valid_data_query_performance' THEN (SELECT count(*) FROM public.valid_data_query_performance)
    WHEN 'orders_history' THEN (SELECT count(*) FROM public.orders_history)
    WHEN 'valid_order_data_archive' THEN (SELECT count(*) FROM public.valid_order_data_archive)
    WHEN 'bulk_import_log' THEN (SELECT count(*) FROM public.bulk_import_log)
    WHEN 'valid_order_data' THEN (SELECT count(*) FROM public.valid_order_data)
    ELSE 0
  END AS current_record_count
FROM public.history_cleanup_config AS cfg
WHERE cfg.can_cleanup = true
ORDER BY cfg.cleanup_priority DESC, cfg.table_name;
