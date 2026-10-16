/*
  Employee data import, write phase.

  Money-critical rule: wallet, baseline, ledger, wallet transactions and withdrawals of one employee
  are written in ONE transaction (employee_import_apply_core) with only the reviewed side-effect
  triggers switched off, then checked against the same formula reconcile_wallet_from_ledger uses.
  Any mismatch raises and rolls the whole employee back. Protective triggers (group isolation,
  archived-employee guards, media guards, rich-card freezing, delete guards) stay enabled.
*/

CREATE FUNCTION private.employee_transfer_admin_ref(p_job private.employee_transfer_jobs, p_old_id uuid, p_old_username text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT COALESCE(
    (SELECT admin.id FROM public.admins AS admin
      WHERE p_old_id IS NOT NULL AND admin.id = NULLIF(p_job.admin_map ->> p_old_id::text, '')::uuid),
    (SELECT admin.id FROM public.admins AS admin
      WHERE p_old_username IS NOT NULL AND admin.username = p_old_username
      ORDER BY admin.is_active DESC, admin.created_at LIMIT 1));
$$;

-- Only employees created by this very job may receive rows.
CREATE FUNCTION private.employee_transfer_assert_job_employee(p_job private.employee_transfer_jobs, p_employee_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.employee_transfer_events AS event
    WHERE event.job_id = p_job.id AND event.action = 'import_core'
      AND event.details ->> 'employee_id' = p_employee_id::text) THEN
    RAISE EXCEPTION 'This employee was not created by the running import task.';
  END IF;
  PERFORM 1 FROM public.users WHERE id = p_employee_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee account was not found.'; END IF;
END;
$$;

CREATE FUNCTION public.employee_import_stage_chunk(
  p_admin_session_token uuid, p_job_token uuid, p_employee_id uuid, p_table_key text, p_chunk_no integer, p_rows jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_count integer;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'import');
  IF p_table_key NOT IN ('account', 'wallet', 'baseline', 'ledger', 'transactions', 'withdrawals',
    'reconciliation_audit', 'verification') THEN
    RAISE EXCEPTION 'Unsupported staging table: %', p_table_key;
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Staged rows must be a list.'; END IF;
  v_count := jsonb_array_length(p_rows);
  IF v_count > 5000 OR p_chunk_no IS NULL OR p_chunk_no < 0 OR p_employee_id IS NULL THEN
    RAISE EXCEPTION 'Invalid staging chunk.';
  END IF;
  INSERT INTO private.employee_transfer_staging (job_id, employee_id, table_key, chunk_no, row_count, payload)
  VALUES (v_job.id, p_employee_id, p_table_key, p_chunk_no, v_count, p_rows)
  ON CONFLICT (job_id, employee_id, table_key, chunk_no)
  DO UPDATE SET row_count = excluded.row_count, payload = excluded.payload, created_at = now();
  RETURN jsonb_build_object('success', true, 'rows', v_count);
END;
$$;

CREATE FUNCTION public.employee_import_apply_core(
  p_admin_session_token uuid, p_job_token uuid, p_employee_id uuid, p_expected jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s'
SET lock_timeout = '30s' AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_account jsonb; v_wallet jsonb; v_baseline jsonb;
  v_user record; v_existing public.users%ROWTYPE;
  v_admin uuid; v_disabled jsonb; v_key text; v_expected integer; v_staged integer; v_rows integer;
  v_counts jsonb := '{}'::jsonb;
  v_old_ids bigint[]; v_new_ids bigint[]; v_rank integer; v_old_cursor bigint; v_new_cursor bigint;
  v_pending numeric; v_available_delta numeric; v_frozen_delta numeric; v_income_delta numeric;
  v_wallet_row public.wallets%ROWTYPE; v_income numeric; v_group uuid;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'import');
  IF p_employee_id IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid employee import request.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('employee-transfer-core'), hashtext(p_employee_id::text));

  SELECT payload -> 0 INTO v_account FROM private.employee_transfer_staging
  WHERE job_id = v_job.id AND employee_id = p_employee_id AND table_key = 'account' AND chunk_no = 0;
  IF v_account IS NULL OR (v_account ->> 'id')::uuid IS DISTINCT FROM p_employee_id THEN
    RAISE EXCEPTION 'The account row of employee % was not staged.', p_employee_id;
  END IF;

  SELECT * INTO v_existing FROM public.users WHERE id = p_employee_id;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.username = (v_account ->> 'username') AND v_existing.archived_at IS NULL AND NOT v_existing.is_active
      AND EXISTS (SELECT 1 FROM private.employee_transfer_events AS event
        WHERE event.action = 'import_core' AND event.details ->> 'employee_id' = p_employee_id::text) THEN
      PERFORM private.employee_transfer_log(v_job.id, v_job.admin_id, v_job.admin_username, 'import', 'import_core',
        jsonb_build_object('employee_id', p_employee_id, 'username', v_existing.username,
          'is_active', COALESCE((v_account ->> 'is_active')::boolean, true), 'already_applied', true));
      DELETE FROM private.employee_transfer_staging WHERE job_id = v_job.id AND employee_id = p_employee_id;
      RETURN jsonb_build_object('success', true, 'already_applied', true, 'employee_id', p_employee_id);
    END IF;
    RAISE EXCEPTION 'Employee % already exists on this site.', v_account ->> 'username';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE username = v_account ->> 'username') THEN
    RAISE EXCEPTION 'Username % is already used on this site. Replace or skip this employee first.', v_account ->> 'username';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE employee_id = v_account ->> 'employee_id') THEN
    RAISE EXCEPTION 'Employee number % is already used on this site.', v_account ->> 'employee_id';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admins WHERE username = v_account ->> 'username') THEN
    RAISE EXCEPTION 'Username % belongs to an administrator on this site.', v_account ->> 'username';
  END IF;

  v_admin := private.employee_transfer_mapped_admin(v_job, NULLIF(v_account ->> 'created_by', '')::uuid);
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'The administrator of employee % is not mapped.', v_account ->> 'username';
  END IF;

  FOR v_key IN SELECT unnest(ARRAY['account', 'wallet', 'baseline', 'ledger', 'transactions', 'withdrawals',
    'reconciliation_audit', 'verification'])
  LOOP
    v_expected := COALESCE((p_expected ->> v_key)::integer, CASE WHEN v_key = 'account' THEN 1 ELSE 0 END);
    SELECT COALESCE(sum(row_count), 0)::integer INTO v_staged FROM private.employee_transfer_staging
    WHERE job_id = v_job.id AND employee_id = p_employee_id AND table_key = v_key;
    IF v_staged IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Staged % rows (%) do not match the export manifest (%) for employee %.',
        v_key, v_staged, v_expected, v_account ->> 'username';
    END IF;
  END LOOP;

  v_disabled := private.employee_transfer_bypass_triggers(ARRAY['wallets', 'wallet_transactions', 'withdrawals']);

  SELECT a.* INTO v_user FROM jsonb_to_record(v_account) AS a(
    id uuid, username text, password_hash text, employee_id text, is_verified boolean, is_active boolean,
    total_income numeric, first_success_order_date timestamptz, remarks text, created_at timestamptz,
    updated_at timestamptz, tags jsonb, is_pinned boolean, credential_password_hash text,
    credential_created_at timestamptz, credential_updated_at timestamptz, group_id uuid);

  INSERT INTO public.users (id, username, password_hash, employee_id, is_verified, is_active, total_income,
    first_success_order_date, created_by, remarks, created_at, updated_at, tags, is_pinned)
  VALUES (v_user.id, v_user.username, v_user.password_hash, v_user.employee_id, COALESCE(v_user.is_verified, false), false,
    COALESCE(v_user.total_income, 0), v_user.first_success_order_date, v_admin, COALESCE(v_user.remarks, ''),
    COALESCE(v_user.created_at, now()), COALESCE(v_user.updated_at, now()),
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_user.tags, '[]'::jsonb))), '{}'::text[]),
    COALESCE(v_user.is_pinned, false));

  IF v_user.credential_password_hash IS NOT NULL THEN
    INSERT INTO public.financial_employee_credentials (user_id, password_hash, created_at, updated_at)
    VALUES (v_user.id, v_user.credential_password_hash, COALESCE(v_user.credential_created_at, now()),
      COALESCE(v_user.credential_updated_at, now()));
  END IF;

  v_group := NULLIF(v_job.group_map ->> v_user.group_id::text, '')::uuid;
  IF v_group IS NOT NULL THEN
    INSERT INTO public.dispatch_group_members (group_id, user_id, assigned_by)
    VALUES (v_group, v_user.id, v_job.admin_id) ON CONFLICT (user_id) DO NOTHING;
  END IF;

  SELECT payload -> 0 INTO v_wallet FROM private.employee_transfer_staging
  WHERE job_id = v_job.id AND employee_id = p_employee_id AND table_key = 'wallet' AND chunk_no = 0;
  IF v_wallet IS NOT NULL THEN
    INSERT INTO public.wallets (user_id, available_balance, frozen_balance, created_at, updated_at)
    SELECT p_employee_id, w.available_balance, w.frozen_balance, COALESCE(w.created_at, now()), COALESCE(w.updated_at, now())
    FROM jsonb_to_record(v_wallet) AS w(user_id uuid, available_balance numeric, frozen_balance numeric,
      created_at timestamptz, updated_at timestamptz)
    WHERE w.user_id = p_employee_id
    ON CONFLICT (user_id) DO UPDATE
    SET available_balance = excluded.available_balance, frozen_balance = excluded.frozen_balance,
        created_at = excluded.created_at, updated_at = excluded.updated_at;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'The wallet row does not belong to employee %.', v_user.username; END IF;
  END IF;

  -- Ledger: new ids are drawn from the target sequence in the order of the old ids.
  SELECT COALESCE(array_agg(r.id ORDER BY r.id), '{}') INTO v_old_ids
  FROM private.employee_transfer_staging AS staged
  CROSS JOIN LATERAL jsonb_to_recordset(staged.payload) AS r(id bigint)
  WHERE staged.job_id = v_job.id AND staged.employee_id = p_employee_id AND staged.table_key = 'ledger';
  IF cardinality(v_old_ids) > 0 THEN
    SELECT array_agg(nextval(pg_get_serial_sequence('public.wallet_ledger_entries', 'id')::regclass) ORDER BY step)
    INTO v_new_ids FROM generate_series(1, cardinality(v_old_ids)) AS step;
    WITH source AS (
      SELECT r.*, row_number() OVER (ORDER BY r.id) AS position
      FROM private.employee_transfer_staging AS staged
      CROSS JOIN LATERAL jsonb_to_recordset(staged.payload) AS r(id bigint, user_id uuid, operation_id uuid,
        source_type text, source_id uuid, event_type text, available_delta numeric, frozen_delta numeric,
        income_delta numeric, created_at timestamptz)
      WHERE staged.job_id = v_job.id AND staged.employee_id = p_employee_id AND staged.table_key = 'ledger'
        AND r.user_id = p_employee_id)
    INSERT INTO public.wallet_ledger_entries (id, user_id, operation_id, source_type, source_id, event_type,
      available_delta, frozen_delta, income_delta, created_at)
    SELECT v_new_ids[source.position::integer], source.user_id, source.operation_id, source.source_type, source.source_id,
      source.event_type, source.available_delta, source.frozen_delta, source.income_delta,
      COALESCE(source.created_at, now())
    FROM source;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> cardinality(v_old_ids) THEN
      RAISE EXCEPTION 'Ledger rows of employee % do not all belong to the employee.', v_user.username;
    END IF;
  END IF;
  v_counts := v_counts || jsonb_build_object('ledger', cardinality(v_old_ids));

  SELECT payload -> 0 INTO v_baseline FROM private.employee_transfer_staging
  WHERE job_id = v_job.id AND employee_id = p_employee_id AND table_key = 'baseline' AND chunk_no = 0;
  IF v_baseline IS NOT NULL THEN
    v_old_cursor := COALESCE((v_baseline ->> 'last_ledger_id')::bigint, 0);
    SELECT count(*)::integer INTO v_rank FROM unnest(v_old_ids) AS old_id WHERE old_id <= v_old_cursor;
    v_new_cursor := CASE WHEN v_rank = 0 THEN 0 ELSE v_new_ids[v_rank] END;
    INSERT INTO public.wallet_balance_baselines (user_id, available_balance, frozen_balance, total_income,
      last_ledger_id, established_at)
    SELECT p_employee_id, b.available_balance, b.frozen_balance, b.total_income, v_new_cursor,
      COALESCE(b.established_at, now())
    FROM jsonb_to_record(v_baseline) AS b(user_id uuid, available_balance numeric, frozen_balance numeric,
      total_income numeric, established_at timestamptz)
    WHERE b.user_id = p_employee_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'The baseline row does not belong to employee %.', v_user.username; END IF;
  END IF;

  INSERT INTO public.wallet_transactions (id, user_id, type, amount, balance_before, balance_after, reference_id,
    remarks, created_by, created_at, operation_id)
  SELECT r.id, r.user_id, r.type, r.amount, r.balance_before, r.balance_after, r.reference_id, COALESCE(r.remarks, ''),
    private.employee_transfer_admin_ref(v_job, r.created_by, r.created_by_username), COALESCE(r.created_at, now()), r.operation_id
  FROM private.employee_transfer_staging AS staged
  CROSS JOIN LATERAL jsonb_to_recordset(staged.payload) AS r(id uuid, user_id uuid, type text, amount numeric,
    balance_before numeric, balance_after numeric, reference_id uuid, remarks text, created_by uuid,
    created_by_username text, created_at timestamptz, operation_id uuid)
  WHERE staged.job_id = v_job.id AND staged.employee_id = p_employee_id AND staged.table_key = 'transactions'
    AND r.user_id = p_employee_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> COALESCE((p_expected ->> 'transactions')::integer, 0) THEN
    RAISE EXCEPTION 'Wallet transactions of employee % do not all belong to the employee.', v_user.username;
  END IF;
  v_counts := v_counts || jsonb_build_object('transactions', v_rows);

  INSERT INTO public.withdrawals (id, user_id, amount, status, audit_remark, audited_by, audited_at, created_at, last_operation_id)
  SELECT r.id, r.user_id, r.amount, r.status, r.audit_remark,
    private.employee_transfer_admin_ref(v_job, r.audited_by, r.audited_by_username), r.audited_at,
    COALESCE(r.created_at, now()), r.last_operation_id
  FROM private.employee_transfer_staging AS staged
  CROSS JOIN LATERAL jsonb_to_recordset(staged.payload) AS r(id uuid, user_id uuid, amount numeric, status text,
    audit_remark text, audited_by uuid, audited_by_username text, audited_at timestamptz, created_at timestamptz,
    last_operation_id uuid)
  WHERE staged.job_id = v_job.id AND staged.employee_id = p_employee_id AND staged.table_key = 'withdrawals'
    AND r.user_id = p_employee_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> COALESCE((p_expected ->> 'withdrawals')::integer, 0) THEN
    RAISE EXCEPTION 'Withdrawals of employee % do not all belong to the employee.', v_user.username;
  END IF;
  v_counts := v_counts || jsonb_build_object('withdrawals', v_rows);

  INSERT INTO public.wallet_reconciliation_audit (user_id, available_before, available_after, frozen_before,
    frozen_after, income_before, income_after, pending_amount, ledger_total, reason, repaired_at)
  SELECT r.user_id, r.available_before, r.available_after, r.frozen_before, r.frozen_after, r.income_before,
    r.income_after, r.pending_amount, r.ledger_total, r.reason, COALESCE(r.repaired_at, now())
  FROM private.employee_transfer_staging AS staged
  CROSS JOIN LATERAL jsonb_to_recordset(staged.payload) AS r(user_id uuid, available_before numeric,
    available_after numeric, frozen_before numeric, frozen_after numeric, income_before numeric, income_after numeric,
    pending_amount numeric, ledger_total numeric, reason text, repaired_at timestamptz, id bigint)
  WHERE staged.job_id = v_job.id AND staged.employee_id = p_employee_id AND staged.table_key = 'reconciliation_audit'
    AND r.user_id = p_employee_id
  ORDER BY staged.chunk_no, r.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> COALESCE((p_expected ->> 'reconciliation_audit')::integer, 0) THEN
    RAISE EXCEPTION 'Reconciliation audit rows of employee % do not all belong to the employee.', v_user.username;
  END IF;
  v_counts := v_counts || jsonb_build_object('reconciliation_audit', v_rows);

  INSERT INTO public.verification_requests (id, user_id, real_name, wallet_address, phone, email, status, audit_remark,
    audited_by, audited_at, created_at, updated_at, id_front_url, id_back_url, selfie_url)
  SELECT r.id, r.user_id, r.real_name, r.wallet_address, r.phone, r.email, r.status, r.audit_remark,
    private.employee_transfer_admin_ref(v_job, r.audited_by, r.audited_by_username), r.audited_at,
    COALESCE(r.created_at, now()), COALESCE(r.updated_at, now()), r.id_front_url, r.id_back_url, r.selfie_url
  FROM private.employee_transfer_staging AS staged
  CROSS JOIN LATERAL jsonb_to_recordset(staged.payload) AS r(id uuid, user_id uuid, real_name text, wallet_address text,
    phone text, email text, status text, audit_remark text, audited_by uuid, audited_by_username text, audited_at timestamptz,
    created_at timestamptz, updated_at timestamptz, id_front_url text, id_back_url text, selfie_url text)
  WHERE staged.job_id = v_job.id AND staged.employee_id = p_employee_id AND staged.table_key = 'verification'
    AND r.user_id = p_employee_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> COALESCE((p_expected ->> 'verification')::integer, 0) THEN
    RAISE EXCEPTION 'Verification requests of employee % do not all belong to the employee.', v_user.username;
  END IF;
  v_counts := v_counts || jsonb_build_object('verification', v_rows);

  -- Same formula as reconcile_wallet_from_ledger.
  SELECT * INTO v_wallet_row FROM public.wallets WHERE user_id = p_employee_id;
  SELECT COALESCE(sum(amount), 0) INTO v_pending FROM public.withdrawals WHERE user_id = p_employee_id AND status = 'pending';
  IF v_wallet_row.user_id IS NULL THEN
    RAISE EXCEPTION 'Employee % has no wallet after the import.', v_user.username;
  END IF;
  IF v_wallet_row.frozen_balance IS DISTINCT FROM v_pending THEN
    RAISE EXCEPTION 'Frozen balance of employee % (%) does not equal the pending withdrawals (%).',
      v_user.username, v_wallet_row.frozen_balance, v_pending;
  END IF;
  IF v_baseline IS NOT NULL THEN
    SELECT COALESCE(sum(available_delta), 0), COALESCE(sum(frozen_delta), 0), COALESCE(sum(income_delta), 0)
    INTO v_available_delta, v_frozen_delta, v_income_delta
    FROM public.wallet_ledger_entries WHERE user_id = p_employee_id AND id > v_new_cursor;
    SELECT COALESCE(total_income, 0) INTO v_income FROM public.users WHERE id = p_employee_id;
    IF v_wallet_row.available_balance + v_wallet_row.frozen_balance IS DISTINCT FROM
      (SELECT baseline.available_balance + baseline.frozen_balance FROM public.wallet_balance_baselines AS baseline
        WHERE baseline.user_id = p_employee_id) + v_available_delta + v_frozen_delta THEN
      RAISE EXCEPTION 'The wallet of employee % does not match its ledger (balance %, expected %).',
        v_user.username, v_wallet_row.available_balance + v_wallet_row.frozen_balance,
        (SELECT baseline.available_balance + baseline.frozen_balance FROM public.wallet_balance_baselines AS baseline
          WHERE baseline.user_id = p_employee_id) + v_available_delta + v_frozen_delta;
    END IF;
    IF v_income IS DISTINCT FROM (SELECT baseline.total_income FROM public.wallet_balance_baselines AS baseline
      WHERE baseline.user_id = p_employee_id) + v_income_delta THEN
      RAISE EXCEPTION 'Total income of employee % does not match its ledger.', v_user.username;
    END IF;
  END IF;

  PERFORM private.employee_transfer_restore_triggers(v_disabled);
  DELETE FROM private.employee_transfer_staging WHERE job_id = v_job.id AND employee_id = p_employee_id;
  PERFORM private.employee_transfer_log(v_job.id, v_job.admin_id, v_job.admin_username, 'import', 'import_core',
    jsonb_build_object('employee_id', p_employee_id, 'username', v_user.username,
      'is_active', COALESCE(v_user.is_active, true), 'counts', v_counts,
      'ledger_cursor', jsonb_build_object('old', v_old_cursor, 'new', v_new_cursor)));
  RETURN jsonb_build_object('success', true, 'employee_id', p_employee_id, 'counts', v_counts,
    'wallet', jsonb_build_object('available', v_wallet_row.available_balance, 'frozen', v_wallet_row.frozen_balance));
