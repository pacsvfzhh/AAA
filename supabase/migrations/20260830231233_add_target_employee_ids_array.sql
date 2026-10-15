/*
# Add target_employee_ids array column to simulated_customers

1. Modified Tables
   - `simulated_customers`
     - `target_employee_ids` (uuid[], nullable) - Array of employee IDs to restrict visibility to.
       When set, only these employees see this customer in their chat list.
       Replaces the single-value `target_employee_id` column for multi-select support.

2. Important Notes
   - The existing `target_employee_id` column is preserved (not dropped) for data safety.
   - New code will use `target_employee_ids` exclusively.
   - Existing data is migrated: if a row has a non-null `target_employee_id`, it is copied
     into `target_employee_ids` as a single-element array.
*/

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'simulated_customers'
      AND column_name = 'target_employee_ids'
  ) THEN
    ALTER TABLE simulated_customers ADD COLUMN target_employee_ids uuid[];
  END IF;
END $$;

-- Migrate existing single-value data to array
UPDATE simulated_customers
SET target_employee_ids = ARRAY[target_employee_id]
WHERE target_employee_id IS NOT NULL
  AND (target_employee_ids IS NULL OR target_employee_ids = '{}');
