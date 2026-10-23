BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- A completed full check may be reused only by the same client statement, while its transaction
-- holds the task row lock under this task's dirty maintenance, for identical inputs, and only if
-- the transaction has written no tracked table or catalog since the check began. Other writers are
-- excluded by the maintenance write guards plus that task lock. Separate requests always recheck.
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

-- Called right after the task row heartbeat UPDATE, in the same subtransaction, so the marker
-- can never outlive that row lock. Task rows are excluded from the counters (every request
-- heartbeats them) and bound by value instead; audit events are never read by reused checks.
CREATE FUNCTION private.employee_transfer_mark_request(p_job_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF current_setting('transaction_read_only')<>'off' OR NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance AS m
    WHERE m.singleton AND m.dirty AND m.job_id=p_job_id) THEN
    RETURN;
  END IF;
  DELETE FROM private.employee_transfer_request_proofs AS proof USING (
    SELECT stale.ctid FROM private.employee_transfer_request_proofs AS stale
    WHERE stale.transaction_id<pg_snapshot_xmin(pg_current_snapshot())
      OR (stale.transaction_id=pg_current_xact_id() AND stale.statement_at<>statement_timestamp())
    FOR UPDATE SKIP LOCKED) AS stale
  WHERE proof.ctid=stale.ctid;
  IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_request_proofs AS marker
    WHERE marker.transaction_id=pg_current_xact_id() AND marker.statement_at=statement_timestamp()
      AND marker.job_id=p_job_id AND marker.kind='task-lock' AND marker.binding='') THEN
    INSERT INTO private.employee_transfer_request_proofs(transaction_id,statement_at,job_id,kind,binding,writes,result)
      SELECT pg_current_xact_id(),statement_timestamp(),p_job_id,'task-lock','',array_agg(c.oid::bigint ORDER BY c.oid),'true'::jsonb
      FROM pg_catalog.pg_class AS c
      WHERE c.relkind IN ('r','p') AND c.relnamespace IN ('pg_catalog'::regnamespace,'public'::regnamespace,'private'::regnamespace)
        AND c.oid NOT IN ('private.employee_transfer_request_proofs'::regclass,'private.employee_transfer_jobs'::regclass,
          'private.employee_transfer_events'::regclass);
  END IF;
END;
$$;

DO $request_marker$
DECLARE v_definition text;v_anchor constant text:=E'  RETURN v_job;\nEND;';
BEGIN
  v_definition:=pg_get_functiondef('private.employee_transfer_job(uuid,uuid,text)'::regprocedure);
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN
    RAISE EXCEPTION 'Request marker task anchor changed.';
  END IF;
  EXECUTE replace(v_definition,v_anchor,E'  PERFORM private.employee_transfer_mark_request(v_job.id);\n'||v_anchor);
END;
$request_marker$;

-- Relations to compare, or NULL when this statement may not reuse proofs for the task.
CREATE FUNCTION private.employee_transfer_request_relations(p_job_id uuid)
RETURNS oid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_relations bigint[];
BEGIN
  IF p_job_id IS NULL OR current_setting('transaction_read_only')<>'off'
    OR current_setting('transaction_isolation')<>'read committed' OR current_setting('track_counts')<>'on' THEN
    RETURN NULL;
  END IF;
  SELECT marker.writes INTO v_relations FROM private.employee_transfer_request_proofs AS marker
    WHERE marker.transaction_id=pg_current_xact_id_if_assigned() AND marker.statement_at=statement_timestamp()
      AND marker.job_id=p_job_id AND marker.kind='task-lock' AND marker.binding='';
  IF v_relations IS NULL
    OR NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance AS m WHERE m.singleton AND m.dirty AND m.job_id=p_job_id)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_write_permits AS w WHERE w.transaction_id=pg_current_xact_id_if_assigned()) THEN
    RETURN NULL;
  END IF;
  RETURN v_relations::oid[];
END;
$$;

-- Per-table row writes by this transaction; they only grow (aborted subtransactions still count).
-- A per-table vector, not a sum: TRUNCATE resets one counter while rewriting pg_class.
CREATE FUNCTION private.employee_transfer_request_writes(p_relations oid[])
RETURNS bigint[] LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT array_agg(pg_stat_get_xact_tuples_inserted(item.relation)+pg_stat_get_xact_tuples_updated(item.relation)
    +pg_stat_get_xact_tuples_deleted(item.relation) ORDER BY item.n)
  FROM unnest(p_relations) WITH ORDINALITY AS item(relation,n);
$$;

-- No formatting SET clauses: the caller's settings are part of what the check saw.
CREATE FUNCTION private.employee_transfer_request_binding(p_kind text,p_job private.employee_transfer_jobs,p_inputs jsonb)
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(p_kind,to_jsonb(p_job),p_inputs,
    CASE WHEN p_job IS NULL THEN '[]'::jsonb ELSE (SELECT COALESCE(jsonb_agg(jsonb_build_array(j.id,j.ctid::text,j.xmin::text) ORDER BY j.id),'[]'::jsonb)
      FROM private.employee_transfer_jobs AS j WHERE j.id<>p_job.id) END,
    jsonb_build_array(current_setting('TimeZone'),current_setting('DateStyle'),current_setting('IntervalStyle'),
      current_setting('extra_float_digits'),current_setting('bytea_output'),current_setting('row_security')))::text,'UTF8')),'hex');