END;
$$;

CREATE FUNCTION public.employee_import_rows_batch(
  p_admin_session_token uuid, p_job_token uuid, p_employee_id uuid, p_table_key text, p_rows jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s'
SET lock_timeout = '30s' AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_received integer; v_rows integer; v_disabled jsonb; v_username text; v_default_admin uuid;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'import');
  PERFORM private.employee_transfer_assert_job_employee(v_job, p_employee_id);
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Rows must be a list.'; END IF;
  v_received := jsonb_array_length(p_rows);
  IF v_received > 5000 THEN RAISE EXCEPTION 'Too many rows in one batch.'; END IF;
  IF v_received = 0 THEN RETURN jsonb_build_object('success', true, 'received', 0, 'inserted', 0); END IF;
  SELECT username INTO v_username FROM public.users WHERE id = p_employee_id;
  v_default_admin := COALESCE(v_job.default_admin_id, v_job.admin_id);

  IF p_table_key = 'orders' THEN
    IF v_job.placeholder_product_id IS NULL THEN RAISE EXCEPTION 'The placeholder product is missing.'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS r(user_id uuid, status text)
      WHERE r.user_id IS DISTINCT FROM p_employee_id OR r.status NOT IN ('success', 'failure')) THEN
      RAISE EXCEPTION 'Order rows must belong to the employee and be completed.';
    END IF;
    v_disabled := private.employee_transfer_bypass_triggers(ARRAY['orders']);
    INSERT INTO public.orders (id, user_id, username, product_type_id, product_value, order_number, transaction_id,
      status, commission_amount, commission_rate, processed_at, created_at)
    SELECT r.id, p_employee_id, v_username, v_job.placeholder_product_id, 0.01, 'IMPORTED-' || r.id::text,
      'IMPORTED-' || r.id::text, r.status, r.commission_amount, r.commission_rate, r.processed_at,
      COALESCE(r.created_at, now())
    FROM jsonb_to_recordset(p_rows) AS r(id uuid, user_id uuid, status text, commission_amount numeric,
      commission_rate numeric, created_at timestamptz, processed_at timestamptz)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    PERFORM private.employee_transfer_restore_triggers(v_disabled);

  ELSIF p_table_key = 'messages' THEN
    INSERT INTO public.messages (id, sender_id, sender_username, title, content, message_type, priority, expires_at,
      created_at, notification_category, reward_amount, reward_currency, audit_origin, delivery_mode)
    SELECT r.id, COALESCE(private.employee_transfer_admin_ref(v_job, r.sender_id, r.sender_username), v_default_admin),
      r.sender_username, r.title, r.content, r.message_type, COALESCE(r.priority, 'normal'), r.expires_at,
      COALESCE(r.created_at, now()), COALESCE(r.notification_category, 'standard'), r.reward_amount, r.reward_currency,
      CASE WHEN r.audit_origin = 'manual_admin' THEN 'manual_admin' ELSE 'unverified' END,
      COALESCE(r.delivery_mode, 'realtime_only')
    FROM jsonb_to_recordset(p_rows) AS r(id uuid, sender_id uuid, sender_username text, title text, content text,
      message_type text, priority text, expires_at timestamptz, created_at timestamptz, notification_category text,
      reward_amount numeric, reward_currency text, audit_origin text, delivery_mode text)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

  ELSIF p_table_key = 'message_recipients' THEN
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS r(recipient_id uuid) WHERE r.recipient_id IS DISTINCT FROM p_employee_id) THEN
      RAISE EXCEPTION 'Notification recipients must be the imported employee.';
    END IF;
    INSERT INTO public.message_recipients (id, message_id, recipient_id, is_read, read_at, is_shown, shown_at,
      created_at, delivery_channel, delivered_at)
    SELECT r.id, r.message_id, p_employee_id, COALESCE(r.is_read, false), r.read_at, COALESCE(r.is_shown, false), r.shown_at,
      COALESCE(r.created_at, now()), r.delivery_channel, r.delivered_at
    FROM jsonb_to_recordset(p_rows) AS r(id uuid, message_id uuid, recipient_id uuid, is_read boolean, read_at timestamptz,
      is_shown boolean, shown_at timestamptz, created_at timestamptz, delivery_channel text, delivered_at timestamptz)
    WHERE EXISTS (SELECT 1 FROM public.messages AS message WHERE message.id = r.message_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

  ELSIF p_table_key = 'employee_login_history' THEN
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS r(user_id uuid) WHERE r.user_id IS DISTINCT FROM p_employee_id) THEN
      RAISE EXCEPTION 'Login history rows must belong to the employee.';
    END IF;
    v_disabled := private.employee_transfer_bypass_triggers(ARRAY['employee_login_history']);
    INSERT INTO public.employee_login_history (id, user_id, username, employee_id, action_type, ip_address, user_agent,
      session_id, created_at, device_info)
    SELECT r.id, p_employee_id, r.username, r.employee_id, r.action_type, r.ip_address, r.user_agent, r.session_id,
      COALESCE(r.created_at, now()), r.device_info
    FROM jsonb_to_recordset(p_rows) AS r(id uuid, user_id uuid, username text, employee_id text, action_type text,
      ip_address text, user_agent text, session_id text, created_at timestamptz, device_info jsonb)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    PERFORM private.employee_transfer_restore_triggers(v_disabled);

  ELSIF p_table_key = 'work_sessions' THEN
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS r(user_id uuid) WHERE r.user_id IS DISTINCT FROM p_employee_id) THEN
      RAISE EXCEPTION 'Work sessions must belong to the employee.';
    END IF;
    v_disabled := private.employee_transfer_bypass_triggers(ARRAY['work_sessions']);
    INSERT INTO public.work_sessions (id, user_id, start_time, end_time, duration_minutes, created_at, last_heartbeat_at)
    SELECT r.id, p_employee_id, r.start_time,
      COALESCE(r.end_time, GREATEST(r.start_time, COALESCE(r.last_heartbeat_at, r.start_time))),
      CASE WHEN r.end_time IS NOT NULL THEN r.duration_minutes
        ELSE GREATEST(0, (extract(epoch FROM GREATEST(r.start_time, COALESCE(r.last_heartbeat_at, r.start_time)) - r.start_time) / 60)::integer) END,
      COALESCE(r.created_at, now()), r.last_heartbeat_at
    FROM jsonb_to_recordset(p_rows) AS r(id uuid, user_id uuid, start_time timestamptz, end_time timestamptz,
      duration_minutes integer, created_at timestamptz, last_heartbeat_at timestamptz)
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    PERFORM private.employee_transfer_restore_triggers(v_disabled);

  ELSE
    RAISE EXCEPTION 'Unsupported import table: %', p_table_key;
  END IF;

  RETURN jsonb_build_object('success', true, 'received', v_received, 'inserted', v_rows);
