BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE TABLE private.employee_transfer_maintenance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  job_id uuid NOT NULL REFERENCES private.employee_transfer_jobs(id),
  admin_id uuid NOT NULL,
  plan_hash text NOT NULL,
  target_hash text NOT NULL,
  entered_at timestamptz NOT NULL,
  dirty boolean NOT NULL DEFAULT false
);
CREATE TABLE private.employee_transfer_write_permits (
  transaction_id xid8 PRIMARY KEY,
  job_id uuid NOT NULL,
  table_names text[] NOT NULL
);
ALTER TABLE private.employee_transfer_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.employee_transfer_write_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.employee_transfer_maintenance, private.employee_transfer_write_permits
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.employee_transfer_guarded_tables()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT ARRAY[
    'private.content_audit_delete_jobs',
    'private.content_audit_events',
    'private.content_audit_public_media_claims',
    'private.content_audit_purge_windows',
    'private.content_audit_recipient_versions',
    'private.content_audit_storage_origins',
    'private.deleted_employee_accounts',
    'private.deleted_employee_delete_jobs',
    'private.deleted_employee_notifications',
    'private.employee_chat_image_deletion_claims',
    'private.employee_work_stop_markers',
    'private.notification_delivery_operations',
    'public.admin_configs',
    'public.admin_group_members',
    'public.admin_groups',
    'public.admins',
    'public.announcement_categories',
    'public.announcements',
    'public.broadcast_messages',
    'public.broadcast_recipients',
    'public.bulk_import_log',
    'public.ccc_conversation_annotations',
    'public.commission_audit_log',
    'public.cs_message_templates',
    'public.customer_auto_message_logs',
    'public.customer_auto_messages',
    'public.customer_employee_conversations',
    'public.customer_service_sessions',
    'public.data_retention_policies',
    'public.dispatch_assignments',
    'public.dispatch_config',
    'public.dispatch_group_members',
    'public.dispatch_group_orders',
    'public.dispatch_groups',
    'public.dispatch_order_pools',
    'public.dispatch_orders',
    'public.dispatch_performance_metrics',
    'public.dispatch_pool_selections',
    'public.dispatch_rate_limits',
    'public.dispatch_sessions',
    'public.dispatch_system_logs',
    'public.employee_financial_sessions',
    'public.employee_login_history',
    'public.employee_login_history_events',
    'public.employee_presence_events',
    'public.employee_submit_time_settings',
    'public.financial_admin_credentials',
    'public.financial_employee_credentials',
    'public.financial_operations',
    'public.group_configs',
    'public.history_cleanup_config',
    'public.history_cleanup_log',
    'public.message_recipients',
    'public.message_templates',
    'public.messages',
    'public.money_data_protection_audit',
    'public.notification_automation_date_runs',
    'public.notification_automation_executions',
    'public.notification_automation_failures',
    'public.notification_automation_plan_members',
    'public.notification_automation_plans',
    'public.notification_automation_progress',
    'public.notification_automation_queue',
    'public.notification_automation_task_recipients',
    'public.notification_automation_tasks',
    'public.orders',
    'public.orders_history',
    'public.orders_history_2025',
    'public.orders_history_2026',
    'public.product_types',
    'public.rating_requests',
    'public.rich_card_contents',
    'public.service_ratings',
    'public.simulated_customers',
    'public.submit_time_groups',
    'public.system_configs',
    'public.used_order_data',
    'public.users',
    'public.valid_data_audit_log',
    'public.valid_data_error_log',
    'public.valid_data_monthly_stats',
    'public.valid_data_query_performance',
    'public.valid_order_data',
    'public.valid_order_data_archive',
    'public.verification_requests',
    'public.wallet_balance_baselines',
    'public.wallet_ledger_entries',
    'public.wallet_reconciliation_audit',
    'public.wallet_reconciliation_queue',
    'public.wallet_transactions',
    'public.wallets',
    'public.withdrawal_events',
    'public.withdrawals',
    'public.work_sessions'
  ]::text[];
$$;

DO $install_guarded_tables$
DECLARE v_definition text;
  v_entry constant text := E'    ''public.notification_automation_date_runs'',\n';
BEGIN
  -- Freeze the reviewed absent-table capability before guard identities are pinned.
  IF to_regclass('public.notification_automation_date_runs') IS NULL THEN
    v_definition := pg_get_functiondef('private.employee_transfer_guarded_tables()'::regprocedure);
    IF (length(v_definition)-length(replace(v_definition,v_entry,'')))/length(v_entry) <> 1 THEN
      RAISE EXCEPTION 'Optional automation guard inventory anchor changed.';
    END IF;
    EXECUTE replace(v_definition,v_entry,'');
  END IF;
