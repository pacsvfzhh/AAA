/*
# Create Admin Deletion Cleanup Trigger

## Problem
When a secondary admin is deleted, most data cascades correctly via foreign keys,
but several tables and storage resources are missed:

1. `cs_message_templates` - uses TEXT admin_id with no FK, rows become orphans
2. `rich_card_contents` - references templates/auto-messages via nullable FKs,
   rows survive after source records cascade-delete
3. `history_cleanup_log` - uuid admin_id with no FK, rows become orphans
4. Storage buckets (announcement-images, template-images, chat-images) -
   files remain after DB rows cascade-delete

## Changes
- Create `cleanup_admin_data()` BEFORE DELETE trigger function on `admins`
- Deletes `cs_message_templates` where admin_id matches (text)
- Deletes `rich_card_contents` that referenced the admin's templates or auto-messages
- Deletes `history_cleanup_log` where admin_id matches
- Cleans up storage files in announcement-images, template-images, and chat-images
  buckets that belonged to the admin's announcements and customers

## Security
- Function is SECURITY DEFINER to access storage.objects and bypass RLS
- search_path locked to 'public', 'pg_temp'
- Only fires on admin deletion (BEFORE DELETE trigger)

## Notes
- Runs BEFORE cascade so it can still look up the admin's customers/announcements
- The existing CASCADE rules handle everything else (employees, customers,
  configs, announcements, etc.)
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

  -- ========================================================================
  -- 1. Collect IDs we need BEFORE cascade deletes them
  -- ========================================================================

  SELECT array_agg(id) INTO v_customer_ids
  FROM simulated_customers WHERE admin_id = v_admin_id;

  SELECT array_agg(id) INTO v_announcement_ids
  FROM announcements WHERE created_by = v_admin_id;

  -- Collect template IDs (text admin_id)
  SELECT array_agg(id) INTO v_template_ids
  FROM cs_message_templates WHERE admin_id = v_admin_id_text;

  -- Collect auto-message IDs via the admin's customers
  IF v_customer_ids IS NOT NULL AND array_length(v_customer_ids, 1) > 0 THEN
    SELECT array_agg(id) INTO v_auto_message_ids
    FROM customer_auto_messages WHERE customer_id = ANY(v_customer_ids);
  END IF;

  -- ========================================================================
  -- 2. Delete rich_card_contents that reference admin's templates/auto-messages
  -- ========================================================================

  IF v_template_ids IS NOT NULL AND array_length(v_template_ids, 1) > 0 THEN
    DELETE FROM rich_card_contents WHERE source_template_id = ANY(v_template_ids);
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    v_total_deleted := v_total_deleted + v_deleted_count;
    RAISE NOTICE '[1] Deleted % rich card contents (from templates)', v_deleted_count;
  END IF;

  IF v_auto_message_ids IS NOT NULL AND array_length(v_auto_message_ids, 1) > 0 THEN
    DELETE FROM rich_card_contents WHERE source_auto_message_id = ANY(v_auto_message_ids);
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    v_total_deleted := v_total_deleted + v_deleted_count;
    RAISE NOTICE '[2] Deleted % rich card contents (from auto-messages)', v_deleted_count;
  END IF;

  -- ========================================================================
  -- 3. Delete cs_message_templates (TEXT admin_id, no FK)
  -- ========================================================================

  DELETE FROM cs_message_templates WHERE admin_id = v_admin_id_text;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[3] Deleted % message templates', v_deleted_count;

  -- ========================================================================
  -- 4. Delete history_cleanup_log (uuid admin_id, no FK)
  -- ========================================================================

  DELETE FROM history_cleanup_log WHERE admin_id = v_admin_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[4] Deleted % history cleanup log entries', v_deleted_count;

  -- ========================================================================
  -- 5. Clean up storage files
  -- ========================================================================

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

  -- 5c. Chat images for admin's customers
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
  RAISE NOTICE '[5c] Deleted % chat image files', v_files_deleted;

  RAISE NOTICE '==========================================';
  RAISE NOTICE 'Admin cleanup complete. Total records: %, Files: %', v_total_deleted, v_files_deleted;
  RAISE NOTICE '==========================================';

  RETURN OLD;
END;
$function$;

-- Create the trigger (BEFORE DELETE so we can look up related data before cascades run)
DROP TRIGGER IF EXISTS cleanup_admin_data_trigger ON admins;
CREATE TRIGGER cleanup_admin_data_trigger
  BEFORE DELETE ON admins
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_admin_data();
