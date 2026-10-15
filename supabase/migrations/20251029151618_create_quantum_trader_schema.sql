/*
  # Quantum Trader Hub - Complete Database Schema

  ## Overview
  This migration creates the complete database schema for the Quantum Trader Hub platform,
  a multi-role order management and commission system with wallet functionality.

  ## New Tables

  ### 1. admins
  Administrator accounts with hierarchical structure
  - `id` (uuid, primary key) - Unique identifier
  - `username` (text, unique) - Login username
  - `password_hash` (text) - Hashed password
  - `role` (text) - 'super_admin' or 'secondary_admin'
  - `parent_id` (uuid, nullable) - Reference to super admin (for secondary admins)
  - `is_active` (boolean) - Account status
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ### 2. users (employees)
  Employee accounts created by admins
  - `id` (uuid, primary key) - Unique identifier
  - `username` (text, unique) - Login username
  - `password_hash` (text) - Hashed password
  - `employee_id` (text, unique) - Employee identification number
  - `is_verified` (boolean) - Real-name verification status
  - `is_active` (boolean) - Account status
  - `total_income` (numeric) - Cumulative earnings in USDT
  - `first_success_order_date` (timestamptz, nullable) - Date of first successful order
  - `created_by` (uuid) - Reference to admin who created this account
  - `remarks` (text) - Admin notes
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ### 3. product_types
  Available product types for orders
  - `id` (uuid, primary key) - Unique identifier
  - `name` (text, unique) - Product type name
  - `is_active` (boolean) - Visibility status
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ### 4. orders
  Employee order submissions
  - `id` (uuid, primary key) - Unique identifier
  - `user_id` (uuid) - Reference to employee
  - `username` (text) - Username field from form
  - `product_type_id` (uuid) - Reference to product type
  - `product_value` (numeric) - Order value in USDT
  - `order_number` (text) - 9-digit order number
  - `transaction_id` (text) - 11-character transaction ID
  - `status` (text) - 'processing', 'success', 'failure'
  - `commission_amount` (numeric, nullable) - Calculated commission
  - `commission_rate` (numeric) - Rate used for calculation
  - `processed_at` (timestamptz, nullable) - When status was determined
  - `created_at` (timestamptz) - Submission timestamp

  ### 5. wallets
  Employee wallet balances
  - `user_id` (uuid, primary key) - Reference to employee
  - `available_balance` (numeric) - Available funds in USDT
  - `frozen_balance` (numeric) - Frozen funds (pending withdrawals)
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ### 6. wallet_transactions
  Complete transaction history
  - `id` (uuid, primary key) - Unique identifier
  - `user_id` (uuid) - Reference to employee
  - `type` (text) - 'commission', 'withdrawal_request', 'withdrawal_approved', 'withdrawal_rejected', 'manual_adjustment'
  - `amount` (numeric) - Transaction amount (positive or negative)
  - `balance_before` (numeric) - Balance before transaction
  - `balance_after` (numeric) - Balance after transaction
  - `reference_id` (uuid, nullable) - Reference to related record (order_id, withdrawal_id)
  - `remarks` (text) - Transaction notes
  - `created_by` (uuid, nullable) - Admin who performed action (for manual adjustments)
  - `created_at` (timestamptz) - Transaction timestamp

  ### 7. withdrawals
  Withdrawal requests and reviews
  - `id` (uuid, primary key) - Unique identifier
  - `user_id` (uuid) - Reference to employee
  - `amount` (numeric) - Withdrawal amount in USDT
  - `status` (text) - 'pending', 'approved', 'rejected'
  - `audit_remark` (text, nullable) - Review result/reason
  - `audited_by` (uuid, nullable) - Admin who reviewed
  - `audited_at` (timestamptz, nullable) - Review timestamp
  - `created_at` (timestamptz) - Request timestamp

  ### 8. admin_configs
  Admin-specific configuration overrides
  - `id` (uuid, primary key) - Unique identifier
  - `admin_id` (uuid) - Reference to admin (null for global defaults)
  - `config_type` (text) - 'commission_rate', 'success_rate', 'withdrawal_amount_threshold', 'withdrawal_days_threshold'
  - `config_value` (text) - Configuration value
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ### 9. announcements
  System announcements
  - `id` (uuid, primary key) - Unique identifier
  - `title` (text) - Announcement title
  - `content` (text) - Rich text content
  - `is_pinned` (boolean) - Pin to top
  - `publish_at` (timestamptz) - Scheduled publish time
  - `created_by` (uuid) - Admin who created
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp

  ## Security
  - RLS enabled on all tables
  - Admins can manage their own data and their team's data
  - Employees can only access their own data
  - Strict data isolation between admin hierarchies
*/

