-- Read-only prerequisites, NOT employee backup, archive authorization or replacement.
-- No task heartbeat, business mutation, write permit, trigger change or saved-backup claim.
BEGIN;

CREATE FUNCTION private.employee_transfer_replacement_owner(p_session uuid,p_token uuid)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid;v_job private.employee_transfer_jobs%ROWTYPE;v_chunk record;v_line text;v_json json;
  v_rows jsonb;v_hashes text;
BEGIN
  SELECT admin_id INTO v_admin FROM private.employee_transfer_admin(p_session);
  SELECT * INTO v_job FROM private.employee_transfer_jobs
    WHERE token_hash=private.hash_financial_token(p_token) AND admin_id=v_admin
      AND kind='import' AND status='running' AND options->>'import_protocol'='dispatch-submission-v1'
      AND last_activity_at>now()-interval '3 hours' AND started_at>now()-interval '12 hours';
  IF p_token IS NULL OR v_job.id IS NULL THEN RAISE EXCEPTION 'Employee replacement owner task is invalid or expired.';END IF;
  -- Unlike employee_transfer_job this does not renew the task or acquire write locks.
  PERFORM private.employee_transfer_identity_owner(v_job);
  PERFORM private.employee_transfer_check_identity_input(v_job);
  -- SQL14 validates staged directory totals. Independently cross-check the source accounts'
  -- raw bytes against BOTH the catalog row hashes and the parsed rows used by this planner.
  FOR v_chunk IN SELECT row_count,payload FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='identity-in:accounts' ORDER BY chunk_no LOOP
    v_rows:='[]';v_hashes:='';
    IF jsonb_typeof(v_chunk.payload->'ndjson') IS DISTINCT FROM 'string'
      OR octet_length(v_chunk.payload->>'ndjson')>262144 THEN RAISE EXCEPTION 'Replacement source accounts changed.';END IF;
    IF v_chunk.payload->>'ndjson'<>'' THEN
      IF right(v_chunk.payload->>'ndjson',1)<>E'\n' THEN RAISE EXCEPTION 'Replacement source accounts changed.';END IF;
      FOR v_line IN SELECT line FROM unnest(string_to_array(left(v_chunk.payload->>'ndjson',length(v_chunk.payload->>'ndjson')-1),E'\n')) AS input(line) LOOP
        v_json:=v_line::json;
        IF NOT private.employee_transfer_unique_json(v_json) THEN RAISE EXCEPTION 'Replacement source accounts changed.';END IF;
        PERFORM private.employee_transfer_check_identity_row('accounts',v_json::jsonb);
        v_rows:=v_rows||jsonb_build_array(v_json::jsonb);
        v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
      END LOOP;
    END IF;
    IF v_rows IS DISTINCT FROM v_chunk.payload->'rows' OR v_hashes IS DISTINCT FROM v_chunk.payload->>'row_hashes'
      OR jsonb_array_length(v_rows) IS DISTINCT FROM v_chunk.row_count
      OR octet_length(v_chunk.payload->>'ndjson') IS DISTINCT FROM (v_chunk.payload->>'bytes')::integer THEN
      RAISE EXCEPTION 'Replacement source accounts changed.';
    END IF;
  END LOOP;
  RETURN v_job;
END;
$$;

