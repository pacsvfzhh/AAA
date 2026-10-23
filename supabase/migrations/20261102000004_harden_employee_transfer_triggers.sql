CREATE FUNCTION private.employee_transfer_trigger_tables()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT ARRAY[
    'users', 'financial_employee_credentials', 'wallets', 'wallet_balance_baselines',
    'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit',
    'orders', 'product_types', 'dispatch_group_members', 'verification_requests',
    'employee_login_history', 'work_sessions', 'messages', 'message_recipients',
    'customer_employee_conversations', 'customer_service_sessions', 'ccc_conversation_annotations',
    'customer_auto_message_logs', 'simulated_customers', 'rich_card_contents'
  ]::text[];
$$;

CREATE FUNCTION private.employee_transfer_fixed_trigger_policy()
RETURNS TABLE(table_name text, trigger_name text, action text)
LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT * FROM (VALUES
    ('users', 'archive_employee_before_delete', 'keep'),
    ('users', 'cleanup_user_data_trigger', 'keep'),
    ('users', 'cleanup_user_storage_trigger', 'keep'),
    ('users', 'create_wallet_trigger', 'keep'),
    ('users', 'guard_employee_archive', 'keep'),
    ('users', 'trigger_cleanup_user_data', 'keep'),
    ('wallets', 'prevent_delete_wallets', 'keep'),
    ('wallets', 'trigger_enqueue_changed_wallet', 'bypass'),
    ('wallet_transactions', 'prevent_delete_wallet_transactions', 'keep'),
    ('wallet_transactions', 'queue_notification_automation_from_wallet_transaction', 'bypass'),
    ('wallet_transactions', 'trigger_audit_commission_transaction', 'bypass'),
    ('wallet_transactions', 'trigger_reverse_deleted_wallet_transaction_ledger', 'keep'),
    ('wallet_transactions', 'trigger_track_wallet_transaction_ledger', 'bypass'),
    ('withdrawals', 'prevent_delete_withdrawals', 'keep'),
    ('withdrawals', 'trigger_track_withdrawal_ledger', 'bypass'),
    ('withdrawals', 'withdrawals_emit_event', 'bypass'),
    ('orders', 'prevent_delete_orders', 'keep'),
    ('orders', 'protect_order_dispatch_rate_snapshots', 'keep'),
    ('orders', 'queue_notification_automation_from_order', 'bypass'),
    ('orders', 'snapshot_order_dispatch_rates', 'bypass'),
    ('orders', 'trg_set_order_scheduled_process_at', 'bypass'),
    ('orders', 'trigger_audit_order_status', 'bypass'),
    ('orders', 'trigger_sync_order_to_wallet', 'bypass'),
    ('orders', 'trigger_update_total_income', 'bypass'),
    ('employee_login_history', 'employee_login_history_emit_event', 'bypass'),
    ('employee_login_history', 'queue_notification_automation_from_employee_login', 'bypass'),
    ('work_sessions', 'queue_notification_automation_from_work_session', 'bypass'),
    ('work_sessions', 'trigger_check_overlapping', 'bypass'),
    ('work_sessions', 'trigger_cleanup_duplicate_sessions', 'bypass'),
    ('work_sessions', 'trigger_prevent_multiple_active_sessions', 'bypass'),
    ('work_sessions', 'trigger_validate_work_session', 'bypass'),
    ('messages', 'audit_notification_change', 'keep'),
    ('messages', 'classify_notification_origin', 'keep'),
    ('messages', 'guard_content_audit_public_media_reference', 'keep'),
    ('messages', 'guard_employee_chat_image_reference', 'keep'),
    ('messages', 'inherit_automation_message_delivery_mode', 'keep'),
    ('messages', 'sync_messages_delivery_mode', 'keep'),
    ('message_recipients', 'reject_archived_notification_recipient', 'keep'),
    ('message_recipients', 'remember_content_audit_recipient', 'keep'),
    ('customer_employee_conversations', 'aa_reject_archived_employee_chat', 'keep'),
    ('customer_employee_conversations', 'audit_chat_change', 'keep'),
    ('customer_employee_conversations', 'freeze_service_rich_card_before_insert', 'keep'),
    ('customer_employee_conversations', 'guard_content_audit_public_media_reference', 'keep'),
    ('customer_employee_conversations', 'guard_employee_chat_image_reference', 'keep'),
    ('customer_employee_conversations', 'trg_check_conversation_group_isolation', 'keep'),
    ('customer_employee_conversations', 'trg_sync_conversation_source_type', 'keep'),
    ('simulated_customers', 'guard_content_audit_public_media_reference', 'keep'),
    ('simulated_customers', 'guard_employee_chat_image_reference', 'keep'),
    ('simulated_customers', 'set_customer_id_trigger', 'keep'),
    ('customer_service_sessions', 'set_service_ticket_number_trigger', 'keep'),
    ('rich_card_contents', 'audit_card_source', 'keep'),
    ('rich_card_contents', 'guard_content_audit_public_media_reference', 'keep'),
    ('rich_card_contents', 'guard_employee_chat_image_reference', 'keep'),
    ('product_types', 'assign_product_type_sort_order', 'keep')
  ) AS policy(table_name, trigger_name, action);
