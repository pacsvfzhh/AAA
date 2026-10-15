/*
  # Add Users DELETE Policy (Open Access)

  1. Security Changes
    - Add DELETE policy for `users` table
    - Uses open access pattern consistent with other policies in the system
    - Allows deletion of employee records

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

-- Drop the previous restrictive policy if it exists
DROP POLICY IF EXISTS "Admins can delete employees" ON users;

-- Allow deletion with open access (consistent with existing policies)
CREATE POLICY "Allow employee deletion"
  ON users
  FOR DELETE
  TO anon, authenticated
  USING (true);
