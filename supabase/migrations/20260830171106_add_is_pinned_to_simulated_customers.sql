/*
# Add is_pinned column to simulated_customers

1. Modified Tables
   - `simulated_customers`
     - `is_pinned` (boolean, default false) - allows admins to pin customers to top of list

2. Notes
   - Pinned customers always appear at the top of the customer list, above unread-sorted cards
   - Idempotent: uses DO block to check column existence first
*/

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'simulated_customers'
      AND column_name = 'is_pinned'
  ) THEN
    ALTER TABLE simulated_customers ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;
  END IF;
END $$;