BEGIN;

CREATE FUNCTION private.employee_transfer_identity_candidate_free(
  p_job private.employee_transfer_jobs,p_source_id uuid,p_candidate uuid
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT p_candidate IS NOT NULL AND p_candidate<>ALL(ARRAY[
      '00000000-0000-0000-0000-000000000000'::uuid,p_job.id,p_job.admin_id,p_source_id,
      (SELECT site_id FROM private.employee_transfer_site),
      (p_job.summary#>>'{identity_catalog,site_id}')::uuid,
      (p_job.summary#>>'{identity_catalog,package_id}')::uuid])
    AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_candidate)
    AND NOT EXISTS(SELECT 1 FROM public.admins WHERE id=p_candidate)
    AND NOT EXISTS(SELECT 1 FROM private.deleted_employee_accounts WHERE id=p_candidate OR employee_id=p_candidate)
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['accounts','credentials','orders']) AS keys(key)
      CROSS JOIN LATERAL private.employee_transfer_identity_input(p_job.id,keys.key) AS source
      WHERE source.id=p_candidate OR source.body->>'user_id'=p_candidate::text OR source.body->>'created_by'=p_candidate::text)
    AND NOT EXISTS(SELECT 1 FROM private.employee_transfer_staging AS s
      WHERE s.table_key='identity-reservation-v1' AND s.payload->>'target_id'=p_candidate::text
        AND NOT (s.job_id=p_job.id AND s.employee_id=p_source_id));
$$;

CREATE FUNCTION private.employee_transfer_identity_reservation_status(
  p_job private.employee_transfer_jobs,p_source_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_after uuid;v_page jsonb;v_saved jsonb;v_stage record;v_count bigint;v_site uuid;
BEGIN
  IF p_source_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') WHERE id=p_source_id
  ) THEN RAISE EXCEPTION 'Identity candidate source is not bound to this task.';END IF;
  IF p_job.summary ? 'identity_restore' THEN
    RAISE EXCEPTION 'Identity restore already started; candidate preparation is closed.';
  END IF;
  SELECT id INTO v_after FROM private.employee_transfer_identity_input(p_job.id,'accounts')
    WHERE id<p_source_id ORDER BY id DESC LIMIT 1;
  v_page:=private.employee_transfer_replacement_page(p_job,v_after,1);
  SELECT site_id INTO STRICT v_site FROM private.employee_transfer_site;
  SELECT count(*) INTO v_count FROM private.employee_transfer_staging
    WHERE job_id=p_job.id AND employee_id=p_source_id AND table_key='identity-reservation-v1';
  IF v_count>1 THEN RAISE EXCEPTION 'Identity candidate binding changed.';END IF;
  IF v_count=1 THEN
    SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging
      WHERE job_id=p_job.id AND employee_id=p_source_id AND table_key='identity-reservation-v1';
    v_saved:=v_stage.payload;
    IF v_stage.chunk_no<>0 OR v_stage.row_count<>1
      OR NOT private.employee_transfer_exact_object(v_saved,ARRAY['version','job_id','site_id','source_site_id',
        'package_id','source_id','target_id','source_fingerprint','target_fingerprint','binding_hash'])
      OR v_saved->'version' IS DISTINCT FROM '1'::jsonb
      OR v_saved->'job_id' IS DISTINCT FROM to_jsonb(p_job.id)
      OR v_saved->'site_id' IS DISTINCT FROM to_jsonb(v_site)
      OR v_saved->'source_id' IS DISTINCT FROM to_jsonb(p_source_id)
      OR v_saved->'source_site_id' IS DISTINCT FROM p_job.summary#>'{identity_catalog,site_id}'
      OR v_saved->'package_id' IS DISTINCT FROM p_job.summary#>'{identity_catalog,package_id}'
      OR jsonb_typeof(v_saved->'target_id') IS DISTINCT FROM 'string'
      OR (v_saved->>'target_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR jsonb_typeof(v_saved->'source_fingerprint') IS DISTINCT FROM 'string'
      OR (v_saved->>'source_fingerprint') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(v_saved->'target_fingerprint') IS DISTINCT FROM 'string'
      OR (v_saved->>'target_fingerprint') !~ '^[0-9a-f]{64}$'
      OR v_saved->'binding_hash' IS DISTINCT FROM to_jsonb(encode(extensions.digest(
        convert_to((v_saved-'binding_hash')::text,'UTF8'),'sha256'),'hex')) THEN
      RAISE EXCEPTION 'Identity candidate binding changed.';
    END IF;
  END IF;
  RETURN jsonb_build_object('scope','employee-identity-reservation','checked',true,
    'job_id',p_job.id,'site_id',v_site,'source_site_id',v_page->'source_site_id','package_id',v_page->'package_id',
    'source_id',p_source_id,'observed',v_page,'reservation',v_saved,
    'source_unchanged',v_saved IS NOT NULL AND v_saved->>'source_fingerprint'=v_page->>'source_fingerprint',
    'target_unchanged',v_saved IS NOT NULL AND v_saved->>'target_fingerprint'=v_page->>'target_fingerprint',
    'candidate_available',v_saved IS NOT NULL AND private.employee_transfer_identity_candidate_free(
      p_job,p_source_id,(v_saved->>'target_id')::uuid),
    'can_restore',false,'complete_employee_backup',false,'can_archive',false,'can_replace',false,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_identity_reservation_status(
  p_admin_session_token uuid,p_job_token uuid,p_source_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  RETURN private.employee_transfer_identity_reservation_status(v_job,p_source_id);
END;
$$;

CREATE FUNCTION public.employee_import_identity_reserve(
  p_admin_session_token uuid,p_job_token uuid,p_source_id uuid,p_source_fingerprint text,p_target_fingerprint text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_status jsonb;v_saved jsonb;v_candidate uuid;v_attempt integer;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  -- Serialize technical candidates only; this does not reserve a public.users namespace slot.
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_status:=private.employee_transfer_identity_reservation_status(v_job,p_source_id);
  IF p_source_fingerprint IS NULL OR p_source_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_target_fingerprint IS NULL OR p_target_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_source_fingerprint IS DISTINCT FROM v_status#>>'{observed,source_fingerprint}'
    OR p_target_fingerprint IS DISTINCT FROM v_status#>>'{observed,target_fingerprint}' THEN
    RAISE EXCEPTION 'Identity candidate checkpoint changed; inspect the original task status.';
  END IF;
  IF v_status->'reservation'<>'null'::jsonb THEN
    IF v_status->'source_unchanged' IS DISTINCT FROM 'true'::jsonb
      OR v_status->'target_unchanged' IS DISTINCT FROM 'true'::jsonb
      OR v_status->'candidate_available' IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'Identity candidate is frozen and no longer matches; no automatic rebase is allowed.';
    END IF;
    RETURN v_status;
  END IF;
  FOR v_attempt IN 1..64 LOOP
    v_candidate:=pg_catalog.gen_random_uuid();
    EXIT WHEN private.employee_transfer_identity_candidate_free(v_job,p_source_id,v_candidate);
    v_candidate:=NULL;
  END LOOP;
  IF v_candidate IS NULL THEN RAISE EXCEPTION 'No unused employee identity candidate could be prepared.';END IF;
  v_saved:=jsonb_build_object('version',1,'job_id',v_job.id,'site_id',v_status->'site_id',
    'source_site_id',v_status->'source_site_id','package_id',v_status->'package_id','source_id',p_source_id,
    'target_id',v_candidate,'source_fingerprint',p_source_fingerprint,'target_fingerprint',p_target_fingerprint);
  v_saved:=v_saved||jsonb_build_object('binding_hash',encode(extensions.digest(convert_to(v_saved::text,'UTF8'),'sha256'),'hex'));
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,p_source_id,'identity-reservation-v1',0,1,v_saved);
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','identity_candidate_reserved',
    jsonb_build_object('source_id',p_source_id,'target_id',v_candidate,'binding_hash',v_saved->'binding_hash',
      'can_restore',false,'can_archive',false,'can_replace',false,'full_site_complete',false));
  RETURN private.employee_transfer_identity_reservation_status(v_job,p_source_id);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_identity_candidate_free(private.employee_transfer_jobs,uuid,uuid),
  private.employee_transfer_identity_reservation_status(private.employee_transfer_jobs,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.employee_import_identity_reservation_status(uuid,uuid,uuid),
  public.employee_import_identity_reserve(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_import_identity_reservation_status(uuid,uuid,uuid),
  public.employee_import_identity_reserve(uuid,uuid,uuid,text,text) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
