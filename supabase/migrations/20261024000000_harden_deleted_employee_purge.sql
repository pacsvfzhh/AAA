DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM private.deleted_employee_delete_jobs WHERE finished_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Completed employee database deletions still await media cleanup. Finish those jobs before upgrading employee deletion.';
  END IF;
END;
$$;

ALTER TABLE private.deleted_employee_delete_jobs
  ADD COLUMN retained_shared_images integer NOT NULL DEFAULT 0;

CREATE TABLE private.retained_employee_chat_images (
  path text PRIMARY KEY,
  retained_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON private.retained_employee_chat_images FROM PUBLIC, anon, authenticated;

CREATE TABLE private.employee_chat_image_deletion_claims (
  path text PRIMARY KEY,
  filename text GENERATED ALWAYS AS (regexp_replace(path, '^.*/', '')) STORED,
  job_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);
REVOKE ALL ON private.employee_chat_image_deletion_claims FROM PUBLIC, anon, authenticated;
CREATE INDEX employee_chat_image_deletion_claims_filename_idx
  ON private.employee_chat_image_deletion_claims(filename);

CREATE FUNCTION private.guard_employee_chat_image_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_content text;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('employee-chat-image-references'));
  IF NOT EXISTS (SELECT 1 FROM private.employee_chat_image_deletion_claims) THEN RETURN NEW; END IF;
  v_content := to_jsonb(NEW)::text;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT matched.parts[1] AS filename
      FROM regexp_matches(v_content, '([A-Za-z0-9_.-]+[.][A-Za-z0-9]{2,8})', 'g') matched(parts)
    ) candidate
    JOIN private.employee_chat_image_deletion_claims claim ON claim.filename = candidate.filename
    WHERE strpos(v_content, claim.path) > 0
  ) THEN
    RAISE EXCEPTION 'The image has been reserved for permanent deletion. Upload or select another image.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.guard_employee_chat_image_reference() FROM PUBLIC, anon, authenticated;

DO $reference_guards$
DECLARE target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('public', 'customer_employee_conversations', 'image_url, message_content, rating_data'),
    ('public', 'messages', 'content'),
    ('public', 'broadcast_messages', 'image_url, message_content'),
    ('public', 'announcements', 'content'),
    ('public', 'cs_message_templates', 'content'),
    ('public', 'customer_auto_messages', 'content'),
    ('public', 'rich_card_contents', 'html_content'),
    ('public', 'message_templates', 'content'),
    ('public', 'notification_automation_tasks', 'content_template, title_template'),
    ('public', 'notification_automation_executions', 'title_snapshot, content_snapshot'),
    ('public', 'simulated_customers', 'custom_avatar_url, customer_avatar'),
    ('public', 'admin_configs', 'icon_custom_url, config_value'),
    ('public', 'system_configs', 'value'),
    ('public', 'financial_operations', 'request_data, result'),
    ('private', 'content_audit_events', 'before_data, after_data, media_refs'),
    ('private', 'deleted_employee_notifications', 'message_data, recipient_data')
  ) AS sources(schema_name, table_name, columns_to_guard) LOOP
    EXECUTE format('CREATE TRIGGER guard_employee_chat_image_reference BEFORE INSERT OR UPDATE OF %s ON %I.%I FOR EACH ROW EXECUTE FUNCTION private.guard_employee_chat_image_reference()',
      target.columns_to_guard, target.schema_name, target.table_name);
  END LOOP;
END;
$reference_guards$;

CREATE FUNCTION public.allow_employee_chat_image_upload(p_path text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, private, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('employee-chat-image-references'));
  RETURN NOT EXISTS (SELECT 1 FROM private.employee_chat_image_deletion_claims WHERE path = p_path);
