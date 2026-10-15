-- Fix preview_cleanup: employee_login_history uses created_at (not login_at), login_attempts uses created_at (not attempted_at)
DROP FUNCTION IF EXISTS preview_cleanup(text, integer);

CREATE FUNCTION preview_cleanup(
  p_table_name text,
  p_days_to_keep integer
)
RETURNS TABLE(table_name text, total_records bigint, records_to_delete bigint, records_to_keep bigint, oldest_record timestamptz, cutoff_date timestamptz, estimated_space text, risk_level text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
v_total bigint;
v_to_delete bigint;
v_oldest timestamptz;
v_cutoff timestamptz;
BEGIN
v_cutoff := NOW() - (p_days_to_keep || ' days')::interval;

CASE p_table_name
WHEN 'orders' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM orders;
WHEN 'wallet_transactions' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM wallet_transactions;
WHEN 'dispatch_assignments' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE assigned_at < v_cutoff), MIN(assigned_at)
  INTO v_total, v_to_delete, v_oldest FROM dispatch_assignments;
WHEN 'work_sessions' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE start_time < v_cutoff), MIN(start_time)
  INTO v_total, v_to_delete, v_oldest FROM work_sessions;
WHEN 'dispatch_sessions' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE started_at < v_cutoff), MIN(started_at)
  INTO v_total, v_to_delete, v_oldest FROM dispatch_sessions;
WHEN 'messages' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM messages;
WHEN 'used_order_data' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM used_order_data;
WHEN 'valid_order_data' THEN
  SELECT 
    COUNT(*) FILTER (WHERE is_active = false),
    COUNT(*) FILTER (WHERE is_active = false AND id IN (
      SELECT uod.valid_order_data_id FROM used_order_data uod WHERE uod.created_at < v_cutoff
    )),
    MIN(CASE WHEN is_active = false THEN created_at END)
  INTO v_total, v_to_delete, v_oldest FROM valid_order_data;
WHEN 'valid_order_data_archive' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE archived_at < v_cutoff), MIN(archived_at)
  INTO v_total, v_to_delete, v_oldest FROM valid_order_data_archive;
WHEN 'customer_conversations' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM customer_conversations;
WHEN 'customer_messages' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM customer_messages;
WHEN 'customer_service_sessions' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM customer_service_sessions;
WHEN 'dispatch_logs' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM dispatch_system_logs;
WHEN 'employee_login_history' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM employee_login_history;
WHEN 'login_attempts' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM login_attempts;
WHEN 'orders_history' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM orders_history;
WHEN 'dispatch_system_logs' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM dispatch_system_logs;
WHEN 'dispatch_performance_metrics' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE measured_at < v_cutoff), MIN(measured_at)
  INTO v_total, v_to_delete, v_oldest FROM dispatch_performance_metrics;
WHEN 'valid_data_audit_log' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE action_timestamp < v_cutoff), MIN(action_timestamp)
  INTO v_total, v_to_delete, v_oldest FROM valid_data_audit_log;
WHEN 'valid_data_error_log' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE detected_at < v_cutoff), MIN(detected_at)
  INTO v_total, v_to_delete, v_oldest FROM valid_data_error_log;
WHEN 'valid_data_query_performance' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE recorded_at < v_cutoff), MIN(recorded_at)
  INTO v_total, v_to_delete, v_oldest FROM valid_data_query_performance;
WHEN 'commission_audit_log' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
  INTO v_total, v_to_delete, v_oldest FROM commission_audit_log;
WHEN 'money_data_protection_audit' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE attempted_at < v_cutoff), MIN(attempted_at)
  INTO v_total, v_to_delete, v_oldest FROM money_data_protection_audit;
WHEN 'bulk_import_log' THEN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE started_at < v_cutoff), MIN(started_at)
  INTO v_total, v_to_delete, v_oldest FROM bulk_import_log;
ELSE
  v_total := 0;
  v_to_delete := 0;
  v_oldest := NULL;
END CASE;

RETURN QUERY SELECT 
  p_table_name,
  COALESCE(v_total, 0)::bigint,
  COALESCE(v_to_delete, 0)::bigint,
  (COALESCE(v_total, 0) - COALESCE(v_to_delete, 0))::bigint,
  v_oldest,
  v_cutoff,
  CASE 
    WHEN COALESCE(v_to_delete, 0) > 0 THEN format('%s MB', ROUND((v_to_delete * 0.5 / 1024.0)::numeric, 2))
    ELSE '0 MB'
  END,
  CASE 
    WHEN COALESCE(v_to_delete, 0) = 0 THEN 'safe'
    WHEN COALESCE(v_to_delete, 0)::float / GREATEST(COALESCE(v_total, 1), 1) > 0.8 THEN 'warning'
    ELSE 'safe'
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION preview_cleanup(text, integer) TO anon, authenticated;
