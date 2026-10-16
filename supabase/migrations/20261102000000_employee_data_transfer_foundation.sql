/*
  Employee data export / import (super administrator "資料遷移" page).

  Purely additive: new private tables and new functions only. No existing table, function,
  trigger or policy is changed.

  Rollback (everything below can be removed without touching other data):
    DROP FUNCTION IF EXISTS public.employee_export_begin(uuid, text, jsonb);
    ... every public.*employee_(export|import|transfer)* function listed at the end of this file ...
    DROP SCHEMA-level objects: private.employee_transfer_* tables and functions.
  The matching DROP statements are kept in docs/employee-data-transfer.md.
*/

-- ============================================================================
-- 1. Private tables
-- ============================================================================

CREATE TABLE private.employee_transfer_site (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  site_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO private.employee_transfer_site DEFAULT VALUES;

CREATE TABLE private.employee_transfer_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('export', 'import')),
  admin_id uuid NOT NULL,
  admin_username text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'finished', 'failed', 'cancelled', 'abandoned')),
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  admin_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  group_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  role_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_admin_id uuid,
  placeholder_product_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  summary jsonb,
  error text
);
CREATE UNIQUE INDEX employee_transfer_single_running_job
  ON private.employee_transfer_jobs (status) WHERE status = 'running';
CREATE INDEX employee_transfer_jobs_started_idx ON private.employee_transfer_jobs (started_at DESC);

CREATE TABLE private.employee_transfer_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  admin_id uuid,
  admin_username text,
  kind text,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX employee_transfer_events_occurred_idx ON private.employee_transfer_events (occurred_at DESC, id DESC);

