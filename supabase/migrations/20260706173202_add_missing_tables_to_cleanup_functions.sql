/*
# Add missing tables to preview_cleanup and execute_cleanup

## Problem
8 tables configured in history_cleanup_config are NOT handled in the 
preview_cleanup and execute_cleanup CASE statements. When auto cleanup 
or manual cleanup runs on these tables, they hit the ELSE case and 
silently return 0 — cleanup never actually happens.

## Missing Tables (now added)
- dispatch_system_logs (date col: created_at)
- dispatch_performance_metrics (date col: measured_at)
- valid_data_audit_log (date col: action_timestamp)
- valid_data_error_log (date col: detected_at)
- valid_data_query_performance (date col: recorded_at)
- commission_audit_log (date col: created_at)
- money_data_protection_audit (date col: attempted_at)
- bulk_import_log (date col: started_at)

## Fix
Add WHEN clauses for each missing table with their correct date columns.
*/

DROP FUNCTION IF EXISTS preview_cleanup(text, integer);
DROP FUNCTION IF EXISTS execute_cleanup(text, integer, uuid);

-- Recreate preview_cleanup with ALL tables
CREATE OR REPLACE FUNCTION preview_cleanup(
  p_table_name text,
  p_days_to_keep integer
)
RETURNS TABLE (
  table_name text,
  total_records bigint,
  records_to_delete bigint,
  records_to_keep bigint,
  oldest_date timestamptz,
  cutoff_date timestamptz,
  estimated_space_freed text,
  safety_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
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
      INTO v_total, v_to_delete, v_oldest
      FROM orders;
    WHEN 'wallet_transactions' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM wallet_transactions;
    WHEN 'dispatch_assignments' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_assignments;
    WHEN 'work_sessions' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE started_at < v_cutoff), MIN(started_at)
      INTO v_total, v_to_delete, v_oldest
      FROM work_sessions;
    WHEN 'dispatch_sessions' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE started_at < v_cutoff), MIN(started_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_sessions;
    WHEN 'messages' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM messages;
    WHEN 'used_order_data' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM used_order_data;
    WHEN 'valid_order_data' THEN
      SELECT 
        COUNT(*) FILTER (WHERE is_active = false),
        COUNT(*) FILTER (WHERE is_active = false AND id IN (
          SELECT uod.valid_order_data_id FROM used_order_data uod 
          WHERE uod.created_at < v_cutoff
        )),
        MIN(CASE WHEN is_active = false THEN created_at END)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_order_data;
    WHEN 'valid_order_data_archive' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE archived_at < v_cutoff), MIN(archived_at)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_order_data_archive;
    WHEN 'customer_conversations' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM customer_conversations;
    WHEN 'customer_messages' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM customer_messages;
    WHEN 'customer_service_sessions' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM customer_service_sessions;
    WHEN 'dispatch_logs' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_logs;
    WHEN 'employee_login_history' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE login_at < v_cutoff), MIN(login_at)
      INTO v_total, v_to_delete, v_oldest
      FROM employee_login_history;
    WHEN 'login_attempts' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE attempted_at < v_cutoff), MIN(attempted_at)
      INTO v_total, v_to_delete, v_oldest
      FROM login_attempts;
    WHEN 'orders_history' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM orders_history;
    -- Previously missing tables:
    WHEN 'dispatch_system_logs' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_system_logs;
    WHEN 'dispatch_performance_metrics' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE measured_at < v_cutoff), MIN(measured_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_performance_metrics;
    WHEN 'valid_data_audit_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE action_timestamp < v_cutoff), MIN(action_timestamp)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_data_audit_log;
    WHEN 'valid_data_error_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE detected_at < v_cutoff), MIN(detected_at)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_data_error_log;
    WHEN 'valid_data_query_performance' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE recorded_at < v_cutoff), MIN(recorded_at)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_data_query_performance;
    WHEN 'commission_audit_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM commission_audit_log;
    WHEN 'money_data_protection_audit' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE attempted_at < v_cutoff), MIN(attempted_at)
      INTO v_total, v_to_delete, v_oldest
      FROM money_data_protection_audit;
    WHEN 'bulk_import_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE started_at < v_cutoff), MIN(started_at)
      INTO v_total, v_to_delete, v_oldest
      FROM bulk_import_log;
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

-- Recreate execute_cleanup with ALL tables
CREATE OR REPLACE FUNCTION execute_cleanup(
  p_table_name text,
  p_days_to_keep integer,
  p_admin_id uuid DEFAULT NULL
)
RETURNS TABLE (
  success boolean,
  records_deleted bigint,
  space_freed text,
  execution_time_ms numeric,
  message text
)
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
      DELETE FROM work_sessions WHERE started_at < v_cutoff;
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
      -- RECYCLE: Reactivate inactive records whose usage has expired
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
      DELETE FROM employee_login_history WHERE login_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'login_attempts' THEN
      DELETE FROM login_attempts WHERE attempted_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'orders_history' THEN
      DELETE FROM orders_history WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    -- Previously missing tables:
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

  -- Log the cleanup
  INSERT INTO history_cleanup_log (table_name, records_deleted, execution_time_ms)
  VALUES (p_table_name, v_deleted, ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2));

  RETURN QUERY SELECT 
    true,
    COALESCE(v_deleted, 0)::bigint,
    format('%s MB', ROUND((COALESCE(v_deleted, 0) * 0.5 / 1024.0)::numeric, 2)),
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    CASE p_table_name
      WHEN 'valid_order_data' THEN format('已回流 %s 条验证数据到可用池', v_deleted)::text
      WHEN 'used_order_data' THEN format('已清理 %s 条派送记录，对应数据可回流', v_deleted)::text
      ELSE format('Cleaned %s records from %s', v_deleted, p_table_name)::text
    END;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION preview_cleanup(text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION execute_cleanup(text, integer, uuid) TO anon, authenticated;