-- IDs here are internal only: the public RPCs derive them exclusively from staged usernames
-- and existing, uncleared archive identities. This digest is NOT a complete backup/media proof.
CREATE FUNCTION private.employee_transfer_replacement_target(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_user public.users%ROWTYPE;v_record private.deleted_employee_accounts%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;v_counts jsonb;v_digests jsonb:='{}';v_table text;v_column text;v_digest text;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id=p_id;
  SELECT * INTO v_record FROM private.deleted_employee_accounts WHERE employee_id=p_id AND cleared_at IS NULL;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id=p_id;
  SELECT jsonb_build_object(
    'completed_orders',(SELECT count(*) FROM public.orders WHERE user_id=p_id AND status IN ('success','failure')),
    'chat',(SELECT count(*) FROM public.customer_employee_conversations WHERE employee_id=p_id),
    'login',(SELECT count(*) FROM public.employee_login_history WHERE user_id=p_id AND action_type='login')) INTO v_counts;
  -- Hash contents, not only counts: same-count edits must change the observed fingerprint.
  -- Includes archive-mutated relations. A real archive therefore normally changes this digest;
  -- status reports that drift separately and never silently normalizes it into approval.
  FOR v_table,v_column IN SELECT * FROM (VALUES
    ('public.users','id'),('public.financial_employee_credentials','user_id'),
    ('public.wallets','user_id'),('public.withdrawals','user_id'),
    ('public.orders','user_id'),('public.orders_history','user_id'),
    ('public.wallet_transactions','user_id'),('public.wallet_ledger_entries','user_id'),
    ('public.wallet_balance_baselines','user_id'),('public.wallet_reconciliation_audit','user_id'),
    ('public.customer_employee_conversations','employee_id'),('public.employee_login_history','user_id'),
    ('public.work_sessions','user_id'),('public.verification_requests','user_id'),
    ('public.dispatch_group_members','user_id'),('public.used_order_data','user_id'),
    ('public.notification_automation_plan_members','user_id'),('public.notification_automation_task_recipients','user_id'),
    ('public.notification_automation_queue','user_id'),('public.message_recipients','recipient_id'),
    ('private.deleted_employee_accounts','employee_id'),('private.deleted_employee_notifications','record_id')
  ) AS tables(name,column_name) LOOP
    EXECUTE format('SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(h,'''' ORDER BY h COLLATE "C"),''''),''UTF8''),''sha256''),''hex'') FROM (SELECT encode(extensions.digest(convert_to(to_jsonb(r)::text,''UTF8''),''sha256''),''hex'') AS h FROM %s AS r WHERE %I=$1) AS hashes',v_table,v_column)
      INTO v_digest USING CASE WHEN v_table='private.deleted_employee_notifications' THEN v_record.id ELSE p_id END;
    v_digests:=v_digests||jsonb_build_object(v_table,v_digest);
  END LOOP;
  RETURN jsonb_build_object('target_id',p_id,
    'username',CASE WHEN v_user.archived_at IS NULL AND v_user.id IS NOT NULL THEN v_user.username ELSE v_record.account_username END,
    'employee_no',CASE WHEN v_user.archived_at IS NULL AND v_user.id IS NOT NULL THEN v_user.employee_id ELSE v_record.employee_number END,
    'archived',v_user.id IS NOT NULL AND v_user.archived_at IS NOT NULL,
    'archive_record_id',v_record.id,
    'archive_evidence',v_record.id IS NOT NULL AND v_user.archived_at IS NOT NULL
      AND v_record.deletion_source IN ('employee_delete','admin_delete')
      AND v_user.username='archived-'||p_id::text AND v_user.employee_id='archived-'||p_id::text
      AND v_user.is_active=false AND v_user.current_session_token IS NULL AND v_user.current_tab_id IS NULL,
    'available_balance',v_wallet.available_balance::text,'frozen_balance',v_wallet.frozen_balance::text,
    'pending_withdrawals',(SELECT count(*) FROM public.withdrawals WHERE user_id=p_id AND status='pending'),
    'pending_amount',(SELECT COALESCE(sum(amount),0)::text FROM public.withdrawals WHERE user_id=p_id AND status='pending'),
    'completed_orders',v_counts->'completed_orders','chat',v_counts->'chat','login',v_counts->'login',
    'last_login',(SELECT max(created_at) FROM public.employee_login_history WHERE user_id=p_id AND action_type='login'),
    'fingerprint',encode(extensions.digest(convert_to(v_digests::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION private.employee_transfer_replacement_page(p_job private.employee_transfer_jobs,p_after uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_source record;v_rows jsonb:='[]';v_targets jsonb;v_target jsonb;v_ids uuid[];v_id uuid;
  v_blockers jsonb;v_row jsonb;v_last uuid;v_more boolean;v_total bigint;v_conflicts integer:=0;v_archived integer:=0;
  v_source_hash text;v_fingerprint text;v_maintenance boolean;v_usernames boolean;v_numbers boolean;v_source_numbers boolean;
  v_occupancy jsonb:='[]';
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid employee replacement page size.';END IF;
  IF p_after IS NOT NULL AND NOT EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') WHERE id=p_after) THEN
    RAISE EXCEPTION 'Employee replacement source cursor is not bound to this task.';
  END IF;
  SELECT count(*) INTO v_total FROM private.employee_transfer_identity_input(p_job.id,'accounts');
  -- Bind status checkpoints to the entire immutable catalog, not just the displayed page.
  v_source_hash:=encode(extensions.digest(convert_to(jsonb_build_object('job_id',p_job.id,
    'catalog',p_job.summary->'identity_catalog')::text,'UTF8'),'sha256'),'hex');
  SELECT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance WHERE job_id=p_job.id) INTO v_maintenance;
  FOR v_source IN SELECT * FROM private.employee_transfer_identity_input(p_job.id,'accounts')
    WHERE p_after IS NULL OR id>p_after ORDER BY id LIMIT p_limit LOOP
    v_last:=v_source.id;v_targets:='[]';v_blockers:='[]';
    -- Do not accept a client target ID, including on status/resume. Existing historical
    -- names can have several archives: list every candidate and block ambiguity.
    SELECT ARRAY(SELECT candidate FROM (
      SELECT id AS candidate FROM public.users WHERE username=v_source.body->>'username'
      UNION SELECT employee_id FROM private.deleted_employee_accounts
        WHERE account_username=v_source.body->>'username' AND cleared_at IS NULL
    ) AS ids ORDER BY candidate) INTO v_ids;
    FOREACH v_id IN ARRAY v_ids LOOP
      v_target:=private.employee_transfer_replacement_target(v_id);
      v_target:=v_target||jsonb_build_object(
        'username_released',NOT EXISTS(SELECT 1 FROM public.users WHERE username=v_source.body->>'username')
          AND NOT EXISTS(SELECT 1 FROM public.admins WHERE username=v_source.body->>'username'),
        'employee_no_released',v_target->>'employee_no' IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM public.users WHERE employee_id=v_target->>'employee_no'));
      v_targets:=v_targets||jsonb_build_array(v_target);
      IF (v_target->>'archive_evidence')::boolean THEN v_archived:=v_archived+1;END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM public.users WHERE id=v_source.id) THEN v_blockers:=v_blockers||'"source_uuid_occupied"'::jsonb;END IF;
    IF EXISTS(SELECT 1 FROM public.users WHERE employee_id=v_source.body->>'employee_id' AND username<>v_source.body->>'username') THEN
      v_blockers:=v_blockers||'"employee_no_other_username"'::jsonb;
    END IF;
    IF EXISTS(SELECT 1 FROM public.admins WHERE username=v_source.body->>'username') THEN
      v_blockers:=v_blockers||'"administrator_username_conflict"'::jsonb;
    END IF;
    IF cardinality(v_ids)>1 THEN v_blockers:=v_blockers||'"ambiguous_target_history"'::jsonb;END IF;
    IF cardinality(v_ids)>0 THEN
      v_blockers:=v_blockers||'["complete_employee_backup_missing","identity_mapping_missing"]'::jsonb;
      IF v_maintenance THEN v_blockers:=v_blockers||'"maintenance_blocks_existing_archive"'::jsonb;END IF;
    END IF;
    IF jsonb_array_length(v_blockers)>0 THEN v_conflicts:=v_conflicts+1;END IF;
    v_row:=jsonb_build_object('source_id',v_source.id,'username',v_source.body->>'username',
      'source_employee_no',v_source.body->>'employee_id','targets',v_targets,'blockers',v_blockers,
      'backup_required',cardinality(v_ids)>0,'can_archive',false);
    v_rows:=v_rows||jsonb_build_array(v_row);
    -- Other identities are blockers, never replacement targets. Bind their actual contents too,
    -- without disclosing their credentials or accepting their IDs from the caller.
    v_occupancy:=v_occupancy||jsonb_build_array(jsonb_build_object('source_id',v_source.id,
      'users',(SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.id),'[]') FROM public.users AS u
        WHERE u.id=v_source.id OR u.employee_id=v_source.body->>'employee_id'),
      'admins',(SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM public.admins AS a
        WHERE a.username=v_source.body->>'username')));
  END LOOP;
  SELECT v_last IS NOT NULL AND EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') WHERE id>v_last) INTO v_more;
  -- Include UUID/number/admin occupancy through the blockers as well as matched target data.
  -- No current timestamps or heartbeat, so repeated reads of unchanged data are identical.
  v_fingerprint:=encode(extensions.digest(convert_to(jsonb_build_object('job_id',p_job.id,'source_fingerprint',v_source_hash,
    'after',p_after,'limit',p_limit,'rows',v_rows,'occupancy',v_occupancy)::text,'UTF8'),'sha256'),'hex');
  SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) AS r(body) JOIN public.users AS u ON u.username=r.body->>'username')
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) AS r(body) JOIN public.admins AS a ON a.username=r.body->>'username'),
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) AS r(body) CROSS JOIN LATERAL jsonb_array_elements(r.body->'targets') AS t(body)
      WHERE NOT (t.body->>'employee_no_released')::boolean),
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) AS r(body) JOIN public.users AS u ON u.employee_id=r.body->>'source_employee_no')
    INTO v_usernames,v_numbers,v_source_numbers;
  RETURN jsonb_build_object('scope','employee-replacement','checked',true,'job_id',p_job.id,
    'source_site_id',p_job.summary#>>'{identity_catalog,site_id}','package_id',p_job.summary#>>'{identity_catalog,package_id}',
    'after',p_after,'limit',p_limit,'next_after',CASE WHEN v_more THEN v_last ELSE NULL END,
    'total_sources',v_total,'counts',jsonb_build_object('sources',jsonb_array_length(v_rows),'conflicts',v_conflicts,'archived',v_archived),
    'rows',v_rows,'source_fingerprint',v_source_hash,'target_fingerprint',v_fingerprint,
    'backup_required',EXISTS(SELECT 1 FROM jsonb_array_elements(v_rows) AS r(body) WHERE (r.body->>'backup_required')::boolean),
    'username_released',v_usernames,'employee_no_released',v_numbers,'source_employee_no_released',v_source_numbers,
    'maintenance',v_maintenance,'can_archive',false,'can_replace',false,
    'complete_employee_backup_missing',true,'identity_mapping_missing',true,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_replacement_plan(
  p_admin_session_token uuid,p_job_token uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  RETURN private.employee_transfer_replacement_page(v_job,p_after,p_limit);
END;
$$;

CREATE FUNCTION public.employee_import_replacement_status(
  p_admin_session_token uuid,p_job_token uuid,p_source_fingerprint text,p_target_fingerprint text,
  p_after uuid DEFAULT NULL,p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_page jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  IF p_source_fingerprint IS NULL OR length(p_source_fingerprint)<>64 OR p_source_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_target_fingerprint IS NULL OR length(p_target_fingerprint)<>64 OR p_target_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'An explicit read-only replacement checkpoint is required.';
  END IF;
  v_page:=private.employee_transfer_replacement_page(v_job,p_after,p_limit);
  IF p_source_fingerprint IS DISTINCT FROM v_page->>'source_fingerprint' THEN
    RAISE EXCEPTION 'The bound replacement source changed; obtain a new plan.';
  END IF;
  -- Hashes supplied by a caller are comparison baselines, NEVER authorization or backup evidence.
  RETURN v_page||jsonb_build_object('expected_target_fingerprint',p_target_fingerprint,
    'target_unchanged',p_target_fingerprint=v_page->>'target_fingerprint');
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_replacement_owner(uuid,uuid),
  private.employee_transfer_replacement_target(uuid),
  private.employee_transfer_replacement_page(private.employee_transfer_jobs,uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.employee_import_replacement_plan(uuid,uuid,uuid,integer),
  public.employee_import_replacement_status(uuid,uuid,text,text,uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_import_replacement_plan(uuid,uuid,uuid,integer),
  public.employee_import_replacement_status(uuid,uuid,text,text,uuid,integer) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
