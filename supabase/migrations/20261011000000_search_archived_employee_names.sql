ALTER TABLE private.deleted_employee_accounts ADD COLUMN account_real_name text;

UPDATE private.deleted_employee_accounts record
SET account_real_name = (
  SELECT verification.real_name
  FROM public.verification_requests verification
  WHERE verification.user_id = record.employee_id AND verification.status = 'approved'
  ORDER BY verification.created_at DESC NULLS LAST, verification.id DESC
  LIMIT 1
)
WHERE record.cleared_at IS NULL;

CREATE OR REPLACE FUNCTION private.archive_employees_before_admin_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_actor public.admins%ROWTYPE; v_operation uuid; v_user public.users%ROWTYPE;
BEGIN
  IF current_setting('content_audit.action', true) IS DISTINCT FROM 'admin_delete'
    OR NULLIF(current_setting('content_audit.operation', true), '') IS NULL THEN
    RAISE EXCEPTION 'Administrator deletion requires an audited operation.';
  END IF;
  v_operation := current_setting('content_audit.operation')::uuid;
  SELECT * INTO v_actor FROM public.admins
  WHERE id = NULLIF(current_setting('content_audit.actor', true), '')::uuid AND is_active = true;
  IF v_actor.id IS NULL OR v_actor.role <> 'super_admin' OR OLD.role <> 'secondary_admin' THEN
    RAISE EXCEPTION 'Administrator deletion requires a verified super administrator.';
  END IF;
  PERFORM private.acquire_notification_automation_configuration_lock();
  INSERT INTO private.deleted_employee_accounts (
    operation_id, employee_id, account_username, employee_number, account_real_name, account_created_at, account_remarks,
    owner_admin_id, owner_username, actor_admin_id, actor_username, actor_role, deletion_source
  )
  SELECT v_operation, u.id, u.username, u.employee_id,
    (SELECT verification.real_name FROM public.verification_requests verification
      WHERE verification.user_id = u.id AND verification.status = 'approved'
      ORDER BY verification.created_at DESC NULLS LAST, verification.id DESC LIMIT 1),
    u.created_at, u.remarks, OLD.id, OLD.username,
    v_actor.id, v_actor.username, v_actor.role, 'admin_delete'
  FROM public.users u WHERE u.created_by = OLD.id AND u.archived_at IS NULL;
  FOR v_user IN SELECT * FROM public.users WHERE created_by = OLD.id AND archived_at IS NULL FOR UPDATE LOOP
    PERFORM private.archive_deleted_employee_notifications(v_user.id, v_operation);
    DELETE FROM public.message_recipients WHERE recipient_id = v_user.id;
    DELETE FROM public.notification_automation_plan_members WHERE user_id = v_user.id;
    DELETE FROM public.notification_automation_task_recipients WHERE user_id = v_user.id;
    DELETE FROM public.notification_automation_queue WHERE user_id = v_user.id;
    DELETE FROM public.dispatch_group_members WHERE user_id = v_user.id;
    UPDATE public.employee_financial_sessions SET revoked_at = clock_timestamp()
      WHERE user_id = v_user.id AND revoked_at IS NULL;
    UPDATE public.users SET is_active = false, archived_at = clock_timestamp(),
      current_session_token = NULL, current_tab_id = NULL, remarks = '',
      username = 'archived-' || id::text, employee_id = 'archived-' || id::text,
      created_by = v_actor.id WHERE id = v_user.id;
  END LOOP;
  UPDATE public.users SET created_by = v_actor.id
  WHERE created_by = OLD.id AND archived_at IS NOT NULL;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_employee_account(p_admin_session_token uuid, p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_operation uuid; v_user public.users%ROWTYPE;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF current_setting('content_audit.action', true) IS DISTINCT FROM 'employee_delete'
    OR NULLIF(current_setting('content_audit.actor', true), '')::uuid IS DISTINCT FROM v_admin
    OR NULLIF(current_setting('content_audit.operation', true), '') IS NULL THEN
    RAISE EXCEPTION 'Employee archive requires a verified audit operation.';
  END IF;
  v_operation := current_setting('content_audit.operation')::uuid;
  PERFORM private.assert_admin_can_manage_user(v_admin, v_role, p_user_id);
  PERFORM private.acquire_notification_automation_configuration_lock();
  SELECT * INTO v_user FROM public.users WHERE id = p_user_id AND archived_at IS NULL FOR UPDATE;
  IF v_user.id IS NULL THEN RETURN false; END IF;
  INSERT INTO private.deleted_employee_accounts (
    operation_id, employee_id, account_username, employee_number, account_real_name, account_created_at, account_remarks,
    owner_admin_id, owner_username, actor_admin_id, actor_username, actor_role, deletion_source
  ) VALUES (
    v_operation, v_user.id, v_user.username, v_user.employee_id,
    (SELECT verification.real_name FROM public.verification_requests verification
      WHERE verification.user_id = v_user.id AND verification.status = 'approved'
      ORDER BY verification.created_at DESC NULLS LAST, verification.id DESC LIMIT 1),
    v_user.created_at, v_user.remarks,
    v_user.created_by, (SELECT username FROM public.admins WHERE id = v_user.created_by),
    v_admin, (SELECT username FROM public.admins WHERE id = v_admin), v_role, 'employee_delete'
  );
  PERFORM private.archive_deleted_employee_notifications(v_user.id, v_operation);
  DELETE FROM public.message_recipients WHERE recipient_id = v_user.id;
  DELETE FROM public.notification_automation_plan_members WHERE user_id = v_user.id;
  DELETE FROM public.notification_automation_task_recipients WHERE user_id = v_user.id;
  DELETE FROM public.notification_automation_queue WHERE user_id = v_user.id;
  DELETE FROM public.dispatch_group_members WHERE user_id = v_user.id;
  UPDATE public.employee_financial_sessions SET revoked_at = clock_timestamp()
    WHERE user_id = v_user.id AND revoked_at IS NULL;
  UPDATE public.users SET is_active = false, archived_at = clock_timestamp(),
    current_session_token = NULL, current_tab_id = NULL, remarks = '',
    username = 'archived-' || id::text, employee_id = 'archived-' || id::text
  WHERE id = v_user.id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_deleted_employee_accounts(
  p_admin_session_token uuid, p_owner uuid DEFAULT NULL, p_search text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL,
  p_page integer DEFAULT 0, p_page_size integer DEFAULT 30, p_source text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb; v_search text;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  IF p_page NOT BETWEEN 0 AND 100000 OR p_page_size NOT BETWEEN 1 AND 100
    OR length(COALESCE(p_search, '')) > 100 OR (p_from IS NOT NULL AND p_to IS NOT NULL AND p_from >= p_to)
    OR (p_source IS NOT NULL AND p_source NOT IN ('employee_delete', 'admin_delete')) THEN
    RAISE EXCEPTION 'Invalid deleted employee search.';
  END IF;
  v_search := NULLIF(btrim(p_search), '');
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM private.deleted_employee_accounts record
      WHERE (p_owner IS NULL OR record.owner_admin_id = p_owner)
        AND (p_source IS NULL OR record.deletion_source = p_source)
        AND (p_from IS NULL OR record.deleted_at >= p_from)
        AND (p_to IS NULL OR record.deleted_at < p_to)
        AND (v_search IS NULL OR record.account_username ILIKE '%' || v_search || '%'
          OR record.account_real_name ILIKE '%' || v_search || '%'
          OR record.employee_number ILIKE '%' || v_search || '%')),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.deleted_at DESC, page.id DESC)
      FROM (SELECT record.id, record.operation_id, record.employee_id, record.account_username, record.employee_number,
        record.account_real_name, record.account_created_at, record.account_remarks, record.owner_admin_id, record.owner_username, record.actor_admin_id, record.actor_username,
        record.actor_role, record.deletion_source, record.deleted_at, record.cleared_at
      FROM private.deleted_employee_accounts record
      WHERE (p_owner IS NULL OR record.owner_admin_id = p_owner)
        AND (p_source IS NULL OR record.deletion_source = p_source)
        AND (p_from IS NULL OR record.deleted_at >= p_from)
        AND (p_to IS NULL OR record.deleted_at < p_to)
        AND (v_search IS NULL OR record.account_username ILIKE '%' || v_search || '%'
          OR record.account_real_name ILIKE '%' || v_search || '%'
          OR record.employee_number ILIKE '%' || v_search || '%')
      ORDER BY record.deleted_at DESC, record.id DESC LIMIT p_page_size OFFSET p_page * p_page_size) page), '[]'::jsonb),
    'owners', CASE WHEN p_page = 0 THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', owners.owner_admin_id,
      'username', owners.owner_username, 'event_count', owners.event_count) ORDER BY owners.owner_username, owners.owner_admin_id)
      FROM (SELECT admin.id AS owner_admin_id, admin.username AS owner_username,
        COALESCE(counts.event_count, 0) AS event_count
        FROM public.admins admin LEFT JOIN (
          SELECT owner_admin_id, count(*) AS event_count FROM private.deleted_employee_accounts GROUP BY owner_admin_id
        ) counts ON counts.owner_admin_id = admin.id
        UNION ALL
        SELECT counts.owner_admin_id,
          COALESCE((SELECT previous.owner_username FROM private.deleted_employee_accounts previous
            WHERE previous.owner_admin_id = counts.owner_admin_id AND previous.owner_username IS NOT NULL
            ORDER BY previous.deleted_at DESC LIMIT 1), counts.owner_admin_id::text), counts.event_count
        FROM (SELECT owner_admin_id, count(*) AS event_count FROM private.deleted_employee_accounts GROUP BY owner_admin_id) counts
        WHERE NOT EXISTS (SELECT 1 FROM public.admins admin WHERE admin.id = counts.owner_admin_id)) owners), '[]'::jsonb) ELSE '[]'::jsonb END
  ) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_deleted_employee_account(
  p_admin_session_token uuid, p_record_id uuid, p_reason text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_record private.deleted_employee_accounts%ROWTYPE;
BEGIN
  v_admin := private.assert_content_audit_purge(p_admin_session_token);
  IF length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'Enter a reason between 10 and 500 characters.';
  END IF;
  SELECT * INTO v_record FROM private.deleted_employee_accounts WHERE id = p_record_id FOR UPDATE;
  IF v_record.id IS NULL THEN RAISE EXCEPTION 'Employee deletion record is not available.'; END IF;
  IF v_record.cleared_at IS NOT NULL THEN RETURN true; END IF;
  UPDATE private.deleted_employee_accounts SET account_username = NULL, employee_number = NULL,
    account_real_name = NULL, account_created_at = NULL, account_remarks = NULL, owner_username = NULL,
    cleared_at = clock_timestamp(), cleared_by = v_admin,
    cleared_username = (SELECT username FROM public.admins WHERE id = v_admin), clear_reason = btrim(p_reason)
  WHERE id = p_record_id;
  RETURN true;
END;
$$;

NOTIFY pgrst, 'reload schema';