END;
$$;

CREATE FUNCTION public.employee_import_chat_batch(
  p_admin_session_token uuid, p_job_token uuid, p_employee_id uuid, p_table_key text, p_rows jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_received integer; v_rows integer := 0; v_extra integer := 0; v_map jsonb;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'import');
  PERFORM private.employee_transfer_assert_job_employee(v_job, p_employee_id);
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Rows must be a list.'; END IF;
  v_received := jsonb_array_length(p_rows);
  IF v_received > 5000 THEN RAISE EXCEPTION 'Too many rows in one batch.'; END IF;
  IF v_received = 0 THEN RETURN jsonb_build_object('success', true, 'received', 0, 'inserted', 0); END IF;
  v_map := v_job.role_map;

  IF p_table_key = 'chat_rich_cards' THEN
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS r(content_hash text, html_content text)
      WHERE r.html_content IS NULL OR r.content_hash IS DISTINCT FROM md5(r.html_content)) THEN
      RAISE EXCEPTION 'A rich-card snapshot does not match its content hash.';
    END IF;
    INSERT INTO public.rich_card_contents (html_content, content_hash)
    SELECT r.html_content, r.content_hash
    FROM jsonb_to_recordset(p_rows) AS r(content_hash text, html_content text)
    ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

  ELSIF p_table_key = 'chat_messages' THEN
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS r(employee_id uuid, customer_id uuid)
      WHERE r.employee_id IS DISTINCT FROM p_employee_id OR NOT (v_map ? r.customer_id::text)) THEN
      RAISE EXCEPTION 'A chat message belongs to another employee or to a chat role without a decision.';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS r(message_type text, rich_card_hash text)
      WHERE r.message_type = 'rich_card' AND NOT EXISTS (
        SELECT 1 FROM public.rich_card_contents AS card WHERE card.content_hash = r.rich_card_hash)) THEN
      RAISE EXCEPTION 'A rich-card message refers to a snapshot that was not imported.';
    END IF;
    INSERT INTO public.customer_employee_conversations (id, customer_id, employee_id, sender_type, message_content,
      is_read, created_at, message_type, image_url, rating_data, read_at, source_type, title, subtitle, rich_card_content_id)
    SELECT r.id, (v_map -> r.customer_id::text ->> 'new_id')::uuid, p_employee_id, r.sender_type, r.message_content,
      COALESCE(r.is_read, false), COALESCE(r.created_at, now()), r.message_type, r.image_url, r.rating_data, r.read_at,
      r.source_type, r.title, r.subtitle,
      CASE WHEN r.message_type = 'rich_card' THEN
        (SELECT card.id FROM public.rich_card_contents AS card WHERE card.content_hash = r.rich_card_hash) END
    FROM jsonb_to_recordset(p_rows) AS r(id uuid, customer_id uuid, employee_id uuid, sender_type text,
      message_content text, is_read boolean, created_at timestamptz, message_type text, image_url text,
      rating_data jsonb, read_at timestamptz, source_type text, title text, subtitle text, rich_card_hash text)
    ORDER BY r.created_at, r.id
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

  ELSIF p_table_key = 'chat_sessions' THEN
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS r(employee_id uuid, customer_id uuid)
      WHERE r.employee_id IS DISTINCT FROM p_employee_id OR NOT (v_map ? r.customer_id::text)) THEN
      RAISE EXCEPTION 'A service session belongs to another employee or to a chat role without a decision.';
    END IF;
    SELECT count(*)::integer INTO v_extra
    FROM jsonb_to_recordset(p_rows) AS r(service_ticket_number text)
    WHERE EXISTS (SELECT 1 FROM public.customer_service_sessions AS taken
      WHERE taken.service_ticket_number = r.service_ticket_number);
    INSERT INTO public.customer_service_sessions (id, customer_id, employee_id, service_ticket_number, status, created_at, closed_at)
    SELECT r.id, (v_map -> r.customer_id::text ->> 'new_id')::uuid, p_employee_id,
      CASE WHEN EXISTS (SELECT 1 FROM public.customer_service_sessions AS taken
        WHERE taken.service_ticket_number = r.service_ticket_number) THEN NULL ELSE r.service_ticket_number END,
      r.status, COALESCE(r.created_at, now()), r.closed_at
    FROM jsonb_to_recordset(p_rows) AS r(id uuid, customer_id uuid, employee_id uuid, service_ticket_number text,
      status text, created_at timestamptz, closed_at timestamptz)
    ORDER BY r.created_at, r.id
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

  ELSIF p_table_key = 'chat_annotations' THEN
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS r(employee_id uuid, customer_id uuid)
      WHERE r.employee_id IS DISTINCT FROM p_employee_id OR NOT (v_map ? r.customer_id::text)) THEN
      RAISE EXCEPTION 'An annotation belongs to another employee or to a chat role without a decision.';
    END IF;
    INSERT INTO public.ccc_conversation_annotations (customer_id, employee_id, owner_admin_id, is_special, note,
      updated_by, updated_at)
    SELECT (v_map -> r.customer_id::text ->> 'new_id')::uuid, p_employee_id,
      (SELECT customer.admin_id FROM public.simulated_customers AS customer
        WHERE customer.id = (v_map -> r.customer_id::text ->> 'new_id')::uuid),
      COALESCE(r.is_special, false), r.note,
      private.employee_transfer_admin_ref(v_job, r.updated_by, r.updated_by_username), COALESCE(r.updated_at, now())
    FROM jsonb_to_recordset(p_rows) AS r(customer_id uuid, employee_id uuid, is_special boolean, note text,
      updated_by uuid, updated_by_username text, updated_at timestamptz)
    ON CONFLICT (customer_id, employee_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

  ELSIF p_table_key = 'chat_auto_logs' THEN
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) AS r(employee_id uuid, customer_id uuid)
      WHERE r.employee_id IS DISTINCT FROM p_employee_id OR NOT (v_map ? r.customer_id::text)) THEN
      RAISE EXCEPTION 'An auto-message log belongs to another employee or to a chat role without a decision.';
    END IF;
    WITH matched AS (
      SELECT (v_map -> r.customer_id::text ->> 'new_id')::uuid AS customer_id, r.sent_at,
        (SELECT auto_message.id FROM public.customer_auto_messages AS auto_message
          WHERE auto_message.customer_id = (v_map -> r.customer_id::text ->> 'new_id')::uuid
            AND auto_message.message_type = r.message_type
            AND auto_message.title IS NOT DISTINCT FROM r.title
            AND auto_message.subtitle IS NOT DISTINCT FROM r.subtitle
            AND md5(auto_message.content) = r.content_md5
          ORDER BY auto_message.sort_order, auto_message.id LIMIT 1) AS auto_message_id
      FROM jsonb_to_recordset(p_rows) AS r(customer_id uuid, sent_at timestamptz, message_type text, title text,
        subtitle text, content_md5 text)),
    inserted AS (
      INSERT INTO public.customer_auto_message_logs (customer_id, employee_id, auto_message_id, sent_at)
      SELECT DISTINCT ON (matched.customer_id, matched.auto_message_id) matched.customer_id, p_employee_id,
        matched.auto_message_id, COALESCE(matched.sent_at, now())
      FROM matched
      WHERE matched.auto_message_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.customer_auto_message_logs AS log
          WHERE log.customer_id = matched.customer_id AND log.employee_id = p_employee_id
            AND log.auto_message_id = matched.auto_message_id)
      ORDER BY matched.customer_id, matched.auto_message_id, matched.sent_at
      RETURNING 1)
    SELECT count(*)::integer INTO v_rows FROM inserted;
    v_extra := v_received - (SELECT count(*)::integer FROM jsonb_to_recordset(p_rows) AS r(customer_id uuid, message_type text,
      title text, subtitle text, content_md5 text)
      WHERE EXISTS (SELECT 1 FROM public.customer_auto_messages AS auto_message
        WHERE auto_message.customer_id = (v_map -> r.customer_id::text ->> 'new_id')::uuid
          AND auto_message.message_type = r.message_type AND auto_message.title IS NOT DISTINCT FROM r.title
          AND auto_message.subtitle IS NOT DISTINCT FROM r.subtitle AND md5(auto_message.content) = r.content_md5));

  ELSE
    RAISE EXCEPTION 'Unsupported chat import table: %', p_table_key;
  END IF;

  RETURN jsonb_build_object('success', true, 'received', v_received, 'inserted', v_rows, 'extra', v_extra);