$$;

CREATE FUNCTION private.employee_transfer_request_proof(p_job_id uuid,p_kind text,p_binding text,p_writes bigint[])
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT proof.result FROM private.employee_transfer_request_proofs AS proof
  WHERE proof.transaction_id=pg_current_xact_id_if_assigned() AND proof.statement_at=statement_timestamp()
    AND proof.job_id=p_job_id AND proof.kind=p_kind AND proof.binding=p_binding AND proof.writes=p_writes;
$$;

CREATE FUNCTION private.employee_transfer_record_request_proof(p_job_id uuid,p_kind text,p_binding text,p_writes bigint[],p_result jsonb)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  INSERT INTO private.employee_transfer_request_proofs(transaction_id,statement_at,job_id,kind,binding,writes,result)
    SELECT pg_current_xact_id(),statement_timestamp(),p_job_id,p_kind,p_binding,p_writes,p_result WHERE p_result IS NOT NULL
  ON CONFLICT (transaction_id,statement_at,job_id,kind,binding) DO UPDATE SET writes=EXCLUDED.writes,result=EXCLUDED.result;
$$;

-- Wrappers are VOLATILE so each full check runs on a fresh snapshot that already includes every
-- write counted before it; the counters are read before the check, never after.
ALTER FUNCTION private.employee_transfer_assert_maintenance_guards() RENAME TO employee_transfer_check_maintenance_guards;
CREATE FUNCTION private.employee_transfer_assert_maintenance_guards()
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job uuid; v_relations oid[]; v_binding text; v_writes bigint[];
BEGIN
  SELECT m.job_id INTO v_job FROM private.employee_transfer_maintenance AS m WHERE m.singleton AND m.dirty;
  v_relations:=private.employee_transfer_request_relations(v_job);
  IF v_relations IS NOT NULL THEN
    v_binding:=private.employee_transfer_request_binding('guards',NULL,NULL);
    v_writes:=private.employee_transfer_request_writes(v_relations);
    IF private.employee_transfer_request_proof(v_job,'guards',v_binding,v_writes) IS NOT NULL THEN RETURN; END IF;
  END IF;
  PERFORM private.employee_transfer_check_maintenance_guards();
  IF v_relations IS NOT NULL THEN PERFORM private.employee_transfer_record_request_proof(v_job,'guards',v_binding,v_writes,'true'); END IF;
END;
$$;

ALTER FUNCTION private.employee_transfer_identity_admin_map(private.employee_transfer_jobs)
  RENAME TO employee_transfer_identity_admin_map_full;
