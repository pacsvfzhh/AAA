CREATE FUNCTION private.is_history_cleanup_table(p_table_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE STRICT
SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT p_table_name = ANY (ARRAY[
    'dispatch_assignments', 'dispatch_sessions', 'work_sessions',
    'customer_service_sessions', 'used_order_data', 'valid_order_data',
    'valid_data_audit_log', 'valid_data_error_log', 'dispatch_system_logs',
    'commission_audit_log', 'money_data_protection_audit',
    'dispatch_performance_metrics', 'valid_data_query_performance',
    'orders_history', 'valid_order_data_archive', 'bulk_import_log'
  ]::text[]);
$function$;

REVOKE ALL ON FUNCTION private.is_history_cleanup_table(text) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.history_cleanup_config
  ADD COLUMN schedule_time_utc time without time zone;

DO $block$
DECLARE
  v_schedule jsonb;
  v_entry jsonb;
  v_config public.history_cleanup_config%ROWTYPE;
BEGIN
  SELECT sc.value INTO v_schedule
  FROM public.system_configs AS sc
  WHERE sc.key = 'auto_cleanup_schedule';

  IF jsonb_typeof(v_schedule) IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_schedule) <> 16 THEN
    RAISE EXCEPTION 'Expected exactly 16 UI history cleanup schedule entries.';
  END IF;

  IF (SELECT count(*) FROM public.history_cleanup_config) <> 16
     OR EXISTS (
       SELECT 1 FROM public.history_cleanup_config AS cfg
       WHERE NOT private.is_history_cleanup_table(cfg.table_name)
     ) THEN
    RAISE EXCEPTION 'History cleanup configuration does not match the 16 supported tables.';
  END IF;

  FOR v_entry IN SELECT item.value FROM jsonb_array_elements(v_schedule) AS item(value) LOOP
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_entry->'table_name') IS DISTINCT FROM 'string'
       OR NOT COALESCE(private.is_history_cleanup_table(v_entry->>'table_name'), false)
       OR jsonb_typeof(v_entry->'enabled') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(v_entry->'days_to_keep') IS DISTINCT FROM 'number'
       OR (v_entry->>'days_to_keep') !~ '^(0|[1-9][0-9]*)$'
       OR jsonb_typeof(v_entry->'schedule_time') IS DISTINCT FROM 'string'
       OR (v_entry->>'schedule_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RAISE EXCEPTION 'Invalid UI history cleanup schedule entry: %', v_entry;
    END IF;
  END LOOP;

  FOR v_config IN SELECT * FROM public.history_cleanup_config ORDER BY table_name LOOP
    IF (SELECT count(*) FROM jsonb_array_elements(v_schedule) AS item(value)
        WHERE item.value->>'table_name' = v_config.table_name) <> 1 THEN
      RAISE EXCEPTION 'Expected exactly one UI schedule entry for %', v_config.table_name;
    END IF;

    SELECT item.value INTO v_entry
    FROM jsonb_array_elements(v_schedule) AS item(value)
    WHERE item.value->>'table_name' = v_config.table_name;

    IF (v_entry->>'days_to_keep')::integer < v_config.min_retention_days
       OR v_config.min_retention_days < 0 THEN
      RAISE EXCEPTION 'UI retention for % is below its minimum', v_config.table_name;
    END IF;

    UPDATE public.history_cleanup_config AS cfg
    SET retention_days = (v_entry->>'days_to_keep')::integer,
        schedule_time_utc = (v_entry->>'schedule_time')::time,
        auto_cleanup_enabled = (v_entry->>'enabled')::boolean,
        updated_at = now()
    WHERE cfg.id = v_config.id;
  END LOOP;
END;
$block$;

ALTER TABLE public.history_cleanup_config
  ALTER COLUMN schedule_time_utc SET NOT NULL,
  ALTER COLUMN auto_cleanup_enabled SET NOT NULL,
  ADD CONSTRAINT history_cleanup_config_retention_min_check
    CHECK (min_retention_days >= 0 AND retention_days >= min_retention_days),
  ADD CONSTRAINT history_cleanup_config_utc_minute_check
    CHECK (EXTRACT(SECOND FROM schedule_time_utc) = 0);

REVOKE INSERT, UPDATE, DELETE ON TABLE public.history_cleanup_config
  FROM PUBLIC, anon, authenticated;

UPDATE public.valid_order_data
SET deactivation_reason = 'manual'
WHERE is_active = false AND deactivation_reason IS NULL;

CREATE FUNCTION private.mark_manual_valid_order_deactivation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF NEW.is_active = false AND OLD.is_active IS DISTINCT FROM false
     AND NEW.deactivation_reason IS NULL THEN
    NEW.deactivation_reason := 'manual';
    NEW.deactivated_at := COALESCE(NEW.deactivated_at, clock_timestamp());
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER mark_manual_valid_order_deactivation
BEFORE UPDATE OF is_active ON public.valid_order_data
FOR EACH ROW EXECUTE FUNCTION private.mark_manual_valid_order_deactivation();

REVOKE ALL ON FUNCTION private.mark_manual_valid_order_deactivation() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.history_cleanup_log
  ADD COLUMN run_source text,
  ADD COLUMN scheduled_for date,
  ADD CONSTRAINT history_cleanup_log_run_source_check
    CHECK (run_source IN ('manual', 'automatic')),
  ADD CONSTRAINT history_cleanup_log_schedule_check
    CHECK ((run_source IS NULL AND scheduled_for IS NULL)
       OR (run_source = 'manual' AND scheduled_for IS NULL AND admin_id IS NOT NULL)
       OR (run_source = 'automatic' AND scheduled_for IS NOT NULL AND admin_id IS NULL));

CREATE UNIQUE INDEX history_cleanup_log_automatic_completed_day_key
  ON public.history_cleanup_log (table_name, scheduled_for)
  WHERE run_source = 'automatic' AND status = 'completed';

CREATE INDEX history_cleanup_log_automatic_failed_day_idx
  ON public.history_cleanup_log (table_name, scheduled_for)
  WHERE run_source = 'automatic' AND status = 'failed';

DROP POLICY IF EXISTS "Allow all operations on cleanup log" ON public.history_cleanup_log;
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.history_cleanup_log
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.run_history_cleanup(
  p_table_name text,
  p_days_to_keep integer,
  p_admin_id uuid,
  p_run_source text,
  p_scheduled_for date
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
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_config public.history_cleanup_config%ROWTYPE;
  v_started_at timestamptz := clock_timestamp();
  v_cutoff timestamptz;
  v_size_before bigint;
  v_size_after bigint;
  v_affected bigint := 0;
  v_references_deleted bigint := 0;
  v_recyclable_ids uuid[];
  v_message text;
  v_space_freed text;
BEGIN
  IF NOT COALESCE(private.is_history_cleanup_table(p_table_name), false) THEN
    RAISE EXCEPTION 'Unsupported history cleanup table: %', p_table_name;
  END IF;
  IF NOT ((p_run_source = 'manual' AND p_admin_id IS NOT NULL AND p_scheduled_for IS NULL)
       OR (p_run_source = 'automatic' AND p_admin_id IS NULL AND p_scheduled_for IS NOT NULL)) THEN
    RAISE EXCEPTION 'Invalid history cleanup run source or actor.';
  END IF;

  -- Manual runs and cron use the same per-table lock; cron uses the try-lock first.
  PERFORM pg_advisory_xact_lock(hashtext('history_cleanup'), hashtext(p_table_name));

  SELECT * INTO v_config
  FROM public.history_cleanup_config AS cfg
  WHERE cfg.table_name = p_table_name AND cfg.can_cleanup = true
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'History cleanup is not allowed for %', p_table_name;
  END IF;
  IF p_days_to_keep IS NULL OR p_days_to_keep < v_config.min_retention_days THEN
    RAISE EXCEPTION 'Retention for % must be at least % days', p_table_name, v_config.min_retention_days;
  END IF;
  IF p_run_source = 'automatic' AND (
       v_config.auto_cleanup_enabled IS DISTINCT FROM true
       OR p_scheduled_for IS DISTINCT FROM (clock_timestamp() AT TIME ZONE 'UTC')::date
       OR v_config.schedule_time_utc > (clock_timestamp() AT TIME ZONE 'UTC')::time
       OR EXISTS (
         SELECT 1 FROM public.history_cleanup_log AS log
         WHERE log.table_name = p_table_name AND log.run_source = 'automatic'
           AND log.scheduled_for = p_scheduled_for AND log.status = 'completed'
       )) THEN
    RAISE EXCEPTION 'Automatic cleanup is not due for %', p_table_name;
  END IF;

  v_cutoff := now() - make_interval(days => p_days_to_keep);
  v_size_before := pg_total_relation_size(format('public.%I', p_table_name)::regclass);
  IF p_table_name = 'valid_order_data' THEN
    v_size_before := v_size_before + pg_total_relation_size('public.used_order_data'::regclass);
  END IF;

  CASE p_table_name
    WHEN 'dispatch_assignments' THEN
      DELETE FROM public.dispatch_assignments AS a
      WHERE a.assigned_at < v_cutoff AND a.status IN ('completed', 'error', 'timeout', 'cancelled');
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'dispatch_sessions' THEN
      DELETE FROM public.dispatch_sessions AS s
      WHERE s.started_at < v_cutoff AND s.ended_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.dispatch_assignments AS a
          WHERE a.dispatch_session_id = s.id AND a.status IN ('pending', 'accepted')
        );
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'work_sessions' THEN
      DELETE FROM public.work_sessions AS s
      WHERE s.start_time < v_cutoff AND s.end_time IS NOT NULL;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'customer_service_sessions' THEN
      DELETE FROM public.customer_service_sessions AS s
      WHERE s.created_at < v_cutoff AND s.closed_at IS NOT NULL;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'used_order_data' THEN
      DELETE FROM public.used_order_data AS u
      WHERE u.created_at < v_cutoff
        AND NOT EXISTS (
          SELECT 1 FROM public.orders AS o
          WHERE o.id = u.order_id AND o.status = 'processing'
        );
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'valid_order_data' THEN
      SELECT array(
        SELECT vod.id
        FROM public.valid_order_data AS vod
        WHERE vod.is_active = false AND vod.deactivation_reason = 'used'
          AND vod.last_used_at < v_cutoff
          AND NOT EXISTS (
            SELECT 1 FROM public.used_order_data AS u
            WHERE u.valid_order_data_id = vod.id
              AND (u.created_at IS NULL OR u.created_at >= v_cutoff)
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.used_order_data AS u
            JOIN public.orders AS o ON o.id = u.order_id
            WHERE u.valid_order_data_id = vod.id AND o.status = 'processing'
          )
        FOR UPDATE OF vod
      ) INTO v_recyclable_ids;

      DELETE FROM public.used_order_data AS u
      WHERE u.valid_order_data_id = ANY(v_recyclable_ids) AND u.created_at < v_cutoff;
      GET DIAGNOSTICS v_references_deleted = ROW_COUNT;

      UPDATE public.valid_order_data AS vod
      SET is_active = true, deactivated_at = NULL, deactivation_reason = NULL
      WHERE vod.id = ANY(v_recyclable_ids) AND vod.is_active = false
        AND NOT EXISTS (
          SELECT 1 FROM public.used_order_data AS u WHERE u.valid_order_data_id = vod.id
        );
      GET DIAGNOSTICS v_affected = ROW_COUNT;
      IF v_affected <> cardinality(v_recyclable_ids) THEN
        RAISE EXCEPTION 'Valid order data recycle eligibility changed during cleanup.';
      END IF;
    WHEN 'valid_data_audit_log' THEN
      DELETE FROM public.valid_data_audit_log AS l WHERE l.action_timestamp < v_cutoff;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'valid_data_error_log' THEN
      DELETE FROM public.valid_data_error_log AS l
      WHERE l.detected_at < v_cutoff AND l.resolved_at IS NOT NULL;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'dispatch_system_logs' THEN
      DELETE FROM public.dispatch_system_logs AS l WHERE l.created_at < v_cutoff;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'commission_audit_log' THEN
      DELETE FROM public.commission_audit_log AS l WHERE l.created_at < v_cutoff;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'money_data_protection_audit' THEN
      DELETE FROM public.money_data_protection_audit AS l WHERE l.attempted_at < v_cutoff;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'dispatch_performance_metrics' THEN
      DELETE FROM public.dispatch_performance_metrics AS m WHERE m.measured_at < v_cutoff;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'valid_data_query_performance' THEN
      DELETE FROM public.valid_data_query_performance AS m WHERE m.recorded_at < v_cutoff;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'orders_history' THEN
      DELETE FROM public.orders_history AS h WHERE h.created_at < v_cutoff;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'valid_order_data_archive' THEN
      DELETE FROM public.valid_order_data_archive AS h WHERE h.archived_at < v_cutoff;
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    WHEN 'bulk_import_log' THEN
      DELETE FROM public.bulk_import_log AS l
      WHERE l.completed_at < v_cutoff AND l.status IN ('completed', 'failed');
      GET DIAGNOSTICS v_affected = ROW_COUNT;
    ELSE
      RAISE EXCEPTION 'History cleanup not implemented for %', p_table_name;
  END CASE;

  v_size_after := pg_total_relation_size(format('public.%I', p_table_name)::regclass);
  IF p_table_name = 'valid_order_data' THEN
    v_size_after := v_size_after + pg_total_relation_size('public.used_order_data'::regclass);
  END IF;
  v_space_freed := pg_size_pretty(GREATEST(v_size_before - v_size_after, 0));
  v_message := CASE WHEN p_table_name = 'valid_order_data'
    THEN format('Recycled %s valid_order_data records after deleting %s expired usage records',
                v_affected, v_references_deleted)
    ELSE format('Deleted %s records from %s', v_affected, p_table_name)
  END;

  INSERT INTO public.history_cleanup_log (
    table_name, admin_id, records_deleted, space_freed, retention_days,
    status, message, run_source, scheduled_for
  ) VALUES (
    p_table_name, p_admin_id, v_affected, v_space_freed, p_days_to_keep,
    'completed', v_message, p_run_source, p_scheduled_for
  );

  UPDATE public.history_cleanup_config AS cfg
  SET last_cleanup_at = clock_timestamp(),
      last_cleanup_records = v_affected,
      updated_at = clock_timestamp()
  WHERE cfg.id = v_config.id;

  RETURN QUERY SELECT true, v_affected, v_space_freed,
    round(extract(epoch FROM (clock_timestamp() - v_started_at)) * 1000, 2), v_message;
END;
$function$;

REVOKE ALL ON FUNCTION private.run_history_cleanup(text, integer, uuid, text, date)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.admin_get_history_cleanup_schedule(p_admin_session_token uuid)
RETURNS TABLE (
  table_name text,
  days_to_keep integer,
  schedule_time text,
  enabled boolean,
  last_cleanup_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_role text;
BEGIN
  SELECT context.admin_role INTO v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;
  IF v_admin_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can view history cleanup schedules.';
  END IF;

  RETURN QUERY SELECT cfg.table_name, cfg.retention_days,
                      left(cfg.schedule_time_utc::text, 5), cfg.auto_cleanup_enabled,
                      cfg.last_cleanup_at
  FROM public.history_cleanup_config AS cfg
  WHERE private.is_history_cleanup_table(cfg.table_name)
  ORDER BY cfg.cleanup_priority DESC, cfg.table_name;
END;
$function$;

CREATE FUNCTION public.admin_save_history_cleanup_schedule(
  p_admin_session_token uuid,
  p_table_name text,
  p_days_to_keep integer,
  p_schedule_time text,
  p_enabled boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_role text;
  v_min_days integer;
BEGIN
  SELECT context.admin_role INTO v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;
  IF v_admin_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can change history cleanup schedules.';
  END IF;
  IF NOT COALESCE(private.is_history_cleanup_table(p_table_name), false) THEN
    RAISE EXCEPTION 'Unsupported history cleanup table: %', p_table_name;
  END IF;
  IF p_schedule_time IS NULL
     OR p_schedule_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'History cleanup requires a UTC HH:MM time and an enabled flag.';
  END IF;

  SELECT cfg.min_retention_days INTO v_min_days
  FROM public.history_cleanup_config AS cfg WHERE cfg.table_name = p_table_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'History cleanup configuration is missing for %', p_table_name;
  END IF;
  IF p_days_to_keep IS NULL OR p_days_to_keep < v_min_days THEN
    RAISE EXCEPTION 'Retention for % must be at least % days', p_table_name, v_min_days;
  END IF;

  UPDATE public.history_cleanup_config AS cfg
  SET retention_days = p_days_to_keep,
      schedule_time_utc = p_schedule_time::time,
      auto_cleanup_enabled = p_enabled,
      updated_at = clock_timestamp()
  WHERE cfg.table_name = p_table_name;
END;
$function$;

CREATE FUNCTION public.admin_preview_history_cleanup(
  p_admin_session_token uuid,
  p_table_name text
)
RETURNS TABLE (
  table_name text,
  total_records bigint,
  records_to_delete bigint,
  records_to_keep bigint,
  oldest_record timestamptz,
  cutoff_date timestamptz,
  estimated_space text,
  risk_level text,
  retention_days integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_role text;
  v_days integer;
  v_cutoff timestamptz;
  v_total bigint;
  v_to_delete bigint;
  v_oldest timestamptz;
  v_size bigint;
BEGIN
  SELECT context.admin_role INTO v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;
  IF v_admin_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can preview history cleanup.';
  END IF;
  IF NOT COALESCE(private.is_history_cleanup_table(p_table_name), false) THEN
    RAISE EXCEPTION 'Unsupported history cleanup table: %', p_table_name;
  END IF;
  SELECT cfg.retention_days INTO v_days
  FROM public.history_cleanup_config AS cfg
  WHERE cfg.table_name = p_table_name AND cfg.can_cleanup = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'History cleanup is not allowed for %', p_table_name;
  END IF;
  v_cutoff := now() - make_interval(days => v_days);

  CASE p_table_name
    WHEN 'dispatch_assignments' THEN
      SELECT count(*), count(*) FILTER (WHERE a.assigned_at < v_cutoff
                                          AND a.status IN ('completed', 'error', 'timeout', 'cancelled')), min(a.assigned_at)
      INTO v_total, v_to_delete, v_oldest FROM public.dispatch_assignments AS a;
    WHEN 'dispatch_sessions' THEN
      SELECT count(*), count(*) FILTER (WHERE s.started_at < v_cutoff
        AND s.ended_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.dispatch_assignments AS a
          WHERE a.dispatch_session_id = s.id AND a.status IN ('pending', 'accepted')
        )), min(s.started_at)
      INTO v_total, v_to_delete, v_oldest FROM public.dispatch_sessions AS s;
    WHEN 'work_sessions' THEN
      SELECT count(*), count(*) FILTER (WHERE s.start_time < v_cutoff AND s.end_time IS NOT NULL), min(s.start_time)
      INTO v_total, v_to_delete, v_oldest FROM public.work_sessions AS s;
    WHEN 'customer_service_sessions' THEN
      SELECT count(*), count(*) FILTER (WHERE s.created_at < v_cutoff AND s.closed_at IS NOT NULL), min(s.created_at)
      INTO v_total, v_to_delete, v_oldest FROM public.customer_service_sessions AS s;
    WHEN 'used_order_data' THEN
      SELECT count(*), count(*) FILTER (WHERE u.created_at < v_cutoff
        AND NOT EXISTS (
          SELECT 1 FROM public.orders AS o
          WHERE o.id = u.order_id AND o.status = 'processing'
        )), min(u.created_at)
      INTO v_total, v_to_delete, v_oldest FROM public.used_order_data AS u;
    WHEN 'valid_order_data' THEN
      SELECT count(*) FILTER (WHERE vod.is_active = false),
             count(*) FILTER (
               WHERE vod.is_active = false AND vod.deactivation_reason = 'used'
                 AND vod.last_used_at < v_cutoff
                 AND NOT EXISTS (
                   SELECT 1 FROM public.used_order_data AS u
                   WHERE u.valid_order_data_id = vod.id
                     AND (u.created_at IS NULL OR u.created_at >= v_cutoff)
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM public.used_order_data AS u
                   JOIN public.orders AS o ON o.id = u.order_id
                   WHERE u.valid_order_data_id = vod.id AND o.status = 'processing'
                 )
             ),
             min(vod.created_at) FILTER (WHERE vod.is_active = false)
      INTO v_total, v_to_delete, v_oldest FROM public.valid_order_data AS vod;
    WHEN 'valid_data_audit_log' THEN
      SELECT count(*), count(*) FILTER (WHERE l.action_timestamp < v_cutoff), min(l.action_timestamp)
      INTO v_total, v_to_delete, v_oldest FROM public.valid_data_audit_log AS l;
    WHEN 'valid_data_error_log' THEN
      SELECT count(*), count(*) FILTER (WHERE l.detected_at < v_cutoff
                                          AND l.resolved_at IS NOT NULL), min(l.detected_at)
      INTO v_total, v_to_delete, v_oldest FROM public.valid_data_error_log AS l;
    WHEN 'dispatch_system_logs' THEN
      SELECT count(*), count(*) FILTER (WHERE l.created_at < v_cutoff), min(l.created_at)
      INTO v_total, v_to_delete, v_oldest FROM public.dispatch_system_logs AS l;
    WHEN 'commission_audit_log' THEN
      SELECT count(*), count(*) FILTER (WHERE l.created_at < v_cutoff), min(l.created_at)
      INTO v_total, v_to_delete, v_oldest FROM public.commission_audit_log AS l;
    WHEN 'money_data_protection_audit' THEN
      SELECT count(*), count(*) FILTER (WHERE l.attempted_at < v_cutoff), min(l.attempted_at)
      INTO v_total, v_to_delete, v_oldest FROM public.money_data_protection_audit AS l;
    WHEN 'dispatch_performance_metrics' THEN
      SELECT count(*), count(*) FILTER (WHERE m.measured_at < v_cutoff), min(m.measured_at)
      INTO v_total, v_to_delete, v_oldest FROM public.dispatch_performance_metrics AS m;
    WHEN 'valid_data_query_performance' THEN
      SELECT count(*), count(*) FILTER (WHERE m.recorded_at < v_cutoff), min(m.recorded_at)
      INTO v_total, v_to_delete, v_oldest FROM public.valid_data_query_performance AS m;
    WHEN 'orders_history' THEN
      SELECT count(*), count(*) FILTER (WHERE h.created_at < v_cutoff), min(h.created_at)
      INTO v_total, v_to_delete, v_oldest FROM public.orders_history AS h;
    WHEN 'valid_order_data_archive' THEN
      SELECT count(*), count(*) FILTER (WHERE h.archived_at < v_cutoff), min(h.archived_at)
      INTO v_total, v_to_delete, v_oldest FROM public.valid_order_data_archive AS h;
    WHEN 'bulk_import_log' THEN
      SELECT count(*), count(*) FILTER (WHERE l.completed_at < v_cutoff
                                          AND l.status IN ('completed', 'failed')), min(l.completed_at)
      INTO v_total, v_to_delete, v_oldest FROM public.bulk_import_log AS l;
    ELSE
      RAISE EXCEPTION 'History cleanup not implemented for %', p_table_name;
  END CASE;

  v_size := pg_total_relation_size(format('public.%I', p_table_name)::regclass);
  IF p_table_name = 'valid_order_data' THEN
    v_size := v_size + pg_total_relation_size('public.used_order_data'::regclass);
  END IF;
  RETURN QUERY SELECT p_table_name, v_total, v_to_delete, v_total - v_to_delete,
    v_oldest, v_cutoff,
    pg_size_pretty((v_size::numeric * v_to_delete / greatest(v_total, 1))::bigint),
    CASE WHEN v_to_delete = 0 THEN 'safe'
         WHEN v_to_delete::numeric / greatest(v_total, 1) > 0.8 THEN 'warning'
         ELSE 'safe' END,
    v_days;
END;
$function$;

CREATE FUNCTION public.admin_execute_history_cleanup(
  p_admin_session_token uuid,
  p_table_name text,
  p_expected_retention_days integer
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
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_days integer;
  v_error text;
  v_started_at timestamptz := clock_timestamp();
BEGIN
  SELECT context.admin_id, context.admin_role INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;
  IF v_admin_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can execute history cleanup.';
  END IF;
  IF NOT COALESCE(private.is_history_cleanup_table(p_table_name), false) THEN
    RAISE EXCEPTION 'Unsupported history cleanup table: %', p_table_name;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('history_cleanup'), hashtext(p_table_name));
  SELECT cfg.retention_days INTO v_days
  FROM public.history_cleanup_config AS cfg
  WHERE cfg.table_name = p_table_name AND cfg.can_cleanup = true
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'History cleanup is not allowed for %', p_table_name;
  END IF;
  IF p_expected_retention_days IS DISTINCT FROM v_days THEN
    RAISE EXCEPTION 'History cleanup retention changed; preview again before executing.';
  END IF;

  BEGIN
    RETURN QUERY SELECT result.success, result.records_deleted, result.space_freed,
                        result.execution_time_ms, result.message
    FROM private.run_history_cleanup(p_table_name, v_days, v_admin_id, 'manual', NULL) AS result;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    INSERT INTO public.history_cleanup_log (
      table_name, admin_id, records_deleted, retention_days, status,
      message, error_details, run_source
    ) VALUES (
      p_table_name, v_admin_id, 0, v_days, 'failed',
      'Manual history cleanup failed', left(v_error, 4000), 'manual'
    );
    RETURN QUERY SELECT false, 0::bigint, '0 bytes'::text,
      round(extract(epoch FROM (clock_timestamp() - v_started_at)) * 1000, 2),
      'Manual history cleanup failed'::text;
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_get_history_cleanup_schedule(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_save_history_cleanup_schedule(uuid, text, integer, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_preview_history_cleanup(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_execute_history_cleanup(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_get_history_cleanup_schedule(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_history_cleanup_schedule(uuid, text, integer, text, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_preview_history_cleanup(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_execute_history_cleanup(uuid, text, integer) TO anon, authenticated;

-- Keep this small aggregate readable through the invoker-security summary view.
CREATE FUNCTION public.history_cleanup_completed_today(p_table_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  IF NOT COALESCE(private.is_history_cleanup_table(p_table_name), false) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.history_cleanup_log AS log
    WHERE log.table_name = p_table_name AND log.run_source = 'automatic'
      AND log.status = 'completed'
      AND log.scheduled_for = (now() AT TIME ZONE 'UTC')::date
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.history_cleanup_completed_today(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.history_cleanup_completed_today(text) TO anon, authenticated;

CREATE FUNCTION public.auto_cleanup_due_history_data()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_table record;
  v_today date;
  v_utc_time time;
  v_days integer;
  v_success boolean;
  v_error text;
BEGIN
  v_today := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  v_utc_time := (clock_timestamp() AT TIME ZONE 'UTC')::time;
  SELECT cfg.table_name INTO v_table
  FROM public.history_cleanup_config AS cfg
  WHERE cfg.can_cleanup = true AND cfg.auto_cleanup_enabled = true
    AND cfg.schedule_time_utc <= v_utc_time
    AND private.is_history_cleanup_table(cfg.table_name)
    AND NOT EXISTS (
      SELECT 1 FROM public.history_cleanup_log AS log
      WHERE log.table_name = cfg.table_name AND log.run_source = 'automatic'
        AND log.scheduled_for = v_today AND log.status = 'completed'
    )
    AND (
      SELECT count(*) FROM public.history_cleanup_log AS log
      WHERE log.table_name = cfg.table_name AND log.run_source = 'automatic'
        AND log.scheduled_for = v_today AND log.status = 'failed'
    ) < 3
  ORDER BY cfg.schedule_time_utc, cfg.table_name
  LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('history_cleanup'), hashtext(v_table.table_name)) THEN
    RETURN;
  END IF;

  SELECT cfg.retention_days INTO v_days
  FROM public.history_cleanup_config AS cfg
  WHERE cfg.table_name = v_table.table_name AND cfg.can_cleanup = true
    AND cfg.auto_cleanup_enabled = true AND cfg.schedule_time_utc <= v_utc_time
  FOR UPDATE;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM public.history_cleanup_log AS log
    WHERE log.table_name = v_table.table_name AND log.run_source = 'automatic'
      AND log.scheduled_for = v_today AND log.status = 'completed'
  ) OR (
    SELECT count(*) FROM public.history_cleanup_log AS log
    WHERE log.table_name = v_table.table_name AND log.run_source = 'automatic'
      AND log.scheduled_for = v_today AND log.status = 'failed'
  ) >= 3 THEN
    RETURN;
  END IF;

  BEGIN
    SELECT result.success INTO v_success
    FROM private.run_history_cleanup(v_table.table_name, v_days, NULL, 'automatic', v_today) AS result;
    IF v_success IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'History cleanup did not complete for %', v_table.table_name;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;

  IF v_error IS NOT NULL THEN
    INSERT INTO public.history_cleanup_log (
      table_name, admin_id, records_deleted, space_freed, retention_days,
      status, message, error_details, run_source, scheduled_for
    ) VALUES (
      v_table.table_name, NULL, 0, '0 bytes', v_days,
      'failed', 'Automatic history cleanup failed', left(v_error, 4000), 'automatic', v_today
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_cleanup_due_history_data() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auto_cleanup_all_tables() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_cleanup(text, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_cleanup(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.preview_cleanup(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_used_order_data(integer, uuid) FROM PUBLIC, anon, authenticated;

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
    WHEN cfg.schedule_time_utc <= (now() AT TIME ZONE 'UTC')::time
         AND NOT public.history_cleanup_completed_today(cfg.table_name) THEN 'due'
    ELSE 'up_to_date'
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

GRANT SELECT ON public.history_cleanup_summary TO anon, authenticated;

DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(job.jobid)
    FROM cron.job AS job
    WHERE job.jobname IN ('daily_auto_cleanup_history_data', 'auto_cleanup_due_history_data_every_minute');

    PERFORM cron.schedule(
      'auto_cleanup_due_history_data_every_minute',
      '* * * * *',
      $command$SELECT public.auto_cleanup_due_history_data();$command$
    );
  ELSE
    RAISE NOTICE 'pg_cron not installed: history cleanup scheduler was not installed';
  END IF;
END;
$block$;

NOTIFY pgrst, 'reload schema';
