CREATE FUNCTION private.content_audit_orphan_notification_snapshots(p_employee_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'message', to_jsonb(message),
    'recipients', (SELECT COALESCE(jsonb_agg(version.recipient_data ORDER BY version.recipient_id), '[]'::jsonb)
      FROM private.content_audit_recipient_versions version WHERE version.message_id = message.id)
  ) ORDER BY message.id), '[]'::jsonb)
  FROM public.messages message
  WHERE message.automation_execution_id IS NULL
    AND EXISTS (SELECT 1 FROM public.message_recipients recipient
      WHERE recipient.message_id = message.id AND recipient.recipient_id = ANY(p_employee_ids))
    AND NOT EXISTS (SELECT 1 FROM public.message_recipients recipient
      WHERE recipient.message_id = message.id AND recipient.recipient_id <> ALL(p_employee_ids));
$$;
REVOKE ALL ON FUNCTION private.content_audit_orphan_notification_snapshots(uuid[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.reject_archived_notification_recipient()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_archived_at timestamptz;
BEGIN
  SELECT archived_at INTO v_archived_at FROM public.users
  WHERE id = NEW.recipient_id FOR KEY SHARE;
  IF NOT FOUND OR v_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'An archived employee cannot receive notifications.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_content_audit_change(
  p_admin_session_token uuid, p_action text, p_target_ids uuid[], p_employee_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_admin uuid;
  v_role text;
  v_count integer;
  v_snapshots jsonb;
  v_target uuid;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role FROM private.get_financial_admin_context(p_admin_session_token);
  v_count := cardinality(p_target_ids);
  IF v_count IS NULL OR v_count NOT BETWEEN 1 AND 500 OR v_count <> (SELECT count(DISTINCT x) FROM unnest(p_target_ids) x) THEN
    RAISE EXCEPTION 'Select between 1 and 500 distinct records.';
  END IF;
  IF p_action = 'notification_delete' THEN
    SELECT count(*), jsonb_agg(jsonb_build_object('message', to_jsonb(m), 'recipients',
      (SELECT COALESCE(jsonb_agg(r.recipient_data ORDER BY r.recipient_id), '[]'::jsonb)
       FROM private.content_audit_recipient_versions r WHERE r.message_id = m.id)) ORDER BY m.id)
    INTO v_count, v_snapshots FROM public.messages m WHERE m.id = ANY(p_target_ids)
      AND (m.sender_id = v_admin OR v_role = 'super_admin');
  ELSIF p_action = 'notification_edit' THEN
    SELECT count(*), jsonb_agg(jsonb_build_object('message', to_jsonb(m), 'recipients',
      (SELECT COALESCE(jsonb_agg(r.recipient_data ORDER BY r.recipient_id), '[]'::jsonb)
       FROM private.content_audit_recipient_versions r WHERE r.message_id = m.id)) ORDER BY m.id)
    INTO v_count, v_snapshots FROM public.messages m WHERE m.id = ANY(p_target_ids)
      AND m.automation_execution_id IS NULL AND (m.sender_id = v_admin OR v_role = 'super_admin');
  ELSIF p_action IN ('chat_edit', 'chat_delete', 'conversation_delete', 'customer_delete') THEN
    IF p_action = 'customer_delete' THEN
      SELECT count(*) INTO v_count FROM public.simulated_customers c
      WHERE c.id = ANY(p_target_ids) AND (c.admin_id = v_admin OR v_role = 'super_admin');
    ELSIF p_action = 'conversation_delete' THEN
      SELECT count(*) INTO v_count FROM public.simulated_customers c
      JOIN public.users u ON u.id = p_employee_id
      WHERE c.id = ANY(p_target_ids) AND (c.admin_id = v_admin OR v_role = 'super_admin')
        AND (u.created_by = c.admin_id OR (v_role = 'super_admin' AND c.admin_id = v_admin AND u.created_by IS NOT NULL));
    ELSE
      SELECT count(*) INTO v_count FROM public.customer_employee_conversations m
      JOIN public.simulated_customers c ON c.id = m.customer_id
      WHERE m.id = ANY(p_target_ids) AND (c.admin_id = v_admin OR v_role = 'super_admin');
    END IF;
    IF v_count <> cardinality(p_target_ids) THEN RAISE EXCEPTION 'Chat record is not accessible.'; END IF;
    SELECT COALESCE(jsonb_agg(private.content_audit_chat_snapshot(m) ORDER BY m.id), '[]'::jsonb)
    INTO v_snapshots FROM public.customer_employee_conversations m
    JOIN public.simulated_customers c ON c.id = m.customer_id
    WHERE (p_action IN ('chat_edit', 'chat_delete') AND m.id = ANY(p_target_ids))
       OR (p_action = 'conversation_delete' AND m.customer_id = p_target_ids[1] AND m.employee_id = p_employee_id)
       OR (p_action = 'customer_delete' AND m.customer_id = p_target_ids[1]);
    IF p_action = 'customer_delete' THEN
      v_snapshots := jsonb_build_object('customers', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.simulated_customers c WHERE c.id = ANY(p_target_ids)), 'messages', v_snapshots);
    END IF;
  ELSIF p_action = 'admin_delete' THEN
    IF v_role <> 'super_admin' OR cardinality(p_target_ids) <> 1 THEN
      RAISE EXCEPTION 'Only a super administrator can remove one secondary administrator.';
    END IF;
    PERFORM 1 FROM public.users u
    WHERE u.created_by = p_target_ids[1] AND u.archived_at IS NULL
    ORDER BY u.id FOR UPDATE;
    PERFORM 1 FROM public.messages m
    JOIN public.message_recipients r ON r.message_id = m.id
    JOIN public.users u ON u.id = r.recipient_id
    WHERE u.created_by = p_target_ids[1] AND u.archived_at IS NULL
    ORDER BY m.id FOR UPDATE OF m;
    SELECT jsonb_build_object('admin_id', a.id, 'username', a.username,
      'messages', (SELECT COALESCE(jsonb_agg(private.content_audit_chat_snapshot(m) ORDER BY m.id), '[]'::jsonb)
        FROM public.customer_employee_conversations m
        JOIN public.simulated_customers c ON c.id = m.customer_id
        WHERE c.admin_id = a.id OR EXISTS (SELECT 1 FROM public.users u
          WHERE u.id = m.employee_id AND u.created_by = a.id)
        OR (m.message_type = 'rich_card' AND NOT m.content_frozen AND EXISTS (
          SELECT 1 FROM public.cs_message_templates t
          WHERE t.id = m.source_template_id AND t.admin_id = a.id::text)))
        || private.content_audit_orphan_notification_snapshots(ARRAY(
          SELECT u.id FROM public.users u WHERE u.created_by = a.id AND u.archived_at IS NULL)))
    INTO v_snapshots FROM public.admins a WHERE a.id = p_target_ids[1] AND a.role = 'secondary_admin';
    v_count := CASE WHEN v_snapshots IS NULL THEN 0 ELSE 1 END;
  ELSIF p_action = 'employee_delete' THEN
    PERFORM private.assert_admin_can_manage_user(v_admin, v_role, p_target_ids[1]);
    PERFORM 1 FROM public.users WHERE id = p_target_ids[1] AND archived_at IS NULL FOR UPDATE;
    PERFORM 1 FROM public.messages m
    JOIN public.message_recipients r ON r.message_id = m.id
    WHERE r.recipient_id = p_target_ids[1]
    ORDER BY m.id FOR UPDATE OF m;
    SELECT jsonb_build_object('employee', jsonb_build_object('id', u.id, 'username', u.username, 'employee_id', u.employee_id),
      'messages', (SELECT COALESCE(jsonb_agg(private.content_audit_chat_snapshot(m) ORDER BY m.id), '[]'::jsonb)
       FROM public.customer_employee_conversations m WHERE m.employee_id = u.id)
       || private.content_audit_orphan_notification_snapshots(ARRAY[u.id]))
    INTO v_snapshots FROM public.users u WHERE u.id = p_target_ids[1];
    v_count := CASE WHEN v_snapshots IS NULL THEN 0 ELSE 1 END;
  ELSIF p_action IN ('template_edit', 'template_delete', 'auto_edit', 'auto_delete') THEN
    v_target := p_target_ids[1];
    IF cardinality(p_target_ids) <> 1 THEN RAISE EXCEPTION 'Select one content source.'; END IF;
    IF p_action LIKE 'template_%' THEN
      SELECT to_jsonb(t) INTO v_snapshots FROM public.cs_message_templates t
      WHERE t.id = v_target AND (t.admin_id = v_admin::text OR v_role = 'super_admin');
      v_count := CASE WHEN FOUND THEN 1 ELSE 0 END;
      SELECT jsonb_build_object('source', v_snapshots, 'messages',
        COALESCE(jsonb_agg(private.content_audit_chat_snapshot(m) ORDER BY m.id), '[]'::jsonb))
      INTO v_snapshots FROM public.customer_employee_conversations m WHERE m.source_template_id = v_target AND m.message_type = 'rich_card' AND NOT m.content_frozen;
    ELSE
      SELECT to_jsonb(a) INTO v_snapshots FROM public.customer_auto_messages a
      JOIN public.simulated_customers c ON c.id = a.customer_id
      WHERE a.id = v_target AND (c.admin_id = v_admin OR v_role = 'super_admin');
      v_count := CASE WHEN FOUND THEN 1 ELSE 0 END;
      SELECT jsonb_build_object('source', v_snapshots, 'messages',
        COALESCE(jsonb_agg(private.content_audit_chat_snapshot(m) ORDER BY m.id), '[]'::jsonb))
      INTO v_snapshots FROM public.customer_employee_conversations m WHERE m.source_auto_message_id = v_target AND m.message_type = 'rich_card' AND NOT m.content_frozen;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported audit operation.';
  END IF;
  IF v_count <> cardinality(p_target_ids) THEN RAISE EXCEPTION 'Record is not accessible or has changed.'; END IF;
  RETURN jsonb_build_object('snapshots', v_snapshots, 'hash', md5(v_snapshots::text));
END;
$$;

CREATE FUNCTION private.remove_deleted_employee_notification_recipients(p_employee_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_message_ids uuid[];
BEGIN
  IF current_setting('content_audit.action', true) NOT IN ('employee_delete', 'admin_delete')
    OR NULLIF(current_setting('content_audit.actor', true), '') IS NULL
    OR NULLIF(current_setting('content_audit.operation', true), '') IS NULL THEN
    RAISE EXCEPTION 'Employee notification cleanup requires an audited operation.';
  END IF;
  SELECT array_agg(DISTINCT recipient.message_id ORDER BY recipient.message_id) INTO v_message_ids
  FROM public.message_recipients recipient WHERE recipient.recipient_id = p_employee_id;
  IF v_message_ids IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM public.messages WHERE id = ANY(v_message_ids) ORDER BY id FOR UPDATE;
  DELETE FROM public.message_recipients WHERE recipient_id = p_employee_id;
  IF EXISTS (SELECT 1 FROM public.messages message
    WHERE message.id = ANY(v_message_ids) AND message.automation_execution_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.message_recipients recipient WHERE recipient.message_id = message.id)
      AND NOT (COALESCE(NULLIF(current_setting('content_audit.media', true), ''), '{}')::jsonb ? message.id::text)
      AND (cardinality(private.content_audit_storage_urls(jsonb_build_object('content', message.content))) > 0
        OR message.content ~* '<(img|video|source)[[:space:]>]')) THEN
    RAISE EXCEPTION 'Notification evidence changed; retry employee deletion.';
  END IF;
  DELETE FROM public.messages message WHERE message.id = ANY(v_message_ids)
    AND NOT EXISTS (SELECT 1 FROM public.message_recipients recipient WHERE recipient.message_id = message.id);
  UPDATE private.content_audit_events event SET employee_id = p_employee_id
  WHERE event.operation_id = current_setting('content_audit.operation')::uuid
    AND event.entity_type = 'notification'
    AND event.action = current_setting('content_audit.action')
    AND event.entity_id = ANY(v_message_ids)
    AND NOT EXISTS (SELECT 1 FROM public.messages message WHERE message.id = event.entity_id);
END;
$$;
REVOKE ALL ON FUNCTION private.remove_deleted_employee_notification_recipients(uuid) FROM PUBLIC, anon, authenticated;
REVOKE DELETE, TRUNCATE ON public.message_recipients FROM anon, authenticated;
REVOKE TRUNCATE ON public.messages FROM anon, authenticated;

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
    PERFORM private.remove_deleted_employee_notification_recipients(v_user.id);
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
  PERFORM private.remove_deleted_employee_notification_recipients(v_user.id);
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

CREATE OR REPLACE FUNCTION public.archive_employee_without_media(
  p_admin_session_token uuid, p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_admin uuid;
  v_role text;
  v_prepared jsonb;
  v_messages jsonb;
  v_media jsonb;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'Employee account is required.'; END IF;
  PERFORM private.assert_admin_can_manage_user(v_admin, v_role, p_user_id);
  PERFORM pg_advisory_xact_lock(hashtext('employee_delete' || p_user_id::text));
  PERFORM 1 FROM public.users WHERE id = p_user_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee account was not found.'; END IF;

  IF EXISTS (SELECT 1 FROM public.customer_employee_conversations
    WHERE employee_id = p_user_id AND (message_type <> 'text' OR COALESCE(image_url, '') <> '')) THEN
    RETURN jsonb_build_object('requires_audit_service', true);
  END IF;

  v_prepared := public.prepare_content_audit_change(
    p_admin_session_token, 'employee_delete', ARRAY[p_user_id], NULL
  );
  v_messages := v_prepared -> 'snapshots' -> 'messages';
  IF cardinality(private.content_audit_storage_urls(v_prepared -> 'snapshots')) > 0
    OR (v_prepared -> 'snapshots')::text ~* '<(img|video|source)[[:space:]>]'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_messages) AS entry(item)
      WHERE NOT (item ? 'recipients')
        AND (item -> 'message' ->> 'message_type' IS DISTINCT FROM 'text'
          OR COALESCE(item -> 'message' ->> 'image_url', '') <> '')) THEN
    RETURN jsonb_build_object('requires_audit_service', true);
  END IF;

  SELECT COALESCE(jsonb_object_agg(item -> 'message' ->> 'id', '{}'::jsonb), '{}'::jsonb)
  INTO v_media FROM jsonb_array_elements(v_messages) AS entry(item);

  RETURN public.commit_content_audit_change(
    p_admin_session_token, 'employee_delete', ARRAY[p_user_id], NULL,
    v_prepared ->> 'hash', '{}'::jsonb, gen_random_uuid(), v_media
  );
