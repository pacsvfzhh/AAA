/*
  # Messages Auto-Cleanup and Management

  1. Changes
    - Add automatic cleanup policy for messages older than 30 days
    - Create index for efficient cleanup queries
    - Add function to manually delete messages
    - Add function to bulk delete messages

  2. Security
    - Super admin can delete any messages
    - Regular admins can only delete their own messages
*/

-- Create index for efficient date-based queries
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- Function to automatically delete messages older than 30 days
CREATE OR REPLACE FUNCTION cleanup_old_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Delete message_recipients for old messages first (foreign key constraint)
  DELETE FROM message_recipients
  WHERE message_id IN (
    SELECT id FROM messages
    WHERE created_at < NOW() - INTERVAL '30 days'
  );

  -- Delete old messages
  DELETE FROM messages
  WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$;

-- Function to manually delete specific messages (with permission check)
CREATE OR REPLACE FUNCTION delete_messages(message_ids uuid[], requesting_admin_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  is_super_admin boolean;
  deleted_count integer := 0;
  failed_count integer := 0;
BEGIN
  -- Check if requesting admin is super admin
  SELECT is_super_admin INTO is_super_admin
  FROM admins
  WHERE id = requesting_admin_id;

  -- Delete message_recipients first
  IF is_super_admin THEN
    -- Super admin can delete any messages
    DELETE FROM message_recipients
    WHERE message_id = ANY(message_ids);

    DELETE FROM messages
    WHERE id = ANY(message_ids);

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
  ELSE
    -- Regular admin can only delete their own messages
    DELETE FROM message_recipients
    WHERE message_id IN (
      SELECT id FROM messages
      WHERE id = ANY(message_ids)
      AND sender_admin_id = requesting_admin_id
    );

    DELETE FROM messages
    WHERE id = ANY(message_ids)
    AND sender_admin_id = requesting_admin_id;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    failed_count := array_length(message_ids, 1) - deleted_count;
  END IF;

  RETURN json_build_object(
    'success', true,
    'deleted_count', deleted_count,
    'failed_count', failed_count
  );
END;
$$;

-- Function to delete all messages for an admin (with permission check)
CREATE OR REPLACE FUNCTION delete_all_messages_for_admin(requesting_admin_id uuid, target_admin_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  is_super_admin boolean;
  deleted_count integer := 0;
  message_ids_to_delete uuid[];
BEGIN
  -- Check if requesting admin is super admin
  SELECT is_super_admin INTO is_super_admin
  FROM admins
  WHERE id = requesting_admin_id;

  IF is_super_admin THEN
    -- Super admin can delete messages for any admin
    SELECT array_agg(id) INTO message_ids_to_delete
    FROM messages
    WHERE sender_admin_id = target_admin_id;
  ELSE
    -- Regular admin can only delete their own messages
    IF requesting_admin_id != target_admin_id THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Permission denied',
        'deleted_count', 0
      );
    END IF;

    SELECT array_agg(id) INTO message_ids_to_delete
    FROM messages
    WHERE sender_admin_id = requesting_admin_id;
  END IF;

  -- Delete message_recipients first
  IF message_ids_to_delete IS NOT NULL THEN
    DELETE FROM message_recipients
    WHERE message_id = ANY(message_ids_to_delete);

    -- Delete messages
    DELETE FROM messages
    WHERE id = ANY(message_ids_to_delete);

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
  END IF;

  RETURN json_build_object(
    'success', true,
    'deleted_count', deleted_count
  );
END;
$$;