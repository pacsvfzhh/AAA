CREATE TABLE private.content_audit_delete_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL,
  token_hash text NOT NULL,
  target_ids uuid[] NOT NULL,
  card_count integer NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '5 minutes',
  finished_at timestamptz,
  paths_to_remove jsonb NOT NULL DEFAULT '[]'::jsonb
);

REVOKE ALL ON private.content_audit_delete_jobs FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.prepare_content_audit_delete(
  p_admin_session_token uuid, p_type text DEFAULT NULL, p_owner uuid DEFAULT NULL,
  p_action text DEFAULT NULL, p_content_search text DEFAULT NULL, p_identity_search text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_event_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_content text; v_identity text;
  v_ids uuid[]; v_cards integer; v_job uuid;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  IF p_type IS NOT NULL AND p_type NOT IN ('notification', 'aaa_service', 'ccc_service') THEN RAISE EXCEPTION 'Invalid type.'; END IF;
  IF p_action IS NOT NULL AND p_action NOT IN ('edit', 'delete', 'conversation_delete', 'customer_delete', 'employee_delete', 'admin_delete', 'source_edit', 'source_delete') THEN RAISE EXCEPTION 'Invalid action.'; END IF;
  IF length(COALESCE(p_content_search, '')) > 200 OR length(COALESCE(p_identity_search, '')) > 200 THEN RAISE EXCEPTION 'Search is too long.'; END IF;
  v_content := lower(NULLIF(btrim(p_content_search), ''));
  v_identity := lower(NULLIF(btrim(p_identity_search), ''));

  WITH matching AS (
    SELECT event.id,
      CASE WHEN event.action = 'conversation_delete' THEN concat(
        'conversation:', event.operation_id, ':', event.entity_type, ':', event.customer_id, ':', event.employee_id)
        ELSE concat('event:', event.id) END AS card_id
    FROM private.content_audit_events event
    WHERE (p_event_id IS NULL OR event.id = p_event_id)
      AND (p_type IS NULL OR event.entity_type = p_type)
      AND (p_owner IS NULL OR event.owner_admin_id = p_owner)
      AND (p_action IS NULL OR event.action = p_action)
      AND (p_from IS NULL OR event.occurred_at >= p_from)
      AND (p_to IS NULL OR event.occurred_at < p_to)
      AND (v_content IS NULL OR strpos(lower(concat_ws(' ',
        event.before_data #>> '{message,title}', event.after_data #>> '{message,title}',
        event.before_data #>> '{message,subtitle}', event.after_data #>> '{message,subtitle}',
        event.before_data #>> '{message,content}', event.after_data #>> '{message,content}',
        event.before_data #>> '{message,message_content}', event.after_data #>> '{message,message_content}',
        event.before_data #>> '{message,rating_data,comment}', event.after_data #>> '{message,rating_data,comment}',
        event.before_data ->> 'rendered_html', event.after_data ->> 'rendered_html'
      )), v_content) > 0)
      AND (v_identity IS NULL OR (event.cleared_at IS NULL AND (
        (event.entity_type IN ('aaa_service', 'ccc_service')
          AND strpos(lower(concat_ws(' ',
            event.before_data ->> 'customer_name', event.employee_account,
            event.before_data ->> 'employee_name', event.before_data ->> 'employee_number',
            (SELECT COALESCE(archived.employee_number,
              CASE WHEN employee.archived_at IS NULL THEN employee.employee_id END)
             FROM public.users employee
             LEFT JOIN private.deleted_employee_accounts archived
               ON archived.employee_id = employee.id AND archived.cleared_at IS NULL
             WHERE employee.id = event.employee_id)
          )), v_identity) > 0)
        OR (event.entity_type = 'notification' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(event.before_data -> 'recipients', '[]'::jsonb)) recipient(data)
          LEFT JOIN public.users recipient_user ON recipient_user.id = (recipient.data ->> 'recipient_id')::uuid
          LEFT JOIN private.deleted_employee_accounts archived
            ON archived.employee_id = (recipient.data ->> 'recipient_id')::uuid AND archived.cleared_at IS NULL
          WHERE strpos(lower(concat_ws(' ', archived.account_username, archived.employee_number,
            CASE WHEN recipient_user.archived_at IS NULL THEN recipient_user.username END,
            CASE WHEN recipient_user.archived_at IS NULL THEN recipient_user.employee_id END
          )), v_identity) > 0
        ))
      )))
  ), cards AS (
    SELECT DISTINCT card_id FROM matching
  ), targets AS (
    SELECT event.id FROM private.content_audit_events event
    WHERE (p_event_id IS NOT NULL AND event.id = p_event_id)
      OR (p_event_id IS NULL AND CASE WHEN event.action = 'conversation_delete' THEN concat(
        'conversation:', event.operation_id, ':', event.entity_type, ':', event.customer_id, ':', event.employee_id)
        ELSE concat('event:', event.id) END IN (SELECT card_id FROM cards))
  )
  SELECT (SELECT count(*) FROM cards), (SELECT array_agg(id) FROM targets) INTO v_cards, v_ids;

  IF v_cards = 0 OR v_ids IS NULL THEN RAISE EXCEPTION 'No matching audit records remain.'; END IF;
  DELETE FROM private.content_audit_delete_jobs WHERE expires_at < clock_timestamp() AND finished_at IS NULL;
  INSERT INTO private.content_audit_delete_jobs(admin_id, token_hash, target_ids, card_count)
  VALUES (v_admin, private.hash_financial_token(p_admin_session_token), v_ids, v_cards)
  RETURNING id INTO v_job;
  RETURN jsonb_build_object('job_id', v_job, 'card_count', v_cards, 'event_count', cardinality(v_ids));
