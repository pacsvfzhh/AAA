ALTER TABLE public.users ADD COLUMN archived_at timestamptz;
CREATE INDEX users_archived_at_idx ON public.users (archived_at) WHERE archived_at IS NOT NULL;
ALTER POLICY "Allow employee access" ON public.users USING (archived_at IS NULL);

CREATE FUNCTION private.reject_archived_notification_recipient()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.users WHERE id = NEW.recipient_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'An archived employee cannot receive notifications.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_archived_notification_recipient BEFORE INSERT OR UPDATE OF recipient_id
ON public.message_recipients FOR EACH ROW EXECUTE FUNCTION private.reject_archived_notification_recipient();
REVOKE ALL ON FUNCTION private.reject_archived_notification_recipient() FROM PUBLIC, anon, authenticated;

CREATE TABLE private.deleted_employee_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  employee_id uuid NOT NULL UNIQUE,
  account_username text,
  employee_number text,
  account_created_at timestamptz,
  account_remarks text,
  owner_admin_id uuid NOT NULL,
  owner_username text,
  actor_admin_id uuid NOT NULL,
  actor_username text NOT NULL,
  actor_role text NOT NULL,
  deletion_source text NOT NULL CHECK (deletion_source IN ('employee_delete', 'admin_delete')),
  deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cleared_at timestamptz,
  cleared_by uuid,
  cleared_username text,
  clear_reason text
);
CREATE INDEX deleted_employee_accounts_time_idx ON private.deleted_employee_accounts (deleted_at DESC, id DESC);
CREATE INDEX deleted_employee_accounts_owner_idx ON private.deleted_employee_accounts (owner_admin_id, deleted_at DESC);
CREATE INDEX deleted_employee_accounts_actor_idx ON private.deleted_employee_accounts (actor_admin_id, deleted_at DESC);
CREATE INDEX deleted_employee_accounts_operation_idx ON private.deleted_employee_accounts (operation_id, employee_id);
CREATE INDEX content_audit_events_employee_time_idx ON private.content_audit_events (employee_id, entity_type, occurred_at DESC, id DESC)
WHERE entity_type IN ('aaa_service', 'ccc_service');
CREATE INDEX content_audit_recipient_employee_idx ON private.content_audit_recipient_versions (recipient_id, message_id);
REVOKE ALL ON private.deleted_employee_accounts FROM PUBLIC, anon, authenticated;

CREATE TABLE private.deleted_employee_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL REFERENCES private.deleted_employee_accounts(id),
  message_id uuid NOT NULL,
  message_data jsonb,
  recipient_data jsonb,
  archived_event_id uuid,
  cleared_at timestamptz,
  cleared_by uuid,
  clear_reason text,
  UNIQUE (record_id, message_id)
);
CREATE INDEX deleted_employee_notifications_record_idx ON private.deleted_employee_notifications(record_id, message_id);
REVOKE ALL ON private.deleted_employee_notifications FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.archive_deleted_employee_notifications(p_employee_id uuid, p_operation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  INSERT INTO private.deleted_employee_notifications (record_id, message_id, message_data, recipient_data, archived_event_id)
  SELECT record.id, recipient.message_id, COALESCE(to_jsonb(message), evidence.before_data -> 'message'),
    recipient.recipient_data, evidence.id
  FROM private.deleted_employee_accounts record
  JOIN private.content_audit_recipient_versions recipient ON recipient.recipient_id = p_employee_id
  LEFT JOIN public.messages message ON message.id = recipient.message_id
  LEFT JOIN LATERAL (
    SELECT event.id, event.before_data FROM private.content_audit_events event
    WHERE event.entity_type = 'notification' AND event.entity_id = recipient.message_id
      AND event.before_data IS NOT NULL
    ORDER BY event.occurred_at DESC, event.id DESC LIMIT 1
  ) evidence ON true
  WHERE record.employee_id = p_employee_id AND record.operation_id = p_operation_id
    AND COALESCE(message.audit_origin, evidence.before_data -> 'message' ->> 'audit_origin') IN ('manual_admin', 'unverified')
    AND COALESCE(to_jsonb(message), evidence.before_data -> 'message') IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.archive_deleted_employee_notifications(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.guard_employee_archive()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_action text; v_actor uuid; v_operation uuid;
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NULL THEN RETURN NEW; END IF;
  v_action := current_setting('content_audit.action', true);
  v_actor := NULLIF(current_setting('content_audit.actor', true), '')::uuid;
  v_operation := NULLIF(current_setting('content_audit.operation', true), '')::uuid;
  IF OLD.archived_at IS NULL THEN
    IF v_action NOT IN ('employee_delete', 'admin_delete') OR v_actor IS NULL OR v_operation IS NULL
      OR NEW.is_active OR NEW.archived_at IS NULL OR NEW.current_session_token IS NOT NULL
      OR NEW.username IS DISTINCT FROM 'archived-' || OLD.id::text
      OR NEW.employee_id IS DISTINCT FROM 'archived-' || OLD.id::text
      OR NOT EXISTS (SELECT 1 FROM private.deleted_employee_accounts record
        WHERE record.employee_id = OLD.id AND record.operation_id = v_operation
          AND record.actor_admin_id = v_actor) THEN
      RAISE EXCEPTION 'Employee archive requires a verified audit operation.';
    END IF;
  ELSIF NEW.archived_at IS DISTINCT FROM OLD.archived_at OR NEW.is_active
    OR NEW.username IS DISTINCT FROM OLD.username OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
    OR NEW.current_session_token IS NOT NULL OR NEW.current_tab_id IS NOT NULL
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND v_action IS DISTINCT FROM 'admin_delete') THEN
    RAISE EXCEPTION 'Archived employee accounts cannot be reactivated or changed.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_employee_archive BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION private.guard_employee_archive();
REVOKE ALL ON FUNCTION private.guard_employee_archive() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.archive_employees_before_admin_delete()
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
    operation_id, employee_id, account_username, employee_number, account_created_at, account_remarks,
    owner_admin_id, owner_username, actor_admin_id, actor_username, actor_role, deletion_source
  )
  SELECT v_operation, u.id, u.username, u.employee_id, u.created_at, u.remarks, OLD.id, OLD.username,
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
CREATE TRIGGER archive_employees_before_admin_delete BEFORE DELETE ON public.admins
FOR EACH ROW EXECUTE FUNCTION private.archive_employees_before_admin_delete();