$$;

CREATE FUNCTION private.employee_transfer_lock_trigger_tables(p_tables text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table text;
BEGIN
  IF p_tables IS NULL OR cardinality(p_tables) = 0
    OR array_ndims(p_tables) IS DISTINCT FROM 1 OR array_lower(p_tables, 1) IS DISTINCT FROM 1
    OR EXISTS (SELECT 1 FROM unnest(p_tables) AS item(table_name)
      WHERE table_name IS NULL OR NOT table_name = ANY (private.employee_transfer_trigger_tables()))
    OR (SELECT count(DISTINCT table_name) FROM unnest(p_tables) AS item(table_name)) <> cardinality(p_tables)
  THEN
    RAISE EXCEPTION 'Invalid employee transfer trigger table list.';
  END IF;
  FOR v_table IN SELECT table_name FROM unnest(p_tables) AS item(table_name) ORDER BY table_name COLLATE "C"
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = v_table AND relkind IN ('r', 'p')) THEN
      RAISE EXCEPTION 'Employee transfer trigger table is missing: public.%', v_table;
    END IF;
    EXECUTE format('LOCK TABLE ONLY public.%I IN ACCESS EXCLUSIVE MODE', v_table);
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_trigger_digest(p_trigger oid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  -- pg_get_triggerdef excludes tgenabled, so disabling does not change this digest.
  SELECT encode(sha256(convert_to(jsonb_build_array(
    pg_get_triggerdef(trigger.oid, false), pg_get_functiondef(trigger.tgfoid),
    procedure.proowner::text, procedure.proacl::text,
    (SELECT role.rolsuper FROM pg_roles AS role WHERE role.oid = procedure.proowner),
    (SELECT role.rolbypassrls FROM pg_roles AS role WHERE role.oid = procedure.proowner)
  )::text, 'UTF8')), 'hex')
  FROM pg_trigger AS trigger JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
  WHERE trigger.oid = p_trigger AND NOT trigger.tgisinternal;
$$;

CREATE FUNCTION private.employee_transfer_install_trigger_digest(p_trigger oid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  -- Installation compares named privileges; runtime receipts still pin native OIDs, ACLs and role attributes.
  SELECT encode(sha256(convert_to(jsonb_build_array(
    pg_get_triggerdef(trigger.oid, false), pg_get_functiondef(procedure.oid),
    owner.rolname, owner.rolbypassrls,
    (SELECT jsonb_agg(jsonb_build_array(
      pg_get_userbyid(acl.grantor), acl.grantee = 0,
      CASE WHEN acl.grantee = 0 THEN NULL ELSE pg_get_userbyid(acl.grantee) END,
      acl.privilege_type, acl.is_grantable)
      ORDER BY pg_get_userbyid(acl.grantor) COLLATE "C",
        acl.grantee = 0, pg_get_userbyid(acl.grantee) COLLATE "C",
        acl.privilege_type COLLATE "C", acl.is_grantable)
     FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) AS acl)
  )::text, 'UTF8')), 'hex')
  FROM pg_trigger AS trigger JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
    JOIN pg_roles AS owner ON owner.oid = procedure.proowner
  WHERE trigger.oid = p_trigger AND NOT trigger.tgisinternal;
$$;
REVOKE ALL ON FUNCTION private.employee_transfer_install_trigger_digest(oid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.employee_transfer_pending_trigger_bypass()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  -- Append-only server receipts, not caller-controlled GUCs, authenticate original modes.
  SELECT event.details FROM private.employee_transfer_events AS event
  WHERE event.action = 'trigger_bypass'
    AND event.details ->> 'transaction_id' = pg_current_xact_id()::text
    AND NOT EXISTS (SELECT 1 FROM private.employee_transfer_events AS restored
      WHERE restored.action = 'trigger_restore'
        AND restored.details ->> 'bypass_id' = event.details ->> 'bypass_id')
  ORDER BY event.id DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION private.employee_transfer_unreviewed_triggers()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', relation.relname, 'trigger', trigger.tgname)
    ORDER BY relation.relname COLLATE "C", trigger.tgname COLLATE "C"), '[]'::jsonb)
  FROM pg_trigger AS trigger
  JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
  WHERE NOT trigger.tgisinternal AND relation.relnamespace = 'public'::regnamespace
    AND relation.relname = ANY (private.employee_transfer_trigger_tables())
    AND NOT EXISTS (SELECT 1 FROM private.employee_transfer_fixed_trigger_policy() AS policy
      WHERE policy.table_name = relation.relname AND policy.trigger_name = trigger.tgname);
