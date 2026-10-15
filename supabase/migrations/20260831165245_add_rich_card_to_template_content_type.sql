/*
# Add 'rich_card' to cs_message_templates content_type constraint

1. Modified Tables
   - `cs_message_templates`: Added 'rich_card' to the content_type CHECK constraint
   
2. Purpose
   - Enables storing rich card notice templates alongside regular text/richtext templates
   - Rich card templates use the TipTap rich editor and send as rich_card messages in chat
*/

ALTER TABLE cs_message_templates
  DROP CONSTRAINT IF EXISTS cs_message_templates_content_type_check;

ALTER TABLE cs_message_templates
  ADD CONSTRAINT cs_message_templates_content_type_check
  CHECK (content_type IN ('text', 'richtext', 'rich_card'));