END;
$$;

CREATE FUNCTION private.employee_transfer_employee_counts(p_employee_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object(
    'ledger', (SELECT count(*) FROM public.wallet_ledger_entries WHERE user_id = p_employee_id),
    'transactions', (SELECT count(*) FROM public.wallet_transactions WHERE user_id = p_employee_id),
    'withdrawals', (SELECT count(*) FROM public.withdrawals WHERE user_id = p_employee_id),
    'pending_withdrawals', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount), 0))
      FROM public.withdrawals WHERE user_id = p_employee_id AND status = 'pending'),
    'reconciliation_audit', (SELECT count(*) FROM public.wallet_reconciliation_audit WHERE user_id = p_employee_id),
    'verification', (SELECT count(*) FROM public.verification_requests WHERE user_id = p_employee_id),
    'orders', (SELECT jsonb_build_object('count', count(*), 'success', count(*) FILTER (WHERE status = 'success'),
        'success_commission', COALESCE(sum(commission_amount) FILTER (WHERE status = 'success'), 0))
      FROM public.orders WHERE user_id = p_employee_id),
    'message_recipients', (SELECT count(*) FROM public.message_recipients WHERE recipient_id = p_employee_id),
    'employee_login_history', (SELECT count(*) FROM public.employee_login_history WHERE user_id = p_employee_id),
    'work_sessions', (SELECT count(*) FROM public.work_sessions WHERE user_id = p_employee_id),
    'chat_messages', (SELECT count(*) FROM public.customer_employee_conversations WHERE employee_id = p_employee_id),
    'chat_sessions', (SELECT count(*) FROM public.customer_service_sessions WHERE employee_id = p_employee_id),
    'chat_annotations', (SELECT count(*) FROM public.ccc_conversation_annotations WHERE employee_id = p_employee_id),
    'wallet', (SELECT jsonb_build_object('available', wallet.available_balance, 'frozen', wallet.frozen_balance)
      FROM public.wallets AS wallet WHERE wallet.user_id = p_employee_id),
    'total_income', (SELECT COALESCE(total_income, 0) FROM public.users WHERE id = p_employee_id));