$$;

CREATE OR REPLACE FUNCTION private.employee_transfer_bypass_triggers(p_tables text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_item jsonb;
  v_disabled jsonb;
  v_bypass_id uuid := gen_random_uuid();
BEGIN
  IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN
    RAISE EXCEPTION 'Employee transfer trigger bypass requires origin replication mode.';
  END IF;
  IF private.employee_transfer_pending_trigger_bypass() IS NOT NULL THEN
    RAISE EXCEPTION 'Restore the pending employee transfer trigger bypass first.';
  END IF;
  PERFORM private.employee_transfer_lock_trigger_tables(p_tables);
  PERFORM private.employee_transfer_assert_triggers_reviewed();
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', 'public', 'table', relation.relname, 'trigger', trigger.tgname,
    'mode', trigger.tgenabled::text, 'definition_digest', private.employee_transfer_trigger_digest(trigger.oid),
    'bypass_id', v_bypass_id
  ) ORDER BY relation.relname COLLATE "C", trigger.tgname COLLATE "C"), '[]'::jsonb)
  INTO v_disabled
  FROM pg_trigger AS trigger
  JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
  JOIN private.employee_transfer_fixed_trigger_policy() AS policy
    ON policy.table_name = relation.relname AND policy.trigger_name = trigger.tgname
  WHERE NOT trigger.tgisinternal AND relation.relnamespace = 'public'::regnamespace
    AND relation.relname = ANY (p_tables) AND policy.action = 'bypass'
    AND trigger.tgenabled IN ('O', 'A');

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_disabled)
  LOOP
    EXECUTE format('ALTER TABLE ONLY public.%I DISABLE TRIGGER %I', v_item ->> 'table', v_item ->> 'trigger');
  END LOOP;
  IF jsonb_array_length(v_disabled) > 0 THEN
    INSERT INTO private.employee_transfer_events (kind, action, details)
    VALUES ('import', 'trigger_bypass', jsonb_build_object(
      'transaction_id', pg_current_xact_id()::text, 'bypass_id', v_bypass_id, 'entries', v_disabled));
  END IF;
  RETURN v_disabled;
END;
$$;

