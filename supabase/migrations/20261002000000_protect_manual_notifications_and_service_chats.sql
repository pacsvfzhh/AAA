CREATE TABLE private.content_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('notification', 'aaa_service', 'ccc_service')),
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('edit', 'delete', 'conversation_delete', 'customer_delete', 'employee_delete', 'admin_delete', 'source_edit', 'source_delete')),
  owner_admin_id uuid NOT NULL,
  owner_username text,
  actor_admin_id uuid NOT NULL,
  actor_username text NOT NULL,
  actor_role text NOT NULL,
  customer_id uuid,
  employee_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  before_data jsonb,
  after_data jsonb,
  media_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  clear_reason text,
  clear_started_at timestamptz,
  cleared_at timestamptz,
  cleared_by uuid,
  cleared_username text
);
CREATE INDEX content_audit_events_time_idx ON private.content_audit_events (occurred_at DESC, id DESC);
CREATE INDEX content_audit_events_type_time_idx ON private.content_audit_events (entity_type, occurred_at DESC, id DESC);
CREATE INDEX content_audit_events_actor_idx ON private.content_audit_events (actor_admin_id, occurred_at DESC);
CREATE INDEX content_audit_events_owner_idx ON private.content_audit_events (owner_admin_id, occurred_at DESC);
CREATE INDEX content_audit_events_entity_idx ON private.content_audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX content_audit_events_operation_idx ON private.content_audit_events (operation_id);
REVOKE ALL ON private.content_audit_events FROM PUBLIC, anon, authenticated;

CREATE TABLE private.content_audit_recipient_versions (
  message_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  recipient_data jsonb NOT NULL,
  PRIMARY KEY (message_id, recipient_id)
);
REVOKE ALL ON private.content_audit_recipient_versions FROM PUBLIC, anon, authenticated;
INSERT INTO private.content_audit_recipient_versions(message_id, recipient_id, recipient_data)
SELECT r.message_id, r.recipient_id, to_jsonb(r) FROM public.message_recipients r
JOIN public.messages m ON m.id = r.message_id WHERE m.automation_execution_id IS NULL;

CREATE FUNCTION private.remember_content_audit_recipient()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_recipient public.message_recipients%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN v_recipient := OLD; ELSE v_recipient := NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.messages WHERE id = v_recipient.message_id
    AND automation_execution_id IS NULL) THEN
    INSERT INTO private.content_audit_recipient_versions(message_id, recipient_id, recipient_data)
    VALUES (v_recipient.message_id, v_recipient.recipient_id, to_jsonb(v_recipient))
    ON CONFLICT (message_id, recipient_id) DO UPDATE SET recipient_data = excluded.recipient_data;
  END IF;
  RETURN v_recipient;
END;
$$;
CREATE TRIGGER remember_content_audit_recipient AFTER INSERT OR UPDATE OR DELETE
ON public.message_recipients FOR EACH ROW EXECUTE FUNCTION private.remember_content_audit_recipient();

CREATE TABLE private.content_audit_purge_windows (
  admin_id uuid PRIMARY KEY,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON private.content_audit_purge_windows FROM PUBLIC, anon, authenticated;

ALTER TABLE public.messages ADD COLUMN audit_origin text NOT NULL DEFAULT 'unverified'
  CHECK (audit_origin IN ('manual_admin', 'automation', 'unverified'));
UPDATE public.messages SET audit_origin = 'automation' WHERE automation_execution_id IS NOT NULL;
UPDATE public.messages AS m SET audit_origin = 'manual_admin'
WHERE m.automation_execution_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.financial_operations AS operation
    WHERE operation.operation_type = 'admin_message_send'
      AND operation.result ->> 'message_id' = m.id::text
  );

CREATE FUNCTION private.classify_notification_origin()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF NEW.automation_execution_id IS NOT NULL THEN
    NEW.audit_origin := 'automation';
  ELSIF NEW.audit_origin = 'automation' THEN
    RAISE EXCEPTION 'An automatic notification requires an execution ID.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER classify_notification_origin BEFORE INSERT OR UPDATE OF automation_execution_id, audit_origin
ON public.messages FOR EACH ROW EXECUTE FUNCTION private.classify_notification_origin();

