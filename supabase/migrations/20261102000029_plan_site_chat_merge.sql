BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_chat_source_issues(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_issues jsonb:='[]';v_key text;v_field text;v_edge jsonb;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['customer_employee_conversations','customer_service_sessions','ccc_conversation_annotations','customer_auto_message_logs','rating_requests','service_ratings'] LOOP
    IF EXISTS(SELECT 1 FROM private.employee_transfer_chat_input(p_job.id,v_key) AS r
      LEFT JOIN private.employee_transfer_identity_input(p_job.id,'accounts') AS a ON a.id::text=r.body->>'employee_id'
      WHERE a.id IS NULL) THEN v_issues:=v_issues||'"source_employee_missing"'::jsonb;EXIT;END IF;
  END LOOP;
  FOR v_key,v_field IN SELECT * FROM (VALUES ('simulated_customers','admin_id'),('cs_message_templates','admin_id'),
    ('customer_auto_messages','admin_id'),('ccc_conversation_annotations','owner_admin_id'),('ccc_conversation_annotations','updated_by')) AS f(k,c) LOOP
    IF EXISTS(SELECT 1 FROM private.employee_transfer_chat_input(p_job.id,v_key)
      WHERE body->>v_field IS NOT NULL AND p_map->>(body->>v_field) IS NULL) THEN v_issues:=v_issues||'"source_admin_unmapped"'::jsonb;EXIT;END IF;
  END LOOP;
  IF EXISTS(WITH visibility AS (
      SELECT body->>'target_employee_id' AS employee FROM private.employee_transfer_chat_input(p_job.id,'simulated_customers')
      UNION ALL SELECT value#>>'{}' FROM private.employee_transfer_chat_input(p_job.id,'simulated_customers') AS r
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(NULLIF(r.body->'target_employee_ids','null'::jsonb),'[]'::jsonb)) AS f(value)
    ) SELECT 1 FROM visibility AS v LEFT JOIN private.employee_transfer_identity_input(p_job.id,'accounts') AS a ON a.id::text=v.employee
      WHERE v.employee IS NOT NULL AND a.id IS NULL) THEN v_issues:=v_issues||'"source_visibility_unmapped"'::jsonb;END IF;
  FOR v_edge IN SELECT value FROM jsonb_array_elements('[
    ["customer_auto_messages","customer_id","simulated_customers"],
    ["customer_employee_conversations","customer_id","simulated_customers"],
    ["customer_employee_conversations","rich_card_content_id","rich_card_contents"],
    ["customer_service_sessions","customer_id","simulated_customers"],
    ["ccc_conversation_annotations","customer_id","simulated_customers"],
    ["customer_auto_message_logs","customer_id","simulated_customers"],
    ["customer_auto_message_logs","auto_message_id","customer_auto_messages"],
    ["rating_requests","customer_id","simulated_customers"],
    ["rating_requests","session_id","customer_service_sessions"],
    ["service_ratings","customer_id","simulated_customers"],
    ["service_ratings","session_id","customer_service_sessions"]
  ]'::jsonb) LOOP
    IF EXISTS(SELECT 1 FROM private.employee_transfer_chat_input(p_job.id,v_edge->>0) AS r
      LEFT JOIN private.employee_transfer_chat_input(p_job.id,v_edge->>2) AS parent ON parent.id=r.body->>(v_edge->>1)
      WHERE r.body->>(v_edge->>1) IS NOT NULL AND parent.id IS NULL) THEN v_issues:=v_issues||'"source_reference_missing"'::jsonb;EXIT;END IF;
  END LOOP;
  IF EXISTS(WITH roles AS MATERIALIZED(SELECT * FROM private.employee_transfer_chat_input(p_job.id,'simulated_customers')),
      accounts AS MATERIALIZED(SELECT * FROM private.employee_transfer_identity_input(p_job.id,'accounts')),
      histories AS (
        SELECT body FROM private.employee_transfer_chat_input(p_job.id,'customer_employee_conversations')
        UNION ALL SELECT body FROM private.employee_transfer_chat_input(p_job.id,'customer_service_sessions')
        UNION ALL SELECT body FROM private.employee_transfer_chat_input(p_job.id,'ccc_conversation_annotations')
        UNION ALL SELECT body FROM private.employee_transfer_chat_input(p_job.id,'customer_auto_message_logs')
        UNION ALL SELECT body FROM private.employee_transfer_chat_input(p_job.id,'rating_requests')
        UNION ALL SELECT body FROM private.employee_transfer_chat_input(p_job.id,'service_ratings')
      ) SELECT 1 FROM histories AS h JOIN roles AS r ON r.id=h.body->>'customer_id'
        JOIN accounts AS a ON a.id::text=h.body->>'employee_id'
        LEFT JOIN public.admins AS ra ON ra.id=(p_map->>(r.body->>'admin_id'))::uuid
        LEFT JOIN public.admins AS ea ON ea.id=(p_map->>(a.body->>'created_by'))::uuid
      WHERE (h.body ? 'source_type' AND h.body->'source_type' IS DISTINCT FROM r.body->'source_type')
        OR (p_map->>(r.body->>'admin_id') IS DISTINCT FROM p_map->>(a.body->>'created_by')
          AND COALESCE(ra.role,'')<>'super_admin' AND COALESCE(ea.role,'')<>'super_admin')
        OR (h.body ? 'owner_admin_id' AND p_map->>(h.body->>'owner_admin_id') IS DISTINCT FROM p_map->>(r.body->>'admin_id')))
    OR EXISTS(SELECT 1 FROM private.employee_transfer_chat_input(p_job.id,'customer_auto_messages') AS m
      JOIN private.employee_transfer_chat_input(p_job.id,'simulated_customers') AS r ON r.id=m.body->>'customer_id'
      WHERE p_map->>(m.body->>'admin_id') IS DISTINCT FROM p_map->>(r.body->>'admin_id'))
    OR EXISTS(SELECT 1 FROM private.employee_transfer_chat_input(p_job.id,'customer_auto_message_logs') AS l
      JOIN private.employee_transfer_chat_input(p_job.id,'customer_auto_messages') AS a ON a.id=l.body->>'auto_message_id'
      WHERE a.body->'customer_id' IS DISTINCT FROM l.body->'customer_id')
    OR EXISTS(WITH ratings AS (
        SELECT body FROM private.employee_transfer_chat_input(p_job.id,'rating_requests')
        UNION ALL SELECT body FROM private.employee_transfer_chat_input(p_job.id,'service_ratings')
      ) SELECT 1 FROM ratings AS r JOIN private.employee_transfer_chat_input(p_job.id,'customer_service_sessions') AS s ON s.id=r.body->>'session_id'
      WHERE r.body->'customer_id' IS DISTINCT FROM s.body->'customer_id' OR r.body->'employee_id' IS DISTINCT FROM s.body->'employee_id')
    THEN v_issues:=v_issues||'"source_scope_mismatch"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_chat_input(p_job.id,'simulated_customers') GROUP BY body->>'customer_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_chat_input(p_job.id,'customer_service_sessions') GROUP BY body->>'service_ticket_number' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_chat_input(p_job.id,'customer_service_sessions') GROUP BY body->>'customer_id',body->>'employee_id',body->>'status' HAVING count(*)>1) THEN
    v_issues:=v_issues||'"source_unique_collision"'::jsonb;
  END IF;
  IF EXISTS(WITH cards AS MATERIALIZED(SELECT * FROM private.employee_transfer_chat_input(p_job.id,'rich_card_contents')),
      templates AS MATERIALIZED(SELECT * FROM private.employee_transfer_chat_input(p_job.id,'cs_message_templates')),
      autos AS MATERIALIZED(SELECT * FROM private.employee_transfer_chat_input(p_job.id,'customer_auto_messages')),
      roles AS MATERIALIZED(SELECT * FROM private.employee_transfer_chat_input(p_job.id,'simulated_customers'))
    SELECT 1 FROM private.employee_transfer_chat_input(p_job.id,'customer_employee_conversations') AS m
      LEFT JOIN roles AS r ON r.id=m.body->>'customer_id'
      LEFT JOIN cards AS c ON c.id=m.body->>'rich_card_content_id'
      LEFT JOIN templates AS t ON t.id=m.body->>'source_template_id'
      LEFT JOIN autos AS a ON a.id=m.body->>'source_auto_message_id'
    WHERE m.body->>'message_type'='rich_card' AND (
      (m.body->'content_frozen'='true'::jsonb AND c.id IS NULL)
      OR (m.body->'content_frozen'='false'::jsonb AND (
        (m.body->>'source_template_id' IS NOT NULL AND (t.id IS NULL OR t.body->>'admin_id' IS DISTINCT FROM r.body->>'admin_id' OR t.body->'source_type' IS DISTINCT FROM r.body->'source_type'))
        OR (m.body->>'source_template_id' IS NULL AND m.body->>'source_auto_message_id' IS NOT NULL AND (a.id IS NULL OR a.body->'customer_id' IS DISTINCT FROM m.body->'customer_id'))
        OR (m.body->>'source_template_id' IS NULL AND m.body->>'source_auto_message_id' IS NULL AND m.body->>'rich_card_content_id' IS NOT NULL AND c.id IS NULL)
      )))) THEN v_issues:=v_issues||'"rich_card_unresolvable"'::jsonb;END IF;
  RETURN v_issues;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_roles(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  WITH source AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_chat_input(p_job.id,'simulated_customers')),
  candidates AS MATERIALIZED(
    SELECT r.id,r.body,p_map->>(r.body->>'admin_id') AS admin_id,
      COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'name',t.customer_name,'number',t.customer_id) ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL),'[]'::jsonb) AS choices,
      (array_agg(t.id ORDER BY t.id) FILTER (WHERE t.customer_name=r.body->>'customer_name' AND t.customer_id=r.body->>'customer_id'))[1] AS exact_id,
      (array_agg(t.id ORDER BY t.id) FILTER (WHERE t.customer_name=r.body->>'customer_name'))[1] AS name_id,
      count(*) FILTER (WHERE t.customer_name=r.body->>'customer_name') AS names
    FROM source AS r LEFT JOIN public.simulated_customers AS t ON t.admin_id=(p_map->>(r.body->>'admin_id'))::uuid
      AND t.source_type=r.body->>'source_type' AND (t.customer_name=r.body->>'customer_name' OR t.customer_id=r.body->>'customer_id')
    GROUP BY r.id,r.body
  ), proposals AS MATERIALIZED(
    SELECT *,CASE WHEN admin_id IS NULL THEN 'unmapped' WHEN exact_id IS NOT NULL THEN 'exact' WHEN names=1 THEN 'name'
      WHEN names>1 THEN 'ambiguous' WHEN jsonb_array_length(choices)>0 THEN 'number_conflict' ELSE 'new' END AS match,
      CASE WHEN admin_id IS NULL THEN NULL ELSE COALESCE(exact_id,CASE WHEN names=1 THEN name_id END) END AS target_id
    FROM candidates
  ), results AS (
    SELECT p.*,COALESCE(v.ids,'[]'::jsonb) AS visibility,
      p.target_id IS NOT NULL AND count(*) OVER (PARTITION BY p.target_id)>1 AS multi,
      EXISTS(SELECT 1 FROM public.simulated_customers AS t WHERE t.customer_id=p.body->>'customer_id' AND t.id IS DISTINCT FROM p.target_id) AS occupied
    FROM proposals AS p LEFT JOIN public.simulated_customers AS target ON target.id=p.target_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(a.id ORDER BY a.id) AS ids FROM private.employee_transfer_identity_input(p_job.id,'accounts') AS a
        LEFT JOIN public.admins AS owner ON owner.id=(p_map->>(a.body->>'created_by'))::uuid
        LEFT JOIN public.admins AS role_owner ON role_owner.id=p.admin_id::uuid
      WHERE p.target_id IS NOT NULL
        AND (p_map->>(a.body->>'created_by')=p.admin_id OR owner.role='super_admin' OR role_owner.role='super_admin')
        AND CASE WHEN jsonb_array_length(COALESCE(NULLIF(p.body->'target_employee_ids','null'::jsonb),'[]'::jsonb))>0
          THEN p.body->'target_employee_ids' ? a.id::text ELSE true END
        AND COALESCE(cardinality(target.target_employee_ids),0)>0
        AND NOT EXISTS(SELECT 1 FROM unnest(target.target_employee_ids) AS visible(employee_id) WHERE visible.employee_id=a.id)
    ) AS v ON true
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('source_id',id,'source_name',body->>'customer_name','source_number',body->>'customer_id',
    'target_admin_id',admin_id,'source_type',body->>'source_type','match',match,'target_id',target_id,'candidates',choices,
    'needs_confirmation',match IN ('ambiguous','number_conflict','unmapped') OR multi OR jsonb_array_length(visibility)>0,
    'number_occupied',occupied,'visibility_employee_ids',visibility,'multi_source_target',multi) ORDER BY id COLLATE "C"),'[]'::jsonb) FROM results;
