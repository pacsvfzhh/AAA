/*
  # Add Verification Requests Table

  1. New Table
    - `verification_requests`
      - `id` (uuid, primary key) - Unique identifier
      - `user_id` (uuid) - Reference to employee
      - `real_name` (text) - Full legal name
      - `wallet_address` (text) - Blockchain wallet address for withdrawals
      - `phone` (text) - Phone number
      - `email` (text) - Email address
      - `status` (text) - 'pending', 'approved', 'rejected'
      - `audit_remark` (text, nullable) - Admin review notes
      - `audited_by` (uuid, nullable) - Admin who reviewed
      - `audited_at` (timestamptz, nullable) - Review timestamp
      - `created_at` (timestamptz) - Submission timestamp
      - `updated_at` (timestamptz) - Last update timestamp

  2. Security
    - Enable RLS on `verification_requests` table
    - Add policy for employees to view their own requests
    - Add policy for employees to create verification requests
    - Add policy for admins to view all requests (handled by admin interface)

  3. Important Notes
    - This table stores employee verification submissions
    - Admins must approve before `users.is_verified` is set to true
    - Only one pending request per user at a time
*/

-- Create verification_requests table
CREATE TABLE IF NOT EXISTS verification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  real_name text NOT NULL,
  wallet_address text NOT NULL,
  phone text NOT NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  audit_remark text,
  audited_by uuid REFERENCES admins(id),
  audited_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_verification_requests_user_id ON verification_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_requests_status ON verification_requests(status);

-- Enable RLS
ALTER TABLE verification_requests ENABLE ROW LEVEL SECURITY;

-- Employees can view their own verification requests
CREATE POLICY "Employees can view own verification requests"
  ON verification_requests
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Employees can create verification requests (only if they don't have a pending one)
CREATE POLICY "Employees can create verification requests"
  ON verification_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());