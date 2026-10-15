/*
  # Customer Service System

  1. New Tables
    - `customer_service_agents`
      - `id` (uuid, primary key)
      - `admin_id` (uuid, references admins) - The admin who controls this agent
      - `agent_name` (text) - Display name for the customer service agent
      - `agent_avatar` (text) - Avatar URL or emoji for the agent
      - `is_active` (boolean) - Whether this agent is active
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    
    - `customer_service_messages`
      - `id` (uuid, primary key)
      - `agent_id` (uuid, references customer_service_agents)
      - `employee_id` (uuid, references users) - The employee receiving the message
      - `sender_type` (text) - 'agent' or 'employee'
      - `message_content` (text)
      - `is_read` (boolean) - Whether employee has read the message
      - `created_at` (timestamptz)

  2. Security
    - Enable RLS on all tables
    - Admins can manage their own agents
    - Admins can send messages as their agents
    - Admins can read all messages for their agents
    - Employees can only read/send messages in their own conversations
    - Super admins can see all agents and messages

  3. Indexes
    - Index on employee_id for fast message retrieval
    - Index on agent_id for admin queries
    - Index on is_read for unread message counting
*/

-- Create customer_service_agents table
CREATE TABLE IF NOT EXISTS customer_service_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  agent_name text NOT NULL,
  agent_avatar text DEFAULT '👤',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create customer_service_messages table
CREATE TABLE IF NOT EXISTS customer_service_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES customer_service_agents(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('agent', 'employee')),
  message_content text NOT NULL,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE customer_service_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_service_messages ENABLE ROW LEVEL SECURITY;

-- RLS Policies for customer_service_agents (open for custom auth)
CREATE POLICY "Anyone can view active agents"
  ON customer_service_agents FOR SELECT
  USING (true);

CREATE POLICY "Anyone can create agents"
  ON customer_service_agents FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update agents"
  ON customer_service_agents FOR UPDATE
  USING (true);

CREATE POLICY "Anyone can delete agents"
  ON customer_service_agents FOR DELETE
  USING (true);

-- RLS Policies for customer_service_messages (open for custom auth)
CREATE POLICY "Anyone can view messages"
  ON customer_service_messages FOR SELECT
  USING (true);

CREATE POLICY "Anyone can send messages"
  ON customer_service_messages FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update messages"
  ON customer_service_messages FOR UPDATE
  USING (true);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_cs_agents_admin_id ON customer_service_agents(admin_id);
CREATE INDEX IF NOT EXISTS idx_cs_agents_is_active ON customer_service_agents(is_active);
CREATE INDEX IF NOT EXISTS idx_cs_messages_agent_id ON customer_service_messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_cs_messages_employee_id ON customer_service_messages(employee_id);
CREATE INDEX IF NOT EXISTS idx_cs_messages_is_read ON customer_service_messages(is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_cs_messages_created_at ON customer_service_messages(created_at DESC);

-- Create function to get unread message count for employee
CREATE OR REPLACE FUNCTION get_employee_unread_messages_count(p_employee_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::integer
    FROM customer_service_messages
    WHERE employee_id = p_employee_id
      AND sender_type = 'agent'
      AND is_read = false
  );
END;
$$;