CREATE OR REPLACE FUNCTION public.send_admin_message_with_delivery(
  p_admin_session_token uuid, p_recipient_ids uuid[], p_title text, p_content text,
  p_delivery_mode text, p_priority text, p_reward_amount numeric, p_operation_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_message_type text;
  v_result jsonb;
  v_message_id uuid;
  v_existing_message_id uuid;
  v_registered_mode text;
BEGIN
  IF p_delivery_mode NOT IN ('realtime_only', 'login_only', 'realtime_with_login_fallback') THEN
    RAISE EXCEPTION 'Unsupported notification delivery mode.';
  END IF;
  SELECT (operation.result ->> 'message_id')::uuid INTO v_existing_message_id
  FROM public.financial_operations AS operation
  WHERE operation.operation_id = p_operation_id AND operation.operation_type = 'admin_message_send';
  IF v_existing_message_id IS NOT NULL THEN
    SELECT delivery_mode INTO v_registered_mode FROM public.messages WHERE id = v_existing_message_id;
  ELSE
    v_registered_mode := p_delivery_mode;
  END IF;
  INSERT INTO private.notification_delivery_operations(operation_id, delivery_mode)
  VALUES (p_operation_id, v_registered_mode) ON CONFLICT (operation_id) DO NOTHING;
  SELECT delivery_mode INTO v_registered_mode
  FROM private.notification_delivery_operations WHERE operation_id = p_operation_id FOR UPDATE;
  IF v_registered_mode IS DISTINCT FROM p_delivery_mode THEN
    RAISE EXCEPTION 'The operation ID was already used with a different delivery mode.';
  END IF;
  v_message_type := CASE p_delivery_mode WHEN 'realtime_only' THEN 'realtime' ELSE 'login_popup' END;
  v_result := public.send_admin_message_secure(
    p_admin_session_token, p_recipient_ids, p_title, p_content,
    v_message_type, p_priority, p_reward_amount, p_operation_id
  );
  v_message_id := (v_result ->> 'message_id')::uuid;
  UPDATE public.messages SET delivery_mode = p_delivery_mode, audit_origin = 'manual_admin'
  WHERE id = v_message_id AND automation_execution_id IS NULL;
  RETURN v_result || jsonb_build_object('delivery_mode', p_delivery_mode);
END;
$$;

ALTER TABLE public.customer_employee_conversations
ADD COLUMN content_frozen boolean NOT NULL DEFAULT false;
ALTER TABLE public.rich_card_contents ADD COLUMN content_hash text;
CREATE UNIQUE INDEX rich_card_contents_content_hash_idx ON public.rich_card_contents (content_hash)
WHERE content_hash IS NOT NULL;

CREATE FUNCTION private.freeze_rich_card_version(p_html text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_card public.rich_card_contents%ROWTYPE;
BEGIN
  INSERT INTO public.rich_card_contents(html_content, content_hash)
  VALUES (p_html, md5(p_html))
  ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL
  DO UPDATE SET content_hash = excluded.content_hash RETURNING * INTO v_card;
  IF v_card.html_content IS DISTINCT FROM p_html THEN RAISE EXCEPTION 'Rich-card content hash collision.'; END IF;
  RETURN v_card.id;
END;
$$;

CREATE FUNCTION private.freeze_service_rich_card()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_html text;
BEGIN
  IF NEW.message_type <> 'rich_card' THEN RETURN NEW; END IF;
  IF NEW.source_template_id IS NOT NULL THEN
    SELECT template.content INTO v_html FROM public.cs_message_templates template
    JOIN public.simulated_customers customer ON customer.admin_id::text = template.admin_id
    WHERE template.id = NEW.source_template_id AND customer.id = NEW.customer_id;
  ELSIF NEW.source_auto_message_id IS NOT NULL THEN
    SELECT content INTO v_html FROM public.customer_auto_messages
    WHERE id = NEW.source_auto_message_id AND customer_id = NEW.customer_id;
  ELSIF NEW.rich_card_content_id IS NOT NULL THEN
    SELECT html_content INTO v_html FROM public.rich_card_contents WHERE id = NEW.rich_card_content_id;
  ELSE
    v_html := NEW.message_content;
  END IF;
  IF v_html IS NULL THEN RAISE EXCEPTION 'Rich-card content source is not available.'; END IF;
  NEW.rich_card_content_id := private.freeze_rich_card_version(v_html);
  NEW.content_frozen := true;
  RETURN NEW;
END;
$$;
CREATE TRIGGER freeze_service_rich_card_before_insert BEFORE INSERT
ON public.customer_employee_conversations FOR EACH ROW EXECUTE FUNCTION private.freeze_service_rich_card();

CREATE FUNCTION private.content_audit_chat_snapshot(p_message public.customer_employee_conversations)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object(
    'message', to_jsonb(p_message),
    'rendered_html', CASE WHEN p_message.message_type = 'rich_card' THEN
      CASE WHEN p_message.content_frozen THEN COALESCE(card.html_content, p_message.message_content)
        ELSE COALESCE(template.content, auto_message.content, card.html_content, p_message.message_content) END
      ELSE NULL END,
    'customer_name', customer.customer_name,
    'custom_avatar_url', customer.custom_avatar_url,
    'employee_name', employee.username,
    'source', CASE WHEN p_message.content_frozen THEN to_jsonb(card)
      ELSE COALESCE(to_jsonb(template), to_jsonb(auto_message), to_jsonb(card)) END
  )
  FROM public.simulated_customers customer
  LEFT JOIN public.users employee ON employee.id = p_message.employee_id
  LEFT JOIN public.cs_message_templates template ON template.id = p_message.source_template_id
  LEFT JOIN public.customer_auto_messages auto_message ON auto_message.id = p_message.source_auto_message_id
  LEFT JOIN public.rich_card_contents card ON card.id = p_message.rich_card_content_id
  WHERE customer.id = p_message.customer_id;
$$;

CREATE FUNCTION private.content_audit_media_for(p_snapshot jsonb, p_entity_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT COALESCE(jsonb_object_agg(source_url, private_path), '{}'::jsonb)
  FROM jsonb_each_text(COALESCE(NULLIF(current_setting('content_audit.media', true), ''), '{}')::jsonb -> p_entity_id::text) AS media(source_url, private_path)
  WHERE strpos(p_snapshot::text, source_url) > 0
    OR strpos(p_snapshot::text, replace(source_url, '&', '&amp;')) > 0;
$$;

CREATE FUNCTION private.capture_content_audit_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_actor uuid;
  v_admin public.admins%ROWTYPE;
  v_before jsonb;
  v_after jsonb;
  v_owner uuid;
  v_owner_username text;
  v_customer uuid;
  v_employee uuid;
  v_kind text;
  v_action text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'messages' THEN
      IF OLD.title IS NOT DISTINCT FROM NEW.title AND OLD.content IS NOT DISTINCT FROM NEW.content THEN RETURN NEW; END IF;
    ELSIF (OLD.message_content, OLD.message_type, OLD.image_url, OLD.rating_data, OLD.title, OLD.subtitle,
           OLD.rich_card_content_id, OLD.source_template_id, OLD.source_auto_message_id)
      IS NOT DISTINCT FROM
          (NEW.message_content, NEW.message_type, NEW.image_url, NEW.rating_data, NEW.title, NEW.subtitle,
           NEW.rich_card_content_id, NEW.source_template_id, NEW.source_auto_message_id) THEN RETURN NEW; END IF;
  END IF;

  IF TG_TABLE_NAME = 'messages' THEN
    IF OLD.automation_execution_id IS NOT NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  END IF;
  v_actor := NULLIF(current_setting('content_audit.actor', true), '')::uuid;
  SELECT * INTO v_admin FROM public.admins WHERE id = v_actor AND is_active = true;
  IF v_admin.id IS NULL THEN RAISE EXCEPTION 'Content change requires a verified administrator session.'; END IF;
  IF NULLIF(current_setting('content_audit.operation', true), '') IS NULL THEN RAISE EXCEPTION 'Content audit operation is missing.'; END IF;

  IF TG_TABLE_NAME = 'messages' THEN
    v_kind := 'notification';
    v_owner := OLD.sender_id;
    v_owner_username := OLD.sender_username;
    v_before := jsonb_build_object('message', to_jsonb(OLD), 'recipients',
      (SELECT COALESCE(jsonb_agg(r.recipient_data ORDER BY r.recipient_id), '[]'::jsonb)
       FROM private.content_audit_recipient_versions r WHERE r.message_id = OLD.id));
    IF TG_OP = 'UPDATE' THEN v_after := jsonb_build_object('message', to_jsonb(NEW)); END IF;
  ELSE
    v_kind := OLD.source_type;
    v_customer := OLD.customer_id;
    v_employee := OLD.employee_id;
    SELECT customer.admin_id, admin.username INTO v_owner, v_owner_username
    FROM public.simulated_customers customer
    LEFT JOIN public.admins admin ON admin.id = customer.admin_id WHERE customer.id = OLD.customer_id;
    v_before := private.content_audit_chat_snapshot(OLD);
    IF TG_OP = 'UPDATE' THEN v_after := private.content_audit_chat_snapshot(NEW); END IF;
  END IF;

  IF v_owner IS NULL THEN RAISE EXCEPTION 'Content audit owner is missing.'; END IF;
  v_action := CASE WHEN TG_OP = 'UPDATE' THEN
    CASE WHEN current_setting('content_audit.action', true) = 'source_delete' THEN 'source_delete' ELSE 'edit' END
    ELSE COALESCE(NULLIF(current_setting('content_audit.action', true), ''), 'delete') END;
  INSERT INTO private.content_audit_events (
    operation_id, entity_type, entity_id, action, owner_admin_id, owner_username, actor_admin_id,
    actor_username, actor_role, customer_id, employee_id, before_data, after_data, media_refs
  ) VALUES (
    current_setting('content_audit.operation')::uuid, v_kind, OLD.id, v_action, v_owner,
    v_owner_username, v_actor, v_admin.username, v_admin.role, v_customer, v_employee, v_before, v_after,
    private.content_audit_media_for(v_before, OLD.id) || private.content_audit_media_for(v_after, OLD.id)
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER audit_notification_change BEFORE UPDATE OR DELETE ON public.messages
FOR EACH ROW EXECUTE FUNCTION private.capture_content_audit_change();
CREATE TRIGGER audit_chat_change BEFORE UPDATE OR DELETE ON public.customer_employee_conversations
FOR EACH ROW EXECUTE FUNCTION private.capture_content_audit_change();

CREATE FUNCTION private.capture_content_audit_source_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_row public.customer_employee_conversations%ROWTYPE;
  v_actor uuid;
  v_admin public.admins%ROWTYPE;
  v_owner uuid;
  v_before jsonb;
  v_after jsonb;
  v_old_html text;
  v_new_html text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'rich_card_contents' THEN
      IF OLD.html_content IS NOT DISTINCT FROM NEW.html_content THEN RETURN NEW; END IF;
    ELSE
      IF OLD.content IS NOT DISTINCT FROM NEW.content THEN RETURN NEW; END IF;
    END IF;
  END IF;
  FOR v_row IN SELECT * FROM public.customer_employee_conversations
    WHERE message_type = 'rich_card' AND (
      (TG_TABLE_NAME = 'cs_message_templates' AND source_template_id = OLD.id AND NOT content_frozen) OR
      (TG_TABLE_NAME = 'customer_auto_messages' AND source_auto_message_id = OLD.id AND NOT content_frozen) OR
      (TG_TABLE_NAME = 'rich_card_contents' AND rich_card_content_id = OLD.id
       AND (content_frozen OR (source_template_id IS NULL AND source_auto_message_id IS NULL))))
    ORDER BY id
  LOOP
    v_actor := NULLIF(current_setting('content_audit.actor', true), '')::uuid;
    SELECT * INTO v_admin FROM public.admins WHERE id = v_actor AND is_active = true;
    IF v_admin.id IS NULL OR NULLIF(current_setting('content_audit.operation', true), '') IS NULL THEN
      RAISE EXCEPTION 'Changing referenced chat content requires a verified audit operation.';
    END IF;
    SELECT admin_id INTO v_owner FROM public.simulated_customers WHERE id = v_row.customer_id;
    IF TG_TABLE_NAME = 'rich_card_contents' THEN
      v_old_html := OLD.html_content;
      v_new_html := CASE WHEN TG_OP = 'UPDATE' THEN NEW.html_content ELSE NULL END;
    ELSE
      v_old_html := OLD.content;
      v_new_html := CASE WHEN TG_OP = 'UPDATE' THEN NEW.content ELSE NULL END;
    END IF;
    v_before := private.content_audit_chat_snapshot(v_row) || jsonb_build_object('rendered_html', v_old_html, 'source', to_jsonb(OLD));
    v_after := private.content_audit_chat_snapshot(v_row) || jsonb_build_object('rendered_html', v_new_html,
      'source', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(NEW) ELSE NULL END);
    INSERT INTO private.content_audit_events (
      operation_id, entity_type, entity_id, action, owner_admin_id, owner_username, actor_admin_id,
      actor_username, actor_role, customer_id, employee_id, before_data, after_data, media_refs
    ) VALUES (
      current_setting('content_audit.operation')::uuid, v_row.source_type, v_row.id,
      CASE WHEN TG_OP = 'UPDATE' THEN 'source_edit' ELSE 'source_delete' END,
      v_owner, (SELECT username FROM public.admins WHERE id = v_owner), v_actor, v_admin.username, v_admin.role, v_row.customer_id, v_row.employee_id,
      v_before, v_after, private.content_audit_media_for(v_before, v_row.id) || private.content_audit_media_for(v_after, v_row.id)
    );
  END LOOP;
  RETURN CASE WHEN TG_OP = 'UPDATE' THEN NEW ELSE OLD END;
END;
$$;
CREATE TRIGGER audit_template_source BEFORE UPDATE OF content OR DELETE ON public.cs_message_templates
FOR EACH ROW EXECUTE FUNCTION private.capture_content_audit_source_change();
CREATE TRIGGER audit_auto_source BEFORE UPDATE OF content OR DELETE ON public.customer_auto_messages
FOR EACH ROW EXECUTE FUNCTION private.capture_content_audit_source_change();
CREATE TRIGGER audit_card_source BEFORE UPDATE OF html_content OR DELETE ON public.rich_card_contents
FOR EACH ROW EXECUTE FUNCTION private.capture_content_audit_source_change();

CREATE FUNCTION public.prepare_content_audit_change(
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
    SELECT jsonb_build_object('admin_id', a.id, 'username', a.username,
      'messages', (SELECT COALESCE(jsonb_agg(private.content_audit_chat_snapshot(m) ORDER BY m.id), '[]'::jsonb)
        FROM public.customer_employee_conversations m
        JOIN public.simulated_customers c ON c.id = m.customer_id
        WHERE c.admin_id = a.id OR EXISTS (SELECT 1 FROM public.users u
          WHERE u.id = m.employee_id AND u.created_by = a.id)
        OR (m.message_type = 'rich_card' AND NOT m.content_frozen AND EXISTS (
          SELECT 1 FROM public.cs_message_templates t
          WHERE t.id = m.source_template_id AND t.admin_id = a.id::text))))
    INTO v_snapshots FROM public.admins a WHERE a.id = p_target_ids[1] AND a.role = 'secondary_admin';
    v_count := CASE WHEN v_snapshots IS NULL THEN 0 ELSE 1 END;
  ELSIF p_action = 'employee_delete' THEN
    PERFORM private.assert_admin_can_manage_user(v_admin, v_role, p_target_ids[1]);
    SELECT jsonb_build_object('employee', jsonb_build_object('id', u.id, 'username', u.username, 'employee_id', u.employee_id),
      'messages', (SELECT COALESCE(jsonb_agg(private.content_audit_chat_snapshot(m) ORDER BY m.id), '[]'::jsonb)
       FROM public.customer_employee_conversations m WHERE m.employee_id = u.id))
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

CREATE FUNCTION private.content_audit_storage_urls(p_snapshot jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT COALESCE(array_agg(DISTINCT replace(rtrim((capture.urls)[1], chr(92)), '&amp;', '&')), ARRAY[]::text[])
  FROM regexp_matches(COALESCE(p_snapshot, '{}'::jsonb)::text,
    'https?://[^"''[:space:]<>)}]+/storage/v1/object/public/[^"''[:space:]<>)}]+', 'g') AS capture(urls);
$$;

CREATE FUNCTION public.commit_content_audit_change(
  p_admin_session_token uuid, p_action text, p_target_ids uuid[], p_employee_id uuid,
  p_expected_hash text, p_payload jsonb, p_operation_id uuid, p_media jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_admin uuid;
  v_role text;
  v_prepared jsonb;
  v_changed integer;
  v_media record;
  v_frozen_id uuid;
  v_source_content text;
  v_source record;
  v_cards uuid[];
  v_entries jsonb;
  v_item jsonb;
  v_entity_id text;
  v_source_url text;
  v_manifest_count integer := 0;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF p_operation_id IS NULL OR jsonb_typeof(p_media) <> 'object' THEN RAISE EXCEPTION 'Invalid audit operation.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_action || array_to_string(p_target_ids, ',')));
  IF p_action IN ('notification_edit', 'notification_delete') THEN
    PERFORM 1 FROM public.messages WHERE id = ANY(p_target_ids) FOR UPDATE;
  ELSIF p_action IN ('chat_edit', 'chat_delete') THEN
    PERFORM 1 FROM public.customer_employee_conversations WHERE id = ANY(p_target_ids) FOR UPDATE;
  ELSIF p_action IN ('conversation_delete', 'customer_delete') THEN
    PERFORM 1 FROM public.simulated_customers WHERE id = ANY(p_target_ids) FOR UPDATE;
    PERFORM 1 FROM public.customer_employee_conversations WHERE customer_id = ANY(p_target_ids) FOR UPDATE;
  ELSIF p_action = 'admin_delete' THEN
    PERFORM 1 FROM public.admins WHERE id = p_target_ids[1] FOR UPDATE;
    PERFORM 1 FROM public.simulated_customers WHERE admin_id = p_target_ids[1] FOR UPDATE;
    PERFORM 1 FROM public.customer_employee_conversations m
      JOIN public.simulated_customers c ON c.id = m.customer_id
      WHERE c.admin_id = p_target_ids[1] OR EXISTS (SELECT 1 FROM public.users u
        WHERE u.id = m.employee_id AND u.created_by = p_target_ids[1])
        OR (m.message_type = 'rich_card' AND NOT m.content_frozen AND EXISTS (
          SELECT 1 FROM public.cs_message_templates t
          WHERE t.id = m.source_template_id AND t.admin_id = p_target_ids[1]::text)) FOR UPDATE OF m;
  ELSIF p_action = 'employee_delete' THEN
    PERFORM 1 FROM public.users WHERE id = p_target_ids[1] FOR UPDATE;
    PERFORM 1 FROM public.customer_employee_conversations WHERE employee_id = p_target_ids[1] FOR UPDATE;
  ELSIF p_action IN ('template_edit', 'template_delete') THEN
    PERFORM 1 FROM public.cs_message_templates WHERE id = p_target_ids[1] FOR UPDATE;
    PERFORM 1 FROM public.customer_employee_conversations WHERE source_template_id = p_target_ids[1] FOR UPDATE;
  ELSIF p_action IN ('auto_edit', 'auto_delete') THEN
    PERFORM 1 FROM public.customer_auto_messages WHERE id = p_target_ids[1] FOR UPDATE;
    PERFORM 1 FROM public.customer_employee_conversations WHERE source_auto_message_id = p_target_ids[1] FOR UPDATE;
  END IF;
  v_prepared := public.prepare_content_audit_change(p_admin_session_token, p_action, p_target_ids, p_employee_id);
  IF v_prepared ->> 'hash' IS DISTINCT FROM p_expected_hash THEN RAISE EXCEPTION 'Content changed; refresh and try again.'; END IF;
  IF p_action IN ('chat_delete', 'conversation_delete', 'customer_delete', 'employee_delete', 'admin_delete') THEN
    SELECT array_agg(DISTINCT (item -> 'message' ->> 'rich_card_content_id')::uuid) INTO v_cards
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_prepared -> 'snapshots') = 'array'
      THEN v_prepared -> 'snapshots' ELSE v_prepared -> 'snapshots' -> 'messages' END) item
    WHERE item -> 'message' ->> 'rich_card_content_id' IS NOT NULL;
  END IF;
  IF p_action IN ('notification_edit', 'chat_edit', 'chat_delete', 'conversation_delete', 'customer_delete', 'employee_delete', 'admin_delete', 'template_edit', 'template_delete', 'auto_edit', 'auto_delete')
    AND cardinality(p_target_ids) <> 1 THEN RAISE EXCEPTION 'Select one record.'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(p_media) media WHERE jsonb_typeof(media.value) <> 'object') THEN
    RAISE EXCEPTION 'Invalid evidence attachment manifest.';
  END IF;
  v_entries := CASE WHEN jsonb_typeof(v_prepared -> 'snapshots') = 'array' THEN v_prepared -> 'snapshots'
    ELSE COALESCE(v_prepared -> 'snapshots' -> 'messages', '[]'::jsonb) END;
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_entries) entries(value) LOOP
    IF p_action = 'notification_delete' AND v_item -> 'message' ->> 'automation_execution_id' IS NOT NULL THEN CONTINUE; END IF;
    v_entity_id := v_item -> 'message' ->> 'id';
    IF v_entity_id IS NULL OR NOT (p_media ? v_entity_id) THEN
      RAISE EXCEPTION 'A message is missing from the evidence attachment manifest.';
    END IF;
    v_manifest_count := v_manifest_count + 1;
    FOR v_source_url IN SELECT unnest(private.content_audit_storage_urls(jsonb_build_object(
      'content', v_item -> 'message' -> 'content',
      'message_content', v_item -> 'message' -> 'message_content',
      'image_url', v_item -> 'message' -> 'image_url',
      'source_content', v_item -> 'source' -> 'content',
      'source_html', v_item -> 'source' -> 'html_content',
      'rendered_html', v_item -> 'rendered_html',
      'custom_avatar_url', v_item -> 'custom_avatar_url'))) LOOP
      IF NOT ((p_media -> v_entity_id) ? v_source_url) THEN
        RAISE EXCEPTION 'An original attachment was not preserved.';
      END IF;
    END LOOP;
    IF p_action IN ('notification_edit', 'chat_edit', 'template_edit', 'auto_edit') THEN
      FOR v_source_url IN SELECT unnest(private.content_audit_storage_urls(jsonb_build_object(
        'content', p_payload -> 'content', 'message_content', p_payload -> 'message_content',
        'image_url', p_payload -> 'image_url', 'html_content', p_payload -> 'html_content'))) LOOP
        IF NOT ((p_media -> v_entity_id) ? v_source_url) THEN
          RAISE EXCEPTION 'A new attachment was not preserved.';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_each(p_media)) <> v_manifest_count THEN
    RAISE EXCEPTION 'The evidence attachment manifest contains unexpected records.';
  END IF;
  FOR v_media IN SELECT event.key AS entity_id, attachment.key AS source_url, attachment.value AS private_path
    FROM jsonb_each(p_media) event CROSS JOIN LATERAL jsonb_each_text(event.value) attachment LOOP
    SELECT item INTO v_item FROM jsonb_array_elements(v_entries) entries(item)
    WHERE item -> 'message' ->> 'id' = v_media.entity_id;
    IF (strpos(v_item::text, v_media.source_url) = 0
        AND strpos(v_item::text, replace(v_media.source_url, '&', '&amp;')) = 0
        AND (p_action NOT IN ('notification_edit', 'chat_edit', 'template_edit', 'auto_edit')
          OR (strpos(p_payload::text, v_media.source_url) = 0
            AND strpos(p_payload::text, replace(v_media.source_url, '&', '&amp;')) = 0)))
      OR v_media.private_path !~ ('^' || p_operation_id::text || '/shared/[0-9]+$')
      OR NOT EXISTS (SELECT 1 FROM storage.objects
        WHERE bucket_id = 'content-audit-evidence' AND name = v_media.private_path)
    THEN RAISE EXCEPTION 'An evidence attachment is missing.'; END IF;
  END LOOP;
  PERFORM set_config('content_audit.actor', v_admin::text, true);
  PERFORM set_config('content_audit.operation', p_operation_id::text, true);
  PERFORM set_config('content_audit.media', p_media::text, true);
  PERFORM set_config('content_audit.action',
    CASE p_action WHEN 'conversation_delete' THEN 'conversation_delete' WHEN 'customer_delete' THEN 'customer_delete'
      WHEN 'employee_delete' THEN 'employee_delete' WHEN 'admin_delete' THEN 'admin_delete'
      WHEN 'template_delete' THEN 'source_delete' WHEN 'auto_delete' THEN 'source_delete' ELSE 'delete' END, true);

  IF p_action = 'notification_edit' THEN
    IF char_length(trim(COALESCE(p_payload ->> 'title', ''))) NOT BETWEEN 1 AND 200
      OR char_length(trim(COALESCE(p_payload ->> 'content', ''))) NOT BETWEEN 1 AND 100000 THEN
      RAISE EXCEPTION 'Notification title or content is invalid.';
    END IF;
    UPDATE public.messages SET title = trim(p_payload ->> 'title'), content = p_payload ->> 'content'
    WHERE id = p_target_ids[1];
  ELSIF p_action = 'notification_delete' THEN
    DELETE FROM public.messages WHERE id = ANY(p_target_ids);
  ELSIF p_action = 'chat_edit' THEN
    IF NOT (p_payload ? 'message_content' OR p_payload ? 'image_url')
      OR (p_payload ? 'message_content' AND char_length(COALESCE(p_payload ->> 'message_content', '')) NOT BETWEEN 1 AND 100000)
      OR (p_payload ? 'image_url' AND (p_payload ->> 'image_url' IS NULL OR length(p_payload ->> 'image_url') > 2048)) THEN
      RAISE EXCEPTION 'Chat content is invalid.';
    END IF;
    UPDATE public.customer_employee_conversations
    SET message_content = COALESCE(p_payload ->> 'message_content', message_content),
        image_url = CASE WHEN p_payload ? 'image_url' THEN p_payload ->> 'image_url' ELSE image_url END
    WHERE id = p_target_ids[1];
  ELSIF p_action = 'chat_delete' THEN
    DELETE FROM public.customer_employee_conversations WHERE id = p_target_ids[1];
  ELSIF p_action = 'conversation_delete' THEN
    DELETE FROM public.customer_employee_conversations WHERE customer_id = p_target_ids[1] AND employee_id = p_employee_id;
  ELSIF p_action = 'customer_delete' THEN
    DELETE FROM public.customer_employee_conversations WHERE customer_id = p_target_ids[1];
    DELETE FROM public.simulated_customers WHERE id = p_target_ids[1];
  ELSIF p_action = 'employee_delete' THEN
    DELETE FROM public.customer_employee_conversations WHERE employee_id = p_target_ids[1];
    IF NOT public.admin_delete_employee_account(p_admin_session_token, p_target_ids[1]) THEN
      RAISE EXCEPTION 'Employee account could not be removed.';
    END IF;
  ELSIF p_action = 'admin_delete' THEN
    DELETE FROM public.customer_employee_conversations m USING public.simulated_customers c
    WHERE m.customer_id = c.id AND (c.admin_id = p_target_ids[1] OR EXISTS (
      SELECT 1 FROM public.users u WHERE u.id = m.employee_id AND u.created_by = p_target_ids[1]));
    PERFORM set_config('content_audit.action', 'source_delete', true);
    FOR v_source IN SELECT id, content FROM public.cs_message_templates
      WHERE admin_id = p_target_ids[1]::text LOOP
      IF EXISTS (SELECT 1 FROM public.customer_employee_conversations
        WHERE source_template_id = v_source.id AND message_type = 'rich_card' AND NOT content_frozen) THEN
        v_frozen_id := private.freeze_rich_card_version(v_source.content);
        UPDATE public.customer_employee_conversations
        SET source_template_id = NULL, rich_card_content_id = v_frozen_id, content_frozen = true
        WHERE source_template_id = v_source.id AND message_type = 'rich_card' AND NOT content_frozen;
      END IF;
    END LOOP;
    PERFORM set_config('content_audit.action', 'admin_delete', true);
    IF NOT public.admin_delete_secondary_account(p_admin_session_token, p_target_ids[1]) THEN
      RAISE EXCEPTION 'Secondary administrator could not be removed.';
    END IF;
  ELSIF p_action = 'template_edit' THEN
    UPDATE public.cs_message_templates
      SET name = COALESCE(p_payload ->> 'name', name), title = CASE WHEN p_payload ? 'title' THEN p_payload ->> 'title' ELSE title END,
          subtitle = CASE WHEN p_payload ? 'subtitle' THEN p_payload ->> 'subtitle' ELSE subtitle END,
          content = COALESCE(p_payload ->> 'content', content), content_type = COALESCE(p_payload ->> 'content_type', content_type), updated_at = now()
      WHERE id = p_target_ids[1];
  ELSIF p_action = 'template_delete' THEN
    SELECT content INTO v_source_content FROM public.cs_message_templates WHERE id = p_target_ids[1];
    IF EXISTS (SELECT 1 FROM public.customer_employee_conversations
      WHERE source_template_id = p_target_ids[1] AND message_type = 'rich_card' AND NOT content_frozen) THEN
      v_frozen_id := private.freeze_rich_card_version(v_source_content);
      UPDATE public.customer_employee_conversations
      SET source_template_id = NULL, rich_card_content_id = v_frozen_id, content_frozen = true
      WHERE source_template_id = p_target_ids[1] AND message_type = 'rich_card' AND NOT content_frozen;
    END IF;
    DELETE FROM public.rich_card_contents card WHERE card.source_template_id = p_target_ids[1]
      AND NOT EXISTS (SELECT 1 FROM public.customer_employee_conversations message
        WHERE message.rich_card_content_id = card.id);
    DELETE FROM public.cs_message_templates WHERE id = p_target_ids[1];
  ELSIF p_action = 'auto_edit' THEN
    UPDATE public.customer_auto_messages
      SET name = COALESCE(p_payload ->> 'name', name), title = CASE WHEN p_payload ? 'title' THEN p_payload ->> 'title' ELSE title END,
          subtitle = CASE WHEN p_payload ? 'subtitle' THEN p_payload ->> 'subtitle' ELSE subtitle END,
          content = COALESCE(p_payload ->> 'content', content),
          content_type = COALESCE(p_payload ->> 'content_type', content_type),
          message_type = COALESCE(p_payload ->> 'message_type', message_type),
          sort_order = COALESCE((p_payload ->> 'sort_order')::integer, sort_order), updated_at = now()
      WHERE id = p_target_ids[1];
  ELSIF p_action = 'auto_delete' THEN
    SELECT content INTO v_source_content FROM public.customer_auto_messages WHERE id = p_target_ids[1];
    IF EXISTS (SELECT 1 FROM public.customer_employee_conversations
      WHERE source_auto_message_id = p_target_ids[1] AND message_type = 'rich_card' AND NOT content_frozen) THEN
      v_frozen_id := private.freeze_rich_card_version(v_source_content);
      UPDATE public.customer_employee_conversations
      SET source_auto_message_id = NULL, rich_card_content_id = v_frozen_id, content_frozen = true
      WHERE source_auto_message_id = p_target_ids[1] AND message_type = 'rich_card' AND NOT content_frozen;
    END IF;
    DELETE FROM public.rich_card_contents card WHERE card.source_auto_message_id = p_target_ids[1]
      AND NOT EXISTS (SELECT 1 FROM public.customer_employee_conversations message
        WHERE message.rich_card_content_id = card.id);
    DELETE FROM public.customer_auto_messages WHERE id = p_target_ids[1];
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_cards IS NOT NULL THEN
    DELETE FROM public.rich_card_contents card
    WHERE card.id = ANY(v_cards)
      AND NOT EXISTS (SELECT 1 FROM public.customer_employee_conversations message
        WHERE message.rich_card_content_id = card.id);
  END IF;
  PERFORM set_config('content_audit.actor', '', true);
  PERFORM set_config('content_audit.operation', '', true);
  PERFORM set_config('content_audit.media', '{}', true);
  PERFORM set_config('content_audit.action', '', true);
  RETURN jsonb_build_object('success', true, 'changed_count', v_changed);
END;
$$;

CREATE FUNCTION public.list_content_audit_owners(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', latest.owner_admin_id,
    'username', COALESCE(admin.username, latest.owner_username, latest.owner_admin_id::text),
    'event_count', totals.event_count) ORDER BY COALESCE(admin.username, latest.owner_username), latest.owner_admin_id), '[]'::jsonb)
  INTO v_result FROM (
    SELECT DISTINCT ON (owner_admin_id) owner_admin_id, owner_username
    FROM private.content_audit_events ORDER BY owner_admin_id, occurred_at DESC, id DESC
  ) latest
  JOIN (SELECT owner_admin_id, count(*) AS event_count FROM private.content_audit_events
    GROUP BY owner_admin_id) totals USING (owner_admin_id)
  LEFT JOIN public.admins admin ON admin.id = latest.owner_admin_id;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.list_content_audit_events(
  p_admin_session_token uuid, p_type text DEFAULT NULL, p_owner uuid DEFAULT NULL, p_actor uuid DEFAULT NULL,
  p_action text DEFAULT NULL, p_search text DEFAULT NULL, p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL, p_page integer DEFAULT 0, p_page_size integer DEFAULT 30
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_role text;
  v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  IF p_page NOT BETWEEN 0 AND 100000 OR p_page_size NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid page size.'; END IF;
  SELECT jsonb_build_object('total', count(*), 'items', COALESCE((
    SELECT jsonb_agg(to_jsonb(page) ORDER BY page.occurred_at DESC, page.id DESC)
    FROM (SELECT id, operation_id, entity_type, entity_id, action, owner_admin_id, actor_admin_id,
          actor_username, actor_role, owner_username, customer_id, employee_id, occurred_at, cleared_at, clear_started_at,
          before_data -> 'message' ->> 'audit_origin' AS notification_origin,
          left(COALESCE(before_data -> 'message' ->> 'title', before_data -> 'message' ->> 'message_content', ''), 160) AS summary
      FROM private.content_audit_events filtered
      WHERE (p_type IS NULL OR filtered.entity_type = p_type)
        AND (p_owner IS NULL OR filtered.owner_admin_id = p_owner)
        AND (p_actor IS NULL OR filtered.actor_admin_id = p_actor)
        AND (p_action IS NULL OR filtered.action = p_action)
        AND (p_from IS NULL OR filtered.occurred_at >= p_from)
        AND (p_to IS NULL OR filtered.occurred_at < p_to)
        AND (p_search IS NULL OR filtered.actor_username ILIKE '%' || p_search || '%'
          OR filtered.entity_id::text = p_search OR filtered.customer_id::text = p_search
          OR filtered.employee_id::text = p_search OR filtered.before_data::text ILIKE '%' || p_search || '%')
      ORDER BY occurred_at DESC, id DESC LIMIT p_page_size OFFSET p_page * p_page_size) page
  ), '[]'::jsonb)) INTO v_result
  FROM private.content_audit_events filtered
  WHERE (p_type IS NULL OR filtered.entity_type = p_type)
    AND (p_owner IS NULL OR filtered.owner_admin_id = p_owner)
    AND (p_actor IS NULL OR filtered.actor_admin_id = p_actor)
    AND (p_action IS NULL OR filtered.action = p_action)
    AND (p_from IS NULL OR filtered.occurred_at >= p_from)
    AND (p_to IS NULL OR filtered.occurred_at < p_to)
    AND (p_search IS NULL OR filtered.actor_username ILIKE '%' || p_search || '%'
      OR filtered.entity_id::text = p_search OR filtered.customer_id::text = p_search
      OR filtered.employee_id::text = p_search OR filtered.before_data::text ILIKE '%' || p_search || '%');
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.get_content_audit_event(p_admin_session_token uuid, p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  SELECT to_jsonb(e) || jsonb_build_object('timeline', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', version.id, 'action', version.action,
      'occurred_at', version.occurred_at, 'cleared_at', version.cleared_at) ORDER BY version.occurred_at, version.id), '[]'::jsonb)
    FROM private.content_audit_events version
    WHERE version.entity_type = e.entity_type AND version.entity_id = e.entity_id
  )) INTO v_result FROM private.content_audit_events e WHERE e.id = p_event_id;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.set_content_audit_purge_window(p_admin_session_token uuid, p_enabled boolean)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_expiry timestamptz;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  IF p_enabled THEN
    v_expiry := clock_timestamp() + interval '5 minutes';
    INSERT INTO private.content_audit_purge_windows(admin_id, token_hash, expires_at)
    VALUES (v_admin, private.hash_financial_token(p_admin_session_token), v_expiry)
    ON CONFLICT (admin_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at;
  ELSE
    DELETE FROM private.content_audit_purge_windows WHERE admin_id = v_admin;
  END IF;
  RETURN v_expiry;
END;
$$;

CREATE FUNCTION private.assert_content_audit_purge(p_token uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role FROM private.get_financial_admin_context(p_token);
  IF v_role <> 'super_admin' OR NOT EXISTS (
    SELECT 1 FROM private.content_audit_purge_windows
    WHERE admin_id = v_admin AND token_hash = private.hash_financial_token(p_token) AND expires_at > clock_timestamp()
  ) THEN RAISE EXCEPTION 'Super administrator purge mode is locked or expired.'; END IF;
  RETURN v_admin;
END;
$$;

CREATE FUNCTION public.begin_content_audit_clear(p_admin_session_token uuid, p_event_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_event private.content_audit_events%ROWTYPE; v_paths jsonb;
BEGIN
  v_admin := private.assert_content_audit_purge(p_admin_session_token);
  PERFORM pg_advisory_xact_lock(hashtext('content-audit-purge-media'));
  IF length(trim(COALESCE(p_reason, ''))) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'Enter a reason between 10 and 500 characters.'; END IF;
  SELECT * INTO v_event FROM private.content_audit_events WHERE id = p_event_id FOR UPDATE;
  IF v_event.id IS NULL OR v_event.cleared_at IS NOT NULL THEN RAISE EXCEPTION 'Evidence is not available.'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each_text(v_event.media_refs) media
    JOIN private.content_audit_events other ON other.id <> p_event_id
      AND other.cleared_at IS NULL AND other.clear_started_at > clock_timestamp() - interval '10 minutes'
      AND other.media_refs @> jsonb_build_object(media.key, media.value)
  ) THEN RAISE EXCEPTION 'A related evidence clear is in progress; retry after it finishes.'; END IF;
  UPDATE private.content_audit_events SET clear_reason = trim(p_reason), clear_started_at = clock_timestamp(), cleared_by = v_admin,
    cleared_username = (SELECT username FROM public.admins WHERE id = v_admin) WHERE id = p_event_id;
  SELECT COALESCE(jsonb_agg(DISTINCT media.value), '[]'::jsonb) INTO v_paths
  FROM jsonb_each_text(v_event.media_refs) media
  JOIN storage.objects object ON object.bucket_id = 'content-audit-evidence' AND object.name = media.value
  WHERE NOT EXISTS (
    SELECT 1 FROM private.content_audit_events other
    WHERE other.id <> p_event_id AND other.cleared_at IS NULL AND other.media_refs @> jsonb_build_object(media.key, media.value)
  );
  RETURN jsonb_build_object('paths_to_remove', v_paths);
END;
$$;

CREATE FUNCTION public.finish_content_audit_clear(p_admin_session_token uuid, p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_event private.content_audit_events%ROWTYPE;
BEGIN
  v_admin := private.assert_content_audit_purge(p_admin_session_token);
  PERFORM pg_advisory_xact_lock(hashtext('content-audit-purge-media'));
  SELECT * INTO v_event FROM private.content_audit_events WHERE id = p_event_id FOR UPDATE;
  IF v_event.cleared_at IS NOT NULL THEN RETURN jsonb_build_object('success', true); END IF;
  IF v_event.id IS NULL OR v_event.cleared_by IS DISTINCT FROM v_admin OR v_event.clear_started_at IS NULL THEN
    RAISE EXCEPTION 'Start the evidence clear again.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each_text(v_event.media_refs) media
    JOIN storage.objects object ON object.bucket_id = 'content-audit-evidence' AND object.name = media.value
    WHERE NOT EXISTS (SELECT 1 FROM private.content_audit_events other
      WHERE other.id <> p_event_id AND other.cleared_at IS NULL AND other.media_refs @> jsonb_build_object(media.key, media.value))
  ) THEN RAISE EXCEPTION 'Evidence media cleanup is incomplete.'; END IF;
  UPDATE private.content_audit_events SET before_data = NULL, after_data = NULL, media_refs = '{}'::jsonb,
    cleared_at = clock_timestamp() WHERE id = p_event_id;
  IF v_event.entity_type = 'notification'
    AND NOT EXISTS (SELECT 1 FROM public.messages WHERE id = v_event.entity_id)
    AND NOT EXISTS (SELECT 1 FROM private.content_audit_events
      WHERE entity_type = 'notification' AND entity_id = v_event.entity_id AND cleared_at IS NULL) THEN
    DELETE FROM private.content_audit_recipient_versions WHERE message_id = v_event.entity_id;
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE FUNCTION public.list_content_audit_orphan_media()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT COALESCE(array_agg(candidate.name), ARRAY[]::text[]) FROM (
    SELECT object.name FROM storage.objects object
    WHERE object.bucket_id = 'content-audit-evidence'
      AND object.created_at < clock_timestamp() - interval '24 hours'
      AND object.name ~ '^[0-9a-f-]{36}/shared/[0-9]+$'
      AND NOT EXISTS (
        SELECT 1 FROM private.content_audit_events event
        WHERE event.operation_id::text = split_part(object.name, '/', 1)
      )
    ORDER BY object.created_at LIMIT 100
  ) candidate;
$$;

INSERT INTO storage.buckets (id, name, public) VALUES ('content-audit-evidence', 'content-audit-evidence', false)
ON CONFLICT (id) DO UPDATE SET public = false;
DROP POLICY IF EXISTS "Anyone can update chat images" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can delete chat images" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can update announcement images" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can delete announcement images" ON storage.objects;
DROP POLICY IF EXISTS "Public can delete from announcement-images" ON storage.objects;
DROP POLICY IF EXISTS "Public can update announcement-images" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can update template images" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can delete template images" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to delete super customer avatars" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to update their super customer avatar" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to update their super customer avatars" ON storage.objects;

CREATE OR REPLACE FUNCTION public.cleanup_admin_data()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  DELETE FROM public.rich_card_contents card
  WHERE (card.source_template_id IN (SELECT id FROM public.cs_message_templates WHERE admin_id = OLD.id::text)
      OR card.source_auto_message_id IN (SELECT id FROM public.customer_auto_messages
        WHERE customer_id IN (SELECT id FROM public.simulated_customers WHERE admin_id = OLD.id)))
    AND NOT EXISTS (SELECT 1 FROM public.customer_employee_conversations message
      WHERE message.rich_card_content_id = card.id);
  DELETE FROM public.cs_message_templates WHERE admin_id = OLD.id::text;
  DELETE FROM public.history_cleanup_log WHERE admin_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_messages()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  DELETE FROM public.messages WHERE automation_execution_id IS NOT NULL AND expires_at < now();
END;
$$;
CREATE OR REPLACE FUNCTION public.cleanup_old_messages()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  DELETE FROM public.messages WHERE automation_execution_id IS NOT NULL AND created_at < now() - interval '30 days';
END;
$$;

REVOKE INSERT, UPDATE, DELETE ON public.messages FROM anon, authenticated;
REVOKE UPDATE (title, content) ON public.messages FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.customer_employee_conversations FROM anon, authenticated;
GRANT UPDATE (is_read, read_at) ON public.customer_employee_conversations TO anon, authenticated;
REVOKE DELETE ON public.simulated_customers FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.cs_message_templates FROM anon, authenticated;
GRANT UPDATE (name, sort_order, is_pinned, updated_at) ON public.cs_message_templates TO anon, authenticated;
REVOKE UPDATE, DELETE ON public.customer_auto_messages FROM anon, authenticated;
GRANT UPDATE (name, sort_order, is_enabled, updated_at) ON public.customer_auto_messages TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.rich_card_contents FROM anon, authenticated;
REVOKE UPDATE ON public.simulated_customers FROM anon, authenticated;
GRANT UPDATE (badge_type, customer_avatar, customer_id, customer_name, custom_avatar_url,
  employee_always_visible, employee_pin_top, is_active, is_super, super_customer_title,
  target_employee_id, target_employee_ids, vip_label, auto_messages_enabled, is_pinned,
  remarks, updated_at) ON public.simulated_customers TO anon, authenticated;

REVOKE ALL ON FUNCTION public.send_admin_message_secure(uuid, uuid[], text, text, text, text, numeric, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_admin_message_content_with_session(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_messages(uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_all_messages_for_admin(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_employee_account(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_secondary_account(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_content_audit_orphan_media() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_content_audit_orphan_media() TO service_role;
REVOKE ALL ON FUNCTION public.prepare_content_audit_change(uuid, text, uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_content_audit_change(uuid, text, uuid[], uuid, text, jsonb, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_content_audit_change(uuid, text, uuid[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_content_audit_change(uuid, text, uuid[], uuid, text, jsonb, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.list_content_audit_owners(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_content_audit_owners(uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.list_content_audit_events(uuid, text, uuid, uuid, text, text, timestamptz, timestamptz, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_content_audit_event(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_content_audit_purge_window(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_content_audit_clear(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_content_audit_clear(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_content_audit_events(uuid, text, uuid, uuid, text, text, timestamptz, timestamptz, integer, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_content_audit_event(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_content_audit_purge_window(uuid, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_content_audit_clear(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_content_audit_clear(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION private.remember_content_audit_recipient() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.classify_notification_origin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.freeze_rich_card_version(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.freeze_service_rich_card() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.content_audit_chat_snapshot(public.customer_employee_conversations) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.content_audit_media_for(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.content_audit_storage_urls(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.capture_content_audit_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.capture_content_audit_source_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_content_audit_purge(uuid) FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
