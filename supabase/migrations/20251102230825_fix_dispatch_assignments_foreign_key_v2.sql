/*
  # Fix dispatch_assignments foreign key constraint

  1. Changes
    - Clear all existing dispatch_assignments (historical test data)
    - Drop the old foreign key constraint pointing to dispatch_orders
    - Add new foreign key constraint pointing to dispatch_group_orders
    - This allows dispatch_assignments to reference orders from dispatch_group_orders table

  2. Reason
    - The system is now using dispatch_group_orders for group-based order management
    - Old dispatch_orders table is deprecated
    - Existing assignments were test data and can be cleared

  3. Security
    - No changes to RLS policies
    - Maintains referential integrity with the correct table
*/

-- Clear all existing dispatch_assignments (test data)
DELETE FROM dispatch_assignments;

-- Drop the old foreign key constraint
ALTER TABLE dispatch_assignments
  DROP CONSTRAINT IF EXISTS dispatch_assignments_dispatch_order_id_fkey;

-- Add new foreign key constraint pointing to dispatch_group_orders
ALTER TABLE dispatch_assignments
  ADD CONSTRAINT dispatch_assignments_dispatch_order_id_fkey
  FOREIGN KEY (dispatch_order_id)
  REFERENCES dispatch_group_orders(id)
  ON DELETE CASCADE;
