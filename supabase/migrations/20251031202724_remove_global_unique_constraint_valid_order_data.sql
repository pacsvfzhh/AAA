/*
  # Remove Global Unique Constraint from valid_order_data Table

  1. Problem
    - Current UNIQUE(product_value, transaction_id) constraint prevents multiple employees from using the same data
    - Admin can only create one record per (product_value, transaction_id) combination
    - Business requirement: Each employee should be able to use the same data independently
    - Only the same employee cannot reuse the same data (already handled by used_order_data table)

  2. Solution
    - Drop the global UNIQUE constraint on (product_value, transaction_id)
    - The used_order_data table already has UNIQUE(user_id, valid_order_data_id)
    - This ensures each employee can only use a specific valid_order_data record once
    - Multiple employees can use different records with the same values

  3. New Workflow
    - Admin uploads multiple records with same (product_value, transaction_id) for multiple employees
    - Each employee finds an unused record with their desired values
    - Employee uses the record once (tracked in used_order_data)
    - Other employees can use other records with the same values
    - Perfect isolation between employees

  4. Example
    Before: Admin adds Product Value=100, Transaction ID=ABC123 (only 1 employee can use)
    After: Admin adds this 5 times (5 different employees can each use once)
*/

-- Drop the global unique constraint on valid_order_data table
ALTER TABLE valid_order_data DROP CONSTRAINT IF EXISTS valid_order_data_product_value_transaction_id_key;