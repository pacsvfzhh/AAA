/*
# Add subtitle field to Rich Card templates and conversation messages

1. Modified Tables
   - `cs_message_templates`: Added `subtitle` (text, nullable) for rich card subtitle
   - `customer_employee_conversations`: Added `subtitle` (text, nullable) for message subtitle

2. Notes
   - Subtitle is optional, only used for rich_card message types
   - Allows rich cards to display a main title and a smaller subtitle
*/

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cs_message_templates' AND column_name = 'subtitle') THEN
    ALTER TABLE cs_message_templates ADD COLUMN subtitle text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customer_employee_conversations' AND column_name = 'subtitle') THEN
    ALTER TABLE customer_employee_conversations ADD COLUMN subtitle text;
  END IF;
END $$;