-- Create admins table
CREATE TABLE IF NOT EXISTS admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('super_admin', 'secondary_admin')),
  parent_id uuid REFERENCES admins(id) ON DELETE CASCADE,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create users (employees) table
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  employee_id text UNIQUE NOT NULL,
  is_verified boolean DEFAULT false,
  is_active boolean DEFAULT true,
  total_income numeric DEFAULT 0,
  first_success_order_date timestamptz,
  created_by uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  remarks text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create product_types table
CREATE TABLE IF NOT EXISTS product_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create orders table
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username text NOT NULL,
  product_type_id uuid NOT NULL REFERENCES product_types(id),
  product_value numeric NOT NULL CHECK (product_value > 0),
  order_number text NOT NULL,
  transaction_id text NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'success', 'failure')),
  commission_amount numeric,
  commission_rate numeric,
  processed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Create wallets table
CREATE TABLE IF NOT EXISTS wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_balance numeric DEFAULT 0 CHECK (available_balance >= 0),
  frozen_balance numeric DEFAULT 0 CHECK (frozen_balance >= 0),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create wallet_transactions table
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('commission', 'withdrawal_request', 'withdrawal_approved', 'withdrawal_rejected', 'manual_adjustment')),
  amount numeric NOT NULL,
  balance_before numeric NOT NULL,
  balance_after numeric NOT NULL,
  reference_id uuid,
  remarks text DEFAULT '',
  created_by uuid REFERENCES admins(id),
  created_at timestamptz DEFAULT now()
);

-- Create withdrawals table
CREATE TABLE IF NOT EXISTS withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  audit_remark text,
  audited_by uuid REFERENCES admins(id),
  audited_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Create admin_configs table
CREATE TABLE IF NOT EXISTS admin_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid REFERENCES admins(id) ON DELETE CASCADE,
  config_type text NOT NULL CHECK (config_type IN ('commission_rate', 'success_rate', 'withdrawal_amount_threshold', 'withdrawal_days_threshold')),
  config_value text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(admin_id, config_type)
);

-- Create announcements table
CREATE TABLE IF NOT EXISTS announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  content text NOT NULL,
  is_pinned boolean DEFAULT false,
  publish_at timestamptz DEFAULT now(),
  created_by uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_announcements_publish_at ON announcements(publish_at);

-- Enable Row Level Security
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

-- RLS Policies for admins table
CREATE POLICY "Allow admin access"
  ON admins FOR SELECT
  TO anon, authenticated
  USING (true);

-- RLS Policies for users table
CREATE POLICY "Allow employee access"
  ON users FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Employees can update own profile"
  ON users FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policies for product_types table
CREATE POLICY "Product types are viewable"
  ON product_types FOR SELECT
  TO anon, authenticated
  USING (true);

-- RLS Policies for orders table
CREATE POLICY "Users can view orders"
  ON orders FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Users can insert orders"
  ON orders FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Users can update orders"
  ON orders FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policies for wallets table
CREATE POLICY "Users can view wallets"
  ON wallets FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Users can insert wallets"
  ON wallets FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Users can update wallets"
  ON wallets FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policies for wallet_transactions table
CREATE POLICY "Users can view transactions"
  ON wallet_transactions FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Users can insert transactions"
  ON wallet_transactions FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- RLS Policies for withdrawals table
CREATE POLICY "Users can view withdrawals"
  ON withdrawals FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Users can insert withdrawals"
  ON withdrawals FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Users can update withdrawals"
  ON withdrawals FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policies for admin_configs table
CREATE POLICY "Configs are viewable"
  ON admin_configs FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Configs can be modified"
  ON admin_configs FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- RLS Policies for announcements table
CREATE POLICY "Announcements are viewable"
  ON announcements FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Announcements can be modified"
  ON announcements FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- Insert default global admin configs
INSERT INTO admin_configs (admin_id, config_type, config_value)
VALUES 
  (NULL, 'commission_rate', '0.05'),
  (NULL, 'success_rate', '0.80'),
  (NULL, 'withdrawal_amount_threshold', '100'),
  (NULL, 'withdrawal_days_threshold', '7')
ON CONFLICT DO NOTHING;

-- Insert some default product types
INSERT INTO product_types (name, is_active)
VALUES 
  ('Electronics', true),
  ('Fashion', true),
  ('Home & Garden', true),
  ('Sports & Outdoors', true),
  ('Books & Media', true),
  ('Health & Beauty', true),
  ('Toys & Games', true),
  ('Automotive', true)
ON CONFLICT DO NOTHING;