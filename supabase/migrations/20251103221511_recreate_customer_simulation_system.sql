/*
  # Recreate Customer Simulation System (Fixed)

  1. Changes
    - Drop old customer service tables
    - Create new customer simulation tables with correct logic
  
  2. New Tables
    - `simulated_customers` - Customer identities created by admins
      - `id` (uuid, primary key)
      - `admin_id` (uuid, references admins) - Admin who created this customer
      - `customer_name` (text) - Display name for the customer
      - `customer_avatar` (text) - Avatar emoji for the customer
      - `is_active` (boolean)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    
    - `customer_employee_conversations` - Messages between customers and employees
      - `id` (uuid, primary key)
      - `customer_id` (uuid, references simulated_customers)
      - `employee_id` (uuid, references users)
      - `sender_type` (text) - 'customer' or 'employee'
      - `message_content` (text)
      - `is_read` (boolean) - Whether message has been read
      - `created_at` (timestamptz)

  3. Logic
    - Admin creates customer identities
    - Admin (as customer) initiates conversation by sending first message
    - Employee only sees conversation after receiving first message
    - Employee can reply to customer messages
    - Admin sees employee replies in real-time
*/

-- Drop old tables if they exist
DROP TABLE IF EXISTS customer_service_messages CASCADE;
DROP TABLE IF EXISTS customer_service_agents CASCADE;
DROP FUNCTION IF EXISTS get_employee_unread_messages_count(uuid);

-- Create simulated_customers table
CREATE TABLE IF NOT EXISTS simulated_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  customer_avatar text DEFAULT '👤',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create customer_employee_conversations table
CREATE TABLE IF NOT EXISTS customer_employee_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES simulated_customers(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('customer', 'employee')),
  message_content text NOT NULL,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE simulated_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_employee_conversations ENABLE ROW LEVEL SECURITY;

-- RLS Policies (open for custom auth)
CREATE POLICY "Anyone can view customers"
  ON simulated_customers FOR SELECT
  USING (true);

CREATE POLICY "Anyone can create customers"
  ON simulated_customers FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update customers"
  ON simulated_customers FOR UPDATE
  USING (true);

CREATE POLICY "Anyone can delete customers"
  ON simulated_customers FOR DELETE
  USING (true);

CREATE POLICY "Anyone can view conversations"
  ON customer_employee_conversations FOR SELECT
  USING (true);

CREATE POLICY "Anyone can send messages"
  ON customer_employee_conversations FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update messages"
  ON customer_employee_conversations FOR UPDATE
  USING (true);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_simulated_customers_admin_id ON simulated_customers(admin_id);
CREATE INDEX IF NOT EXISTS idx_simulated_customers_is_active ON simulated_customers(is_active);
CREATE INDEX IF NOT EXISTS idx_conversations_customer_id ON customer_employee_conversations(customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_employee_id ON customer_employee_conversations(employee_id);
CREATE INDEX IF NOT EXISTS idx_conversations_is_read ON customer_employee_conversations(is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON customer_employee_conversations(created_at DESC);

-- Create function to get unread customer messages count for employee
CREATE OR REPLACE FUNCTION get_employee_unread_customer_messages_count(p_employee_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::integer
    FROM customer_employee_conversations
    WHERE employee_id = p_employee_id
      AND sender_type = 'customer'
      AND is_read = false
  );
END;
$$;

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE simulated_customers;
ALTER PUBLICATION supabase_realtime ADD TABLE customer_employee_conversations;
