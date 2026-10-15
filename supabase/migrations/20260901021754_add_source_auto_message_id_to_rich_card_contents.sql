/*
# Add source_auto_message_id to rich_card_contents

1. Modified Tables
   - `rich_card_contents`: Added `source_auto_message_id` (uuid, nullable) to track which auto-message a content row was created from
2. New Indexes  
   - Unique index on `source_auto_message_id` (where not null) so each auto-message gets at most one content row
3. Important Notes
   - Prevents duplicate 5.3MB content rows when the same auto-message is delivered to multiple employees
*/

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rich_card_contents' AND column_name = 'source_auto_message_id') THEN
    ALTER TABLE rich_card_contents ADD COLUMN source_auto_message_id uuid;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rich_card_contents_source_auto_message_id
  ON rich_card_contents (source_auto_message_id) WHERE source_auto_message_id IS NOT NULL;
