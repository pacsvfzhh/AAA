/*
  # Fix Cleanup Functions - Correct Column Names

  ## Problem
  The `preview_cleanup` and `execute_cleanup` functions had incorrect column names
  that caused "column does not exist" errors when cleaning up data.

  ## Fixes
  1. `valid_data_audit_log` - uses `action_timestamp` not `created_at`
  2. `valid_data_error_log` - uses `detected_at` not `created_at`
  3. `dispatch_performance_metrics` - uses `measured_at` not `created_at`
  4. `valid_data_query_performance` - uses `recorded_at` not `created_at`
  5. `money_data_protection_audit` - uses `attempted_at` not `created_at`
  6. `bulk_import_log` - uses `started_at` not `created_at`
  7. `work_sessions` - standardize to use `start_time`
  8. `valid_order_data` - add missing case in preview_cleanup

  ## Security
  - Functions remain SECURITY DEFINER with proper search_path
*/

-- Fix preview_cleanup function with correct column names
CREATE OR REPLACE FUNCTION public.preview_cleanup(p_table_name text, p_days_to_keep integer)
RETURNS TABLE(
  table_name text,
  total_records bigint,
  records_to_delete bigint,
  records_to_keep bigint,
  oldest_date timestamp with time zone,
  cutoff_date timestamp with time zone,
  estimated_space_freed text,
  safety_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total bigint;
  v_to_delete bigint;
  v_oldest timestamptz;
  v_cutoff timestamptz;
  v_size_estimate bigint;
BEGIN
  -- Validate table name exists
  IF NOT EXISTS (
    SELECT 1 FROM history_cleanup_config
    WHERE history_cleanup_config.table_name = p_table_name
    AND can_cleanup = true
  ) THEN
    RAISE EXCEPTION 'Table % is not configured for cleanup or cleanup is disabled', p_table_name;
  END IF;

  -- Calculate cutoff date
  v_cutoff := NOW() - (p_days_to_keep || ' days')::INTERVAL;

  -- Get statistics based on table with correct column names
  CASE p_table_name
    WHEN 'dispatch_assignments' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE assigned_at < v_cutoff), MIN(assigned_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_assignments;

    WHEN 'dispatch_sessions' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE started_at < v_cutoff), MIN(started_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_sessions;

    WHEN 'work_sessions' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE start_time < v_cutoff), MIN(start_time)
      INTO v_total, v_to_delete, v_oldest
      FROM work_sessions;

    WHEN 'customer_service_sessions' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM customer_service_sessions;

    WHEN 'used_order_data' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM used_order_data;

    WHEN 'valid_order_data' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_order_data;

    WHEN 'valid_data_audit_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE action_timestamp < v_cutoff), MIN(action_timestamp)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_data_audit_log;

    WHEN 'valid_data_error_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE detected_at < v_cutoff), MIN(detected_at)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_data_error_log;

    WHEN 'dispatch_system_logs' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_system_logs;

    WHEN 'commission_audit_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM commission_audit_log;

    WHEN 'money_data_protection_audit' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE attempted_at < v_cutoff), MIN(attempted_at)
      INTO v_total, v_to_delete, v_oldest
      FROM money_data_protection_audit;

    WHEN 'dispatch_performance_metrics' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE measured_at < v_cutoff), MIN(measured_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_performance_metrics;

    WHEN 'valid_data_query_performance' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE recorded_at < v_cutoff), MIN(recorded_at)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_data_query_performance;

    WHEN 'orders_history' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE archived_at < v_cutoff), MIN(archived_at)
      INTO v_total, v_to_delete, v_oldest
      FROM orders_history;

    WHEN 'valid_order_data_archive' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE archived_at < v_cutoff), MIN(archived_at)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_order_data_archive;

    WHEN 'bulk_import_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE started_at < v_cutoff), MIN(started_at)
      INTO v_total, v_to_delete, v_oldest
      FROM bulk_import_log;

    ELSE
      RAISE EXCEPTION 'Table % is not supported for cleanup preview', p_table_name;
  END CASE;

  -- Estimate space to be freed (approximate based on record count)
  IF v_to_delete > 0 AND v_total > 0 THEN
    v_size_estimate := (pg_total_relation_size(p_table_name::regclass) * v_to_delete / v_total);
  ELSE
    v_size_estimate := 0;
  END IF;

  -- Return results
  RETURN QUERY SELECT
    p_table_name,
    v_total,
    v_to_delete,
    v_total - v_to_delete,
    v_oldest,
    v_cutoff,
    pg_size_pretty(v_size_estimate),
    CASE
      WHEN v_to_delete = 0 THEN 'No records to delete'
      WHEN v_to_delete < v_total * 0.1 THEN 'Safe - Less than 10% will be deleted'
      WHEN v_to_delete < v_total * 0.5 THEN 'Moderate - Less than 50% will be deleted'
      ELSE 'Warning - More than 50% will be deleted'
    END;
END;
$function$;