CREATE FUNCTION private.employee_transfer_identity_admin_map(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_relations oid[]:=private.employee_transfer_request_relations(p_job.id); v_binding text; v_writes bigint[]; v_result jsonb;
BEGIN
  IF v_relations IS NOT NULL THEN
    v_binding:=private.employee_transfer_request_binding('admin-map',p_job,NULL);
    v_writes:=private.employee_transfer_request_writes(v_relations);
    v_result:=private.employee_transfer_request_proof(p_job.id,'admin-map',v_binding,v_writes);
    IF v_result IS NOT NULL THEN RETURN v_result; END IF;
  END IF;
  v_result:=private.employee_transfer_identity_admin_map_full(p_job);
  IF v_relations IS NOT NULL THEN PERFORM private.employee_transfer_record_request_proof(p_job.id,'admin-map',v_binding,v_writes,v_result); END IF;
  RETURN v_result;
END;
$$;

ALTER FUNCTION private.employee_transfer_verify_identity_contents(private.employee_transfer_jobs,jsonb)
  RENAME TO employee_transfer_verify_identity_contents_full;
CREATE FUNCTION private.employee_transfer_verify_identity_contents(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_relations oid[]:=private.employee_transfer_request_relations(p_job.id); v_binding text; v_writes bigint[];
BEGIN
  IF v_relations IS NOT NULL THEN
    v_binding:=private.employee_transfer_request_binding('identity',p_job,p_map);
    v_writes:=private.employee_transfer_request_writes(v_relations);
    IF private.employee_transfer_request_proof(p_job.id,'identity',v_binding,v_writes) IS NOT NULL THEN RETURN; END IF;
  END IF;
  PERFORM private.employee_transfer_verify_identity_contents_full(p_job,p_map);
  IF v_relations IS NOT NULL THEN PERFORM private.employee_transfer_record_request_proof(p_job.id,'identity',v_binding,v_writes,'true'); END IF;
END;
$$;

ALTER FUNCTION private.employee_transfer_dependency_owner(private.employee_transfer_jobs)
  RENAME TO employee_transfer_dependency_owner_full;
CREATE FUNCTION private.employee_transfer_dependency_owner(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_relations oid[]:=private.employee_transfer_request_relations(p_job.id); v_binding text; v_writes bigint[]; v_result jsonb;
BEGIN
  IF v_relations IS NOT NULL THEN
    v_binding:=private.employee_transfer_request_binding('dependency',p_job,NULL);
    v_writes:=private.employee_transfer_request_writes(v_relations);
    v_result:=private.employee_transfer_request_proof(p_job.id,'dependency',v_binding,v_writes);
    IF v_result IS NOT NULL THEN RETURN v_result; END IF;
  END IF;
  v_result:=private.employee_transfer_dependency_owner_full(p_job);
  IF v_relations IS NOT NULL THEN PERFORM private.employee_transfer_record_request_proof(p_job.id,'dependency',v_binding,v_writes,v_result); END IF;
  RETURN v_result;
END;
$$;

ALTER FUNCTION private.employee_transfer_check_dependency_progress(private.employee_transfer_jobs,jsonb)
  RENAME TO employee_transfer_check_dependency_progress_full;
CREATE FUNCTION private.employee_transfer_check_dependency_progress(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_relations oid[]:=private.employee_transfer_request_relations(p_job.id); v_binding text; v_writes bigint[];
BEGIN
  IF v_relations IS NOT NULL THEN
    v_binding:=private.employee_transfer_request_binding('dependency-progress',p_job,p_map);
    v_writes:=private.employee_transfer_request_writes(v_relations);
    IF private.employee_transfer_request_proof(p_job.id,'dependency-progress',v_binding,v_writes) IS NOT NULL THEN RETURN; END IF;
  END IF;
  PERFORM private.employee_transfer_check_dependency_progress_full(p_job,p_map);
  IF v_relations IS NOT NULL THEN PERFORM private.employee_transfer_record_request_proof(p_job.id,'dependency-progress',v_binding,v_writes,'true'); END IF;
END;
$$;

ALTER FUNCTION private.employee_transfer_finance_context(private.employee_transfer_jobs)
  RENAME TO employee_transfer_finance_context_full;
CREATE FUNCTION private.employee_transfer_finance_context(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_relations oid[]:=private.employee_transfer_request_relations(p_job.id); v_binding text; v_writes bigint[]; v_result jsonb;
BEGIN
  IF v_relations IS NOT NULL THEN
    v_binding:=private.employee_transfer_request_binding('finance-context',p_job,NULL);
    v_writes:=private.employee_transfer_request_writes(v_relations);
    v_result:=private.employee_transfer_request_proof(p_job.id,'finance-context',v_binding,v_writes);
    IF v_result IS NOT NULL THEN RETURN v_result; END IF;
  END IF;
  v_result:=private.employee_transfer_finance_context_full(p_job);
  IF v_relations IS NOT NULL THEN PERFORM private.employee_transfer_record_request_proof(p_job.id,'finance-context',v_binding,v_writes,v_result); END IF;
  RETURN v_result;
END;
$$;

ALTER FUNCTION private.employee_transfer_check_finance_input(private.employee_transfer_jobs)
  RENAME TO employee_transfer_check_finance_input_full;
CREATE FUNCTION private.employee_transfer_check_finance_input(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_relations oid[]:=private.employee_transfer_request_relations(p_job.id); v_binding text; v_writes bigint[]; v_result jsonb;
BEGIN
  IF v_relations IS NOT NULL THEN
    v_binding:=private.employee_transfer_request_binding('finance-input',p_job,NULL);
    v_writes:=private.employee_transfer_request_writes(v_relations);
    v_result:=private.employee_transfer_request_proof(p_job.id,'finance-input',v_binding,v_writes);
    IF v_result IS NOT NULL THEN RETURN v_result; END IF;
  END IF;
  v_result:=private.employee_transfer_check_finance_input_full(p_job);
  IF v_relations IS NOT NULL THEN PERFORM private.employee_transfer_record_request_proof(p_job.id,'finance-input',v_binding,v_writes,v_result); END IF;
  RETURN v_result;
END;
$$;

ALTER FUNCTION private.employee_transfer_finance_progress(private.employee_transfer_jobs,jsonb)
  RENAME TO employee_transfer_finance_progress_full;
CREATE FUNCTION private.employee_transfer_finance_progress(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_relations oid[]:=private.employee_transfer_request_relations(p_job.id); v_binding text; v_writes bigint[]; v_result jsonb;
BEGIN
  IF v_relations IS NOT NULL THEN
    v_binding:=private.employee_transfer_request_binding('finance-progress',p_job,p_map);
    v_writes:=private.employee_transfer_request_writes(v_relations);
    v_result:=private.employee_transfer_request_proof(p_job.id,'finance-progress',v_binding,v_writes);
    IF v_result IS NOT NULL THEN RETURN (v_result#>>'{}')::bigint; END IF;
  END IF;
  v_result:=to_jsonb(private.employee_transfer_finance_progress_full(p_job,p_map));
  IF v_relations IS NOT NULL THEN PERFORM private.employee_transfer_record_request_proof(p_job.id,'finance-progress',v_binding,v_writes,v_result); END IF;
  RETURN (v_result#>>'{}')::bigint;
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
