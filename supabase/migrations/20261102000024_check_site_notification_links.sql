BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_notifications_source_issues(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_issues jsonb:='[]';v_key text;v_field text;v_edge jsonb;v_bad boolean;
BEGIN
  FOR v_key,v_field IN SELECT * FROM (VALUES
    ('notification_automation_plan_members','user_id'),('notification_automation_task_recipients','user_id'),
    ('notification_automation_progress','user_id'),('notification_automation_executions','user_id'),
    ('notification_automation_failures','user_id'),('message_recipients','recipient_id'),('broadcast_recipients','employee_id')) AS f(k,c) LOOP
    IF EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,v_key) AS n
      LEFT JOIN private.employee_transfer_identity_input(p_job.id,'accounts') AS a ON a.id::text=n.body->>v_field
      WHERE n.body->>v_field IS NOT NULL AND a.id IS NULL) THEN v_issues:=v_issues||'"source_employee_missing"'::jsonb;EXIT;END IF;
  END LOOP;
  FOR v_key,v_field IN SELECT * FROM (VALUES
    ('notification_automation_plans','owner_admin_id'),('notification_automation_tasks','owner_admin_id'),
    ('notification_automation_executions','owner_admin_id'),('notification_automation_failures','owner_admin_id'),
    ('messages','sender_id'),('message_templates','admin_id'),('broadcast_messages','admin_id'),('broadcast_messages','target_admin_id')) AS f(k,c) LOOP
    IF EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,v_key)
      WHERE body->>v_field IS NOT NULL AND p_map->>(body->>v_field) IS NULL) THEN v_issues:=v_issues||'"source_admin_unmapped"'::jsonb;EXIT;END IF;
  END LOOP;
  FOR v_edge IN SELECT value FROM jsonb_array_elements('[
    ["notification_automation_tasks","plan_id","notification_automation_plans"],
    ["notification_automation_tasks","source_task_id","notification_automation_tasks"],
    ["notification_automation_plan_members","plan_id","notification_automation_plans"],
    ["notification_automation_task_recipients","task_id","notification_automation_tasks"],
    ["notification_automation_progress","task_id","notification_automation_tasks"],
    ["notification_automation_executions","task_id","notification_automation_tasks"],
    ["notification_automation_executions","plan_id","notification_automation_plans"],
    ["notification_automation_executions","message_id","messages"],
    ["notification_automation_failures","task_id","notification_automation_tasks"],
    ["notification_automation_date_runs","task_id","notification_automation_tasks"],
    ["messages","automation_execution_id","notification_automation_executions"],
    ["message_recipients","message_id","messages"],
    ["broadcast_recipients","broadcast_id","broadcast_messages"]
  ]'::jsonb) LOOP
    IF EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,v_edge->>0) AS n
      LEFT JOIN private.employee_transfer_notifications_input(p_job.id,v_edge->>2) AS parent ON parent.id=n.body->>(v_edge->>1)
      WHERE n.body->>(v_edge->>1) IS NOT NULL AND parent.id IS NULL) THEN v_issues:=v_issues||'"source_reference_missing"'::jsonb;EXIT;END IF;
  END LOOP;

  IF EXISTS(WITH tasks AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_tasks')),
      plans AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_plans')),
      accounts AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_identity_input(p_job.id,'accounts'))
    SELECT 1 FROM tasks AS t JOIN plans AS p ON p.id=t.body->>'plan_id' WHERE t.body->'owner_admin_id' IS DISTINCT FROM p.body->'owner_admin_id'
    UNION ALL SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_plan_members') AS m
      JOIN plans AS p ON p.id=m.body->>'plan_id' JOIN accounts AS a ON a.id::text=m.body->>'user_id'
      WHERE p_map->>(p.body->>'owner_admin_id') IS DISTINCT FROM p_map->>(a.body->>'created_by')
    UNION ALL SELECT 1 FROM (
      SELECT body FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_task_recipients')
      UNION ALL SELECT body FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_progress')
      UNION ALL SELECT body FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_failures')
    ) AS r JOIN tasks AS t ON t.id=r.body->>'task_id' JOIN accounts AS a ON a.id::text=r.body->>'user_id'
      WHERE p_map->>(t.body->>'owner_admin_id') IS DISTINCT FROM p_map->>(a.body->>'created_by')
        OR (r.body ? 'owner_admin_id' AND r.body->'owner_admin_id' IS DISTINCT FROM t.body->'owner_admin_id')) THEN v_issues:=v_issues||'"source_scope_mismatch"'::jsonb;END IF;

  IF EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_plans') GROUP BY p_map->>(body->>'owner_admin_id'),lower(body->>'name') HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_tasks') GROUP BY p_map->>(body->>'owner_admin_id'),body->>'plan_id',body->>'name',body->>'is_shared_template' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'message_templates') GROUP BY p_map->>(body->>'admin_id'),body->>'name' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'message_recipients') GROUP BY body->>'message_id',body->>'recipient_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'broadcast_recipients') GROUP BY body->>'broadcast_id',body->>'employee_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_executions') WHERE body->>'task_id' IS NOT NULL AND body->>'user_id' IS NOT NULL
      GROUP BY body->>'task_id',body->>'task_version',body->>'user_id',body->>'period_key',body->>'stage' HAVING count(*)>1) THEN v_issues:=v_issues||'"source_unique_collision"'::jsonb;END IF;

  WITH messages AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_notifications_input(p_job.id,'messages')),
    recipients AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_notifications_input(p_job.id,'message_recipients')),
    executions AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_executions')),
    bonuses AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_finance_input(p_job.id,'wallet_transactions') WHERE body->>'type'='performance_bonus')
  SELECT EXISTS(
    SELECT 1 FROM bonuses AS b LEFT JOIN recipients AS r ON r.id=b.body->>'reference_id' LEFT JOIN messages AS m ON m.id=r.body->>'message_id'
      WHERE r.id IS NULL OR m.id IS NULL OR b.body->'user_id' IS DISTINCT FROM r.body->'recipient_id'
        OR m.body->>'notification_category' IS DISTINCT FROM 'performance_reward'
        OR b.body->'amount' IS DISTINCT FROM m.body->'reward_amount'
    UNION ALL SELECT 1 FROM messages AS m JOIN recipients AS r ON r.body->>'message_id'=m.id LEFT JOIN bonuses AS b ON b.body->>'reference_id'=r.id
      WHERE m.body->>'notification_category'='performance_reward' AND (b.id IS NULL OR b.body->'user_id' IS DISTINCT FROM r.body->'recipient_id' OR b.body->'amount' IS DISTINCT FROM m.body->'reward_amount')
    UNION ALL SELECT 1 FROM messages AS m LEFT JOIN executions AS e ON e.id=m.body->>'automation_execution_id'
      WHERE (m.body->>'audit_origin'='automation' AND m.body->>'automation_execution_id' IS NULL)
        OR (m.body->>'automation_execution_id' IS NOT NULL AND (e.id IS NULL OR m.body->>'audit_origin'<>'automation' OR e.body->>'message_id' IS DISTINCT FROM m.id))
        OR (m.body->>'notification_category'='performance_reward' AND ((m.body->>'reward_amount')::numeric IS NULL OR (m.body->>'reward_amount')::numeric<=0 OR m.body->>'reward_currency' IS NULL
          OR NOT EXISTS(SELECT 1 FROM recipients AS r WHERE r.body->>'message_id'=m.id)))
    UNION ALL SELECT 1 FROM executions AS e LEFT JOIN messages AS m ON m.id=e.body->>'message_id'
      LEFT JOIN recipients AS r ON r.body->>'message_id'=m.id AND r.body->'recipient_id'=e.body->'user_id'
      LEFT JOIN bonuses AS b ON b.id=e.body->>'wallet_transaction_id'
      WHERE (e.body->>'wallet_transaction_id' IS NOT NULL AND (b.id IS NULL OR b.body->'user_id' IS DISTINCT FROM e.body->'user_id'
          OR b.body->'amount' IS DISTINCT FROM e.body->'reward_amount' OR b.body->>'reference_id' IS DISTINCT FROM r.id OR b.body->>'operation_id' IS DISTINCT FROM e.id))
        OR (e.body->>'status'='succeeded' AND (m.id IS NULL OR r.id IS NULL OR m.body->>'automation_execution_id' IS DISTINCT FROM e.id
          OR m.body->'sender_id' IS DISTINCT FROM e.body->'owner_admin_id' OR m.body->'reward_amount' IS DISTINCT FROM e.body->'reward_amount'
          OR m.body->'reward_currency' IS DISTINCT FROM e.body->'reward_currency'
          OR (e.body->>'reward_amount' IS NOT NULL AND b.id IS NULL)
          OR (SELECT count(*) FROM recipients AS x WHERE x.body->>'message_id'=m.id)<>1))
  ) INTO v_bad;
  IF v_bad THEN v_issues:=v_issues||'"reward_link_mismatch"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_executions') WHERE body->>'status'='processing') THEN v_issues:=v_issues||'"unfinished_execution"'::jsonb;END IF;
  IF to_regclass('public.notification_automation_date_runs') IS NULL AND EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_date_runs')) THEN v_issues:=v_issues||'"unsupported_date_runs"'::jsonb;END IF;
  RETURN v_issues;
