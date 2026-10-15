/*
# Add auto_messages_enabled flag to simulated_customers

1. Modified Tables
   - `simulated_customers`
     - `auto_messages_enabled` (boolean, default false) - Master toggle for auto-message feature per customer

2. Notes
   - When false, auto messages will not be sent even if configured
   - Defaults to false so existing customers are unaffected
*/

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'simulated_customers'
    AND column_name = 'auto_messages_enabled'
  ) THEN
    ALTER TABLE simulated_customers ADD COLUMN auto_messages_enabled boolean NOT NULL DEFAULT false;
  END IF;
END $$;