END;
$install_guarded_tables$;

CREATE FUNCTION private.employee_transfer_guard_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job uuid;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance', 0));
  -- Older transaction snapshots can miss newly committed maintenance.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Business writes are paused for employee transfer maintenance.' USING ERRCODE = '55000';
  END IF;
  SELECT job_id INTO v_job FROM private.employee_transfer_maintenance WHERE singleton;
  IF v_job IS NOT NULL AND (TG_OP = 'TRUNCATE' OR NOT EXISTS (
    SELECT 1 FROM private.employee_transfer_write_permits
    WHERE transaction_id = pg_current_xact_id() AND job_id = v_job
      AND (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME) = ANY(table_names)
  )) THEN
    RAISE EXCEPTION 'Business writes are paused for employee transfer maintenance.' USING ERRCODE = '55000';
  END IF;
  IF v_job IS NOT NULL AND TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='dispatch_assignments'
    AND (TG_OP<>'UPDATE' OR EXISTS(SELECT 1 FROM public.dispatch_assignments)) THEN
    RAISE EXCEPTION 'Business writes are paused for employee transfer maintenance.' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION private.employee_transfer_lock_maintenance_tables()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table text;
BEGIN
  -- Relation locks precede the advisory lock to avoid waiting on an already-blocked writer.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Employee transfer maintenance requires read committed isolation.';
  END IF;
  FOR v_table IN SELECT name FROM unnest(private.employee_transfer_guarded_tables()) AS item(name)
    ORDER BY name COLLATE "C" LOOP
    EXECUTE format('LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE', split_part(v_table,'.',1), split_part(v_table,'.',2));
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended('employee-transfer-maintenance', 0));
END;
$$;

CREATE FUNCTION private.employee_transfer_allow_config_write(p_job_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job uuid;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance', 0));
  SELECT job.id INTO v_job FROM private.employee_transfer_jobs AS job
    JOIN private.employee_transfer_maintenance AS maintenance ON maintenance.job_id = job.id
      AND maintenance.admin_id = job.admin_id AND maintenance.plan_hash = job.summary->>'dispatch_plan_hash'
    WHERE job.id = p_job_id AND job.kind = 'import' AND job.status = 'running'
      AND job.options->>'import_protocol' = 'dispatch-submission-v1'
      AND job.last_activity_at > now()-interval '3 hours' AND job.started_at > now()-interval '12 hours'
    FOR UPDATE OF job, maintenance;
  IF v_job IS NULL THEN RAISE EXCEPTION 'A running maintenance owner task is required.'; END IF;
  INSERT INTO private.employee_transfer_write_permits(transaction_id, job_id, table_names)
    VALUES(pg_current_xact_id(), v_job, ARRAY['public.dispatch_config','public.dispatch_groups',
      'public.dispatch_order_pools','public.dispatch_group_orders','public.dispatch_group_members','public.dispatch_assignments']);
  UPDATE private.employee_transfer_maintenance SET dirty = true WHERE singleton AND job_id = v_job;
END;
$$;

CREATE FUNCTION private.employee_transfer_clear_write_permit()
RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  DELETE FROM private.employee_transfer_write_permits WHERE transaction_id = pg_current_xact_id();
$$;

DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY private.employee_transfer_guarded_tables() LOOP
    EXECUTE format('CREATE TRIGGER zz_employee_transfer_maintenance BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()',
      split_part(v_table,'.',1), split_part(v_table,'.',2));
    EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance',
      split_part(v_table,'.',1), split_part(v_table,'.',2));
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_guarded_tables(), private.employee_transfer_guard_write(),
  private.employee_transfer_lock_maintenance_tables(), private.employee_transfer_allow_config_write(uuid),
  private.employee_transfer_clear_write_permit() FROM PUBLIC, anon, authenticated, service_role;