$$;

CREATE FUNCTION private.employee_transfer_chat_target_hash()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_hash text;v_state jsonb:='{}';
BEGIN
  FOREACH v_key IN ARRAY private.employee_transfer_chat_keys() LOOP
    EXECUTE 'SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(body::text,''UTF8''),''sha256''),''hex''),'''' ORDER BY id COLLATE "C"),''''),''UTF8''),''sha256''),''hex'') FROM ('||private.employee_transfer_chat_query(v_key)||') AS r' INTO v_hash;
    v_state:=v_state||jsonb_build_object(v_key,v_hash);
  END LOOP;
  RETURN encode(extensions.digest(convert_to(v_state::text,'UTF8'),'sha256'),'hex');
END;
$$;

CREATE FUNCTION public.get_employee_import_chat_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_admin uuid;v_map jsonb;v_counts jsonb;v_plan jsonb;
BEGIN
  SELECT admin_id INTO v_admin FROM private.employee_transfer_admin(p_admin_session_token);
  SELECT * INTO v_job FROM private.employee_transfer_jobs
    WHERE token_hash=private.hash_financial_token(p_job_token) AND admin_id=v_admin AND kind='import' AND status='running'
      AND options->>'import_protocol'='dispatch-submission-v1' AND last_activity_at>now()-interval '3 hours' AND started_at>now()-interval '12 hours';
  IF v_job.id IS NULL OR p_job_token IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.';END IF;
  v_map:=private.employee_transfer_chat_owner(v_job);v_counts:=private.employee_transfer_check_chat_input(v_job);
  v_plan:=jsonb_build_object('scope','site-chat','checked',true,'can_restore',false,'restore_pending',true,'media_pending',true,
    'counts',v_counts,'employees',(v_job.summary#>>'{identity_catalog,tables,0,rows}')::bigint,
    'conflicts',private.employee_transfer_chat_source_issues(v_job,v_map),'roles',private.employee_transfer_chat_roles(v_job,v_map),
    'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,'job_id',v_job.id,
    'catalog',v_job.summary->'chat_catalog','admin_map',v_map,'target_hash',private.employee_transfer_chat_target_hash())::text,'UTF8'),'sha256'),'hex'));
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_chat_source_issues(private.employee_transfer_jobs,jsonb),
  private.employee_transfer_chat_roles(private.employee_transfer_jobs,jsonb),private.employee_transfer_chat_target_hash() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_employee_import_chat_plan(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_import_chat_plan(uuid,uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