END;
$$;

CREATE FUNCTION public.get_employee_import_notifications_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_admin uuid;v_map jsonb;v_counts jsonb;v_issues jsonb;v_rewards bigint;v_plan jsonb;
BEGIN
  SELECT admin_id INTO v_admin FROM private.employee_transfer_admin(p_admin_session_token);
  SELECT * INTO v_job FROM private.employee_transfer_jobs
    WHERE token_hash=private.hash_financial_token(p_job_token) AND admin_id=v_admin AND kind='import' AND status='running'
      AND options->>'import_protocol'='dispatch-submission-v1' AND last_activity_at>now()-interval '3 hours' AND started_at>now()-interval '12 hours';
  IF v_job.id IS NULL OR p_job_token IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.';END IF;
  v_map:=private.employee_transfer_notifications_owner(v_job);v_counts:=private.employee_transfer_check_notifications_input(v_job);
  v_issues:=private.employee_transfer_notifications_source_issues(v_job,v_map);
  SELECT count(*) INTO v_rewards FROM private.employee_transfer_finance_input(v_job.id,'wallet_transactions') WHERE body->>'type'='performance_bonus';
  v_plan:=jsonb_build_object('scope','site-notifications','checked',true,'can_restore',false,'restore_pending',true,'media_pending',true,'automation_pending',true,
    'counts',v_counts,'employees',(v_job.summary#>>'{identity_catalog,tables,0,rows}')::bigint,'rewards',v_rewards,'conflicts',v_issues,
    'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,'job_id',v_job.id,
    'catalog',v_job.summary->'notifications_catalog','admin_map',v_map)::text,'UTF8'),'sha256'),'hex'));
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_notifications_source_issues(private.employee_transfer_jobs,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_employee_import_notifications_plan(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_import_notifications_plan(uuid,uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
