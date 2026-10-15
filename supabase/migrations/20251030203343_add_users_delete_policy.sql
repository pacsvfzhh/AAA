/*
  # Add Users DELETE Policy

  1. Security Changes
    - Add DELETE policy for `users` table
    - Allow admins to delete their created employees
    - Super admins can delete any employee
    - Secondary admins can only delete employees they created

  2. Important Notes
    - This enables the employee deletion feature in admin dashboard
    - CASCADE delete will automatically clean up related data:
      - orders
      - wallets
      - wallet_transactions
      - withdrawals
      - verification_requests
      - used_order_data
*/

-- Allow admins to delete employees they created or all employees (for super admins)
CREATE POLICY "Admins can delete employees"
  ON users
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.id = (
        SELECT id FROM admins WHERE username = current_user LIMIT 1
      )
      AND (
        admins.role = 'super_admin'
        OR (admins.role = 'secondary_admin' AND admins.id = users.created_by)
      )
    )
  );
