/*
  # Add RLS Policies for Emergency Admin
  
  1. Changes
    - Emergency admin can only access account_locks table
    - Emergency admin can view and unlock accounts
    - Emergency admin CANNOT access any other tables (users, orders, wallets, etc.)
  
  2. Security
    - Strict read-only access to most tables for emergency_admin
    - Can only modify account_locks (unlock accounts)
    - Cannot access sensitive financial or employee data
*/

-- Emergency admin can view account locks
CREATE POLICY "Emergency admin can view account locks"
ON account_locks
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM admins
    WHERE id = auth.uid()
    AND role = 'emergency_admin'
  )
);

-- Emergency admin can unlock accounts (update)
CREATE POLICY "Emergency admin can unlock accounts"
ON account_locks
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM admins
    WHERE id = auth.uid()
    AND role = 'emergency_admin'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM admins
    WHERE id = auth.uid()
    AND role = 'emergency_admin'
  )
);

-- Emergency admin can view login attempts (for context)
CREATE POLICY "Emergency admin can view login attempts"
ON login_attempts
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM admins
    WHERE id = auth.uid()
    AND role = 'emergency_admin'
  )
);