END;
$$;

CREATE FUNCTION public.finish_content_audit_delete(p_admin_session_token uuid, p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_job private.content_audit_delete_jobs%ROWTYPE; v_count integer;
  v_notification_ids uuid[]; v_operation_ids text[]; v_paths jsonb;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('content-audit-purge-media'));
  SELECT * INTO v_job FROM private.content_audit_delete_jobs WHERE id = p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.admin_id IS DISTINCT FROM v_admin
    OR (v_job.finished_at IS NULL AND (v_job.token_hash IS DISTINCT FROM private.hash_financial_token(p_admin_session_token)
      OR v_job.expires_at <= clock_timestamp())) THEN
    RAISE EXCEPTION 'Deletion confirmation has expired. Preview the records again.';
  END IF;
  IF v_job.finished_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'deleted_events', cardinality(v_job.target_ids), 'paths_to_remove', v_job.paths_to_remove);
  END IF;
  IF (SELECT count(*) FROM private.content_audit_events WHERE id = ANY(v_job.target_ids)) <> cardinality(v_job.target_ids) THEN
    RAISE EXCEPTION 'The audit records changed. Preview the records again.';
  END IF;
  SELECT array_agg(DISTINCT operation_id::text), array_agg(DISTINCT entity_id) FILTER (WHERE entity_type = 'notification')
    INTO v_operation_ids, v_notification_ids FROM private.content_audit_events WHERE id = ANY(v_job.target_ids);
  DELETE FROM private.content_audit_events WHERE id = ANY(v_job.target_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  DELETE FROM private.content_audit_recipient_versions recipient
  WHERE recipient.message_id = ANY(COALESCE(v_notification_ids, ARRAY[]::uuid[]))
    AND NOT EXISTS (SELECT 1 FROM public.messages message WHERE message.id = recipient.message_id)
    AND NOT EXISTS (SELECT 1 FROM private.content_audit_events event
      WHERE event.entity_type = 'notification' AND event.entity_id = recipient.message_id AND event.cleared_at IS NULL);
  SELECT COALESCE(jsonb_agg(object.name), '[]'::jsonb) INTO v_paths FROM storage.objects object
  WHERE object.bucket_id = 'content-audit-evidence' AND split_part(object.name, '/', 1) = ANY(v_operation_ids)
    AND NOT EXISTS (
      SELECT 1 FROM private.content_audit_events event
      CROSS JOIN LATERAL jsonb_each_text(COALESCE(event.media_refs, '{}'::jsonb)) ref
      WHERE event.cleared_at IS NULL AND ref.value = object.name
    );
  UPDATE private.content_audit_delete_jobs SET finished_at = clock_timestamp(), paths_to_remove = v_paths WHERE id = p_job_id;
  RETURN jsonb_build_object('success', true, 'deleted_events', v_count, 'paths_to_remove', v_paths);
END;
$$;

CREATE FUNCTION public.complete_content_audit_delete(p_admin_session_token uuid, p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_job private.content_audit_delete_jobs%ROWTYPE;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  SELECT * INTO v_job FROM private.content_audit_delete_jobs WHERE id = p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.admin_id IS DISTINCT FROM v_admin
    OR v_job.finished_at IS NULL THEN RAISE EXCEPTION 'Deletion has not finished.'; END IF;
  IF EXISTS (SELECT 1 FROM storage.objects object
    WHERE object.bucket_id = 'content-audit-evidence'
      AND object.name IN (SELECT jsonb_array_elements_text(v_job.paths_to_remove))) THEN
    RAISE EXCEPTION 'Evidence media cleanup is incomplete.';
  END IF;
  DELETE FROM private.content_audit_delete_jobs WHERE id = p_job_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE FUNCTION public.list_content_audit_pending_deletes(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_jobs jsonb;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('job_id', id, 'card_count', card_count,
    'event_count', cardinality(target_ids), 'finished_at', finished_at) ORDER BY finished_at), '[]'::jsonb)
    INTO v_jobs FROM private.content_audit_delete_jobs
    WHERE admin_id = v_admin AND finished_at IS NOT NULL;
  RETURN v_jobs;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_content_audit_delete FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_content_audit_delete FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_content_audit_delete FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_content_audit_pending_deletes FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_content_audit_delete TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_content_audit_delete TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_content_audit_delete TO service_role;
GRANT EXECUTE ON FUNCTION public.list_content_audit_pending_deletes TO service_role;
NOTIFY pgrst, 'reload schema';