-- Pin installed identities and definitions in literals, not caller-writable state.
DO $install_assert$
DECLARE v_manifest jsonb; v_functions jsonb;
BEGIN
  SELECT jsonb_object_agg(name, jsonb_build_object('oid', relation.oid, 'owner', relation.relowner,
    'kind', relation.relkind, 'partition', relation.relispartition,
    'parents', (SELECT COALESCE(jsonb_agg(inhparent ORDER BY inhparent),'[]') FROM pg_inherits WHERE inhrelid = relation.oid),
    'definition', pg_get_triggerdef(trigger.oid, false))) INTO v_manifest
    FROM unnest(private.employee_transfer_guarded_tables()) AS item(name)
    JOIN pg_class AS relation ON relation.oid = to_regclass(name)
    JOIN pg_trigger AS trigger ON trigger.tgrelid = relation.oid AND trigger.tgname = 'zz_employee_transfer_maintenance';
  SELECT jsonb_object_agg(procedure.oid::regprocedure::text, jsonb_build_object(
    'oid', procedure.oid, 'definition', pg_get_functiondef(procedure.oid), 'owner', procedure.proowner,
    'acl', procedure.proacl::text, 'super', role.rolsuper, 'bypassrls', role.rolbypassrls)) INTO v_functions
    FROM pg_proc AS procedure JOIN pg_roles AS role ON role.oid = procedure.proowner
    WHERE procedure.oid = ANY(ARRAY['private.employee_transfer_guarded_tables()'::regprocedure,
      'private.employee_transfer_guard_write()'::regprocedure,'private.employee_transfer_lock_maintenance_tables()'::regprocedure,
      'private.employee_transfer_allow_config_write(uuid)'::regprocedure,'private.employee_transfer_clear_write_permit()'::regprocedure]::oid[]);
  EXECUTE format($definition$
CREATE FUNCTION private.employee_transfer_assert_maintenance_guards()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $body$
DECLARE v_tables constant jsonb := %L::jsonb; v_functions constant jsonb := %L::jsonb;
  v_actual text[]; v_item record; v_metadata jsonb; v_function jsonb;
BEGIN
  -- Explicit reviewed exclusions; a new table (even named employee_transfer_*) is rejected.
  SELECT array_agg(namespace.nspname||'.'||relation.relname ORDER BY (namespace.nspname||'.'||relation.relname) COLLATE "C")
    INTO v_actual FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public','private') AND relation.relkind IN ('r','p','f')
      AND (namespace.nspname||'.'||relation.relname) <> ALL(ARRAY[
        'private.employee_transfer_events','private.employee_transfer_excluded_columns','private.employee_transfer_jobs',
        'private.employee_transfer_shared_backups','private.employee_transfer_site','private.employee_transfer_staging',
        'private.employee_transfer_trigger_policy','private.employee_transfer_maintenance','private.employee_transfer_write_permits',
        'public.admin_financial_sessions','public.financial_login_attempts','public.account_locks','public.account_lock_events','public.login_attempts']);
  IF v_actual IS DISTINCT FROM ARRAY(SELECT key FROM jsonb_each(v_tables) ORDER BY key COLLATE "C") THEN
    RAISE EXCEPTION 'Unreviewed employee transfer maintenance inventory or guards.';
  END IF;
  FOR v_item IN SELECT key, value FROM jsonb_each(v_functions) LOOP
    SELECT jsonb_build_object('oid', procedure.oid, 'definition', pg_get_functiondef(procedure.oid),
      'owner', procedure.proowner, 'acl', procedure.proacl::text, 'super', role.rolsuper, 'bypassrls', role.rolbypassrls)
      INTO v_function FROM pg_proc AS procedure JOIN pg_roles AS role ON role.oid = procedure.proowner
      WHERE procedure.oid = to_regprocedure(v_item.key);
    IF v_function IS DISTINCT FROM v_item.value THEN
      RAISE EXCEPTION 'Unreviewed employee transfer maintenance inventory or guards.';
    END IF;
  END LOOP;
  FOR v_item IN SELECT key, value FROM jsonb_each(v_tables) LOOP
    SELECT jsonb_build_object('oid', relation.oid, 'owner', relation.relowner, 'kind', relation.relkind,
      'partition', relation.relispartition,
      'parents', (SELECT COALESCE(jsonb_agg(inhparent ORDER BY inhparent),'[]') FROM pg_inherits WHERE inhrelid = relation.oid),
      'definition', pg_get_triggerdef(trigger.oid, false)) INTO v_metadata
      FROM pg_class AS relation JOIN pg_trigger AS trigger ON trigger.tgrelid = relation.oid
      WHERE relation.oid = to_regclass(v_item.key) AND NOT trigger.tgisinternal
        AND trigger.tgname = 'zz_employee_transfer_maintenance' AND trigger.tgenabled = 'A'
        AND trigger.tgfoid = 'private.employee_transfer_guard_write()'::regprocedure AND trigger.tgtype = 62;
    IF v_metadata IS DISTINCT FROM v_item.value THEN
      RAISE EXCEPTION 'Unreviewed employee transfer maintenance inventory or guards.';
    END IF;
  END LOOP;
END;
$body$;
$definition$, v_manifest::text, v_functions::text);
END;
$install_assert$;
REVOKE ALL ON FUNCTION private.employee_transfer_assert_maintenance_guards() FROM PUBLIC, anon, authenticated, service_role;
SELECT private.employee_transfer_assert_maintenance_guards();

