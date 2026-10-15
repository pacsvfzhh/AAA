-- Fix execute_cleanup function: wrong column names causing repeated errors
-- 1. history_cleanup_log INSERT uses non-existent 'execution_time_ms' column
-- 2. work_sessions uses 'started_at' but actual column is 'start_time'
-- 3. employee_login_history uses 'login_at' but actual column is 'created_at'
-- 4. login_attempts uses 'attempted_at' but actual column is 'created_at'

DROP FUNCTION IF EXISTS execute_cleanup(text, integer, uuid);

CREATE FUNCTION execute_cleanup(
  p_table_name text,
  p_days_to_keep integer,
  p_admin_id uuid
)
RETURNS TABLE(success boolean, records_deleted bigint, space_freed text, execution_time_ms numeric, message text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_time timestamp;
  v_deleted bigint;
  v_cutoff timestamptz;
BEGIN
  v_start_time := clock_timestamp();
  v_cutoff := NOW() - (p_days_to_keep || ' days')::interval;

  CASE p_table_name
    WHEN 'orders' THEN
      DELETE FROM orders WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'wallet_transactions' THEN
      DELETE FROM wallet_transactions WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'dispatch_assignments' THEN
      DELETE FROM dispatch_assignments WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'work_sessions' THEN
      DELETE FROM work_sessions WHERE start_time < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'dispatch_sessions' THEN
      DELETE FROM dispatch_sessions WHERE started_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'messages' THEN
      DELETE FROM messages WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'used_order_data' THEN
      DELETE FROM used_order_data WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'valid_order_data' THEN
      DELETE FROM used_order_data 
      WHERE created_at < v_cutoff
      AND valid_order_data_id IN (
        SELECT id FROM valid_order_data WHERE is_active = false
      );
      UPDATE valid_order_data
      SET is_active = true
      WHERE is_active = false
      AND NOT EXISTS (
        SELECT 1 FROM used_order_data uod 
        WHERE uod.valid_order_data_id = valid_order_data.id
      );
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'valid_order_data_archive' THEN
      DELETE FROM valid_order_data_archive WHERE archived_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'customer_conversations' THEN
      DELETE FROM customer_conversations WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'customer_messages' THEN
      DELETE FROM customer_messages WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'customer_service_sessions' THEN
      DELETE FROM customer_service_sessions WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'dispatch_logs' THEN
      DELETE FROM dispatch_logs WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'employee_login_history' THEN
      DELETE FROM employee_login_history WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'login_attempts' THEN
      DELETE FROM login_attempts WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'orders_history' THEN
      DELETE FROM orders_history WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'dispatch_system_logs' THEN
      DELETE FROM dispatch_system_logs WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'dispatch_performance_metrics' THEN
      DELETE FROM dispatch_performance_metrics WHERE measured_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'valid_data_audit_log' THEN
      DELETE FROM valid_data_audit_log WHERE action_timestamp < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'valid_data_error_log' THEN
      DELETE FROM valid_data_error_log WHERE detected_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'valid_data_query_performance' THEN
      DELETE FROM valid_data_query_performance WHERE recorded_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'commission_audit_log' THEN
      DELETE FROM commission_audit_log WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'money_data_protection_audit' THEN
      DELETE FROM money_data_protection_audit WHERE attempted_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'bulk_import_log' THEN
      DELETE FROM bulk_import_log WHERE started_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    ELSE
      v_deleted := 0;
  END CASE;

  -- Log cleanup using correct columns that exist in history_cleanup_log
  INSERT INTO history_cleanup_log (table_name, admin_id, records_deleted, space_freed, retention_days, status, message)
  VALUES (
    p_table_name,
    p_admin_id,
    COALESCE(v_deleted, 0),
    format('%s MB', ROUND((COALESCE(v_deleted, 0) * 0.5 / 1024.0)::numeric, 2)),
    p_days_to_keep,
    'success',
    CASE p_table_name
      WHEN 'valid_order_data' THEN format('Recycled %s records back to available pool', v_deleted)
      WHEN 'used_order_data' THEN format('Cleaned %s dispatch records', v_deleted)
      ELSE format('Cleaned %s records from %s', v_deleted, p_table_name)
    END
  );

  RETURN QUERY SELECT 
    true,
    COALESCE(v_deleted, 0)::bigint,
    format('%s MB', ROUND((COALESCE(v_deleted, 0) * 0.5 / 1024.0)::numeric, 2)),
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    CASE p_table_name
      WHEN 'valid_order_data' THEN format('Recycled %s records back to available pool', v_deleted)::text
      WHEN 'used_order_data' THEN format('Cleaned %s dispatch records', v_deleted)::text
      ELSE format('Cleaned %s records from %s', v_deleted, p_table_name)::text
    END;
END;
$$;

GRANT EXECUTE ON FUNCTION execute_cleanup(text, integer, uuid) TO anon, authenticated;