CREATE OR REPLACE FUNCTION private.employee_transfer_restore_triggers(p_disabled jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_item jsonb;
  v_pending jsonb;
  v_sorted jsonb;
  v_tables text[];
BEGIN
  IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN
    RAISE EXCEPTION 'Employee transfer trigger restore requires origin replication mode.';
  END IF;
  IF jsonb_typeof(p_disabled) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid employee transfer trigger restore payload.';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_disabled)
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Invalid employee transfer trigger restore entry.';
    END IF;
    IF NOT v_item ?& ARRAY['schema', 'table', 'trigger', 'mode', 'definition_digest', 'bypass_id']
      OR (SELECT count(*) FROM jsonb_object_keys(v_item)) <> 6
      OR EXISTS (SELECT 1 FROM jsonb_each(v_item) AS property WHERE jsonb_typeof(property.value) <> 'string')
      OR v_item ->> 'schema' IS DISTINCT FROM 'public'
      OR (v_item ->> 'mode') NOT IN ('O', 'A')
      OR (v_item ->> 'definition_digest') !~ '^[0-9a-f]{64}$'
      OR NOT EXISTS (SELECT 1 FROM private.employee_transfer_fixed_trigger_policy() AS policy
        WHERE policy.table_name = v_item ->> 'table' AND policy.trigger_name = v_item ->> 'trigger'
          AND policy.action = 'bypass') THEN
      RAISE EXCEPTION 'Invalid employee transfer trigger restore entry.';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_disabled) AS item
    GROUP BY item ->> 'schema', item ->> 'table', item ->> 'trigger' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate employee transfer trigger restore entry.';
  END IF;
  SELECT COALESCE(jsonb_agg(item ORDER BY (item ->> 'table') COLLATE "C", (item ->> 'trigger') COLLATE "C"), '[]'::jsonb)
  INTO v_sorted FROM jsonb_array_elements(p_disabled) AS item;
  v_pending := private.employee_transfer_pending_trigger_bypass();
  IF v_pending IS NULL AND v_sorted = '[]'::jsonb THEN RETURN; END IF;
  IF v_pending IS NULL OR v_sorted IS DISTINCT FROM v_pending -> 'entries' THEN
    RAISE EXCEPTION 'Trigger restore payload does not match the pending bypass in this transaction.';
  END IF;
  SELECT array_agg(DISTINCT item ->> 'table' ORDER BY item ->> 'table') INTO v_tables
  FROM jsonb_array_elements(v_sorted) AS item;
  PERFORM private.employee_transfer_lock_trigger_tables(v_tables);
  PERFORM private.employee_transfer_assert_triggers_reviewed();

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_sorted)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger AS trigger
      JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      WHERE relation.relnamespace = 'public'::regnamespace AND relation.relname = v_item ->> 'table'
        AND trigger.tgname = v_item ->> 'trigger' AND NOT trigger.tgisinternal
        AND trigger.tgenabled = 'D'
        AND private.employee_transfer_trigger_digest(trigger.oid) = v_item ->> 'definition_digest') THEN
      RAISE EXCEPTION 'Employee transfer trigger definition or disabled state changed: public.%.%',
        v_item ->> 'table', v_item ->> 'trigger';
    END IF;
  END LOOP;
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_sorted)
  LOOP
    IF v_item ->> 'mode' = 'A' THEN
      EXECUTE format('ALTER TABLE ONLY public.%I ENABLE ALWAYS TRIGGER %I', v_item ->> 'table', v_item ->> 'trigger');
    ELSE
      EXECUTE format('ALTER TABLE ONLY public.%I ENABLE TRIGGER %I', v_item ->> 'table', v_item ->> 'trigger');
    END IF;
  END LOOP;
  INSERT INTO private.employee_transfer_events (kind, action, details)
  VALUES ('import', 'trigger_restore', jsonb_build_object(
    'transaction_id', pg_current_xact_id()::text, 'bypass_id', v_pending ->> 'bypass_id'));
END;
$$;

CREATE FUNCTION private.employee_transfer_require_trigger_restore()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF NEW.action = 'trigger_bypass'
    AND NOT EXISTS (SELECT 1 FROM private.employee_transfer_events AS restored
      WHERE restored.action = 'trigger_restore'
        AND restored.details ->> 'transaction_id' = NEW.details ->> 'transaction_id'
        AND restored.details ->> 'bypass_id' = NEW.details ->> 'bypass_id') THEN
    RAISE EXCEPTION 'Employee transfer triggers must be restored before committing.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER employee_transfer_require_trigger_restore
AFTER INSERT ON private.employee_transfer_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.action = 'trigger_bypass')
EXECUTE FUNCTION private.employee_transfer_require_trigger_restore();

REVOKE ALL ON FUNCTION private.employee_transfer_require_trigger_restore() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_trigger_tables() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_fixed_trigger_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_lock_trigger_tables(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_trigger_digest(oid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_pending_trigger_bypass() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_unreviewed_triggers() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_bypass_triggers(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_restore_triggers(jsonb) FROM PUBLIC, anon, authenticated;