CREATE FUNCTION public.employee_import_dispatch_enter_maintenance(
  p_admin_session_token uuid, p_job_token uuid, p_plan_hash text, p_confirmation text, p_admin_password text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout = '2s' AS $$
DECLARE v_admin uuid; v_username text; v_check jsonb; v_job private.employee_transfer_jobs%ROWTYPE;
  v_backup private.employee_transfer_shared_backups%ROWTYPE; v_maintenance private.employee_transfer_maintenance%ROWTYPE;
  v_target_hash text;
BEGIN
  SELECT admin.admin_id, admin.admin_username INTO v_admin, v_username FROM private.employee_transfer_admin(p_admin_session_token) AS admin;
  IF p_confirmation IS DISTINCT FROM '確認暫停業務並導入派單資料' THEN RAISE EXCEPTION 'The maintenance confirmation does not match.'; END IF;
  v_check := private.employee_transfer_verify_password(v_admin, v_username, p_admin_password);
  IF NOT COALESCE((v_check->>'success')::boolean,false) THEN RETURN v_check; END IF;
  PERFORM private.employee_transfer_lock_maintenance_tables();
  PERFORM private.employee_transfer_assert_maintenance_guards();
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'dispatch-import');
  IF p_plan_hash IS NULL OR p_plan_hash !~ '^[0-9a-f]{64}$'
    OR p_plan_hash IS DISTINCT FROM v_job.summary->>'dispatch_plan_hash' THEN
    RAISE EXCEPTION 'A confirmed dispatch preparation plan is required.';
  END IF;
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id = v_job.id AND admin_id = v_admin
    AND plan_hash = p_plan_hash AND sealed_at IS NOT NULL AND sealed_sha256 IS NOT NULL AND catalog->>'scope' = 'dispatch-submission';
  IF v_backup.id IS NULL THEN RAISE EXCEPTION 'A saved and sealed dispatch backup is required.'; END IF;
  SELECT * INTO v_maintenance FROM private.employee_transfer_maintenance WHERE singleton;
  IF v_maintenance.singleton IS NOT NULL AND (v_maintenance.job_id IS DISTINCT FROM v_job.id
    OR v_maintenance.admin_id IS DISTINCT FROM v_admin OR v_maintenance.plan_hash IS DISTINCT FROM p_plan_hash
    OR v_maintenance.target_hash IS DISTINCT FROM v_backup.target_hash OR v_maintenance.dirty) THEN
    RAISE EXCEPTION 'Employee transfer maintenance cannot be entered for this task or state.';
  END IF;
  v_target_hash := encode(extensions.digest(convert_to(private.employee_transfer_dispatch_target(p_admin_session_token)::text,'UTF8'),'sha256'),'hex');
  IF v_target_hash IS DISTINCT FROM v_backup.target_hash THEN RAISE EXCEPTION 'Dispatch target changed after backup preparation; restart the task.'; END IF;
  IF v_maintenance.singleton IS NULL THEN
    INSERT INTO private.employee_transfer_maintenance(singleton,job_id,admin_id,plan_hash,target_hash,entered_at)
      VALUES(true,v_job.id,v_admin,p_plan_hash,v_target_hash,clock_timestamp());
  END IF;
  RETURN jsonb_build_object('success',true,'maintenance',true,'dirty',false,
    'repeated',v_maintenance.singleton IS NOT NULL,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_transfer_maintenance(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_maintenance private.employee_transfer_maintenance%ROWTYPE;
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  SELECT * INTO v_maintenance FROM private.employee_transfer_maintenance WHERE singleton;
  RETURN jsonb_build_object('active',v_maintenance.singleton IS NOT NULL,'job_id',v_maintenance.job_id,
    'dirty',COALESCE(v_maintenance.dirty,false),'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_transfer_leave_maintenance(
  p_admin_session_token uuid, p_job_id uuid, p_admin_password text, p_confirmation text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout = '2s' AS $$
DECLARE v_admin uuid; v_username text; v_check jsonb; v_maintenance private.employee_transfer_maintenance%ROWTYPE; v_target_hash text;
BEGIN
  SELECT admin.admin_id, admin.admin_username INTO v_admin, v_username FROM private.employee_transfer_admin(p_admin_session_token) AS admin;
  IF p_confirmation IS DISTINCT FROM '確認取消尚未寫入的遷移' THEN RAISE EXCEPTION 'The maintenance cancellation confirmation does not match.'; END IF;
  v_check := private.employee_transfer_verify_password(v_admin, v_username, p_admin_password);
  IF NOT COALESCE((v_check->>'success')::boolean,false) THEN RETURN v_check; END IF;
  PERFORM private.employee_transfer_lock_maintenance_tables();
  PERFORM private.employee_transfer_assert_maintenance_guards();
  SELECT * INTO v_maintenance FROM private.employee_transfer_maintenance WHERE singleton;
  IF v_maintenance.job_id IS DISTINCT FROM p_job_id OR p_job_id IS NULL OR v_maintenance.admin_id IS DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'Only the original maintenance owner may cancel this maintenance.';
  END IF;
  IF v_maintenance.dirty THEN RAISE EXCEPTION 'Maintenance contains committed writes and cannot be cancelled.'; END IF;
  v_target_hash := encode(extensions.digest(convert_to(private.employee_transfer_dispatch_target(p_admin_session_token)::text,'UTF8'),'sha256'),'hex');
  IF v_target_hash IS DISTINCT FROM v_maintenance.target_hash THEN RAISE EXCEPTION 'The maintenance target changed; cancellation is blocked.'; END IF;
  DELETE FROM private.employee_transfer_maintenance WHERE singleton;
  -- A fresh owner login can recover clean maintenance after task expiry.
  RETURN jsonb_build_object('success',true,'maintenance',false,'full_site_complete',false);
END;
$$;

DO $compatibility$
DECLARE v_name text; v_definition text; v_anchor text; v_replacement text;
BEGIN
  v_definition := pg_get_functiondef('private.employee_transfer_fixed_trigger_policy()'::regprocedure);
  v_anchor := '  ) AS policy(table_name, trigger_name, action);';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'The fixed trigger policy compatibility anchor changed.';
  END IF;
  v_replacement := E'  ) AS policy(table_name, trigger_name, action)\n  UNION ALL\n  SELECT split_part(name,\'.\',2),\'zz_employee_transfer_maintenance\',\'keep\'\n  FROM unnest(private.employee_transfer_guarded_tables()) AS item(name)\n  WHERE split_part(name,\'.\',1)=\'public\' AND split_part(name,\'.\',2)=ANY(private.employee_transfer_trigger_tables());';
  EXECUTE replace(v_definition,v_anchor,v_replacement);
  FOREACH v_name IN ARRAY ARRAY['employee_transfer_assert_shared_insert_triggers',
    'employee_transfer_assert_shared_replace_triggers','employee_transfer_assert_product_triggers'] LOOP
    v_definition := pg_get_functiondef(to_regprocedure('private.'||v_name||'()'));
    v_anchor := E'BEGIN\n';
    IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1 THEN
      RAISE EXCEPTION 'The trigger assertion entry anchor changed.';
    END IF;
    v_definition := replace(v_definition,v_anchor,v_anchor||E'  PERFORM private.employee_transfer_assert_maintenance_guards();\n');
    v_anchor := 'NOT trigger.tgisinternal';
    IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1 THEN
      RAISE EXCEPTION 'The trigger assertion filter anchor changed.';
    END IF;
    EXECUTE replace(v_definition,v_anchor,v_anchor||' AND trigger.tgname <> ''zz_employee_transfer_maintenance''');
  END LOOP;
END;
$compatibility$;

REVOKE ALL ON FUNCTION public.employee_import_dispatch_enter_maintenance(uuid,uuid,text,text,text),
  public.get_employee_transfer_maintenance(uuid), public.employee_transfer_leave_maintenance(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_dispatch_enter_maintenance(uuid,uuid,text,text,text),
  public.get_employee_transfer_maintenance(uuid), public.employee_transfer_leave_maintenance(uuid,uuid,text,text)
  TO anon, authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