END;
$$;

DO $retain_shared_notification_evidence$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.finish_deleted_employee_archive_delete(uuid, uuid)'::regprocedure);
  IF strpos(definition, 'DELETE FROM private.content_audit_events WHERE employee_id = ANY(v_employee_ids);') = 0 THEN
    RAISE EXCEPTION 'Unexpected employee purge definition.';
  END IF;
  EXECUTE replace(definition,
    'DELETE FROM private.content_audit_events WHERE employee_id = ANY(v_employee_ids);',
    $shared_events$
  UPDATE private.content_audit_events event
  SET employee_id = (
    SELECT archive.employee_id
    FROM private.deleted_employee_notifications notification
    JOIN private.deleted_employee_accounts archive ON archive.id = notification.record_id
    WHERE notification.message_id = event.entity_id
      AND notification.id <> ALL(v_job.notification_ids)
      AND notification.record_id <> ALL(v_job.account_ids)
      AND archive.employee_id <> ALL(v_employee_ids)
    ORDER BY archive.deleted_at, archive.employee_id LIMIT 1
  )
  WHERE event.employee_id = ANY(v_employee_ids)
    AND event.entity_type = 'notification'
    AND event.action IN ('employee_delete', 'admin_delete')
    AND EXISTS (
      SELECT 1 FROM private.deleted_employee_notifications notification
      JOIN private.deleted_employee_accounts archive ON archive.id = notification.record_id
      WHERE notification.message_id = event.entity_id
        AND notification.id <> ALL(v_job.notification_ids)
        AND notification.record_id <> ALL(v_job.account_ids)
        AND archive.employee_id <> ALL(v_employee_ids)
    );
  DELETE FROM private.content_audit_events WHERE employee_id = ANY(v_employee_ids);$shared_events$);
END;
$retain_shared_notification_evidence$;

NOTIFY pgrst, 'reload schema';
