/*
# Add source_template_id and source_auto_message_id to conversations

1. Modified Tables
   - `customer_employee_conversations`: Added `source_template_id` (uuid) to reference the original template directly
   - `customer_employee_conversations`: Added `source_auto_message_id` (uuid) to reference the original auto-message directly

2. Data Backfill
   - Existing rich_card messages linked to a template via rich_card_contents are backfilled with source_template_id
   - Existing rich_card messages linked to an auto-message via rich_card_contents are backfilled with source_auto_message_id

3. Important Notes
   - Viewers will now fetch content directly from the template or auto-message table
   - No more copying 5MB+ content into rich_card_contents for every send
   - Old messages with rich_card_content_id still work as fallback
*/

-- Add columns
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customer_employee_conversations' AND column_name = 'source_template_id') THEN
    ALTER TABLE customer_employee_conversations ADD COLUMN source_template_id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customer_employee_conversations' AND column_name = 'source_auto_message_id') THEN
    ALTER TABLE customer_employee_conversations ADD COLUMN source_auto_message_id uuid;
  END IF;
END $$;

-- Backfill: link existing rich_card conversations to their source template via rich_card_contents
UPDATE customer_employee_conversations c
SET source_template_id = rc.source_template_id
FROM rich_card_contents rc
WHERE c.rich_card_content_id = rc.id
  AND rc.source_template_id IS NOT NULL
  AND c.source_template_id IS NULL;

-- Backfill: link existing rich_card conversations to their source auto-message via rich_card_contents
UPDATE customer_employee_conversations c
SET source_auto_message_id = rc.source_auto_message_id
FROM rich_card_contents rc
WHERE c.rich_card_content_id = rc.id
  AND rc.source_auto_message_id IS NOT NULL
  AND c.source_auto_message_id IS NULL;

-- Index for lookup
CREATE INDEX IF NOT EXISTS idx_conversations_source_template_id ON customer_employee_conversations (source_template_id) WHERE source_template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_source_auto_message_id ON customer_employee_conversations (source_auto_message_id) WHERE source_auto_message_id IS NOT NULL;
