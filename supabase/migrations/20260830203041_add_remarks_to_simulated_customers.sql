/*
# Add remarks column to simulated_customers

1. Modified Tables
   - `simulated_customers`
     - `remarks` (text, nullable) - Admin notes/remarks for distinguishing customers

2. Security
   - No policy changes needed; existing RLS policies cover the new column.

3. Notes
   - Uses DO block for idempotent conditional column addition.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'simulated_customers'
      AND column_name = 'remarks'
  ) THEN
    ALTER TABLE public.simulated_customers ADD COLUMN remarks text;
  END IF;
END $$;