END;
$$;
REVOKE ALL ON FUNCTION public.allow_employee_chat_image_upload(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allow_employee_chat_image_upload(text) TO anon, authenticated;
DROP POLICY "Anyone can upload chat images" ON storage.objects;
CREATE POLICY "Anyone can upload chat images" ON storage.objects FOR INSERT TO public
WITH CHECK (bucket_id = 'chat-images' AND public.allow_employee_chat_image_upload(name));

CREATE FUNCTION private.employee_chat_image_in_use(p_path text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF p_path IS NULL OR p_path = '' THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.cs_message_templates template
    WHERE strpos(COALESCE(template.content, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.customer_employee_conversations conversation
    WHERE strpos(COALESCE(conversation.image_url, ''), p_path) > 0
      OR strpos(COALESCE(conversation.message_content, ''), p_path) > 0
      OR strpos(COALESCE(conversation.rating_data::text, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.messages message
    WHERE strpos(COALESCE(message.content, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.broadcast_messages message
    WHERE strpos(COALESCE(message.image_url, ''), p_path) > 0
      OR strpos(COALESCE(message.message_content, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.announcements announcement
    WHERE strpos(COALESCE(announcement.content, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.customer_auto_messages automated
    WHERE strpos(COALESCE(automated.content, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.message_templates template
    WHERE strpos(COALESCE(template.content, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.notification_automation_tasks task
    WHERE strpos(COALESCE(task.content_template, ''), p_path) > 0
      OR strpos(COALESCE(task.title_template, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.notification_automation_executions execution
    WHERE strpos(COALESCE(execution.title_snapshot, ''), p_path) > 0
      OR strpos(COALESCE(execution.content_snapshot, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.simulated_customers customer
    WHERE strpos(COALESCE(customer.custom_avatar_url, ''), p_path) > 0
      OR strpos(COALESCE(customer.customer_avatar, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.admin_configs config
    WHERE strpos(COALESCE(config.icon_custom_url, ''), p_path) > 0
      OR strpos(COALESCE(config.config_value, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.system_configs config
    WHERE strpos(COALESCE(config.value::text, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.financial_operations operation
    WHERE strpos(operation.request_data::text, p_path) > 0
      OR strpos(operation.result::text, p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM private.content_audit_events event
    WHERE strpos(COALESCE(event.before_data::text, ''), p_path) > 0
      OR strpos(COALESCE(event.after_data::text, ''), p_path) > 0
      OR strpos(event.media_refs::text, p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM private.deleted_employee_notifications notification
    WHERE strpos(COALESCE(notification.message_data::text, ''), p_path) > 0
      OR strpos(COALESCE(notification.recipient_data::text, ''), p_path) > 0) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.rich_card_contents card
    WHERE strpos(COALESCE(card.html_content, ''), p_path) > 0) THEN RETURN true; END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION private.employee_chat_image_in_use(text) FROM PUBLIC, anon, authenticated;

DO $purge_patch$
DECLARE
  definition text;
BEGIN
  definition := pg_get_functiondef('public.finish_deleted_employee_archive_delete(uuid, uuid)'::regprocedure);
  IF strpos(definition, 'v_operation_ids text[];') = 0
    OR strpos(definition, 'SELECT array_agg(DISTINCT operation_id::text) INTO v_operation_ids') = 0
    OR strpos(definition, 'SET finished_at = clock_timestamp(), paths_to_remove = v_paths WHERE id = p_job_id;') = 0
    OR strpos(definition, 'v_employee_ids uuid[];') = 0
    OR strpos(definition, 'DELETE FROM public.financial_operations WHERE actor_id = ANY(v_employee_ids);') = 0
    OR strpos(definition, 'DELETE FROM public.users WHERE id = ANY(v_employee_ids);') = 0
    OR strpos(definition, 'DELETE FROM private.deleted_employee_accounts WHERE id = ANY(v_job.account_ids);') = 0 THEN
    RAISE EXCEPTION 'Unexpected employee purge definition.';
  END IF;

  definition := replace(definition,
    'v_employee_ids uuid[];',
    'v_employee_ids uuid[];' || E'\n  ' || 'v_withdrawal_ids uuid[];');
  definition := replace(definition,
    'v_operation_ids text[];',
    'v_operation_ids text[];' || E'\n  ' ||
    'v_original_paths text[];' || E'\n  ' || 'v_public_paths jsonb;');
  definition := replace(definition,
    'SELECT array_agg(DISTINCT operation_id::text) INTO v_operation_ids',
    $capture_original_images$
  SELECT COALESCE(array_agg(DISTINCT original.path), '{}'::text[]) INTO v_original_paths
  FROM private.content_audit_events event
  CROSS JOIN LATERAL jsonb_object_keys(COALESCE(event.media_refs, '{}'::jsonb)) source(url)
  CROSS JOIN LATERAL (
    SELECT substring(source.url FROM '/storage/v1/object/public/chat-images/([^?#]+)$') AS path
  ) original
  WHERE event.employee_id = ANY(v_employee_ids) AND original.path IS NOT NULL;
  IF EXISTS (SELECT 1 FROM unnest(v_original_paths) candidate(path)
    WHERE strpos(candidate.path, '%') > 0
      OR regexp_replace(candidate.path, '^.*/', '') !~ '^[A-Za-z0-9_.-]+[.][A-Za-z0-9]{2,8}$') THEN
    RAISE EXCEPTION 'An archived chat image path must be reviewed before permanent deletion.';
  END IF;

  SELECT array_agg(DISTINCT operation_id::text) INTO v_operation_ids
    $capture_original_images$);

  definition := replace(definition,
    'DELETE FROM public.financial_operations WHERE actor_id = ANY(v_employee_ids);',
    $financial_cleanup$
    UPDATE public.financial_operations operation
    SET request_data = jsonb_set(operation.request_data, '{recipient_ids}', (
      SELECT COALESCE(jsonb_agg(recipient.id ORDER BY recipient.position), '[]'::jsonb)
      FROM jsonb_array_elements(operation.request_data -> 'recipient_ids')
        WITH ORDINALITY recipient(id, position)
      WHERE recipient.id #>> '{}' <> ALL(v_employee_ids::text[])
    )) || jsonb_build_object('_original_request_sha256',
      COALESCE(operation.request_data ->> '_original_request_sha256',
        encode(sha256(convert_to(operation.request_data::text, 'UTF8')), 'hex')))
    WHERE operation.operation_type = 'admin_message_send'
      AND jsonb_typeof(operation.request_data -> 'recipient_ids') = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(operation.request_data -> 'recipient_ids') recipient(id)
        WHERE recipient.id = ANY(v_employee_ids::text[])
      );

    PERFORM 1 FROM public.wallets wallet
    WHERE wallet.user_id = ANY(v_employee_ids) ORDER BY wallet.user_id FOR UPDATE;
    PERFORM 1 FROM public.withdrawals withdrawal
    WHERE withdrawal.user_id = ANY(v_employee_ids) ORDER BY withdrawal.id FOR UPDATE;
    SELECT COALESCE(array_agg(withdrawal.id), '{}'::uuid[]) INTO v_withdrawal_ids
    FROM public.withdrawals withdrawal WHERE withdrawal.user_id = ANY(v_employee_ids);

    DELETE FROM public.financial_operations operation
    WHERE (operation.actor_type = 'employee' AND operation.actor_id = ANY(v_employee_ids))
      OR (operation.operation_type IN ('admin_adjust_wallet', 'notification_automation_bonus')
        AND operation.request_data ->> 'user_id' = ANY(v_employee_ids::text[]))
      OR (operation.operation_type = 'customer_service_tip'
        AND operation.request_data ->> 'employee_id' = ANY(v_employee_ids::text[]))
      OR (operation.operation_type IN ('review_withdrawal', 'correct_withdrawal_status')
        AND operation.request_data ->> 'withdrawal_id' = ANY(v_withdrawal_ids::text[]));

    UPDATE public.dispatch_performance_metrics metric
    SET metadata = metric.metadata - 'user_id'
    WHERE metric.metadata ->> 'user_id' = ANY(v_employee_ids::text[]);

    PERFORM 1 FROM public.simulated_customers customer
    WHERE customer.target_employee_id = ANY(v_employee_ids)
      OR customer.target_employee_ids && v_employee_ids
    ORDER BY customer.id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.simulated_customers customer
      WHERE customer.target_employee_ids && v_employee_ids
        AND NOT EXISTS (
          SELECT 1 FROM unnest(COALESCE(customer.target_employee_ids, '{}'::uuid[])) target(id)
          WHERE target.id <> ALL(v_employee_ids)
        )
    ) THEN
      RAISE EXCEPTION 'A shared customer is assigned only to this employee. Reassign the customer before permanent deletion.';
    END IF;
    UPDATE public.simulated_customers customer
    SET target_employee_id = CASE WHEN customer.target_employee_id = ANY(v_employee_ids)
      THEN NULL ELSE customer.target_employee_id END,
      target_employee_ids = ARRAY(
        SELECT target.id FROM unnest(customer.target_employee_ids) target(id)
        WHERE target.id <> ALL(v_employee_ids)
      )
    WHERE customer.target_employee_ids && v_employee_ids;
    UPDATE public.simulated_customers customer
    SET target_employee_id = NULL
    WHERE customer.target_employee_id = ANY(v_employee_ids);

    DELETE FROM public.message_recipients recipient
    WHERE recipient.recipient_id = ANY(v_employee_ids);
    $financial_cleanup$);

  definition := replace(definition,
    'DELETE FROM public.users WHERE id = ANY(v_employee_ids);',
    $after_user_delete$
    DELETE FROM public.users WHERE id = ANY(v_employee_ids);
    DELETE FROM private.content_audit_recipient_versions
    WHERE recipient_id = ANY(v_employee_ids);

    SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', 'chat-images', 'path', candidate.path)), '[]'::jsonb)
    INTO v_public_paths
    FROM (SELECT DISTINCT unnest(v_original_paths) AS path) candidate
    JOIN storage.objects object ON object.bucket_id = 'chat-images' AND object.name = candidate.path;
    v_paths := v_paths || v_public_paths;
    $after_user_delete$);

  definition := replace(definition,
    $$'paths_to_remove', v_job.paths_to_remove)$$,
    $$'paths_to_remove', v_job.paths_to_remove, 'retained_shared_images', v_job.retained_shared_images)$$);
  definition := replace(definition,
    $$'paths_to_remove', v_paths)$$,
    $$'paths_to_remove', v_paths, 'retained_shared_images', 0)$$);

  definition := replace(definition,
    'DELETE FROM private.deleted_employee_accounts WHERE id = ANY(v_job.account_ids);',
    $verify_cleanup$
  IF EXISTS (SELECT 1 FROM public.message_recipients WHERE recipient_id = ANY(v_employee_ids))
    OR EXISTS (SELECT 1 FROM private.content_audit_recipient_versions WHERE recipient_id = ANY(v_employee_ids))
    OR EXISTS (SELECT 1 FROM public.dispatch_system_logs WHERE user_id = ANY(v_employee_ids))
    OR EXISTS (SELECT 1 FROM public.dispatch_performance_metrics WHERE metadata ->> 'user_id' = ANY(v_employee_ids::text[]))
    OR EXISTS (SELECT 1 FROM public.simulated_customers customer
      WHERE customer.target_employee_id = ANY(v_employee_ids)
        OR customer.target_employee_ids && v_employee_ids)
    OR EXISTS (SELECT 1 FROM public.financial_operations operation
      WHERE (operation.actor_type = 'employee' AND operation.actor_id = ANY(v_employee_ids))
        OR (operation.operation_type IN ('admin_adjust_wallet', 'notification_automation_bonus')
          AND operation.request_data ->> 'user_id' = ANY(v_employee_ids::text[]))
        OR (operation.operation_type = 'customer_service_tip'
          AND operation.request_data ->> 'employee_id' = ANY(v_employee_ids::text[]))
        OR (operation.operation_type IN ('review_withdrawal', 'correct_withdrawal_status')
          AND operation.request_data ->> 'withdrawal_id' = ANY(v_withdrawal_ids::text[]))
        OR (operation.operation_type = 'admin_message_send'
          AND jsonb_typeof(operation.request_data -> 'recipient_ids') = 'array'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(operation.request_data -> 'recipient_ids') recipient(id)
            WHERE recipient.id = ANY(v_employee_ids::text[])
          ))) THEN
    RAISE EXCEPTION 'Employee-linked data remains; permanent deletion was rolled back.';
  END IF;
  DELETE FROM private.deleted_employee_accounts WHERE id = ANY(v_job.account_ids);
    $verify_cleanup$);

  EXECUTE definition;

  definition := pg_get_functiondef('private.begin_financial_operation(uuid, text, text, uuid, jsonb)'::regprocedure);
  IF strpos(definition, 'v_operation.request_data IS DISTINCT FROM p_request_data') = 0 THEN
    RAISE EXCEPTION 'Unexpected financial operation replay definition.';
  END IF;
  definition := replace(definition,
    'v_operation.request_data IS DISTINCT FROM p_request_data',
    $redacted_replay$(v_operation.request_data IS DISTINCT FROM p_request_data
        AND NOT (p_operation_type = 'admin_message_send'
          AND v_operation.request_data ? '_original_request_sha256'
          AND v_operation.request_data ->> '_original_request_sha256' =
            encode(sha256(convert_to(p_request_data::text, 'UTF8')), 'hex')))$redacted_replay$);
  EXECUTE definition;
END;
$purge_patch$;

DO $complete_media_purge$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.complete_deleted_employee_archive_delete(uuid, uuid)'::regprocedure);
  IF strpos(definition, 'DELETE FROM private.deleted_employee_delete_jobs WHERE id = p_job_id;') = 0 THEN
    RAISE EXCEPTION 'Unexpected employee media completion definition.';
  END IF;
  definition := replace(definition,
    'DELETE FROM private.deleted_employee_delete_jobs WHERE id = p_job_id;',
    $completed_images$
    UPDATE private.employee_chat_image_deletion_claims
    SET deleted_at = clock_timestamp()
    WHERE job_id = p_job_id AND deleted_at IS NULL;
    DELETE FROM private.deleted_employee_delete_jobs WHERE id = p_job_id;
    $completed_images$);
  EXECUTE definition;
END;
$complete_media_purge$;

CREATE FUNCTION public.recheck_deleted_employee_archive_media(
  p_admin_session_token uuid, p_job_id uuid, p_paths text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_job private.deleted_employee_delete_jobs%ROWTYPE;
  v_paths jsonb; v_retained integer; v_shared_paths text[];
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('content-audit-purge-media'));
  SELECT * INTO v_job FROM private.deleted_employee_delete_jobs WHERE id = p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.finished_at IS NULL THEN
    RAISE EXCEPTION 'Employee deletion has not finished.';
  END IF;
  IF cardinality(p_paths) NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'Invalid media batch.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('employee-chat-image-references'));
  IF EXISTS (SELECT 1 FROM private.employee_chat_image_deletion_claims claim
    JOIN storage.objects object ON object.bucket_id = 'chat-images' AND object.name = claim.path
    WHERE claim.path = ANY(p_paths) AND claim.job_id <> p_job_id)
    OR EXISTS (SELECT 1 FROM private.employee_chat_image_deletion_claims claim
      WHERE claim.path = ANY(p_paths) AND claim.job_id <> p_job_id AND claim.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'An image is already reserved by another employee deletion. Retry after that deletion finishes.';
  END IF;
  WITH checked AS MATERIALIZED (
    SELECT item.data ->> 'path' AS path, private.employee_chat_image_in_use(item.data ->> 'path') AS in_use
    FROM jsonb_array_elements(v_job.paths_to_remove) item(data)
    WHERE item.data ->> 'bucket' = 'chat-images' AND item.data ->> 'path' = ANY(p_paths)
      AND NOT EXISTS (SELECT 1 FROM private.employee_chat_image_deletion_claims claim
        WHERE claim.path = item.data ->> 'path' AND claim.job_id <> p_job_id
          AND claim.deleted_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM storage.objects object
            WHERE object.bucket_id = 'chat-images' AND object.name = claim.path))
  )
  SELECT COALESCE(jsonb_agg(item.data ORDER BY item.position), '[]'::jsonb),
    (SELECT count(*) FROM checked WHERE in_use),
    (SELECT COALESCE(array_agg(path), '{}'::text[]) FROM checked WHERE in_use)
  INTO v_paths, v_retained, v_shared_paths
  FROM jsonb_array_elements(v_job.paths_to_remove) WITH ORDINALITY item(data, position)
  LEFT JOIN checked ON item.data ->> 'bucket' = 'chat-images' AND checked.path = item.data ->> 'path'
  WHERE checked.in_use IS DISTINCT FROM true
    AND NOT (item.data ->> 'bucket' = 'chat-images' AND item.data ->> 'path' = ANY(p_paths)
      AND EXISTS (SELECT 1 FROM private.employee_chat_image_deletion_claims claim
        WHERE claim.path = item.data ->> 'path' AND claim.job_id <> p_job_id
          AND claim.deleted_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM storage.objects object
            WHERE object.bucket_id = 'chat-images' AND object.name = claim.path)));
  INSERT INTO private.retained_employee_chat_images(path)
  SELECT DISTINCT unnest(v_shared_paths) ON CONFLICT (path) DO NOTHING;
  INSERT INTO private.employee_chat_image_deletion_claims(path, job_id)
  SELECT DISTINCT item.data ->> 'path', p_job_id
  FROM jsonb_array_elements(v_paths) item(data)
  WHERE item.data ->> 'bucket' = 'chat-images' AND item.data ->> 'path' = ANY(p_paths)
  ON CONFLICT (path) DO NOTHING;
  UPDATE private.deleted_employee_delete_jobs
  SET paths_to_remove = v_paths, retained_shared_images = retained_shared_images + v_retained
  WHERE id = p_job_id RETURNING * INTO v_job;
  RETURN jsonb_build_object('paths_to_remove', v_job.paths_to_remove,
    'retained_shared_images', v_job.retained_shared_images);
END;
$$;
REVOKE ALL ON FUNCTION public.recheck_deleted_employee_archive_media(uuid, uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recheck_deleted_employee_archive_media(uuid, uuid, text[]) TO service_role;

CREATE FUNCTION private.guard_archived_withdrawal_operation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.operation_type IN ('review_withdrawal', 'correct_withdrawal_status')
    AND NOT EXISTS (
      SELECT 1 FROM public.withdrawals withdrawal
      WHERE withdrawal.id::text = NEW.request_data ->> 'withdrawal_id'
      FOR KEY SHARE
    ) THEN
    RAISE EXCEPTION 'The withdrawal no longer exists. The financial operation was not saved.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_archived_withdrawal_operation BEFORE INSERT ON public.financial_operations
FOR EACH ROW EXECUTE FUNCTION private.guard_archived_withdrawal_operation();
REVOKE ALL ON FUNCTION private.guard_archived_withdrawal_operation() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.finish_deleted_employee_archive_delete(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_deleted_employee_archive_delete(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION private.begin_financial_operation(uuid, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
