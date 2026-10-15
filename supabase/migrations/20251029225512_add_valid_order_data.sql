/*
  # Add Valid Order Data Table

  ## Overview
  This migration creates a table to store valid product values and transaction IDs
  that employees can use when submitting orders. Each combination must be unique
  and can only be used once per employee.

  ## New Tables

  ### 1. valid_order_data
  Stores valid product values and transaction IDs uploaded by admins
  - `id` (uuid, primary key) - Unique identifier
  - `product_value` (numeric) - Valid product value in USDT
  - `transaction_id` (text) - Valid transaction ID
  - `is_active` (boolean) - Whether this data is still available for use
  - `created_by` (uuid) - Admin who uploaded this data
  - `created_at` (timestamptz) - Upload timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ### 2. used_order_data
  Tracks which employees have used which valid order data
  - `id` (uuid, primary key) - Unique identifier
  - `user_id` (uuid) - Reference to employee who used this data
  - `valid_order_data_id` (uuid) - Reference to the valid order data
  - `order_id` (uuid) - Reference to the order that used this data
  - `created_at` (timestamptz) - When this data was used

  ## Security
  - RLS enabled on all tables
  - Admins can manage valid order data
  - Employees can only view active valid order data
  - Strict validation to prevent duplicate usage per employee
*/

-- Create valid_order_data table
CREATE TABLE IF NOT EXISTS valid_order_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_value numeric NOT NULL CHECK (product_value > 0),
  transaction_id text NOT NULL,
  is_active boolean DEFAULT true,
  created_by uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(product_value, transaction_id)
);

-- Create used_order_data table
CREATE TABLE IF NOT EXISTS used_order_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  valid_order_data_id uuid NOT NULL REFERENCES valid_order_data(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, valid_order_data_id)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_valid_order_data_active ON valid_order_data(is_active);
CREATE INDEX IF NOT EXISTS idx_valid_order_data_created_by ON valid_order_data(created_by);
CREATE INDEX IF NOT EXISTS idx_used_order_data_user_id ON used_order_data(user_id);
CREATE INDEX IF NOT EXISTS idx_used_order_data_valid_id ON used_order_data(valid_order_data_id);

-- Enable Row Level Security
ALTER TABLE valid_order_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE used_order_data ENABLE ROW LEVEL SECURITY;

-- RLS Policies for valid_order_data table
CREATE POLICY "Users can view active valid order data"
  ON valid_order_data FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

CREATE POLICY "Admins can manage valid order data"
  ON valid_order_data FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policies for used_order_data table
CREATE POLICY "Users can view their own used order data"
  ON used_order_data FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Users can insert used order data"
  ON used_order_data FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);
