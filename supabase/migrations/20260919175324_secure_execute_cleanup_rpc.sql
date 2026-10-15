CREATE OR REPLACE FUNCTION public.execute_cleanup(
  p_admin_session_token uuid,
  p_table_name text,
  p_days_to_keep integer
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
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_config public.history_cleanup_config%ROWTYPE;
  v_start_time timestamp;
  v_deleted bigint := 0;
  v_cutoff timestamptz;
  v_size_before bigint;
  v_size_after bigint;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  SELECT *
  INTO v_config
  FROM public.history_cleanup_config
  WHERE table_name = p_table_name
    AND can_cleanup = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      false,
      0::bigint,
      '0 bytes'::text,
      0::numeric,
      'Table not found or cleanup not allowed'::text;
    RETURN;
  END IF;

  IF p_days_to_keep IS NULL OR p_days_to_keep < 0 THEN
    RETURN QUERY SELECT
      false,
      0::bigint,
      '0 bytes'::text,
      0::numeric,
      'Retention days must be 0 or greater'::text;
    RETURN;
  END IF;

  IF v_admin_role <> 'super_admin'
    AND p_days_to_keep < COALESCE(v_config.min_retention_days, 0) THEN
    RETURN QUERY SELECT
      false,
      0::bigint,
      '0 bytes'::text,
      0::numeric,
      format('Retention must be at least %s days', v_config.min_retention_days)::text;
    RETURN;
  END IF;

  v_start_time := clock_timestamp();
  v_cutoff := now() - make_interval(days => p_days_to_keep);
  v_size_before := pg_total_relation_size(format('public.%I', p_table_name)::regclass);

  CASE p_table_name
    WHEN 'orders' THEN
      DELETE FROM public.orders WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'wallet_transactions' THEN
      DELETE FROM public.wallet_transactions WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'dispatch_assignments' THEN
      DELETE FROM public.dispatch_assignments WHERE assigned_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'work_sessions' THEN
      DELETE FROM public.work_sessions WHERE start_time < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'dispatch_sessions' THEN
      DELETE FROM public.dispatch_sessions WHERE started_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'messages' THEN
      DELETE FROM public.messages WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'used_order_data' THEN
      DELETE FROM public.used_order_data WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'valid_order_data' THEN
      DELETE FROM public.used_order_data
      WHERE created_at < v_cutoff
        AND valid_order_data_id IN (
          SELECT id
          FROM public.valid_order_data
          WHERE is_active = false
        );
      UPDATE public.valid_order_data
      SET is_active = true
      WHERE is_active = false
        AND NOT EXISTS (
          SELECT 1
          FROM public.used_order_data AS used
          WHERE used.valid_order_data_id = valid_order_data.id
        );
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'valid_order_data_archive' THEN
      DELETE FROM public.valid_order_data_archive WHERE archived_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'customer_conversations' THEN
      DELETE FROM public.customer_conversations WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'customer_messages' THEN
      DELETE FROM public.customer_messages WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'customer_service_sessions' THEN
      DELETE FROM public.customer_service_sessions WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'dispatch_logs' THEN
      DELETE FROM public.dispatch_logs WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'employee_login_history' THEN
      DELETE FROM public.employee_login_history WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'login_attempts' THEN
      DELETE FROM public.login_attempts WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'orders_history' THEN
      DELETE FROM public.orders_history WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'dispatch_system_logs' THEN
      DELETE FROM public.dispatch_system_logs WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'dispatch_performance_metrics' THEN
      DELETE FROM public.dispatch_performance_metrics WHERE measured_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'valid_data_audit_log' THEN
      DELETE FROM public.valid_data_audit_log WHERE action_timestamp < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'valid_data_error_log' THEN
      DELETE FROM public.valid_data_error_log
      WHERE detected_at < v_cutoff
        AND resolved_at IS NOT NULL;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'valid_data_query_performance' THEN
      DELETE FROM public.valid_data_query_performance WHERE recorded_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'commission_audit_log' THEN
      DELETE FROM public.commission_audit_log WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'money_data_protection_audit' THEN
      DELETE FROM public.money_data_protection_audit WHERE attempted_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    WHEN 'bulk_import_log' THEN
      DELETE FROM public.bulk_import_log WHERE started_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    ELSE
      RAISE EXCEPTION 'Cleanup not implemented for table %', p_table_name;
  END CASE;

  v_size_after := pg_total_relation_size(format('public.%I', p_table_name)::regclass);

  INSERT INTO public.history_cleanup_log (
    table_name,
    admin_id,
    records_deleted,
    space_freed,
    retention_days,
    status,
    message
  ) VALUES (
    p_table_name,
    v_admin_id,
    v_deleted,
    pg_size_pretty(GREATEST(v_size_before - v_size_after, 0)),
    p_days_to_keep,
    'completed',
    format('Cleaned %s records from %s', v_deleted, p_table_name)
  );

  RETURN QUERY SELECT
    true,
    v_deleted,
    pg_size_pretty(GREATEST(v_size_before - v_size_after, 0)),
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    format('Cleaned %s records from %s', v_deleted, p_table_name)::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.execute_cleanup(text, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_cleanup(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_cleanup(uuid, text, integer) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