-- Fix execute_cleanup function with correct column names
CREATE OR REPLACE FUNCTION public.execute_cleanup(
  p_table_name text, 
  p_days_to_keep integer, 
  p_admin_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  success boolean, 
  records_deleted bigint, 
  space_freed text, 
  execution_time_ms numeric, 
  message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start_time timestamp;
  v_deleted bigint := 0;
  v_cutoff timestamptz;
  v_size_before bigint;
  v_size_after bigint;
  v_total_before bigint;
  v_delete_percentage numeric;
  v_config record;
  v_estimated_space bigint;
BEGIN
  v_start_time := clock_timestamp();

  -- Validate table exists in cleanup config and cleanup is allowed
  SELECT * INTO v_config
  FROM history_cleanup_config
  WHERE history_cleanup_config.table_name = p_table_name
  AND can_cleanup = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      false,
      0::bigint,
      '0 bytes',
      0::numeric,
      'Table not found or cleanup not allowed'::text;
    RETURN;
  END IF;

  -- Validate retention period
  IF p_days_to_keep < 0 THEN
    RETURN QUERY SELECT
      false,
      0::bigint,
      '0 bytes',
      0::numeric,
      'Retention days must be 0 or greater'::text;
    RETURN;
  END IF;

  -- Calculate cutoff date
  v_cutoff := NOW() - (p_days_to_keep || ' days')::interval;

  -- Get size and count before cleanup
  EXECUTE format('SELECT pg_total_relation_size(%L)', p_table_name) INTO v_size_before;
  EXECUTE format('SELECT COUNT(*) FROM %I', p_table_name) INTO v_total_before;

  -- Execute cleanup based on table with correct column names
  CASE p_table_name
    -- Operational tables
    WHEN 'dispatch_assignments' THEN
      DELETE FROM dispatch_assignments WHERE assigned_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'dispatch_sessions' THEN
      DELETE FROM dispatch_sessions WHERE started_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'work_sessions' THEN
      DELETE FROM work_sessions WHERE start_time < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'customer_service_sessions' THEN
      DELETE FROM customer_service_sessions WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'used_order_data' THEN
      DELETE FROM used_order_data WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'valid_order_data' THEN
      DELETE FROM valid_order_data WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    -- Audit tables (with correct column names)
    WHEN 'valid_data_audit_log' THEN
      DELETE FROM valid_data_audit_log WHERE action_timestamp < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'valid_data_error_log' THEN
      DELETE FROM valid_data_error_log WHERE detected_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'dispatch_system_logs' THEN
      DELETE FROM dispatch_system_logs WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'commission_audit_log' THEN
      DELETE FROM commission_audit_log WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'money_data_protection_audit' THEN
      DELETE FROM money_data_protection_audit WHERE attempted_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    -- Performance tables (with correct column names)
    WHEN 'dispatch_performance_metrics' THEN
      DELETE FROM dispatch_performance_metrics WHERE measured_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'valid_data_query_performance' THEN
      DELETE FROM valid_data_query_performance WHERE recorded_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    -- Archive tables
    WHEN 'orders_history' THEN
      DELETE FROM orders_history WHERE archived_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'valid_order_data_archive' THEN
      DELETE FROM valid_order_data_archive WHERE archived_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'bulk_import_log' THEN
      DELETE FROM bulk_import_log WHERE started_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    ELSE
      RAISE EXCEPTION 'Cleanup not implemented for table %', p_table_name;
  END CASE;

  -- Calculate deletion percentage
  IF v_total_before > 0 THEN
    v_delete_percentage := (v_deleted::numeric / v_total_before::numeric) * 100;
  ELSE
    v_delete_percentage := 0;
  END IF;

  -- Get size after cleanup (immediate check, no VACUUM)
  EXECUTE format('SELECT pg_total_relation_size(%L)', p_table_name) INTO v_size_after;

  -- Estimate space freed based on deleted records ratio
  IF v_total_before > 0 THEN
    v_estimated_space := (v_size_before * v_deleted / v_total_before);
  ELSE
    v_estimated_space := 0;
  END IF;

  -- Log the cleanup (only if admin_id provided)
  IF p_admin_id IS NOT NULL THEN
    INSERT INTO history_cleanup_log (
      table_name,
      admin_id,
      records_deleted,
      space_freed,
      retention_days,
      status,
      message
    ) VALUES (
      p_table_name,
      p_admin_id,
      v_deleted,
      pg_size_pretty(GREATEST(v_estimated_space, 0)),
      p_days_to_keep,
      'completed',
      'Deleted ' || v_deleted || ' records (' || ROUND(v_delete_percentage, 1) || '%).'
    );
  END IF;

  -- Update config
  UPDATE history_cleanup_config
  SET
    last_cleanup_at = NOW(),
    last_cleanup_records = v_deleted,
    updated_at = NOW()
  WHERE history_cleanup_config.table_name = p_table_name;

  -- Return result
  RETURN QUERY SELECT
    true,
    v_deleted,
    pg_size_pretty(GREATEST(v_estimated_space, 0)),
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    ('Successfully deleted ' || v_deleted || ' records (' || ROUND(v_delete_percentage, 1) || '%).')::text;
END;
$function$;
