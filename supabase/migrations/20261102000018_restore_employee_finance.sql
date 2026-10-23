BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

DO $install_finance_audit$
DECLARE v_expected constant jsonb:='{
 "wallet_transactions.prevent_delete_wallet_transactions": "912c2e783c29bfbd67be268ac21aab57173378a0158bd685175e0b840c967bd7",
 "wallet_transactions.queue_notification_automation_from_wallet_transaction": "e31a28ee84b9b0155b90bbfb9e1ee8b73fb8c8c2aa9047ee6195f2342539e553",
 "wallet_transactions.trigger_audit_commission_transaction": "14ad25ce345fd06c401533c9333d17366614942f9257ce8dfaf35466adaf7f50",
 "wallet_transactions.trigger_reverse_deleted_wallet_transaction_ledger": "7cefef658c658bb991d984977d9442952f4253e27d9dd80b65ff05060b54ddeb",
 "wallet_transactions.trigger_track_wallet_transaction_ledger": "34eeddb69d09fcac7f1c92f8cd70e94e927e1b33b2ca2093ff58df4f538446b9",
 "wallets.prevent_delete_wallets": "7d493b1e1bc89f9acdfa68425055800aad773c3a2ed9b79504d7f93054340428",
 "wallets.trigger_enqueue_changed_wallet": "ee885054e5eca6816bba0edea92631df992e80f14e4a01d24e737ed98da072ae",
 "withdrawals.prevent_delete_withdrawals": "5c6c8c1c0906ee977fd09176c9a2f405676f1085f6681428ff36134dcaf338d8",
 "withdrawals.trigger_track_withdrawal_ledger": "b109dc28ab0ce522bdf703ab316d2eddf7265711b777548fa5dd57f031bd8dec",
 "withdrawals.withdrawals_emit_event": "9b00c2611c0d38629e5a74c240b2a5d11c5c7ee4163ac98eef1dfff05eaf51e7"
}';v_native jsonb; v_actual jsonb;v_modes jsonb;
BEGIN
  SELECT jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_install_trigger_digest(t.oid)),jsonb_object_agg(c.relname||'.'||t.tgname,t.tgenabled::text),
    jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_trigger_digest(t.oid))
    INTO v_actual,v_modes,v_native FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace
      AND c.relname IN ('wallets','wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit')
      AND NOT t.tgisinternal AND t.tgname<>'zz_employee_transfer_maintenance';
  IF v_actual IS DISTINCT FROM v_expected OR EXISTS(SELECT 1 FROM jsonb_each_text(v_modes) WHERE value NOT IN ('O','A')) THEN RAISE EXCEPTION 'Unreviewed employee finance triggers.';END IF;
  EXECUTE format($definition$
    CREATE FUNCTION private.employee_transfer_assert_finance_triggers()
    RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, private, pg_temp AS $body$
    DECLARE v_expected constant jsonb:=%L::jsonb;v_modes constant jsonb:=%L::jsonb;v_actual jsonb;v_actual_modes jsonb;
    BEGIN
      PERFORM private.employee_transfer_assert_maintenance_guards();
      SELECT jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_trigger_digest(t.oid)),jsonb_object_agg(c.relname||'.'||t.tgname,t.tgenabled::text)
        INTO v_actual,v_actual_modes FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace
          AND c.relname IN ('wallets','wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit')
          AND NOT t.tgisinternal AND t.tgname<>'zz_employee_transfer_maintenance';
      IF v_actual IS DISTINCT FROM v_expected OR v_actual_modes IS DISTINCT FROM v_modes THEN RAISE EXCEPTION 'Unreviewed employee finance triggers.';END IF;
    END;
    $body$;
  $definition$,v_native::text,v_modes::text);
END;
$install_finance_audit$;

