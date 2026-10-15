/*
# Add read_at timestamp to customer_employee_conversations

1. Modified Tables
   - `customer_employee_conversations`
     - Added `read_at` (timestamptz, nullable) - records when the employee read a customer message
     
2. Details
   - When an employee opens a conversation, customer messages are marked as read.
   - Previously only `is_read` (boolean) was set. Now `read_at` is also set to record the exact time.
   - Only applies to messages where sender_type = 'customer' (messages FROM customers TO employees).
   - Admin dashboard will use this to show whether/when the employee read each message.
   
3. Backfill
   - Existing messages that are already marked as `is_read = true` get `read_at` set to their `created_at` 
     plus 1 minute as a reasonable approximation.
*/

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'customer_employee_conversations' 
    AND column_name = 'read_at'
  ) THEN
    ALTER TABLE customer_employee_conversations ADD COLUMN read_at timestamptz;
  END IF;
END $$;

-- Backfill existing read messages with an approximate read_at
UPDATE customer_employee_conversations
SET read_at = created_at + interval '1 minute'
WHERE is_read = true 
  AND sender_type = 'customer' 
  AND read_at IS NULL;
