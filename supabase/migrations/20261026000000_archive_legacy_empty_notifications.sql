DO $archive_legacy_empty_notifications$
DECLARE
  v_operation_id uuid := gen_random_uuid();
  v_targets integer;
  v_manual integer;
  v_unverified integer;
  v_automation integer;
  v_archived integer;
  v_deleted integer;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Historical notification cleanup must run as a database migration.';
  END IF;

  LOCK TABLE public.messages, public.message_recipients IN ACCESS EXCLUSIVE MODE;

  CREATE TEMP TABLE legacy_empty_notification_targets ON COMMIT DROP AS
  SELECT message.id, message.audit_origin
  FROM public.messages message
  WHERE NOT EXISTS (SELECT 1 FROM public.message_recipients recipient WHERE recipient.message_id = message.id);

  SELECT count(*), count(*) FILTER (WHERE audit_origin = 'manual_admin'),
    count(*) FILTER (WHERE audit_origin = 'unverified'),
    count(*) FILTER (WHERE audit_origin = 'automation')
  INTO v_targets, v_manual, v_unverified, v_automation
  FROM pg_temp.legacy_empty_notification_targets;

  IF (v_targets, v_manual, v_unverified, v_automation) IS DISTINCT FROM (167, 21, 140, 6) THEN
    RAISE EXCEPTION 'Historical notification inventory changed; inspect before cleanup.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_temp.legacy_empty_notification_targets target
    JOIN public.messages message ON message.id = target.id
    WHERE message.sender_id IS NULL
      OR cardinality(private.content_audit_storage_urls(to_jsonb(message))) > 0
      OR (COALESCE(message.title, '') || COALESCE(message.content, '')) ~* 'https?://|<(img|video|source)[[:space:]>]|(src|poster)[[:space:]]*='
      OR (target.audit_origin = 'automation') IS DISTINCT FROM (message.automation_execution_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM private.content_audit_events event
        WHERE event.entity_type = 'notification' AND event.entity_id = message.id)
  ) THEN
    RAISE EXCEPTION 'Historical notification evidence requires manual review; no content was removed.';
  END IF;

  ALTER TABLE private.content_audit_events ALTER COLUMN actor_admin_id DROP NOT NULL;
  ALTER TABLE private.content_audit_events ADD CONSTRAINT content_audit_system_actor_identity
    CHECK (actor_admin_id IS NOT NULL OR (actor_role = 'system_maintenance'
      AND actor_username = '資料庫維護（依授權清理）' AND entity_type = 'notification' AND action = 'delete'));

  INSERT INTO private.content_audit_events (
    operation_id, entity_type, entity_id, action, owner_admin_id, owner_username,
    actor_admin_id, actor_username, actor_role, before_data, media_refs
  )
  SELECT v_operation_id, 'notification', message.id, 'delete', message.sender_id, message.sender_username,
    NULL, '資料庫維護（依授權清理）', 'system_maintenance',
    jsonb_build_object(
      'message', to_jsonb(message),
      'recipients', (SELECT COALESCE(jsonb_agg(version.recipient_data ORDER BY version.recipient_id), '[]'::jsonb)
        FROM private.content_audit_recipient_versions version WHERE version.message_id = message.id),
      'legacy_orphan_cleanup', true,
      'recipient_history', CASE WHEN EXISTS (
        SELECT 1 FROM private.content_audit_recipient_versions version WHERE version.message_id = message.id
      ) THEN 'available_since_audit_launch' ELSE 'unavailable' END
    ), '{}'::jsonb
  FROM pg_temp.legacy_empty_notification_targets target
  JOIN public.messages message ON message.id = target.id
  WHERE target.audit_origin IN ('manual_admin', 'unverified');
  GET DIAGNOSTICS v_archived = ROW_COUNT;
  IF v_archived <> v_manual + v_unverified THEN
    RAISE EXCEPTION 'Historical notification archive is incomplete.';
  END IF;

  ALTER TABLE public.messages DISABLE TRIGGER audit_notification_change;
  DELETE FROM public.messages message
  USING pg_temp.legacy_empty_notification_targets target
  WHERE message.id = target.id
    AND NOT EXISTS (SELECT 1 FROM public.message_recipients recipient WHERE recipient.message_id = message.id);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  ALTER TABLE public.messages ENABLE TRIGGER audit_notification_change;

  IF v_deleted <> v_targets
    OR (SELECT count(*) FROM private.content_audit_events event
      WHERE event.operation_id = v_operation_id AND event.entity_type = 'notification') <> v_archived THEN
    RAISE EXCEPTION 'Historical notification cleanup is incomplete; the transaction was rolled back.';
  END IF;
END;
$archive_legacy_empty_notifications$;

NOTIFY pgrst, 'reload schema';
