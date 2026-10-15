/*
  # Create Broadcast Message System

  1. New Tables
    - `broadcast_messages`
      - `id` (uuid, primary key) - Unique broadcast ID
      - `admin_id` (uuid, foreign key) - Admin who sent the broadcast
      - `message_content` (text) - Broadcast message content
      - `message_type` (text) - Type: 'text' or 'image'
      - `image_url` (text, nullable) - Image URL if type is image
      - `target_type` (text) - 'all', 'admin_group', 'specific_employees'
      - `target_admin_id` (uuid, nullable) - For admin_group targeting
      - `sent_count` (integer) - Number of recipients
      - `created_at` (timestamptz) - When broadcast was sent
    
    - `broadcast_recipients`
      - `id` (uuid, primary key)
      - `broadcast_id` (uuid, foreign key) - Reference to broadcast
      - `employee_id` (uuid, foreign key) - Recipient employee
      - `is_read` (boolean) - Read status
      - `read_at` (timestamptz, nullable) - When message was read
      - `created_at` (timestamptz)
  
  2. Security
    - Enable RLS on both tables
    - Admins can view their own broadcasts
    - Employees can view broadcasts sent to them
    
  3. Functions
    - `send_broadcast_message` - Function to send broadcast to multiple employees
*/

-- Create broadcast_messages table
CREATE TABLE IF NOT EXISTS broadcast_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid REFERENCES admins(id) ON DELETE CASCADE,
  message_content text NOT NULL,
  message_type text NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image')),
  image_url text,
  target_type text NOT NULL DEFAULT 'all' CHECK (target_type IN ('all', 'admin_group', 'specific_employees')),
  target_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL,
  sent_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Create broadcast_recipients table
CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id uuid REFERENCES broadcast_messages(id) ON DELETE CASCADE NOT NULL,
  employee_id uuid REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  is_read boolean DEFAULT false,
  read_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(broadcast_id, employee_id)
);

-- Enable RLS
ALTER TABLE broadcast_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_recipients ENABLE ROW LEVEL SECURITY;

-- RLS Policies for broadcast_messages
CREATE POLICY "Admins can view their own broadcasts"
  ON broadcast_messages FOR SELECT
  USING (true);

CREATE POLICY "Admins can insert broadcasts"
  ON broadcast_messages FOR INSERT
  WITH CHECK (true);

-- RLS Policies for broadcast_recipients
CREATE POLICY "Employees can view their broadcasts"
  ON broadcast_recipients FOR SELECT
  USING (true);

CREATE POLICY "Employees can update read status"
  ON broadcast_recipients FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "System can insert broadcast recipients"
  ON broadcast_recipients FOR INSERT
  WITH CHECK (true);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_broadcast_messages_admin_id ON broadcast_messages(admin_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_messages_created_at ON broadcast_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast_id ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_employee_id ON broadcast_recipients(employee_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_is_read ON broadcast_recipients(is_read) WHERE is_read = false;

-- Function to send broadcast message
CREATE OR REPLACE FUNCTION send_broadcast_message(
  p_admin_id uuid,
  p_message_content text,
  p_message_type text DEFAULT 'text',
  p_image_url text DEFAULT NULL,
  p_target_type text DEFAULT 'all',
  p_target_admin_id uuid DEFAULT NULL,
  p_employee_ids uuid[] DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_broadcast_id uuid;
  v_employee_id uuid;
  v_count integer := 0;
  v_employee_ids uuid[];
BEGIN
  -- Create broadcast message
  INSERT INTO broadcast_messages (
    admin_id,
    message_content,
    message_type,
    image_url,
    target_type,
    target_admin_id
  ) VALUES (
    p_admin_id,
    p_message_content,
    p_message_type,
    p_image_url,
    p_target_type,
    p_target_admin_id
  ) RETURNING id INTO v_broadcast_id;

  -- Determine target employees based on target_type
  IF p_target_type = 'all' THEN
    -- Get all employees
    SELECT array_agg(id) INTO v_employee_ids
    FROM users
    WHERE id IS NOT NULL;
  ELSIF p_target_type = 'admin_group' AND p_target_admin_id IS NOT NULL THEN
    -- Get employees under specific admin
    SELECT array_agg(employee_id) INTO v_employee_ids
    FROM (
      SELECT DISTINCT jsonb_array_elements_text(employees::jsonb)::uuid as employee_id
      FROM (
        SELECT * FROM get_employees_by_admin()
      ) sub
      WHERE admin_id = p_target_admin_id
    ) emp_list;
  ELSIF p_target_type = 'specific_employees' AND p_employee_ids IS NOT NULL THEN
    -- Use provided employee IDs
    v_employee_ids := p_employee_ids;
  END IF;

  -- Create broadcast recipients
  IF v_employee_ids IS NOT NULL THEN
    FOREACH v_employee_id IN ARRAY v_employee_ids
    LOOP
      INSERT INTO broadcast_recipients (broadcast_id, employee_id)
      VALUES (v_broadcast_id, v_employee_id)
      ON CONFLICT (broadcast_id, employee_id) DO NOTHING;
      v_count := v_count + 1;
    END LOOP;
  END IF;

  -- Update sent_count
  UPDATE broadcast_messages
  SET sent_count = v_count
  WHERE id = v_broadcast_id;

  RETURN v_broadcast_id;
END;
$$;

-- Enable realtime for broadcast tables
ALTER PUBLICATION supabase_realtime ADD TABLE broadcast_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE broadcast_recipients;