CREATE FUNCTION private.employee_transfer_finance_context(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb;
BEGIN
  v_map:=private.employee_transfer_finance_owner(p_job);
  PERFORM private.employee_transfer_assert_finance_triggers();
  PERFORM private.employee_transfer_dependency_owner(p_job);
  PERFORM private.employee_transfer_check_dependency_progress(p_job,v_map);
  RETURN v_map;
END;
$$;

CREATE FUNCTION private.employee_transfer_finance_source_issues(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_issues jsonb:='[]';v_key text;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['wallets','wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit'] LOOP
    IF EXISTS(WITH accounts AS MATERIALIZED(SELECT id FROM private.employee_transfer_identity_input(p_job.id,'accounts'))
      SELECT 1 FROM private.employee_transfer_finance_input(p_job.id,v_key) AS f LEFT JOIN accounts AS a ON a.id=(f.body->>'user_id')::uuid WHERE a.id IS NULL) THEN
      RETURN '["source_employee_missing"]'::jsonb;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') AS a
    LEFT JOIN private.employee_transfer_finance_input(p_job.id,'wallets') AS w ON w.id=a.id::text WHERE w.id IS NULL) THEN
    v_issues:=v_issues||'"source_employee_missing"'::jsonb;
  END IF;
  IF EXISTS(WITH accounts AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_identity_input(p_job.id,'accounts')),
    wallets AS MATERIALIZED(SELECT body FROM private.employee_transfer_finance_input(p_job.id,'wallets')),
    baselines AS MATERIALIZED(SELECT body FROM private.employee_transfer_finance_input(p_job.id,'wallet_balance_baselines')),
    ledger AS MATERIALIZED(SELECT body FROM private.employee_transfer_finance_input(p_job.id,'wallet_ledger_entries')),
    pending AS (SELECT body->>'user_id' AS owner,sum((body->>'amount')::numeric) AS amount FROM private.employee_transfer_finance_input(p_job.id,'withdrawals') WHERE body->>'status'='pending' GROUP BY body->>'user_id')
    SELECT 1 FROM accounts AS a JOIN wallets AS w ON w.body->>'user_id'=a.id::text LEFT JOIN baselines AS b ON b.body->>'user_id'=a.id::text
      LEFT JOIN pending AS p ON p.owner=a.id::text LEFT JOIN LATERAL(
        SELECT COALESCE(sum((body->>'available_delta')::numeric+(body->>'frozen_delta')::numeric),0) AS total,
          COALESCE(sum((body->>'income_delta')::numeric),0) AS income FROM ledger WHERE body->>'user_id'=a.id::text AND (body->>'id')::bigint>(b.body->>'last_ledger_id')::bigint
      ) AS d ON true
    WHERE w.body->>'available_balance' IS NULL OR w.body->>'frozen_balance' IS NULL
      OR (w.body->>'frozen_balance')::numeric IS DISTINCT FROM COALESCE(p.amount,0)
      OR (b.body IS NOT NULL AND ((w.body->>'available_balance')::numeric+(w.body->>'frozen_balance')::numeric IS DISTINCT FROM
        (b.body->>'available_balance')::numeric+(b.body->>'frozen_balance')::numeric+d.total
        OR COALESCE((a.body->>'total_income')::numeric,0) IS DISTINCT FROM (b.body->>'total_income')::numeric+d.income))) THEN
    v_issues:=v_issues||'"inconsistent_source_finance"'::jsonb;
  END IF;
  RETURN v_issues;
END;
$$;

