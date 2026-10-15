/*
# Add vip_label column to simulated_customers

1. Modified Tables
   - `simulated_customers`
     - Added `vip_label` (text, nullable, default 'VIP') - customizable label text for the VIP badge shown on customer cards

2. Notes
   - Existing VIP customers will show 'VIP' by default
   - Admins can customize this per-customer in the Create/Edit Customer form
*/

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'simulated_customers' AND column_name = 'vip_label'
  ) THEN
    ALTER TABLE simulated_customers ADD COLUMN vip_label text DEFAULT 'VIP';
  END IF;
END $$;
