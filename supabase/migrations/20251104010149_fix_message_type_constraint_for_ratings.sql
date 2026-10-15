/*
  # Fix Message Type Constraint to Support Ratings

  1. Changes
    - Drop old message_type constraint that only allows 'text' and 'image'
    - Add new constraint that includes 'rating_request' and 'rating_result'

  2. Notes
    - This fixes the constraint violation when inserting rating messages
    - Allows the chat system to support all four message types
*/

-- Drop the old constraint
ALTER TABLE customer_employee_conversations 
DROP CONSTRAINT IF EXISTS customer_employee_conversations_message_type_check;

-- Add the new constraint with all four message types
ALTER TABLE customer_employee_conversations
ADD CONSTRAINT customer_employee_conversations_message_type_check 
CHECK (message_type IN ('text', 'image', 'rating_request', 'rating_result'));