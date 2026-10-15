CREATE FUNCTION public.prepare_approved_content_residual_cleanup(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_notifications jsonb; v_images jsonb; v_scope jsonb;
  v_ids uuid[]; v_paths jsonb; v_job uuid; v_redacted integer;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('content-audit-purge-media'));
  PERFORM pg_advisory_xact_lock(hashtext('employee-chat-image-references'));
  SELECT jsonb_agg(id ORDER BY id) INTO v_notifications FROM (
    SELECT operation.result ->> 'message_id' AS id FROM public.financial_operations operation
    WHERE operation.operation_type = 'admin_message_send' AND operation.result ->> 'message_id' IS NOT NULL
      AND (operation.request_data ? 'title' OR operation.request_data ? 'content')
      AND NOT EXISTS (SELECT 1 FROM public.messages message WHERE message.id::text = operation.result ->> 'message_id')
      AND NOT EXISTS (SELECT 1 FROM private.content_audit_events event
        WHERE event.entity_type = 'notification' AND event.entity_id::text = operation.result ->> 'message_id' AND event.cleared_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM private.deleted_employee_notifications notification
        WHERE notification.message_id::text = operation.result ->> 'message_id' AND notification.cleared_at IS NULL)
  ) notifications;
  SELECT jsonb_agg(name ORDER BY name) INTO v_images FROM storage.objects
  WHERE bucket_id = 'chat-images' AND created_at < clock_timestamp() - interval '24 hours'
    AND NOT private.employee_chat_image_in_use(name);
  v_scope := jsonb_build_object('notifications', v_notifications, 'images', v_images);
  IF encode(sha256(convert_to(v_scope::text, 'UTF8')), 'hex')
      <> 'dc764294703171f1f425908b3183128e5354aacefe4f4f91a2813d7a66586f0c'
    OR jsonb_array_length(v_notifications) IS DISTINCT FROM 25
    OR jsonb_array_length(v_images) IS DISTINCT FROM 67 THEN
    RAISE EXCEPTION 'The approved residual cleanup scope changed. Recheck and request confirmation again.';
  END IF;
  SELECT array_agg(id::uuid) INTO v_ids FROM jsonb_array_elements_text(v_notifications) notifications(id);
  SELECT jsonb_agg(jsonb_build_object('bucket', 'chat-images', 'path', path) ORDER BY path) INTO v_paths
  FROM jsonb_array_elements_text(v_images) images(path);
  v_redacted := private.redact_deleted_notification_send_content(v_ids);
  IF v_redacted <> 25 THEN RAISE EXCEPTION 'The notification cleanup scope changed.'; END IF;
  INSERT INTO private.content_audit_delete_jobs(admin_id, token_hash, target_ids, card_count, finished_at, public_media_to_remove)
  VALUES (v_admin, private.hash_financial_token(p_admin_session_token), '{}'::uuid[], 0, clock_timestamp(), v_paths)
  RETURNING id INTO v_job;
  RETURN jsonb_build_object('job_id', v_job, 'redacted_notifications', v_redacted, 'candidate_files', jsonb_array_length(v_paths));
END;
$$;
REVOKE ALL ON FUNCTION public.prepare_approved_content_residual_cleanup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_approved_content_residual_cleanup(uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
