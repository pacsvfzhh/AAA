BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- A full check may be reused only inside the transaction and client statement that
-- ran it, while that statement holds the task row lock, for byte-identical inputs and
-- session formatting, and only if the transaction has written no tracked table or
-- catalog since the check. Separate requests always recheck from scratch.
CREATE TABLE private.employee_transfer_request_proofs (
  transaction_id xid8 NOT NULL,
  statement_at timestamptz NOT NULL,
  job_id uuid NOT NULL,
  kind text NOT NULL,
  binding text NOT NULL,
  writes bigint[] NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (transaction_id, statement_at, job_id, kind, binding)
);
ALTER TABLE private.employee_transfer_request_proofs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.employee_transfer_request_proofs FROM PUBLIC, anon, authenticated, service_role;

DO $request_proof_inventory$
DECLARE v_definition text;v_anchor constant text:='''private.employee_transfer_shared_backups'',''private.employee_transfer_site''';
BEGIN
  v_definition:=pg_get_functiondef('private.employee_transfer_assert_maintenance_guards()'::regprocedure);
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN
    RAISE EXCEPTION 'Request proof maintenance inventory anchor changed.';
  END IF;
  EXECUTE replace(v_definition,v_anchor,'''private.employee_transfer_request_proofs'','||v_anchor);
  PERFORM private.employee_transfer_assert_maintenance_guards();
END;
$request_proof_inventory$;

-- This transaction's own row writes per table, with or without triggers or permits;
-- aborted subtransactions still count. Any write since a proof changes the vector.
-- TRUNCATE resets a table counter but rewrites pg_class, which is tracked. Task rows
-- and audit events are excluded: proven checks never read them, except other task
-- rows through the administrator map, which each wrapper re-derives and binds.
DO $request_writes$
DECLARE v_relations oid[];
BEGIN
  SELECT array_agg(to_regclass(item.name)::oid ORDER BY item.n) INTO v_relations
    FROM unnest(private.employee_transfer_guarded_tables()||ARRAY[
      'private.employee_transfer_staging','private.employee_transfer_maintenance','private.employee_transfer_write_permits',
      'private.employee_transfer_shared_backups','private.employee_transfer_notification_backups',
      'private.employee_transfer_chat_backups','private.employee_transfer_site',
      'pg_catalog.pg_class','pg_catalog.pg_attribute','pg_catalog.pg_attrdef','pg_catalog.pg_constraint',
      'pg_catalog.pg_trigger','pg_catalog.pg_proc','pg_catalog.pg_namespace','pg_catalog.pg_inherits',
      'pg_catalog.pg_policy','pg_catalog.pg_type','pg_catalog.pg_index','pg_catalog.pg_extension',
      'pg_catalog.pg_depend','pg_catalog.pg_shdepend','pg_catalog.pg_authid','pg_catalog.pg_auth_members'])
      WITH ORDINALITY AS item(name,n)
    WHERE to_regclass(item.name) IS NOT NULL;
  EXECUTE format($definition$
    CREATE FUNCTION private.employee_transfer_request_writes()
    RETURNS bigint[] LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, private, pg_temp AS $body$
      SELECT array_agg(pg_stat_get_xact_tuples_inserted(item.relation)+pg_stat_get_xact_tuples_updated(item.relation)
        +pg_stat_get_xact_tuples_deleted(item.relation) ORDER BY item.n)
      FROM unnest(%L::oid[]) WITH ORDINALITY AS item(relation,n);
    $body$;
  $definition$,v_relations);
END;
$request_writes$;

-- Evaluated on the caller's snapshot: the task lock marker must predate the check it proves.
CREATE FUNCTION private.employee_transfer_request_scope(p_job_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  RETURN p_job_id IS NOT NULL AND current_setting('transaction_read_only')='off'
    AND current_setting('transaction_isolation')='read committed' AND current_setting('track_counts')='on'
    AND EXISTS(SELECT 1 FROM private.employee_transfer_request_proofs AS marker
      WHERE marker.transaction_id=pg_current_xact_id_if_assigned() AND marker.statement_at=statement_timestamp()
        AND marker.job_id=p_job_id AND marker.kind='task-lock' AND marker.binding='');
END;
$$;

-- No SET clauses: the caller's formatting settings are part of what the check saw.
CREATE FUNCTION private.employee_transfer_request_binding(p_kind text,p_job private.employee_transfer_jobs,p_inputs jsonb)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(p_kind,to_jsonb(p_job),p_inputs,
    jsonb_build_array(current_setting('TimeZone'),current_setting('DateStyle'),current_setting('IntervalStyle'),
      current_setting('extra_float_digits'),current_setting('bytea_output')))::text,'UTF8')),'hex');
$$;

-- Volatile on purpose: a fresh snapshot sees proofs recorded earlier in this statement.
CREATE FUNCTION private.employee_transfer_request_proof(p_job_id uuid,p_kind text,p_binding text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_result jsonb; v_writes bigint[];
BEGIN
  IF p_binding IS NULL OR current_setting('track_counts')<>'on' THEN RETURN NULL; END IF;
  SELECT proof.result,proof.writes INTO v_result,v_writes FROM private.employee_transfer_request_proofs AS proof
    WHERE proof.transaction_id=pg_current_xact_id() AND proof.statement_at=statement_timestamp()
      AND proof.job_id=p_job_id AND proof.kind=p_kind AND proof.binding=p_binding;
  IF v_result IS NULL OR v_writes IS DISTINCT FROM private.employee_transfer_request_writes()
    OR NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance AS m WHERE m.singleton AND m.dirty AND m.job_id=p_job_id) THEN
    RETURN NULL;
  END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.employee_transfer_record_request_proof(p_job_id uuid,p_kind text,p_binding text,p_result jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  -- Guarded writes need a permit; never record inside a write window.
  IF p_binding IS NULL OR p_result IS NULL OR current_setting('track_counts')<>'on'
    OR EXISTS(SELECT 1 FROM private.employee_transfer_write_permits AS w WHERE w.transaction_id=pg_current_xact_id())
    OR NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance AS m WHERE m.singleton AND m.dirty AND m.job_id=p_job_id) THEN
    RETURN;
  END IF;
  INSERT INTO private.employee_transfer_request_proofs(transaction_id,statement_at,job_id,kind,binding,writes,result)
    VALUES(pg_current_xact_id(),statement_timestamp(),p_job_id,p_kind,p_binding,private.employee_transfer_request_writes(),p_result)
    ON CONFLICT (transaction_id,statement_at,job_id,kind,binding) DO UPDATE SET writes=EXCLUDED.writes,result=EXCLUDED.result;
END;
$$;

ALTER FUNCTION private.employee_transfer_job(uuid,uuid,text) RENAME TO employee_transfer_job_row;
CREATE FUNCTION private.employee_transfer_job(p_session uuid,p_job_token uuid,p_kind text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job_row(p_session,p_job_token,p_kind);
  -- The UPDATE above keeps the task row locked until this transaction ends.
  DELETE FROM private.employee_transfer_request_proofs AS proof USING (
    SELECT stale.ctid FROM private.employee_transfer_request_proofs AS stale
    WHERE stale.transaction_id<pg_snapshot_xmin(pg_current_snapshot())
      OR (stale.transaction_id=pg_current_xact_id() AND stale.statement_at<>statement_timestamp())
    FOR UPDATE SKIP LOCKED) AS stale
  WHERE proof.ctid=stale.ctid;
  INSERT INTO private.employee_transfer_request_proofs(transaction_id,statement_at,job_id,kind,binding,writes,result)
    VALUES(pg_current_xact_id(),statement_timestamp(),v_job.id,'task-lock','','{}','true') ON CONFLICT DO NOTHING;
  RETURN v_job;
END;
$$;

ALTER FUNCTION private.employee_transfer_assert_maintenance_guards() RENAME TO employee_transfer_check_maintenance_guards;
CREATE FUNCTION private.employee_transfer_assert_maintenance_guards()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job uuid; v_binding text;
BEGIN
  SELECT m.job_id INTO v_job FROM private.employee_transfer_maintenance AS m WHERE m.singleton AND m.dirty;
  IF private.employee_transfer_request_scope(v_job) THEN v_binding:=private.employee_transfer_request_binding('guards',NULL,NULL); END IF;
  IF private.employee_transfer_request_proof(v_job,'guards',v_binding) IS NULL THEN
    PERFORM private.employee_transfer_check_maintenance_guards();
    PERFORM private.employee_transfer_record_request_proof(v_job,'guards',v_binding,'true');
  END IF;
END;
$$;

ALTER FUNCTION private.employee_transfer_verify_identity_contents(private.employee_transfer_jobs,jsonb)
  RENAME TO employee_transfer_verify_identity_contents_full;
CREATE FUNCTION private.employee_transfer_verify_identity_contents(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_binding text;
BEGIN
  IF private.employee_transfer_request_scope(p_job.id) THEN v_binding:=private.employee_transfer_request_binding('identity',p_job,p_map); END IF;
  IF private.employee_transfer_request_proof(p_job.id,'identity',v_binding) IS NULL THEN
    PERFORM private.employee_transfer_verify_identity_contents_full(p_job,p_map);
    PERFORM private.employee_transfer_record_request_proof(p_job.id,'identity',v_binding,'true');
  END IF;
END;
$$;

ALTER FUNCTION private.employee_transfer_dependency_owner(private.employee_transfer_jobs)
  RENAME TO employee_transfer_dependency_owner_full;
CREATE FUNCTION private.employee_transfer_dependency_owner(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb; v_binding text;
BEGIN
  IF NOT private.employee_transfer_request_scope(p_job.id) THEN RETURN private.employee_transfer_dependency_owner_full(p_job); END IF;
  v_map:=private.employee_transfer_identity_admin_map(p_job);
  v_binding:=private.employee_transfer_request_binding('dependency',p_job,v_map);
  IF private.employee_transfer_request_proof(p_job.id,'dependency',v_binding) IS NULL THEN
    v_map:=private.employee_transfer_dependency_owner_full(p_job);
    PERFORM private.employee_transfer_record_request_proof(p_job.id,'dependency',v_binding,'true');
  END IF;
  RETURN v_map;
END;
$$;

ALTER FUNCTION private.employee_transfer_check_dependency_progress(private.employee_transfer_jobs,jsonb)
  RENAME TO employee_transfer_check_dependency_progress_full;
CREATE FUNCTION private.employee_transfer_check_dependency_progress(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_binding text;
BEGIN
  IF private.employee_transfer_request_scope(p_job.id) THEN v_binding:=private.employee_transfer_request_binding('dependency-progress',p_job,p_map); END IF;
  IF private.employee_transfer_request_proof(p_job.id,'dependency-progress',v_binding) IS NULL THEN
    PERFORM private.employee_transfer_check_dependency_progress_full(p_job,p_map);
    PERFORM private.employee_transfer_record_request_proof(p_job.id,'dependency-progress',v_binding,'true');
  END IF;
END;
$$;

ALTER FUNCTION private.employee_transfer_check_finance_input(private.employee_transfer_jobs)
  RENAME TO employee_transfer_check_finance_input_full;
CREATE FUNCTION private.employee_transfer_check_finance_input(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_counts jsonb; v_binding text;
BEGIN
  IF NOT private.employee_transfer_request_scope(p_job.id) THEN RETURN private.employee_transfer_check_finance_input_full(p_job); END IF;
  v_binding:=private.employee_transfer_request_binding('finance-input',p_job,private.employee_transfer_finance_owner(p_job));
  v_counts:=private.employee_transfer_request_proof(p_job.id,'finance-input',v_binding);
  IF v_counts IS NULL THEN
    v_counts:=private.employee_transfer_check_finance_input_full(p_job);
    PERFORM private.employee_transfer_record_request_proof(p_job.id,'finance-input',v_binding,v_counts);
  END IF;
  RETURN v_counts;
END;
$$;

ALTER FUNCTION private.employee_transfer_finance_progress(private.employee_transfer_jobs,jsonb)
  RENAME TO employee_transfer_finance_progress_full;
CREATE FUNCTION private.employee_transfer_finance_progress(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_count jsonb; v_binding text;
BEGIN
  IF NOT private.employee_transfer_request_scope(p_job.id) THEN RETURN private.employee_transfer_finance_progress_full(p_job,p_map); END IF;
  v_binding:=private.employee_transfer_request_binding('finance-progress',p_job,p_map);
  v_count:=private.employee_transfer_request_proof(p_job.id,'finance-progress',v_binding);
  IF v_count IS NULL THEN
    v_count:=to_jsonb(private.employee_transfer_finance_progress_full(p_job,p_map));
    PERFORM private.employee_transfer_record_request_proof(p_job.id,'finance-progress',v_binding,v_count);
  END IF;
  RETURN (v_count#>>'{}')::bigint;
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
  END LOOP;
END;
$$;
SELECT private.employee_transfer_assert_maintenance_guards();
COMMIT;
