-- replacement-records-v1: actual employee records, NOT a complete/sealed employee backup.
-- SQL37 owner/maintenance gates stay intact. No new job, heartbeat, permit or business write.
BEGIN;

CREATE FUNCTION private.employee_transfer_replacement_backup_keys()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT ARRAY['accounts','credentials','orders','wallets','wallet_balance_baselines',
    'wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit',
    'employee_login_history','work_sessions','work_stop_markers','verification_requests',
    'dispatch_group_members','employee_submit_time_settings']::text[];
$$;

CREATE FUNCTION private.employee_transfer_replacement_backup_spec()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT private.employee_transfer_identity_spec() || private.employee_transfer_finance_spec()
    || private.employee_transfer_activity_spec() || private.employee_transfer_verification_spec()
    || jsonb_build_object('dispatch_group_members',private.employee_transfer_dispatch_spec()->'dispatch_group_members',
      'employee_submit_time_settings','{"id":"uuid!","user_id":"uuid!","group_id":"uuid","min_seconds":"integer","max_seconds":"integer","created_at":"timestamp with time zone"}'::jsonb);
$$;

-- Reuse reviewed projections only, never the site-export job/protocol APIs. $1 is an INTERNAL
-- server-derived target UUID, never an RPC argument. Every branch is employee-scoped.
CREATE FUNCTION private.employee_transfer_replacement_backup_query(p_key text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_query text;v_filter text;v_projection text;
BEGIN
  IF p_key IS NULL OR NOT p_key=ANY(private.employee_transfer_replacement_backup_keys()) THEN
    RAISE EXCEPTION 'Unsupported replacement backup table key.';
  END IF;
  CASE
    WHEN p_key IN ('accounts','credentials','orders') THEN
      v_query:=private.employee_transfer_identity_query(p_key);
    WHEN p_key IN ('wallets','wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit') THEN
      v_query:=private.employee_transfer_finance_query(p_key);
    WHEN p_key IN ('employee_login_history','work_sessions','work_stop_markers') THEN
      -- Never use verification mode: historical session identifiers must be irreversibly hashed.
      v_query:=private.employee_transfer_activity_query(p_key,true);
    WHEN p_key='verification_requests' THEN
      v_query:=private.employee_transfer_verification_query(p_key);
    WHEN p_key='dispatch_group_members' THEN
      v_query:=private.employee_transfer_dispatch_query(p_key);
    WHEN p_key='employee_submit_time_settings' THEN
      SELECT string_agg(format('%L,src.%I',key,key),',' ORDER BY key COLLATE "C") INTO v_projection
        FROM jsonb_each(private.employee_transfer_replacement_backup_spec()->p_key);
      v_query:=format('SELECT src.id,jsonb_build_object(%s) AS body FROM public.employee_submit_time_settings AS src',v_projection);
  END CASE;
  v_filter:=CASE WHEN p_key IN ('accounts','credentials') THEN 'r.id=$1::uuid'
    ELSE 'r.body->>''user_id''=$1::text' END;
  RETURN 'SELECT r.id,r.body FROM ('||v_query||') AS r WHERE '||v_filter;
END;
$$;

-- SQL39 only: the older activity export is unchanged. Reject, never strip/rewrite device JSON.
-- Root depth is 0; every child value adds 1. Only exact normalized keys are denied.
CREATE FUNCTION private.employee_transfer_replacement_device_check(p_value jsonb,p_depth integer DEFAULT 0)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;v_value jsonb;
BEGIN
  IF p_depth IS NULL OR p_depth<0 OR p_depth>64 THEN
    RAISE EXCEPTION 'Replacement backup device information exceeds the reviewed depth.' USING ERRCODE='22023';
  END IF;
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      FOR v_key,v_value IN SELECT key,value FROM jsonb_each(p_value) LOOP
        IF translate(lower(v_key COLLATE "C"),'_/-:','')=ANY(ARRAY[
          'currentsessiontoken','currenttabid','sessionid','sessiontoken','tokenhash',
          'accesstoken','refreshtoken','servicerolekey','anonkey','password','passwordhash',
          'token','authorization','apikey','clientsecret','secret'
        ]) THEN
          RAISE EXCEPTION 'Replacement backup device information contains a structured secret.' USING ERRCODE='22023';
        END IF;
        PERFORM private.employee_transfer_replacement_device_check(v_value,p_depth+1);
      END LOOP;
    WHEN 'array' THEN
      FOR v_value IN SELECT value FROM jsonb_array_elements(p_value) LOOP
        PERFORM private.employee_transfer_replacement_device_check(v_value,p_depth+1);
      END LOOP;
    ELSE NULL;
  END CASE;
END;
$$;

CREATE FUNCTION private.employee_transfer_replacement_backup_catalog(p_job private.employee_transfer_jobs,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_source jsonb;v_ids uuid[];v_target uuid;v_key text;v_query text;v_actual jsonb;v_expected jsonb;
  v_rows bigint;v_bytes bigint;v_largest bigint;v_hash text;v_total bigint:=0;v_tables jsonb:='[]';v_catalog jsonb;
BEGIN
  -- Public entry points already use the SQL37 authenticated owner. This helper never accepts
  -- a target or manufactures an import/export permission, even for same-ID replacement risks.
  SELECT body INTO v_source FROM private.employee_transfer_identity_input(p_job.id,'accounts') WHERE id=p_source_id;
  IF p_source_id IS NULL OR v_source IS NULL THEN RAISE EXCEPTION 'Replacement backup source employee is not bound to this task.';END IF;
  SELECT ARRAY(SELECT candidate FROM (
    SELECT id AS candidate FROM public.users WHERE username=v_source->>'username'
    UNION SELECT employee_id FROM private.deleted_employee_accounts
      WHERE account_username=v_source->>'username' AND cleared_at IS NULL
  ) AS candidates ORDER BY candidate) INTO v_ids;
  IF cardinality(v_ids)<>1 THEN RAISE EXCEPTION 'Replacement backup requires exactly one unambiguous same-name target.';END IF;
  v_target:=v_ids[1];
  IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=v_target AND username=v_source->>'username' AND archived_at IS NULL)
    OR EXISTS(SELECT 1 FROM private.deleted_employee_accounts WHERE employee_id=v_target AND cleared_at IS NULL) THEN
    RAISE EXCEPTION 'Replacement backup target is archived or has archive evidence.';
  END IF;
  PERFORM private.employee_transfer_finance_schema();
  PERFORM private.employee_transfer_activity_schema();
  PERFORM private.employee_transfer_verification_schema();
  -- All target login devices, not just a requested page. Foreign employees are outside scope.
  -- Catalog, every page fingerprint recheck and verify all execute this guard before hashing.
  PERFORM private.employee_transfer_replacement_device_check(login.device_info)
    FROM public.employee_login_history AS login WHERE login.user_id=v_target;
  -- SQL37 already checks the identity schema. Review the two additional physical relations;
  -- new columns never get silently exported or silently treated as backed up.
  FOREACH v_key IN ARRAY ARRAY['dispatch_group_members','employee_submit_time_settings'] LOOP
    v_expected:=private.employee_transfer_replacement_backup_spec()->v_key;
    SELECT jsonb_object_agg(attname,format_type(atttypid,atttypmod)||CASE WHEN attnotnull THEN '!' ELSE '' END)
      INTO v_actual FROM pg_attribute WHERE attrelid=to_regclass('public.'||v_key) AND attnum>0 AND NOT attisdropped;
    IF v_actual IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Unreviewed replacement backup schema.';END IF;
  END LOOP;
  FOREACH v_key IN ARRAY private.employee_transfer_replacement_backup_keys() LOOP
    v_query:=private.employee_transfer_replacement_backup_query(v_key);
    -- body::text is serialized INSIDE PostgreSQL. No JS numeric/timestamp round trip.
    -- The reused activity projection contains device_info_is_sql_null and hashes session_id.
    EXECUTE 'SELECT count(*),COALESCE(sum(octet_length(body::text||E''\n'')),0),
      COALESCE(max(octet_length(body::text||E''\n'')),0),
      encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(
        convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),'''' ORDER BY id),''''),''UTF8''),''sha256''),''hex'')
      FROM ('||v_query||') AS selected' INTO v_rows,v_bytes,v_largest,v_hash USING v_target;
    v_total:=v_total+v_bytes;
    IF v_rows>500000 OR v_bytes>268435456 OR v_total>1073741824 OR v_largest>65536 THEN
      RAISE EXCEPTION 'Replacement records exceed reviewed limits; no records were truncated.';
    END IF;
    v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
  END LOOP;
  v_catalog:=jsonb_build_object('version',1,'protocol','replacement-records-v1','scope','employee-replacement-records',
    'job_id',p_job.id,'source_site_id',p_job.summary#>>'{identity_catalog,site_id}',
    'package_id',p_job.summary#>>'{identity_catalog,package_id}',
    'target_site_id',(SELECT site_id FROM private.employee_transfer_site),
    'source_employee_id',p_source_id,'target_employee_id',v_target,'username',v_source->>'username',
    'source_fingerprint',encode(extensions.digest(convert_to(jsonb_build_object('job_id',p_job.id,
      'catalog',p_job.summary->'identity_catalog')::text,'UTF8'),'sha256'),'hex'),
    'tables',v_tables,'projections',private.employee_transfer_replacement_backup_spec(),
    'missing_domains',jsonb_build_array('chat','notifications','media','dispatch_configuration','used_order_data','orders_history','archive_evidence'),
    'excluded_data',jsonb_build_array('active_sessions','account_locks','detailed_orders','financial_operations'),
    'records_only',true,'complete_employee_backup',false,'backup_sealed',false,
    'media_included',false,'can_archive',false,'can_replace',false,'full_site_complete',false);
  -- Includes every selected row, full bound source catalog, task, sites, source and target.
  -- This comparison checkpoint is NOT a persisted backup/seal receipt or write authorization.
  RETURN v_catalog||jsonb_build_object('fingerprint',encode(extensions.digest(convert_to(v_catalog::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.get_employee_import_replacement_backup(
  p_admin_session_token uuid,p_job_token uuid,p_source_employee_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  RETURN private.employee_transfer_replacement_backup_catalog(v_job,p_source_employee_id);
END;
$$;

CREATE FUNCTION private.employee_transfer_replacement_backup_check(p_catalog jsonb,p_fingerprint text)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'An explicit replacement backup catalog fingerprint is required.';
  END IF;
  IF p_catalog->>'fingerprint' IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'Replacement backup source or target changed; discard these records and restart.';
  END IF;
END;
$$;

CREATE FUNCTION public.get_employee_import_replacement_backup_page(
  p_admin_session_token uuid,p_job_token uuid,p_source_employee_id uuid,p_catalog_fingerprint text,
  p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_catalog jsonb;v_target uuid;v_query text;v_type text;
  v_row record;v_line text;v_text text:='';v_cursor text;v_count integer:=0;v_more boolean:=false;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid replacement backup page size.';END IF;
  v_query:=private.employee_transfer_replacement_backup_query(p_table_key);
  v_catalog:=private.employee_transfer_replacement_backup_catalog(v_job,p_source_employee_id);
  PERFORM private.employee_transfer_replacement_backup_check(v_catalog,p_catalog_fingerprint);
  v_target:=(v_catalog->>'target_employee_id')::uuid;
  v_type:=CASE WHEN p_table_key IN ('wallet_ledger_entries','wallet_reconciliation_audit') THEN 'bigint' ELSE 'uuid' END;
  IF p_after IS NOT NULL THEN
    EXECUTE 'SELECT id::text FROM ('||v_query||') AS selected WHERE id=$2::'||v_type INTO v_cursor USING v_target,p_after;
    IF v_cursor IS NULL OR v_cursor IS DISTINCT FROM p_after THEN RAISE EXCEPTION 'Replacement backup cursor is not canonical or belongs to another employee.';END IF;
  END IF;
  FOR v_row IN EXECUTE 'SELECT id::text AS cursor_id,body::text AS body FROM ('||v_query||') AS selected
    WHERE ($2::'||v_type||' IS NULL OR id>$2::'||v_type||') ORDER BY id LIMIT $3' USING v_target,p_after,p_limit+1 LOOP
    v_line:=v_row.body||E'\n';
    IF octet_length(v_line)>65536 THEN RAISE EXCEPTION 'Replacement backup row exceeds reviewed limits.';END IF;
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_line)>262144 THEN v_more:=true;EXIT;END IF;
    v_text:=v_text||v_line;v_cursor:=v_row.cursor_id;v_count:=v_count+1;
  END LOOP;
  RETURN jsonb_build_object('protocol','replacement-records-v1','source_employee_id',p_source_employee_id,
    'target_employee_id',v_target,'fingerprint',v_catalog->>'fingerprint','table_key',p_table_key,
    'count',v_count,'bytes',octet_length(v_text),'ndjson',v_text,'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'),
    'records_only',true,'media_included',false,'can_archive',false,'can_replace',false,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_replacement_backup_verify(
  p_admin_session_token uuid,p_job_token uuid,p_source_employee_id uuid,p_catalog_fingerprint text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_catalog jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_catalog:=private.employee_transfer_replacement_backup_catalog(v_job,p_source_employee_id);
  PERFORM private.employee_transfer_replacement_backup_check(v_catalog,p_catalog_fingerprint);
  -- Only checks unchanged selected records. Does NOT attest client download, encryption,
  -- independent storage, media, completed coverage or SQL37's existing archive prerequisites.
  RETURN jsonb_build_object('verified',true,'protocol','replacement-records-v1','scope','employee-replacement-records',
    'source_employee_id',p_source_employee_id,'target_employee_id',v_catalog->'target_employee_id',
    'fingerprint',v_catalog->>'fingerprint','missing_domains',v_catalog->'missing_domains',
    'records_only',true,'complete_employee_backup',false,'backup_sealed',false,
    'media_included',false,'can_archive',false,'can_replace',false,'full_site_complete',false);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_replacement_device_check(jsonb,integer),
  private.employee_transfer_replacement_backup_keys(),
  private.employee_transfer_replacement_backup_spec(),private.employee_transfer_replacement_backup_query(text),
  private.employee_transfer_replacement_backup_catalog(private.employee_transfer_jobs,uuid),
  private.employee_transfer_replacement_backup_check(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_employee_import_replacement_backup(uuid,uuid,uuid),
  public.get_employee_import_replacement_backup_page(uuid,uuid,uuid,text,text,text,integer),
  public.employee_import_replacement_backup_verify(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_import_replacement_backup(uuid,uuid,uuid),
  public.get_employee_import_replacement_backup_page(uuid,uuid,uuid,text,text,text,integer),
  public.employee_import_replacement_backup_verify(uuid,uuid,uuid,text) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