CREATE FUNCTION private.archive_employee_before_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Employee accounts must be archived, not physically deleted.';
END;
$$;
CREATE TRIGGER archive_employee_before_delete BEFORE DELETE ON public.users
FOR EACH ROW EXECUTE FUNCTION private.archive_employee_before_delete();
REVOKE DELETE ON public.users FROM anon, authenticated;
REVOKE DELETE ON public.admins FROM anon, authenticated;
REVOKE ALL ON FUNCTION private.archive_employees_before_admin_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.archive_employee_before_delete() FROM PUBLIC, anon, authenticated;

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
    operation_id, employee_id, account_username, employee_number, account_created_at, account_remarks,
    owner_admin_id, owner_username, actor_admin_id, actor_username, actor_role, deletion_source
  ) VALUES (
    v_operation, v_user.id, v_user.username, v_user.employee_id, v_user.created_at, v_user.remarks,
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
REVOKE ALL ON FUNCTION public.admin_delete_employee_account(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.list_deleted_employee_accounts(
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
          OR record.employee_number ILIKE '%' || v_search || '%')),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.deleted_at DESC, page.id DESC)
      FROM (SELECT record.id, record.operation_id, record.employee_id, record.account_username, record.employee_number,
        record.account_created_at, record.account_remarks, record.owner_admin_id, record.owner_username, record.actor_admin_id, record.actor_username,
        record.actor_role, record.deletion_source, record.deleted_at, record.cleared_at
      FROM private.deleted_employee_accounts record
      WHERE (p_owner IS NULL OR record.owner_admin_id = p_owner)
        AND (p_source IS NULL OR record.deletion_source = p_source)
        AND (p_from IS NULL OR record.deleted_at >= p_from)
        AND (p_to IS NULL OR record.deleted_at < p_to)
        AND (v_search IS NULL OR record.account_username ILIKE '%' || v_search || '%'
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

CREATE FUNCTION public.get_deleted_employee_account(
  p_admin_session_token uuid, p_record_id uuid, p_related_page integer DEFAULT 0,
  p_related_page_size integer DEFAULT 20, p_type text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  IF p_related_page NOT BETWEEN 0 AND 100000 OR p_related_page_size NOT BETWEEN 1 AND 100
    OR (p_type IS NOT NULL AND p_type NOT IN ('aaa_service', 'ccc_service')) THEN
    RAISE EXCEPTION 'Invalid evidence page.';
  END IF;
  SELECT to_jsonb(record) || jsonb_build_object(
    'account_summary', CASE WHEN record.cleared_at IS NULL AND employee.archived_at IS NOT NULL THEN jsonb_build_object(
      'is_verified', employee.is_verified, 'total_income', employee.total_income,
      'available_balance', wallet.available_balance, 'frozen_balance', wallet.frozen_balance,
      'total_orders', (SELECT count(*) FROM public.orders o WHERE o.user_id = record.employee_id)
    ) ELSE NULL END,
    'related_total', (SELECT count(*) FROM private.content_audit_events event
      WHERE event.employee_id = record.employee_id
        AND event.entity_type IN ('aaa_service', 'ccc_service')
        AND (p_type IS NULL OR event.entity_type = p_type)),
    'related_counts', (SELECT jsonb_build_object(
      'aaa_service', count(*) FILTER (WHERE entity_type = 'aaa_service'),
      'ccc_service', count(*) FILTER (WHERE entity_type = 'ccc_service'))
      FROM private.content_audit_events event WHERE event.employee_id = record.employee_id),
    'related_items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', page.id, 'operation_id', page.operation_id, 'entity_type', page.entity_type, 'action', page.action,
      'occurred_at', page.occurred_at, 'cleared_at', page.cleared_at,
      'before_data', page.before_data, 'after_data', page.after_data,
      'media_refs', page.media_refs)
      ORDER BY page.occurred_at DESC, page.id DESC)
      FROM (SELECT event.id, event.operation_id, event.entity_type, event.action, event.occurred_at, event.cleared_at,
          event.before_data, event.after_data, event.media_refs
        FROM private.content_audit_events event
        WHERE event.employee_id = record.employee_id
          AND event.entity_type IN ('aaa_service', 'ccc_service')
          AND (p_type IS NULL OR event.entity_type = p_type)
        ORDER BY event.occurred_at DESC, event.id DESC
        LIMIT p_related_page_size OFFSET p_related_page * p_related_page_size) page), '[]'::jsonb)
  ) INTO v_result FROM private.deleted_employee_accounts record
  LEFT JOIN public.users employee ON employee.id = record.employee_id
  LEFT JOIN public.wallets wallet ON wallet.user_id = record.employee_id
  WHERE record.id = p_record_id;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.clear_deleted_employee_account(
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
    account_created_at = NULL, account_remarks = NULL, owner_username = NULL,
    cleared_at = clock_timestamp(), cleared_by = v_admin,
    cleared_username = (SELECT username FROM public.admins WHERE id = v_admin), clear_reason = btrim(p_reason)
  WHERE id = p_record_id;
  RETURN true;
END;
$$;

CREATE FUNCTION public.list_deleted_employee_notifications(
  p_admin_session_token uuid, p_record_id uuid, p_page integer DEFAULT 0, p_page_size integer DEFAULT 30
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  IF p_page NOT BETWEEN 0 AND 100000 OR p_page_size NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid page.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM private.deleted_employee_accounts WHERE id = p_record_id) THEN
    RAISE EXCEPTION 'Employee archive is not available.';
  END IF;
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM private.deleted_employee_notifications n WHERE n.record_id = p_record_id),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.sent_at DESC NULLS LAST, page.id DESC)
      FROM (SELECT n.id, n.message_id, n.cleared_at, n.message_data ->> 'title' AS title,
        n.message_data ->> 'sender_username' AS sender_username,
        n.message_data ->> 'audit_origin' AS audit_origin,
        (n.message_data ->> 'created_at')::timestamptz AS sent_at,
        n.recipient_data ->> 'is_read' AS is_read
      FROM private.deleted_employee_notifications n WHERE n.record_id = p_record_id
      ORDER BY (n.message_data ->> 'created_at')::timestamptz DESC NULLS LAST, n.id DESC
      LIMIT p_page_size OFFSET p_page * p_page_size) page), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.get_deleted_employee_notification(p_admin_session_token uuid, p_notification_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  SELECT to_jsonb(n) - 'archived_event_id' INTO v_result
  FROM private.deleted_employee_notifications n
  JOIN private.deleted_employee_accounts record ON record.id = n.record_id
  WHERE n.id = p_notification_id;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.clear_deleted_employee_notification(
  p_admin_session_token uuid, p_notification_id uuid, p_reason text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_record private.deleted_employee_notifications%ROWTYPE;
BEGIN
  v_admin := private.assert_content_audit_purge(p_admin_session_token);
  IF length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'Enter a reason between 10 and 500 characters.';
  END IF;
  SELECT * INTO v_record FROM private.deleted_employee_notifications WHERE id = p_notification_id FOR UPDATE;
  IF v_record.id IS NULL THEN RAISE EXCEPTION 'Archived notification is not available.'; END IF;
  IF v_record.cleared_at IS NOT NULL THEN RETURN true; END IF;
  UPDATE private.deleted_employee_notifications
  SET message_data = NULL, recipient_data = NULL, cleared_at = clock_timestamp(),
    cleared_by = v_admin, clear_reason = btrim(p_reason) WHERE id = p_notification_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.list_deleted_employee_notifications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_deleted_employee_notification FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_deleted_employee_notification FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_deleted_employee_notifications TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_deleted_employee_notification TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_deleted_employee_notification TO anon, authenticated;
REVOKE ALL ON FUNCTION public.list_deleted_employee_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_deleted_employee_account FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_deleted_employee_account FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_deleted_employee_accounts TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_deleted_employee_account TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_deleted_employee_account TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