$$;

-- Final checks for one employee; re-enables the account only when every count matches the manifest.
CREATE FUNCTION public.employee_import_finalize_employee(
  p_admin_session_token uuid, p_job_token uuid, p_employee_id uuid, p_expected jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_username text; v_active boolean; v_counts jsonb; v_problems jsonb := '[]'::jsonb; v_key text;
  v_expected numeric; v_actual numeric; v_entry record; v_new uuid;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'import');
  PERFORM private.employee_transfer_assert_job_employee(v_job, p_employee_id);
  SELECT username INTO v_username FROM public.users WHERE id = p_employee_id;
  SELECT COALESCE((event.details ->> 'is_active')::boolean, true) INTO v_active
  FROM private.employee_transfer_events AS event
  WHERE event.job_id = v_job.id AND event.action = 'import_core' AND event.details ->> 'employee_id' = p_employee_id::text
  ORDER BY event.id DESC LIMIT 1;
  v_counts := private.employee_transfer_employee_counts(p_employee_id);

  FOR v_key IN SELECT unnest(ARRAY['ledger', 'transactions', 'withdrawals', 'reconciliation_audit', 'verification',
    'message_recipients', 'employee_login_history', 'work_sessions', 'chat_messages', 'chat_sessions', 'chat_annotations'])
  LOOP
    IF p_expected ? v_key THEN
      v_expected := (p_expected ->> v_key)::numeric;
      v_actual := (v_counts ->> v_key)::numeric;
      IF v_actual IS DISTINCT FROM v_expected THEN
        v_problems := v_problems || jsonb_build_array(jsonb_build_object('table', v_key, 'expected', v_expected, 'actual', v_actual));
      END IF;
    END IF;
  END LOOP;
  IF p_expected ? 'orders' THEN
    IF (v_counts #>> '{orders,count}')::numeric IS DISTINCT FROM (p_expected #>> '{orders,count}')::numeric THEN
      v_problems := v_problems || jsonb_build_array(jsonb_build_object('table', 'orders',
        'expected', p_expected #>> '{orders,count}', 'actual', v_counts #>> '{orders,count}'));
    END IF;
    IF (v_counts #>> '{orders,success_commission}')::numeric IS DISTINCT FROM (p_expected #>> '{orders,success_commission}')::numeric THEN
      v_problems := v_problems || jsonb_build_array(jsonb_build_object('table', 'orders.success_commission',
        'expected', p_expected #>> '{orders,success_commission}', 'actual', v_counts #>> '{orders,success_commission}'));
    END IF;
  END IF;
  IF p_expected ? 'pending_withdrawals' THEN
    IF (v_counts #>> '{pending_withdrawals,count}')::numeric IS DISTINCT FROM (p_expected #>> '{pending_withdrawals,count}')::numeric
      OR (v_counts #>> '{pending_withdrawals,amount}')::numeric IS DISTINCT FROM (p_expected #>> '{pending_withdrawals,amount}')::numeric THEN
      v_problems := v_problems || jsonb_build_array(jsonb_build_object('table', 'pending_withdrawals'));
    END IF;
  END IF;
  IF p_expected ? 'wallet' AND (
    (v_counts #>> '{wallet,available}')::numeric IS DISTINCT FROM (p_expected #>> '{wallet,available}')::numeric
    OR (v_counts #>> '{wallet,frozen}')::numeric IS DISTINCT FROM (p_expected #>> '{wallet,frozen}')::numeric) THEN
    v_problems := v_problems || jsonb_build_array(jsonb_build_object('table', 'wallet'));
  END IF;
  IF p_expected ? 'total_income' AND (v_counts ->> 'total_income')::numeric IS DISTINCT FROM (p_expected ->> 'total_income')::numeric THEN
    v_problems := v_problems || jsonb_build_array(jsonb_build_object('table', 'total_income'));
  END IF;

  IF jsonb_array_length(v_problems) = 0 THEN
    -- Chat roles that restrict their employees: make the imported employee visible again.
    FOR v_entry IN SELECT item.key AS old_id, item.value AS role FROM jsonb_each(v_job.role_map) AS item
    LOOP
      v_new := (v_entry.role ->> 'new_id')::uuid;
      IF NOT (EXISTS (SELECT 1 FROM public.customer_employee_conversations WHERE employee_id = p_employee_id AND customer_id = v_new)
        OR EXISTS (SELECT 1 FROM public.customer_service_sessions WHERE employee_id = p_employee_id AND customer_id = v_new)
        OR EXISTS (SELECT 1 FROM public.ccc_conversation_annotations WHERE employee_id = p_employee_id AND customer_id = v_new)) THEN
        CONTINUE;
      END IF;
      IF COALESCE((v_entry.role ->> 'merged')::boolean, false) THEN
        IF COALESCE((v_entry.role ->> 'make_visible')::boolean, false) THEN
          UPDATE public.simulated_customers
          SET target_employee_ids = array_append(target_employee_ids, p_employee_id)
          WHERE id = v_new AND cardinality(COALESCE(target_employee_ids, '{}')) > 0
            AND NOT (p_employee_id = ANY (target_employee_ids));
        END IF;
      ELSIF v_entry.role -> 'old_targets' ? p_employee_id::text THEN
        UPDATE public.simulated_customers
        SET target_employee_ids = CASE WHEN p_employee_id = ANY (COALESCE(target_employee_ids, '{}')) THEN target_employee_ids
          ELSE array_append(COALESCE(target_employee_ids, '{}'), p_employee_id) END,
          target_employee_id = COALESCE(target_employee_id, CASE WHEN (v_entry.role ->> 'old_target') = p_employee_id::text THEN p_employee_id END)
        WHERE id = v_new;
      END IF;
    END LOOP;
    UPDATE public.users SET is_active = v_active WHERE id = p_employee_id;
  END IF;

  PERFORM private.employee_transfer_log(v_job.id, v_job.admin_id, v_job.admin_username, 'import', 'import_finalize',
    jsonb_build_object('employee_id', p_employee_id, 'username', v_username, 'ok', jsonb_array_length(v_problems) = 0,
      'is_active', v_active, 'counts', v_counts, 'problems', v_problems));
  RETURN jsonb_build_object('success', true, 'ok', jsonb_array_length(v_problems) = 0, 'employee_id', p_employee_id,
    'username', v_username, 'is_active', CASE WHEN jsonb_array_length(v_problems) = 0 THEN v_active ELSE false END,
    'counts', v_counts, 'problems', v_problems);
END;
$$;

CREATE FUNCTION public.get_employee_import_verify(p_admin_session_token uuid, p_job_token uuid, p_employee_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'import');
  IF cardinality(COALESCE(p_employee_ids, '{}')) > 500 THEN RAISE EXCEPTION 'Too many employees to verify at once.'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('employee_id', employee.id, 'username', employee.username,
      'is_active', employee.is_active, 'counts', private.employee_transfer_employee_counts(employee.id))
      ORDER BY employee.username)
    FROM public.users AS employee WHERE employee.id = ANY (p_employee_ids) AND employee.archived_at IS NULL), '[]'::jsonb);
END;
$$;

CREATE FUNCTION public.employee_import_finish(p_admin_session_token uuid, p_job_token uuid, p_summary jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'import');
  PERFORM private.employee_transfer_end_job(v_job, 'finished', COALESCE(p_summary, '{}'::jsonb));
  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_admin_ref(private.employee_transfer_jobs, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_assert_job_employee(private.employee_transfer_jobs, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_employee_counts(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.employee_import_stage_chunk(uuid, uuid, uuid, text, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_import_apply_core(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_import_rows_batch(uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_import_chat_batch(uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_import_finalize_employee(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_import_verify(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_import_finish(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_stage_chunk(uuid, uuid, uuid, text, integer, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_apply_core(uuid, uuid, uuid, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_rows_batch(uuid, uuid, uuid, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_chat_batch(uuid, uuid, uuid, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_finalize_employee(uuid, uuid, uuid, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_import_verify(uuid, uuid, uuid[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_finish(uuid, uuid, jsonb) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
