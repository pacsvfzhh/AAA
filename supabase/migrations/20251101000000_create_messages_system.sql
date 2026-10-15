/*
  # Create Messages System

  ## Overview
  Comprehensive messaging system allowing admins to send messages to employees with
  support for login popups and real-time notifications. Includes permission controls,
  read tracking, and efficient querying.

  ## New Tables

  ### 1. messages
  Core message storage with sender information and content
  - `id` (uuid, primary key) - Unique message identifier
  - `sender_id` (uuid) - Reference to admin who sent the message
  - `sender_username` (text) - Admin username (denormalized for performance)
  - `title` (text) - Message title (max 200 chars)
  - `content` (text) - Message content (max 5000 chars)
  - `message_type` (text) - 'login_popup' or 'realtime'
  - `priority` (text) - 'low', 'normal', 'high', or 'urgent'
  - `expires_at` (timestamptz, nullable) - Optional expiration time
  - `created_at` (timestamptz) - Creation timestamp

  ### 2. message_recipients
  Tracks message delivery and read status for each recipient
  - `id` (uuid, primary key) - Unique identifier
  - `message_id` (uuid) - Reference to message
  - `recipient_id` (uuid) - Reference to employee (user)
  - `is_read` (boolean) - Whether message has been read
  - `read_at` (timestamptz, nullable) - When message was read
  - `is_shown` (boolean) - Whether login popup was shown
  - `shown_at` (timestamptz, nullable) - When popup was shown
  - `created_at` (timestamptz) - Creation timestamp

  ## Security
  - Enable RLS on all tables
  - Admins can view own messages and create new ones
  - Employees can view messages sent to them
  - Employees can update their own read status
  - Prevent unauthorized access across admin boundaries

  ## Performance Optimizations
  - Indexes on foreign keys
  - Indexes for unread message queries
  - Indexes for login popup queries
  - Partial indexes for active messages only
*/

-- Create messages table
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Sender information
  sender_id uuid NOT NULL,
  sender_username text NOT NULL,

  -- Message content
  title text NOT NULL,
  content text NOT NULL,

  -- Message classification
  message_type text NOT NULL CHECK (message_type IN ('login_popup', 'realtime')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),

  -- Timestamps
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),

  -- Constraints
  CONSTRAINT messages_title_length CHECK (char_length(title) > 0 AND char_length(title) <= 200),
  CONSTRAINT messages_content_length CHECK (char_length(content) > 0 AND char_length(content) <= 5000)
);

-- Create message_recipients table
CREATE TABLE IF NOT EXISTS message_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL,

  -- Read tracking
  is_read boolean DEFAULT false,
  read_at timestamptz,

  -- Popup tracking (for login_popup type)
  is_shown boolean DEFAULT false,
  shown_at timestamptz,

  -- Timestamps
  created_at timestamptz DEFAULT now(),

  -- Constraints
  UNIQUE(message_id, recipient_id)
);

-- Performance indexes for messages
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(message_type);
CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at) WHERE expires_at IS NOT NULL;

-- Performance indexes for message_recipients
CREATE INDEX IF NOT EXISTS idx_message_recipients_message_id ON message_recipients(message_id);
CREATE INDEX IF NOT EXISTS idx_message_recipients_recipient_id ON message_recipients(recipient_id);
CREATE INDEX IF NOT EXISTS idx_message_recipients_created_at ON message_recipients(created_at DESC);

-- Partial indexes for common queries (unread messages)
CREATE INDEX IF NOT EXISTS idx_message_recipients_unread
  ON message_recipients(recipient_id, is_read, created_at DESC)
  WHERE is_read = false;

-- Partial indexes for login popups (unshown)
CREATE INDEX IF NOT EXISTS idx_message_recipients_unshown
  ON message_recipients(recipient_id, is_shown, created_at DESC)
  WHERE is_shown = false;

-- Composite index for message list with read status
CREATE INDEX IF NOT EXISTS idx_message_recipients_composite
  ON message_recipients(recipient_id, message_id, is_read, created_at DESC);

-- Enable Row Level Security
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_recipients ENABLE ROW LEVEL SECURITY;

-- RLS Policies for messages table

-- Admins can view messages they sent
CREATE POLICY "Admins can view own messages"
  ON messages FOR SELECT
  USING (
    sender_id::text IN (
      SELECT value::text
      FROM json_each_text(current_setting('request.jwt.claims', true)::json)
      WHERE key = 'sub'
    )
    OR sender_id::text = current_setting('app.current_admin_id', true)
  );