CREATE TABLE private.employee_transfer_staging (
  job_id uuid NOT NULL REFERENCES private.employee_transfer_jobs(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  table_key text NOT NULL,
  chunk_no integer NOT NULL CHECK (chunk_no >= 0),
  row_count integer NOT NULL CHECK (row_count >= 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, employee_id, table_key, chunk_no)
);

CREATE TABLE private.employee_transfer_excluded_columns (
  table_name text NOT NULL,
  column_name text NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (table_name, column_name)
);

CREATE TABLE private.employee_transfer_trigger_policy (
  table_name text NOT NULL,
  trigger_name text NOT NULL,
  action text NOT NULL CHECK (action IN ('bypass', 'keep')),
  reason text NOT NULL,
  PRIMARY KEY (table_name, trigger_name)
);

CREATE FUNCTION private.employee_transfer_guard_events()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Employee transfer audit events are append-only.';
END;
$$;
CREATE TRIGGER employee_transfer_events_append_only
BEFORE UPDATE OR DELETE ON private.employee_transfer_events
FOR EACH ROW EXECUTE FUNCTION private.employee_transfer_guard_events();

ALTER TABLE private.employee_transfer_site ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.employee_transfer_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.employee_transfer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.employee_transfer_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.employee_transfer_excluded_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.employee_transfer_trigger_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.employee_transfer_site, private.employee_transfer_jobs,
  private.employee_transfer_events, private.employee_transfer_staging,
  private.employee_transfer_excluded_columns, private.employee_transfer_trigger_policy
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_guard_events() FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2. Reviewed lists: tables, columns that are never exported, trigger policy
-- ============================================================================

CREATE FUNCTION private.employee_transfer_tables()
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY[
    'users', 'financial_employee_credentials', 'wallets', 'wallet_balance_baselines',
    'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit',
    'orders', 'product_types', 'dispatch_group_members', 'verification_requests',
    'employee_login_history', 'work_sessions', 'messages', 'message_recipients',
    'customer_employee_conversations', 'customer_service_sessions', 'ccc_conversation_annotations',
    'customer_auto_message_logs', 'simulated_customers', 'rich_card_contents'
  ]::text[];
$$;

INSERT INTO private.employee_transfer_excluded_columns (table_name, column_name, reason) VALUES
  ('users', 'current_session_token', 'Login sessions are never transferred.'),
  ('users', 'session_created_at', 'Login sessions are never transferred.'),
  ('users', 'last_heartbeat_at', 'Login sessions are never transferred.'),
  ('users', 'current_tab_id', 'Login sessions are never transferred.'),
  ('users', 'archived_at', 'Archived employees are never exported.'),
  ('orders', 'username', 'Rewritten from the imported employee.'),
  ('orders', 'product_type_id', 'Replaced by the disabled placeholder product.'),
  ('orders', 'product_value', 'Order amounts are not transferred.'),
  ('orders', 'order_number', 'Order numbers are not transferred.'),
  ('orders', 'transaction_id', 'Transaction ids are not transferred.'),
  ('orders', 'scheduled_process_at', 'Only completed orders are transferred.'),
  ('orders', 'assignment_id', 'Dispatch records are not transferred.'),
  ('orders', 'dispatch_commission_rate_snapshot', 'Dispatch records are not transferred.'),
  ('orders', 'dispatch_success_rate_snapshot', 'Dispatch records are not transferred.'),
  ('messages', 'automation_execution_id', 'Automation executions are not transferred.'),
  ('message_recipients', 'delivery_claim_token', 'Transient delivery claim.'),
  ('message_recipients', 'delivery_claim_channel', 'Transient delivery claim.'),
  ('message_recipients', 'delivery_claim_until', 'Transient delivery claim.'),
  ('message_recipients', 'delivery_completed_claim_token', 'Transient delivery claim.'),
  ('message_recipients', 'delivery_sequence', 'Generated by the target database.'),
  ('customer_employee_conversations', 'rich_card_content_id', 'Replaced by a content hash.'),
  ('customer_employee_conversations', 'source_template_id', 'Templates are shared configuration.'),
  ('customer_employee_conversations', 'source_auto_message_id', 'Auto messages are shared configuration.'),
  ('customer_employee_conversations', 'content_frozen', 'Set by the rich-card freeze trigger.'),
  ('rich_card_contents', 'id', 'Matched by content hash.'),
  ('rich_card_contents', 'source_template_id', 'Templates are shared configuration.'),
  ('rich_card_contents', 'source_auto_message_id', 'Auto messages are shared configuration.'),
  ('wallet_ledger_entries', 'id', 'Renumbered by the target sequence.'),
  ('wallet_reconciliation_audit', 'id', 'Renumbered by the target sequence.');

-- Every trigger that exists on a table touched by an import must be listed here. An unlisted
-- trigger makes the import refuse to run (a new side effect has not been reviewed yet).
INSERT INTO private.employee_transfer_trigger_policy (table_name, trigger_name, action, reason) VALUES
  ('users', 'archive_employee_before_delete', 'keep', 'Delete guard.'),
  ('users', 'cleanup_user_data_trigger', 'keep', 'Delete-time cleanup.'),
  ('users', 'cleanup_user_storage_trigger', 'keep', 'Delete-time cleanup.'),
  ('users', 'create_wallet_trigger', 'keep', 'Creates the wallet row that the import then overwrites.'),
  ('users', 'guard_employee_archive', 'keep', 'Archive guard.'),
  ('users', 'trigger_cleanup_user_data', 'keep', 'Delete-time cleanup.'),
  ('wallets', 'prevent_delete_wallets', 'keep', 'Delete guard.'),
  ('wallets', 'trigger_enqueue_changed_wallet', 'bypass', 'Would create a baseline and queue reconciliation.'),
  ('wallet_transactions', 'prevent_delete_wallet_transactions', 'keep', 'Delete guard.'),
  ('wallet_transactions', 'queue_notification_automation_from_wallet_transaction', 'bypass', 'Would queue notification automation.'),
  ('wallet_transactions', 'trigger_audit_commission_transaction', 'bypass', 'Rejects commissions without a successful order.'),
  ('wallet_transactions', 'trigger_reverse_deleted_wallet_transaction_ledger', 'keep', 'Delete-time ledger reversal.'),
  ('wallet_transactions', 'trigger_track_wallet_transaction_ledger', 'bypass', 'Would write duplicate ledger entries.'),
  ('withdrawals', 'prevent_delete_withdrawals', 'keep', 'Delete guard.'),
  ('withdrawals', 'trigger_track_withdrawal_ledger', 'bypass', 'Would write duplicate ledger entries.'),
  ('withdrawals', 'withdrawals_emit_event', 'bypass', 'Would emit realtime withdrawal events.'),
  ('orders', 'prevent_delete_orders', 'keep', 'Delete guard.'),
  ('orders', 'protect_order_dispatch_rate_snapshots', 'keep', 'Update guard.'),
  ('orders', 'queue_notification_automation_from_order', 'bypass', 'Would queue notification automation.'),
  ('orders', 'snapshot_order_dispatch_rates', 'bypass', 'Requires a live dispatch assignment or group rate.'),
  ('orders', 'trg_set_order_scheduled_process_at', 'bypass', 'Would schedule re-processing.'),
  ('orders', 'trigger_audit_order_status', 'bypass', 'Would write commission audit rows.'),
  ('orders', 'trigger_sync_order_to_wallet', 'bypass', 'Would credit the commission again.'),
  ('orders', 'trigger_update_total_income', 'bypass', 'Would add the commission to total income again.'),
  ('employee_login_history', 'employee_login_history_emit_event', 'bypass', 'Would emit realtime login events.'),
  ('employee_login_history', 'queue_notification_automation_from_employee_login', 'bypass', 'Would queue notification automation.'),
  ('work_sessions', 'queue_notification_automation_from_work_session', 'bypass', 'Would queue notification automation.'),
  ('work_sessions', 'trigger_check_overlapping', 'bypass', 'Per-row overlap scan is quadratic for history imports.'),
  ('work_sessions', 'trigger_cleanup_duplicate_sessions', 'bypass', 'Would close other sessions.'),
  ('work_sessions', 'trigger_prevent_multiple_active_sessions', 'bypass', 'Would close other sessions.'),
  ('work_sessions', 'trigger_validate_work_session', 'bypass', 'Would rewrite stored end times.'),
  ('messages', 'audit_notification_change', 'keep', 'Update/delete audit.'),
  ('messages', 'classify_notification_origin', 'keep', 'Origin classification.'),
  ('messages', 'guard_content_audit_public_media_reference', 'keep', 'Media deletion guard.'),
  ('messages', 'guard_employee_chat_image_reference', 'keep', 'Media deletion guard.'),
  ('messages', 'inherit_automation_message_delivery_mode', 'keep', 'Automation delivery mode.'),
  ('messages', 'sync_messages_delivery_mode', 'keep', 'Delivery mode normalisation.'),
  ('message_recipients', 'reject_archived_notification_recipient', 'keep', 'Archived employee guard.'),
  ('message_recipients', 'remember_content_audit_recipient', 'keep', 'Audit trail of recipients.'),
  ('customer_employee_conversations', 'aa_reject_archived_employee_chat', 'keep', 'Archived employee guard.'),
  ('customer_employee_conversations', 'audit_chat_change', 'keep', 'Update/delete audit.'),
  ('customer_employee_conversations', 'freeze_service_rich_card_before_insert', 'keep', 'Freezes rich-card content.'),
  ('customer_employee_conversations', 'guard_content_audit_public_media_reference', 'keep', 'Media deletion guard.'),
  ('customer_employee_conversations', 'guard_employee_chat_image_reference', 'keep', 'Media deletion guard.'),
  ('customer_employee_conversations', 'trg_check_conversation_group_isolation', 'keep', 'Group isolation.'),
  ('customer_employee_conversations', 'trg_sync_conversation_source_type', 'keep', 'Source type consistency.'),
  ('simulated_customers', 'guard_content_audit_public_media_reference', 'keep', 'Media deletion guard.'),
  ('simulated_customers', 'guard_employee_chat_image_reference', 'keep', 'Media deletion guard.'),
  ('simulated_customers', 'set_customer_id_trigger', 'keep', 'Generates display ids.'),
  ('customer_service_sessions', 'set_service_ticket_number_trigger', 'keep', 'Generates missing ticket numbers.'),
  ('rich_card_contents', 'audit_card_source', 'keep', 'Update/delete audit.'),
  ('rich_card_contents', 'guard_content_audit_public_media_reference', 'keep', 'Media deletion guard.'),
  ('rich_card_contents', 'guard_employee_chat_image_reference', 'keep', 'Media deletion guard.'),
  ('product_types', 'assign_product_type_sort_order', 'keep', 'Assigns the sort order.');

REVOKE ALL ON FUNCTION private.employee_transfer_tables() FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 3. Guards, jobs and audit events
-- ============================================================================

CREATE FUNCTION private.employee_transfer_admin(p_session uuid)
RETURNS TABLE(admin_id uuid, admin_username text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text;
BEGIN
  SELECT context.admin_id, context.admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_session) AS context;
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Super administrator permission is required.';
  END IF;
  RETURN QUERY SELECT admin.id, admin.username FROM public.admins AS admin WHERE admin.id = v_admin;
END;
$$;

CREATE FUNCTION private.employee_transfer_log(
  p_job_id uuid, p_admin_id uuid, p_admin_username text, p_kind text, p_action text, p_details jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  INSERT INTO private.employee_transfer_events (job_id, admin_id, admin_username, kind, action, details)
  VALUES (p_job_id, p_admin_id, p_admin_username, p_kind, p_action, COALESCE(p_details, '{}'::jsonb));
$$;

CREATE FUNCTION private.employee_transfer_job(p_session uuid, p_job_token uuid, p_kind text)
RETURNS private.employee_transfer_jobs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  SELECT admin.admin_id INTO v_admin FROM private.employee_transfer_admin(p_session) AS admin;
  IF p_job_token IS NULL THEN
    RAISE EXCEPTION 'Employee transfer task is invalid or expired.';
  END IF;
  UPDATE private.employee_transfer_jobs
  SET last_activity_at = now()
  WHERE token_hash = private.hash_financial_token(p_job_token)
    AND kind = p_kind AND admin_id = v_admin AND status = 'running'
    AND last_activity_at > now() - interval '3 hours'
    AND started_at > now() - interval '12 hours'
  RETURNING * INTO v_job;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'Employee transfer task is invalid or expired.';
  END IF;
  RETURN v_job;
END;
$$;

CREATE FUNCTION private.employee_transfer_verify_password(p_admin_id uuid, p_username text, p_password text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, extensions, pg_temp AS $$
DECLARE
  v_attempt public.financial_login_attempts%ROWTYPE;
  v_hash text;
BEGIN
  IF p_password IS NULL OR length(p_password) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid credentials');
  END IF;

  SELECT * INTO v_attempt FROM public.financial_login_attempts
  WHERE account_type = 'admin' AND username = p_username FOR UPDATE;
  IF FOUND AND v_attempt.locked_until IS NOT NULL AND v_attempt.locked_until > now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Account is temporarily locked.',
      'locked_until', v_attempt.locked_until);
  END IF;

  SELECT password_hash INTO v_hash FROM public.financial_admin_credentials WHERE admin_id = p_admin_id;
  IF v_hash IS NULL OR NOT private.verify_bcrypt_password(p_password, v_hash) THEN
    INSERT INTO public.financial_login_attempts AS attempts
      (account_type, username, failed_attempts, locked_until, last_attempt_at)
    VALUES ('admin', p_username, 1, NULL, now())
    ON CONFLICT (account_type, username) DO UPDATE
    SET failed_attempts = attempts.failed_attempts + 1,
        locked_until = CASE WHEN attempts.failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END,
        last_attempt_at = now();
    RETURN jsonb_build_object('success', false, 'error', 'Invalid credentials');
  END IF;

  DELETE FROM public.financial_login_attempts WHERE account_type = 'admin' AND username = p_username;
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE FUNCTION private.employee_transfer_start_job(
  p_session uuid, p_password text, p_kind text, p_options jsonb,
  p_admin_map jsonb DEFAULT '{}'::jsonb, p_group_map jsonb DEFAULT '{}'::jsonb,
  p_default_admin uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_admin uuid; v_username text; v_check jsonb; v_token uuid := gen_random_uuid();
  v_job_id uuid; v_site uuid;
BEGIN
  SELECT admin.admin_id, admin.admin_username INTO v_admin, v_username
  FROM private.employee_transfer_admin(p_session) AS admin;

  v_check := private.employee_transfer_verify_password(v_admin, v_username, p_password);
  IF NOT COALESCE((v_check ->> 'success')::boolean, false) THEN
    RETURN v_check;
  END IF;

  UPDATE private.employee_transfer_jobs
  SET status = 'abandoned', finished_at = now(), error = 'The task stopped reporting activity.'
  WHERE status = 'running'
    AND (last_activity_at < now() - interval '3 hours' OR started_at < now() - interval '12 hours'
      OR (admin_id = v_admin AND last_activity_at < now() - interval '2 minutes'));
  DELETE FROM private.employee_transfer_staging AS staged
  USING private.employee_transfer_jobs AS job
  WHERE staged.job_id = job.id AND job.status <> 'running';

  BEGIN
    INSERT INTO private.employee_transfer_jobs
      (kind, admin_id, admin_username, token_hash, options, admin_map, group_map, default_admin_id)
    VALUES (p_kind, v_admin, v_username, private.hash_financial_token(v_token),
      COALESCE(p_options, '{}'::jsonb), COALESCE(p_admin_map, '{}'::jsonb),
      COALESCE(p_group_map, '{}'::jsonb), p_default_admin)
    RETURNING id INTO v_job_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Another employee data transfer is still running.';
  END;

  SELECT site_id INTO v_site FROM private.employee_transfer_site;
  PERFORM private.employee_transfer_log(v_job_id, v_admin, v_username, p_kind, p_kind || '_begin', COALESCE(p_options, '{}'::jsonb));
  RETURN jsonb_build_object('success', true, 'job_id', v_job_id, 'job_token', v_token,
    'site_id', v_site, 'server_time', now());
END;
$$;

CREATE FUNCTION private.employee_transfer_end_job(
  p_job private.employee_transfer_jobs, p_status text, p_summary jsonb, p_error text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  UPDATE private.employee_transfer_jobs
  SET status = p_status, finished_at = now(), summary = p_summary, error = p_error
  WHERE id = p_job.id;
  DELETE FROM private.employee_transfer_staging WHERE job_id = p_job.id;
  PERFORM private.employee_transfer_log(p_job.id, p_job.admin_id, p_job.admin_username, p_job.kind,
    p_job.kind || '_' || p_status, COALESCE(p_summary, '{}'::jsonb) || jsonb_build_object('error', p_error));
END;
$$;

CREATE FUNCTION public.employee_transfer_cancel(p_admin_session_token uuid, p_job_token uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  SELECT admin.admin_id INTO v_admin FROM private.employee_transfer_admin(p_admin_session_token) AS admin;
  SELECT * INTO v_job FROM private.employee_transfer_jobs
  WHERE token_hash = private.hash_financial_token(p_job_token) AND admin_id = v_admin AND status = 'running';
  IF v_job.id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'cancelled', false);
  END IF;
  PERFORM private.employee_transfer_end_job(v_job, 'cancelled', NULL);
  RETURN jsonb_build_object('success', true, 'cancelled', true);
END;
$$;

CREATE FUNCTION public.get_employee_transfer_log(p_admin_session_token uuid, p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  RETURN jsonb_build_object(
    'site_id', (SELECT site_id FROM private.employee_transfer_site),
    'last_export_at', (SELECT max(finished_at) FROM private.employee_transfer_jobs
      WHERE kind = 'export' AND status = 'finished'),
    'running', (SELECT to_jsonb(running) FROM (
      SELECT job.id, job.kind, job.admin_username, job.started_at, job.last_activity_at
      FROM private.employee_transfer_jobs AS job WHERE job.status = 'running' LIMIT 1) AS running),
    'events', COALESCE((SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id DESC) FROM (
      SELECT item.id, item.job_id, item.occurred_at, item.admin_username, item.kind, item.action, item.details
      FROM private.employee_transfer_events AS item ORDER BY item.id DESC LIMIT v_limit) AS event), '[]'::jsonb));
END;
$$;

-- ============================================================================
-- 4. Schema fingerprint and trigger bypass helpers
-- ============================================================================

CREATE FUNCTION private.employee_transfer_schema_fingerprint()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  WITH tables AS (SELECT unnest(private.employee_transfer_tables()) AS table_name),
  columns AS (
    SELECT tables.table_name,
      COALESCE(string_agg(attribute.attname::text || ':' || format_type(attribute.atttypid, attribute.atttypmod)
        || ':' || attribute.attnotnull::text, ',' ORDER BY attribute.attname::text), 'missing') AS signature
    FROM tables
    LEFT JOIN pg_class AS relation ON relation.relname = tables.table_name
      AND relation.relnamespace = 'public'::regnamespace AND relation.relkind IN ('r', 'p')
    LEFT JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND NOT EXISTS (SELECT 1 FROM private.employee_transfer_excluded_columns AS excluded
        WHERE excluded.table_name = tables.table_name AND excluded.column_name = attribute.attname::text)
    GROUP BY tables.table_name
  )
  SELECT jsonb_build_object(
    'hash', md5(string_agg(table_name || '=' || md5(signature), ';' ORDER BY table_name)),
    'tables', jsonb_object_agg(table_name, md5(signature)))
  FROM columns;
$$;

CREATE FUNCTION private.employee_transfer_unreviewed_triggers()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', relation.relname, 'trigger', trigger.tgname)
    ORDER BY relation.relname, trigger.tgname), '[]'::jsonb)
  FROM pg_trigger AS trigger
  JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
  WHERE NOT trigger.tgisinternal
    AND relation.relnamespace = 'public'::regnamespace
    AND relation.relname = ANY (private.employee_transfer_tables())
    AND NOT EXISTS (SELECT 1 FROM private.employee_transfer_trigger_policy AS policy
      WHERE policy.table_name = relation.relname AND policy.trigger_name = trigger.tgname);
$$;

CREATE FUNCTION private.employee_transfer_assert_triggers_reviewed()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_unreviewed jsonb := private.employee_transfer_unreviewed_triggers();
BEGIN
  IF jsonb_array_length(v_unreviewed) > 0 THEN
    RAISE EXCEPTION 'The target database has triggers that were not reviewed for employee import: %', v_unreviewed::text;
  END IF;
END;
$$;

-- Disables the reviewed side-effect triggers on the named tables for the rest of the current
-- transaction. ALTER TABLE ... DISABLE TRIGGER is transactional, so any error (or crash) restores
-- the triggers automatically; callers re-enable them explicitly before they return.
CREATE FUNCTION private.employee_transfer_bypass_triggers(p_tables text[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_item record; v_disabled jsonb := '[]'::jsonb;
BEGIN
  PERFORM private.employee_transfer_assert_triggers_reviewed();
  FOR v_item IN
    SELECT relation.relname::text AS table_name, trigger.tgname::text AS trigger_name
    FROM pg_trigger AS trigger
    JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
    JOIN private.employee_transfer_trigger_policy AS policy
      ON policy.table_name = relation.relname AND policy.trigger_name = trigger.tgname
    WHERE NOT trigger.tgisinternal AND relation.relnamespace = 'public'::regnamespace
      AND relation.relname = ANY (p_tables) AND policy.action = 'bypass'
      AND trigger.tgenabled IN ('O', 'A')
    ORDER BY relation.relname, trigger.tgname
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', v_item.table_name, v_item.trigger_name);
    v_disabled := v_disabled || jsonb_build_array(jsonb_build_object('table', v_item.table_name, 'trigger', v_item.trigger_name));
  END LOOP;
  RETURN v_disabled;
END;
$$;

CREATE FUNCTION private.employee_transfer_restore_triggers(p_disabled jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_item jsonb;
BEGIN
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_disabled, '[]'::jsonb))
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I', v_item ->> 'table', v_item ->> 'trigger');
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_admin(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_log(uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_job(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_verify_password(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_start_job(uuid, text, text, jsonb, jsonb, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_end_job(private.employee_transfer_jobs, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_schema_fingerprint() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_unreviewed_triggers() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_assert_triggers_reviewed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_bypass_triggers(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_restore_triggers(jsonb) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.employee_transfer_cancel(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_transfer_cancel(uuid, uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_transfer_log(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_transfer_log(uuid, integer) TO anon, authenticated;
