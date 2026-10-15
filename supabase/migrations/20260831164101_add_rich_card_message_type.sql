/*
# Add 'rich_card' message type to customer service conversations

1. Modified Tables
   - `customer_employee_conversations`: Added 'rich_card' to the message_type CHECK constraint
   
2. Purpose
   - Enables admins to send rich announcement-style card messages in CCC chat
   - These messages display as clickable cards in the employee chat
   - Clicking opens a full-content popup similar to the announcement viewer

3. Changes
   - Drops and recreates the message_type CHECK constraint to include 'rich_card'
*/

ALTER TABLE customer_employee_conversations
  DROP CONSTRAINT IF EXISTS customer_employee_conversations_message_type_check;

ALTER TABLE customer_employee_conversations
  ADD CONSTRAINT customer_employee_conversations_message_type_check
  CHECK (message_type = ANY (ARRAY['text'::text, 'image'::text, 'rating_request'::text, 'rating_result'::text, 'tip'::text, 'rich_card'::text]));
