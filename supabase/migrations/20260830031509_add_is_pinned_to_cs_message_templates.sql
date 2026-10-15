/*
# Add is_pinned column to cs_message_templates

1. Modified Tables
   - `cs_message_templates`
     - `is_pinned` (boolean, default false) - allows pinning templates to the top of the list

2. Important Notes
   - Idempotent: uses DO block to check column existence before adding
   - Pinned templates sort before unpinned ones in the UI
*/

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cs_message_templates'
      AND column_name = 'is_pinned'
  ) THEN
    ALTER TABLE cs_message_templates ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;
  END IF;
END $$;
