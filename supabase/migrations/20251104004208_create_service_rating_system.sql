/*
  # Create Service Rating System

  1. New Tables
    - service_ratings: Store customer service ratings
      - id (uuid, primary key)
      - customer_id (uuid, references simulated_customers)
      - employee_id (uuid, references users)
      - session_id (uuid, references customer_service_sessions, nullable)
      - rating (integer) - 1-5 stars
      - comment (text, nullable) - Optional feedback
      - created_at (timestamptz)

    - rating_requests: Track rating requests sent by employees
      - id (uuid, primary key)
      - customer_id (uuid, references simulated_customers)
      - employee_id (uuid, references users)
      - session_id (uuid, references customer_service_sessions, nullable)
      - status (text) - 'pending', 'completed', 'expired'
      - requested_at (timestamptz)
      - completed_at (timestamptz, nullable)

  2. Security
    - Enable RLS on both tables
    - Add policies for viewing and managing ratings

  3. Functions
    - Auto-expire old rating requests after 24 hours
*/

-- Create service_ratings table
CREATE TABLE IF NOT EXISTS service_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES simulated_customers(id) ON DELETE CASCADE NOT NULL,
  employee_id uuid REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  session_id uuid REFERENCES customer_service_sessions(id) ON DELETE SET NULL,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment text,
  created_at timestamptz DEFAULT now()
);

-- Create rating_requests table
CREATE TABLE IF NOT EXISTS rating_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES simulated_customers(id) ON DELETE CASCADE NOT NULL,
  employee_id uuid REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  session_id uuid REFERENCES customer_service_sessions(id) ON DELETE SET NULL,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired')),
  requested_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- Enable RLS
ALTER TABLE service_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rating_requests ENABLE ROW LEVEL SECURITY;

-- RLS Policies for service_ratings
CREATE POLICY "Anyone can view service ratings"
  ON service_ratings FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Anyone can insert service ratings"
  ON service_ratings FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Anyone can update service ratings"
  ON service_ratings FOR UPDATE
  TO public
  USING (true);

CREATE POLICY "Anyone can delete service ratings"
  ON service_ratings FOR DELETE
  TO public
  USING (true);

-- RLS Policies for rating_requests
CREATE POLICY "Anyone can view rating requests"
  ON rating_requests FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Anyone can insert rating requests"
  ON rating_requests FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Anyone can update rating requests"
  ON rating_requests FOR UPDATE
  TO public
  USING (true);

CREATE POLICY "Anyone can delete rating requests"
  ON rating_requests FOR DELETE
  TO public
  USING (true);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_service_ratings_customer_id ON service_ratings(customer_id);
CREATE INDEX IF NOT EXISTS idx_service_ratings_employee_id ON service_ratings(employee_id);
CREATE INDEX IF NOT EXISTS idx_service_ratings_session_id ON service_ratings(session_id);
CREATE INDEX IF NOT EXISTS idx_rating_requests_customer_id ON rating_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_rating_requests_employee_id ON rating_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_rating_requests_status ON rating_requests(status);

-- Function to auto-expire old rating requests
CREATE OR REPLACE FUNCTION expire_old_rating_requests()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE rating_requests
  SET status = 'expired'
  WHERE status = 'pending'
    AND requested_at < now() - INTERVAL '24 hours';
END;
$$;

-- Enable realtime for rating tables
ALTER PUBLICATION supabase_realtime ADD TABLE service_ratings;
ALTER PUBLICATION supabase_realtime ADD TABLE rating_requests;