-- Admins can insert messages (sender_id must match their ID)
CREATE POLICY "Admins can create messages"
  ON messages FOR INSERT
  WITH CHECK (
    sender_id::text IN (
      SELECT value::text
      FROM json_each_text(current_setting('request.jwt.claims', true)::json)
      WHERE key = 'sub'
    )
    OR sender_id::text = current_setting('app.current_admin_id', true)
  );

-- RLS Policies for message_recipients table

-- Employees can view their own message receipts
CREATE POLICY "Employees can view own message receipts"
  ON message_recipients FOR SELECT
  USING (
    recipient_id::text IN (
      SELECT value::text
      FROM json_each_text(current_setting('request.jwt.claims', true)::json)
      WHERE key = 'sub'
    )
    OR recipient_id::text = current_setting('app.current_user_id', true)
  );

-- Employees can update their own read/shown status
CREATE POLICY "Employees can update own read status"
  ON message_recipients FOR UPDATE
  USING (
    recipient_id::text IN (
      SELECT value::text
      FROM json_each_text(current_setting('request.jwt.claims', true)::json)
      WHERE key = 'sub'
    )
    OR recipient_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    recipient_id::text IN (
      SELECT value::text
      FROM json_each_text(current_setting('request.jwt.claims', true)::json)
      WHERE key = 'sub'
    )
    OR recipient_id::text = current_setting('app.current_user_id', true)
  );

-- Admins can view message receipts for messages they sent
CREATE POLICY "Admins can view receipts for own messages"
  ON message_recipients FOR SELECT
  USING (
    message_id IN (
      SELECT id FROM messages
      WHERE sender_id::text IN (
        SELECT value::text
        FROM json_each_text(current_setting('request.jwt.claims', true)::json)
        WHERE key = 'sub'
      )
      OR sender_id::text = current_setting('app.current_admin_id', true)
    )
  );

-- Admins can create message recipients for their messages
CREATE POLICY "Admins can create message recipients"
  ON message_recipients FOR INSERT
  WITH CHECK (
    message_id IN (
      SELECT id FROM messages
      WHERE sender_id::text IN (
        SELECT value::text
        FROM json_each_text(current_setting('request.jwt.claims', true)::json)
        WHERE key = 'sub'
      )
      OR sender_id::text = current_setting('app.current_admin_id', true)
    )
  );

-- Enable realtime for message_recipients (for employees to receive notifications)
ALTER PUBLICATION supabase_realtime ADD TABLE message_recipients;

-- Function to automatically clean up expired messages
CREATE OR REPLACE FUNCTION cleanup_expired_messages()
RETURNS void AS $$
BEGIN
  DELETE FROM messages
  WHERE expires_at IS NOT NULL
    AND expires_at < now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get unread message count for a user
CREATE OR REPLACE FUNCTION get_unread_message_count(user_id_param uuid)
RETURNS integer AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::integer
    FROM message_recipients
    WHERE recipient_id = user_id_param
      AND is_read = false
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to mark message as read
CREATE OR REPLACE FUNCTION mark_message_as_read(
  message_id_param uuid,
  user_id_param uuid
)
RETURNS boolean AS $$
BEGIN
  UPDATE message_recipients
  SET
    is_read = true,
    read_at = now()
  WHERE message_id = message_id_param
    AND recipient_id = user_id_param
    AND is_read = false;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to mark login popup as shown
CREATE OR REPLACE FUNCTION mark_login_popup_as_shown(
  message_id_param uuid,
  user_id_param uuid
)
RETURNS boolean AS $$
BEGIN
  UPDATE message_recipients
  SET
    is_shown = true,
    shown_at = now()
  WHERE message_id = message_id_param
    AND recipient_id = user_id_param
    AND is_shown = false;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add comment for documentation
COMMENT ON TABLE messages IS 'Stores messages sent by admins to employees';
COMMENT ON TABLE message_recipients IS 'Tracks delivery and read status of messages for each recipient';
COMMENT ON FUNCTION cleanup_expired_messages() IS 'Deletes messages that have passed their expiration date';
COMMENT ON FUNCTION get_unread_message_count(uuid) IS 'Returns the count of unread messages for a specific user';
COMMENT ON FUNCTION mark_message_as_read(uuid, uuid) IS 'Marks a message as read for a specific user';
COMMENT ON FUNCTION mark_login_popup_as_shown(uuid, uuid) IS 'Marks a login popup message as shown for a specific user';
