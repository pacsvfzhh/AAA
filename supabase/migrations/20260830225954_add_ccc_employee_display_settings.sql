/*
# Add CCC employee display settings to simulated_customers

1. New Columns on `simulated_customers`
   - `employee_pin_top` (boolean, default false) - Pin this customer to top of employee's chat list
   - `employee_always_visible` (boolean, default false) - Show in employee chat even without messages
   - `target_employee_id` (uuid, nullable, FK to users) - If set, only this employee sees the customer

2. Important Notes
   - These settings are only used by CCC-source customers (source_type = 'ccc_service')
   - target_employee_id is nullable; when null, the customer is visible to all assigned employees
*/

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'simulated_customers' AND column_name = 'employee_pin_top') THEN
    ALTER TABLE simulated_customers ADD COLUMN employee_pin_top boolean NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'simulated_customers' AND column_name = 'employee_always_visible') THEN
    ALTER TABLE simulated_customers ADD COLUMN employee_always_visible boolean NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'simulated_customers' AND column_name = 'target_employee_id') THEN
    ALTER TABLE simulated_customers ADD COLUMN target_employee_id uuid REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_simulated_customers_target_employee
  ON simulated_customers(target_employee_id) WHERE target_employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_simulated_customers_always_visible
  ON simulated_customers(employee_always_visible) WHERE employee_always_visible = true;
