/*
  # Add Customer ID and Service Session System

  1. Changes to simulated_customers
    - Add customer_id field to display unique customer identifier
    - Auto-generate customer_id on insert

  2. New Tables
    - customer_service_sessions: Track unique service sessions between customers and employees
      - id (uuid, primary key)
      - customer_id (uuid, references simulated_customers)
      - employee_id (uuid, references users)
      - service_ticket_number (text, unique) - Auto-generated business receipt number
      - status (text) - 'active' or 'closed'
      - created_at (timestamptz)
      - closed_at (timestamptz, nullable)

  3. Security
    - Enable RLS on customer_service_sessions
    - Add policies for viewing and managing sessions

  4. Functions
    - Auto-generate service ticket numbers in format: SRV-YYYYMMDD-XXXXXX
*/

-- Add customer_id to simulated_customers if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'simulated_customers' AND column_name = 'customer_id'
  ) THEN
    ALTER TABLE simulated_customers ADD COLUMN customer_id text;
    
    -- Generate customer_id for existing customers
    UPDATE simulated_customers
    SET customer_id = 'CUS-' || LPAD(FLOOR(RANDOM() * 999999)::text, 6, '0')
    WHERE customer_id IS NULL;
    
    -- Make customer_id NOT NULL after setting values
    ALTER TABLE simulated_customers ALTER COLUMN customer_id SET NOT NULL;
    
    -- Add unique constraint
    ALTER TABLE simulated_customers ADD CONSTRAINT simulated_customers_customer_id_unique UNIQUE (customer_id);
  END IF;
END $$;

-- Create function to generate customer_id
CREATE OR REPLACE FUNCTION generate_customer_id()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  new_id text;
  id_exists boolean;
BEGIN
  LOOP
    -- Generate format: CUS-XXXXXX (6 random digits)
    new_id := 'CUS-' || LPAD(FLOOR(RANDOM() * 999999)::text, 6, '0');
    
    -- Check if this ID already exists
    SELECT EXISTS(SELECT 1 FROM simulated_customers WHERE customer_id = new_id) INTO id_exists;
    
    -- Exit loop if ID is unique
    EXIT WHEN NOT id_exists;
  END LOOP;
  
  RETURN new_id;
END;
$$;

-- Create trigger to auto-generate customer_id on insert
CREATE OR REPLACE FUNCTION set_customer_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_id IS NULL THEN
    NEW.customer_id := generate_customer_id();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_customer_id_trigger ON simulated_customers;
CREATE TRIGGER set_customer_id_trigger
  BEFORE INSERT ON simulated_customers
  FOR EACH ROW
  EXECUTE FUNCTION set_customer_id();

-- Create customer_service_sessions table
CREATE TABLE IF NOT EXISTS customer_service_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES simulated_customers(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_ticket_number text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at timestamptz DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (customer_id, employee_id, status)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_service_sessions_customer_employee 
  ON customer_service_sessions(customer_id, employee_id, status);

CREATE INDEX IF NOT EXISTS idx_service_sessions_ticket_number 
  ON customer_service_sessions(service_ticket_number);

-- Function to generate service ticket number
CREATE OR REPLACE FUNCTION generate_service_ticket_number()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  new_ticket text;
  ticket_exists boolean;
  date_part text;
BEGIN
  date_part := TO_CHAR(NOW(), 'YYYYMMDD');
  
  LOOP
    -- Generate format: SRV-YYYYMMDD-XXXXXX (6 random digits)
    new_ticket := 'SRV-' || date_part || '-' || LPAD(FLOOR(RANDOM() * 999999)::text, 6, '0');
    
    -- Check if this ticket number already exists
    SELECT EXISTS(SELECT 1 FROM customer_service_sessions WHERE service_ticket_number = new_ticket) INTO ticket_exists;
    
    -- Exit loop if ticket number is unique
    EXIT WHEN NOT ticket_exists;
  END LOOP;
  
  RETURN new_ticket;
END;
$$;

-- Trigger to auto-generate service ticket number
CREATE OR REPLACE FUNCTION set_service_ticket_number()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.service_ticket_number IS NULL THEN
    NEW.service_ticket_number := generate_service_ticket_number();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_service_ticket_number_trigger ON customer_service_sessions;
CREATE TRIGGER set_service_ticket_number_trigger
  BEFORE INSERT ON customer_service_sessions
  FOR EACH ROW
  EXECUTE FUNCTION set_service_ticket_number();

-- Enable RLS
ALTER TABLE customer_service_sessions ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Anyone can view service sessions"
  ON customer_service_sessions FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Anyone can create service sessions"
  ON customer_service_sessions FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Anyone can update service sessions"
  ON customer_service_sessions FOR UPDATE
  TO public
  USING (true);

CREATE POLICY "Anyone can delete service sessions"
  ON customer_service_sessions FOR DELETE
  TO public
  USING (true);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE customer_service_sessions;

-- Function to get or create active session
CREATE OR REPLACE FUNCTION get_or_create_service_session(
  p_customer_id uuid,
  p_employee_id uuid
)
RETURNS TABLE (
  session_id uuid,
  service_ticket_number text,
  created_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_session_id uuid;
  v_ticket_number text;
  v_created_at timestamptz;
BEGIN
  -- Try to find an active session
  SELECT id, customer_service_sessions.service_ticket_number, customer_service_sessions.created_at
  INTO v_session_id, v_ticket_number, v_created_at
  FROM customer_service_sessions
  WHERE customer_service_sessions.customer_id = p_customer_id
    AND customer_service_sessions.employee_id = p_employee_id
    AND status = 'active'
  LIMIT 1;
  
  -- If no active session exists, create one
  IF v_session_id IS NULL THEN
    INSERT INTO customer_service_sessions (customer_id, employee_id, service_ticket_number, status)
    VALUES (p_customer_id, p_employee_id, generate_service_ticket_number(), 'active')
    RETURNING id, customer_service_sessions.service_ticket_number, customer_service_sessions.created_at
    INTO v_session_id, v_ticket_number, v_created_at;
  END IF;
  
  RETURN QUERY SELECT v_session_id, v_ticket_number, v_created_at;
END;
$$;