CREATE FUNCTION private.employee_transfer_finance_target_issues(p_job private.employee_transfer_jobs,p_employee uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;v_bad boolean;v_issues jsonb:='[]';
BEGIN
  IF EXISTS(SELECT 1 FROM public.wallets AS w JOIN private.employee_transfer_identity_input(p_job.id,'accounts') AS a ON a.id=w.user_id
    WHERE (p_employee IS NULL OR a.id=p_employee) AND (w.available_balance IS DISTINCT FROM 0::numeric OR w.frozen_balance IS DISTINCT FROM 0::numeric))
    OR EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') AS a LEFT JOIN public.wallets AS w ON w.user_id=a.id WHERE (p_employee IS NULL OR a.id=p_employee) AND w.user_id IS NULL) THEN
    v_issues:=v_issues||'"financial_target_not_empty"'::jsonb;
  END IF;
  FOREACH v_key IN ARRAY ARRAY['wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I AS t JOIN private.employee_transfer_identity_input($1,''accounts'') AS a ON a.id=t.user_id WHERE ($2::uuid IS NULL OR a.id=$2))',v_key) INTO v_bad USING p_job.id,p_employee;
    IF v_bad THEN RETURN CASE WHEN v_issues ? 'financial_target_not_empty' THEN v_issues ELSE v_issues||'"financial_target_not_empty"'::jsonb END;END IF;
  END LOOP;
  RETURN v_issues;
END;
$$;

CREATE FUNCTION private.employee_transfer_finance_plan(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_counts jsonb;v_issues jsonb;v_pending bigint;v_amount numeric;v_plan jsonb;
BEGIN
  v_counts:=private.employee_transfer_check_finance_input(p_job);
  v_issues:=private.employee_transfer_finance_source_issues(p_job)||private.employee_transfer_finance_target_issues(p_job);
  IF EXISTS(SELECT 1 FROM private.employee_transfer_finance_input(p_job.id,'wallet_transactions') AS s JOIN public.wallet_transactions AS t ON t.id=s.id::uuid)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_finance_input(p_job.id,'withdrawals') AS s JOIN public.withdrawals AS t ON t.id=s.id::uuid) THEN v_issues:=v_issues||'"financial_uuid_collision"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_finance_input(p_job.id,'wallet_transactions') AS s JOIN public.wallet_transactions AS t
    ON ((s.body->>'operation_id')::uuid=t.operation_id AND s.body->>'type'=t.type)
      OR (s.body->>'type'=t.type AND t.type IN ('tip','performance_bonus') AND (s.body->>'reference_id')::uuid=t.reference_id))
    OR EXISTS(SELECT 1 FROM private.employee_transfer_finance_input(p_job.id,'wallet_ledger_entries') AS s JOIN public.wallet_ledger_entries AS t
      ON (s.body->>'operation_id')::uuid=t.operation_id AND s.body->>'source_type'=t.source_type AND (s.body->>'source_id')::uuid=t.source_id AND s.body->>'event_type'=t.event_type)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_finance_input(p_job.id,'wallet_transactions') GROUP BY body->>'operation_id',body->>'type' HAVING body->>'operation_id' IS NOT NULL AND count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_finance_input(p_job.id,'wallet_transactions') WHERE body->>'type' IN ('tip','performance_bonus') AND body->>'reference_id' IS NOT NULL GROUP BY body->>'type',body->>'reference_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_finance_input(p_job.id,'wallet_transactions') WHERE body->>'type'='commission' GROUP BY body->>'user_id',body->>'reference_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_finance_input(p_job.id,'wallet_ledger_entries') GROUP BY body->>'operation_id',body->>'source_type',body->>'source_id',body->>'event_type' HAVING count(*)>1) THEN
    v_issues:=v_issues||'"financial_unique_collision"'::jsonb;
  END IF;
  IF EXISTS(SELECT 1 FROM (SELECT body->>'created_by' AS actor FROM private.employee_transfer_finance_input(p_job.id,'wallet_transactions') UNION
      SELECT body->>'audited_by' FROM private.employee_transfer_finance_input(p_job.id,'withdrawals')) AS s
    LEFT JOIN public.admins AS a ON a.id=(p_map->>s.actor)::uuid WHERE s.actor IS NOT NULL AND a.id IS NULL) THEN v_issues:=v_issues||'"unmapped_administrator"'::jsonb;END IF;
  SELECT count(*),COALESCE(sum((body->>'amount')::numeric),0) INTO v_pending,v_amount FROM private.employee_transfer_finance_input(p_job.id,'withdrawals') WHERE body->>'status'='pending';
  v_plan:=jsonb_build_object('scope','employee-finance','can_restore',jsonb_array_length(v_issues)=0,'counts',v_counts,
    'employees',(p_job.summary#>>'{identity_catalog,tables,0,rows}')::bigint,'pending_withdrawals',jsonb_build_object('count',v_pending,'amount',v_amount::text),
    'conflicts',v_issues,'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,'job_id',p_job.id,
    'catalog',p_job.summary->'finance_catalog','admin_map',p_map)::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION private.employee_transfer_finance_expected(p_job private.employee_transfer_jobs,p_employee uuid,p_key text,p_map jsonb)
RETURNS TABLE(id text,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  PERFORM private.employee_transfer_finance_cursor_type(p_key);
  RETURN QUERY WITH mappings AS MATERIALIZED(
    SELECT item.value->>'old_id' AS old_id,item.value->>'new_id' AS new_id FROM private.employee_transfer_staging AS s CROSS JOIN LATERAL jsonb_array_elements(s.payload) AS item(value)
      WHERE s.job_id=p_job.id AND s.employee_id=p_employee AND s.table_key='finance-map:'||p_key
  ), cursor_map AS (
    SELECT COALESCE(max((item.value->>'new_id')::bigint),0)::text AS new_cursor FROM private.employee_transfer_staging AS s
      CROSS JOIN LATERAL jsonb_array_elements(s.payload) AS item(value) WHERE s.job_id=p_job.id AND s.employee_id=p_employee AND s.table_key='finance-map:wallet_ledger_entries'
      AND (item.value->>'old_id')::bigint<=(SELECT (b.body->>'last_ledger_id')::bigint FROM private.employee_transfer_finance_input(p_job.id,'wallet_balance_baselines') AS b WHERE b.id=p_employee::text)
  ) SELECT CASE WHEN p_key IN ('wallet_ledger_entries','wallet_reconciliation_audit') THEN m.new_id ELSE f.id END,
    f.body||CASE p_key
      WHEN 'wallet_ledger_entries' THEN jsonb_build_object('id',m.new_id)
      WHEN 'wallet_reconciliation_audit' THEN jsonb_build_object('id',m.new_id)
      WHEN 'wallet_balance_baselines' THEN jsonb_build_object('last_ledger_id',(SELECT new_cursor FROM cursor_map))
      WHEN 'wallet_transactions' THEN jsonb_build_object('created_by',p_map->(f.body->>'created_by'))
      WHEN 'withdrawals' THEN jsonb_build_object('audited_by',p_map->(f.body->>'audited_by'))
      ELSE '{}'::jsonb END
    FROM private.employee_transfer_finance_input(p_job.id,p_key) AS f LEFT JOIN mappings AS m ON m.old_id=f.id WHERE f.body->>'user_id'=p_employee::text;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_finance_written(p_job private.employee_transfer_jobs,p_employee uuid,p_map jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_expected bigint;v_actual bigint;v_bad boolean;v_counts jsonb:='{}';v_wallet public.wallets%ROWTYPE;v_baseline public.wallet_balance_baselines%ROWTYPE;v_pending numeric;v_total numeric;v_income numeric;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['wallets','wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit'] LOOP
    SELECT count(*) INTO v_expected FROM private.employee_transfer_finance_input(p_job.id,v_key) WHERE body->>'user_id'=p_employee::text;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id=$1',v_key) INTO v_actual USING p_employee;
    IF v_actual IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Finance committed count changed.';END IF;
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM private.employee_transfer_finance_expected($1,$2,$3,$4) AS expected LEFT JOIN ('||private.employee_transfer_finance_query(v_key)||') AS actual
      ON actual.id::text=expected.id AND actual.body=expected.body WHERE actual.id IS NULL)' INTO v_bad USING p_job,p_employee,v_key,p_map;
    IF v_bad THEN RAISE EXCEPTION 'Finance post-write content verification failed.';END IF;
    v_counts:=v_counts||jsonb_build_object(v_key,v_actual);
  END LOOP;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id=p_employee;SELECT * INTO v_baseline FROM public.wallet_balance_baselines WHERE user_id=p_employee;
  SELECT COALESCE(sum(amount),0) INTO v_pending FROM public.withdrawals WHERE user_id=p_employee AND status='pending';
  IF v_wallet.user_id IS NULL OR v_wallet.available_balance IS NULL OR v_wallet.frozen_balance IS DISTINCT FROM v_pending THEN RAISE EXCEPTION 'Finance pending withdrawals and frozen balance differ.';END IF;
  IF v_baseline.user_id IS NOT NULL THEN
    SELECT v_baseline.available_balance+v_baseline.frozen_balance+COALESCE(sum(available_delta+frozen_delta),0),v_baseline.total_income+COALESCE(sum(income_delta),0)
      INTO v_total,v_income FROM public.wallet_ledger_entries WHERE user_id=p_employee AND id>v_baseline.last_ledger_id;
    IF v_total IS DISTINCT FROM v_wallet.available_balance+v_wallet.frozen_balance OR v_income IS DISTINCT FROM (SELECT COALESCE(total_income,0) FROM public.users WHERE id=p_employee) THEN RAISE EXCEPTION 'Finance wallet/ledger/income reconciliation failed.';END IF;
  END IF;
  RETURN v_counts;
END;
$$;

CREATE FUNCTION private.employee_transfer_finance_progress(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_count bigint:=0;v_done record;v_actual jsonb;
BEGIN
  IF p_job.summary ? 'finance_restore' AND p_job.summary#>'{finance_restore,admin_map}' IS DISTINCT FROM p_map THEN RAISE EXCEPTION 'Finance administrator mapping changed.';END IF;
  FOR v_done IN SELECT employee_id,payload FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='finance-done' LOOP
    IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') WHERE id=v_done.employee_id)
      OR v_done.payload->>'plan_hash' IS DISTINCT FROM p_job.summary#>>'{finance_plan,plan_hash}' THEN RAISE EXCEPTION 'Finance completion binding changed.';END IF;
    v_actual:=private.employee_transfer_check_finance_written(p_job,v_done.employee_id,p_map);
    IF v_done.payload->'counts' IS DISTINCT FROM v_actual THEN RAISE EXCEPTION 'Finance completion counts changed.';END IF;
    v_count:=v_count+1;
  END LOOP;
  IF v_count IS DISTINCT FROM COALESCE((p_job.summary#>>'{finance_restore,completed_employees}')::bigint,0) THEN RAISE EXCEPTION 'Finance committed progress changed.';END IF;
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.get_employee_import_finance_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_map jsonb;v_plan jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_finance_context(v_job);
  IF v_job.summary ? 'finance_restore' THEN PERFORM private.employee_transfer_check_finance_input(v_job);PERFORM private.employee_transfer_finance_progress(v_job,v_map);RETURN v_job.summary->'finance_plan';END IF;
  v_plan:=private.employee_transfer_finance_plan(v_job,v_map);
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('finance_plan',v_plan) WHERE id=v_job.id;RETURN v_plan;
END;
$$;

CREATE FUNCTION private.employee_transfer_allow_finance_write(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  PERFORM private.employee_transfer_finance_owner(p_job);
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names) VALUES(pg_current_xact_id(),p_job.id,
    ARRAY['public.wallets','public.wallet_balance_baselines','public.wallet_ledger_entries','public.wallet_transactions','public.withdrawals','public.wallet_reconciliation_audit']);
END;
$$;

CREATE FUNCTION private.employee_transfer_finance_receipt(p_employee uuid,p_counts jsonb,p_completed bigint,p_total bigint,p_repeated boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object('success',true,'scope','employee-finance','counts',p_counts,'completed_employees',p_completed,'total_employees',p_total,
    'verified',true,'repeated',p_repeated,'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false)
    ||CASE WHEN p_employee IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('employee_id',p_employee) END;
$$;

CREATE FUNCTION public.employee_import_finance_apply(p_admin_session_token uuid,p_job_token uuid,p_employee_id uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_map jsonb;v_plan jsonb;v_completed bigint;v_total bigint;v_counts jsonb;v_done jsonb;v_disabled jsonb;v_key text;
  v_stage record;v_row jsonb;v_mapping jsonb;v_old_id text;v_new_id bigint;v_columns text;v_cursor bigint;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_finance_context(v_job);PERFORM private.employee_transfer_check_finance_input(v_job);
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_job.summary#>>'{finance_plan,plan_hash}' OR v_job.summary#>'{finance_plan,can_restore}' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'A matching conflict-free finance plan must be confirmed.';END IF;
  IF p_employee_id IS NULL OR NOT EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(v_job.id,'accounts') WHERE id=p_employee_id) THEN RAISE EXCEPTION 'Finance employee is not a verified member of this source package.';END IF;
  v_total:=(v_job.summary#>>'{finance_plan,employees}')::bigint;v_completed:=private.employee_transfer_finance_progress(v_job,v_map);
  SELECT payload INTO v_done FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id=p_employee_id AND table_key='finance-done' AND chunk_no=0;
  IF v_done IS NOT NULL THEN RETURN private.employee_transfer_finance_receipt(p_employee_id,v_done->'counts',v_completed,v_total,true);END IF;
  IF NOT v_job.summary ? 'finance_restore' THEN
    v_plan:=private.employee_transfer_finance_plan(v_job,v_map);
    IF v_plan IS DISTINCT FROM v_job.summary->'finance_plan' THEN RAISE EXCEPTION 'Finance plan or target changed.';END IF;
  ELSIF private.employee_transfer_finance_target_issues(v_job,p_employee_id)<>'[]'::jsonb THEN RAISE EXCEPTION 'Employee finance target changed or is no longer empty.';END IF;
  PERFORM private.employee_transfer_allow_finance_write(v_job);
  v_disabled:=private.employee_transfer_bypass_triggers(ARRAY['wallets','wallet_transactions','withdrawals']);
  FOREACH v_key IN ARRAY ARRAY['wallet_ledger_entries','wallet_reconciliation_audit'] LOOP
    FOR v_stage IN SELECT chunk_no,payload->'rows' AS rows FROM private.employee_transfer_staging WHERE job_id=v_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='finance-in:'||v_key ORDER BY chunk_no LOOP
      v_mapping:='[]';
      FOR v_row IN SELECT value FROM jsonb_array_elements(v_stage.rows) WHERE value->>'user_id'=p_employee_id::text ORDER BY (value->>'id')::bigint LOOP
        v_old_id:=v_row->>'id';
        SELECT nextval(pg_get_serial_sequence('public.'||v_key,'id')::regclass) INTO v_new_id;
        v_mapping:=v_mapping||jsonb_build_array(jsonb_build_object('old_id',v_old_id,'new_id',v_new_id::text));
        v_row:=v_row||jsonb_build_object('id',v_new_id::text);PERFORM private.employee_transfer_check_finance_row(v_key,v_row);
        SELECT string_agg(format('%I',key),',' ORDER BY key COLLATE "C") INTO v_columns FROM jsonb_each(private.employee_transfer_finance_spec()->v_key);
        EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) AS r',v_key,v_columns,v_columns,v_key) USING v_row;
      END LOOP;
      IF jsonb_array_length(v_mapping)>0 THEN INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
        VALUES(v_job.id,p_employee_id,'finance-map:'||v_key,v_stage.chunk_no,jsonb_array_length(v_mapping),v_mapping);END IF;
    END LOOP;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['wallets','wallet_balance_baselines','wallet_transactions','withdrawals'] LOOP
    FOR v_row IN SELECT body FROM private.employee_transfer_finance_expected(v_job,p_employee_id,v_key,v_map) LOOP
      PERFORM private.employee_transfer_check_finance_row(v_key,v_row);
      IF v_key='wallets' THEN
        UPDATE public.wallets SET available_balance=(v_row->>'available_balance')::numeric,frozen_balance=(v_row->>'frozen_balance')::numeric,
          created_at=(v_row->>'created_at')::timestamptz,updated_at=(v_row->>'updated_at')::timestamptz WHERE user_id=p_employee_id;
      ELSE
        SELECT string_agg(format('%I',key),',' ORDER BY key COLLATE "C") INTO v_columns FROM jsonb_each(private.employee_transfer_finance_spec()->v_key) WHERE NOT(v_key='wallet_balance_baselines' AND key='id');
        EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) AS r',v_key,v_columns,v_columns,v_key) USING v_row;
      END IF;
    END LOOP;
  END LOOP;
  PERFORM private.employee_transfer_restore_triggers(v_disabled);PERFORM private.employee_transfer_clear_write_permit();PERFORM private.employee_transfer_assert_finance_triggers();
  v_counts:=private.employee_transfer_check_finance_written(v_job,p_employee_id,v_map);v_completed:=v_completed+1;
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('finance_restore',jsonb_build_object('completed_employees',v_completed,'admin_map',v_map,'verified',false)) WHERE id=v_job.id;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,p_employee_id,'finance-done',0,1,jsonb_build_object('plan_hash',p_plan_hash,'counts',v_counts));
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','finance_employee_restored',jsonb_build_object('employee_id',p_employee_id,'counts',v_counts,'full_site_complete',false));
  RETURN private.employee_transfer_finance_receipt(p_employee_id,v_counts,v_completed,v_total,false);
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit();RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_finance_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_map jsonb;v_counts jsonb;v_completed bigint;v_total bigint;v_repeated boolean;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');v_map:=private.employee_transfer_finance_context(v_job);
  v_counts:=private.employee_transfer_check_finance_input(v_job);v_completed:=private.employee_transfer_finance_progress(v_job,v_map);v_total:=(v_job.summary#>>'{finance_plan,employees}')::bigint;
  IF v_total IS NULL OR v_job.summary#>'{finance_plan,can_restore}' IS DISTINCT FROM 'true'::jsonb OR v_completed<>v_total THEN RAISE EXCEPTION 'Finance restore is incomplete.';END IF;
  v_repeated:=COALESCE((v_job.summary#>>'{finance_restore,verified}')::boolean,false);
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('finance_restore',jsonb_build_object('completed_employees',v_completed,'admin_map',v_map,'verified',true)) WHERE id=v_job.id;
  IF NOT v_repeated THEN PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','finance_verified',jsonb_build_object('counts',v_counts,'full_site_complete',false));END IF;
  RETURN private.employee_transfer_finance_receipt(NULL,v_counts,v_completed,v_total,v_repeated);
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);END LOOP;
  REVOKE ALL ON FUNCTION public.get_employee_import_finance_plan(uuid,uuid),public.employee_import_finance_apply(uuid,uuid,uuid,text),public.employee_import_finance_verify(uuid,uuid) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.get_employee_import_finance_plan(uuid,uuid),public.employee_import_finance_apply(uuid,uuid,uuid,text),public.employee_import_finance_verify(uuid,uuid) TO anon,authenticated;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
