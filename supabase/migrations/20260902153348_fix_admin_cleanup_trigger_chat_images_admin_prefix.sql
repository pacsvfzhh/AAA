/*
# Fix Admin Cleanup Trigger: Chat Images Under Admin ID Prefix

## Problem
The `cleanup_admin_data` trigger only deletes chat-images stored under
customer ID prefixes (`customer_id/...`), but some chat images are uploaded
under the admin's own ID as the folder prefix (`admin_id/...`).
When an admin is deleted, those files survive as orphans.

## Changes
- Add a step (5c-extra) that also deletes chat-images stored under
  `admin_id/...` prefix, before the existing customer-prefix cleanup.

## Security
- No changes to function security model (remains SECURITY DEFINER).
*/

CREATE OR REPLACE FUNCTION public.cleanup_admin_data()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_id_text text;
  v_customer_ids uuid[];
  v_announcement_ids uuid[];
  v_template_ids uuid[];
  v_auto_message_ids uuid[];
  v_deleted_count integer;
  v_total_deleted integer := 0;
  v_file_record record;
  v_files_deleted integer := 0;
BEGIN
  v_admin_id := OLD.id;
  v_admin_id_text := OLD.id::text;

  RAISE NOTICE '==========================================';
  RAISE NOTICE 'Starting admin cleanup for: % (username: %)', v_admin_id, OLD.username;
  RAISE NOTICE '==========================================';

  SELECT array_agg(id) INTO v_customer_ids
  FROM simulated_customers WHERE admin_id = v_admin_id;

  SELECT array_agg(id) INTO v_announcement_ids
  FROM announcements WHERE created_by = v_admin_id;

  SELECT array_agg(id) INTO v_template_ids
  FROM cs_message_templates WHERE admin_id = v_admin_id_text;

  IF v_customer_ids IS NOT NULL AND array_length(v_customer_ids, 1) > 0 THEN
    SELECT array_agg(id) INTO v_auto_message_ids
    FROM customer_auto_messages WHERE customer_id = ANY(v_customer_ids);
  END IF;

  -- 1. Delete rich_card_contents referencing admin's templates
  IF v_template_ids IS NOT NULL AND array_length(v_template_ids, 1) > 0 THEN
    DELETE FROM rich_card_contents WHERE source_template_id = ANY(v_template_ids);
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    v_total_deleted := v_total_deleted + v_deleted_count;
    RAISE NOTICE '[1] Deleted % rich card contents (from templates)', v_deleted_count;
  END IF;

  -- 2. Delete rich_card_contents referencing admin's auto-messages
  IF v_auto_message_ids IS NOT NULL AND array_length(v_auto_message_ids, 1) > 0 THEN
    DELETE FROM rich_card_contents WHERE source_auto_message_id = ANY(v_auto_message_ids);
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    v_total_deleted := v_total_deleted + v_deleted_count;
    RAISE NOTICE '[2] Deleted % rich card contents (from auto-messages)', v_deleted_count;
  END IF;

  -- 3. Delete cs_message_templates (TEXT admin_id, no FK)
  DELETE FROM cs_message_templates WHERE admin_id = v_admin_id_text;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[3] Deleted % message templates', v_deleted_count;

  -- 4. Delete history_cleanup_log (uuid admin_id, no FK)
  DELETE FROM history_cleanup_log WHERE admin_id = v_admin_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[4] Deleted % history cleanup log entries', v_deleted_count;

  -- 5. Clean up storage files
  PERFORM set_config('storage.allow_delete_query', 'true', true);

  -- 5a. Announcement images (stored under admin ID prefix)
  FOR v_file_record IN
    SELECT name, bucket_id
    FROM storage.objects
    WHERE bucket_id = 'announcement-images'
      AND name LIKE v_admin_id_text || '/%'
  LOOP
    DELETE FROM storage.objects
    WHERE bucket_id = v_file_record.bucket_id
      AND name = v_file_record.name;
    v_files_deleted := v_files_deleted + 1;
  END LOOP;
  RAISE NOTICE '[5a] Deleted % announcement image files', v_files_deleted;

  -- 5b. Template images (stored under admin ID prefix)
  v_files_deleted := 0;
  FOR v_file_record IN
    SELECT name, bucket_id
    FROM storage.objects
    WHERE bucket_id = 'template-images'
      AND name LIKE v_admin_id_text || '/%'
  LOOP
    DELETE FROM storage.objects
    WHERE bucket_id = v_file_record.bucket_id
      AND name = v_file_record.name;
    v_files_deleted := v_files_deleted + 1;
  END LOOP;
  RAISE NOTICE '[5b] Deleted % template image files', v_files_deleted;

  -- 5c. Chat images stored under admin ID prefix
  v_files_deleted := 0;
  FOR v_file_record IN
    SELECT name, bucket_id
    FROM storage.objects
    WHERE bucket_id = 'chat-images'
      AND name LIKE v_admin_id_text || '/%'
  LOOP
    DELETE FROM storage.objects
    WHERE bucket_id = v_file_record.bucket_id
      AND name = v_file_record.name;
    v_files_deleted := v_files_deleted + 1;
  END LOOP;
  RAISE NOTICE '[5c] Deleted % chat image files (admin prefix)', v_files_deleted;

  -- 5d. Chat images stored under customer ID prefixes
  v_files_deleted := 0;
  IF v_customer_ids IS NOT NULL AND array_length(v_customer_ids, 1) > 0 THEN
    FOR v_file_record IN
      SELECT name, bucket_id
      FROM storage.objects
      WHERE bucket_id = 'chat-images'
        AND (
          SELECT bool_or(name LIKE cid::text || '/%')
          FROM unnest(v_customer_ids) AS cid
        )
    LOOP
      DELETE FROM storage.objects
      WHERE bucket_id = v_file_record.bucket_id
        AND name = v_file_record.name;
      v_files_deleted := v_files_deleted + 1;
    END LOOP;
  END IF;
  RAISE NOTICE '[5d] Deleted % chat image files (customer prefix)', v_files_deleted;

  RAISE NOTICE '==========================================';
  RAISE NOTICE 'Admin cleanup complete. Total records: %, Files: %', v_total_deleted, v_files_deleted;
  RAISE NOTICE '==========================================';

  RETURN OLD;
END;
$function$;
