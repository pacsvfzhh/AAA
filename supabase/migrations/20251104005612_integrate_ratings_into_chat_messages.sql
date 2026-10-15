/*
  # Integrate Rating System into Chat Messages

  1. Changes
    - Add message_type column to customer_employee_conversations table
      - 'text': regular text message (default)
      - 'image': image message
      - 'rating_request': rating request from employee
      - 'rating_result': rating submitted by customer
    - Add rating_data JSONB column to store rating information
      - For rating_request: { employee_id: uuid, status: 'pending' }
      - For rating_result: { rating: 1-5, comment: string, employee_id: uuid }
    - Update existing messages to have 'text' or 'image' type based on content
    - Add indexes for efficient filtering by message_type

  2. Security
    - No RLS changes needed (inherits from existing table policies)

  3. Notes
    - This replaces the standalone rating_requests and service_ratings tables
    - Ratings are now integrated as special message types in the chat flow
    - Employee sends rating_request message
    - Customer submits rating as rating_result message
*/

-- Add message_type column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customer_employee_conversations' AND column_name = 'message_type'
  ) THEN
    ALTER TABLE customer_employee_conversations 
    ADD COLUMN message_type text DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'rating_request', 'rating_result'));
  END IF;
END $$;

-- Add rating_data column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customer_employee_conversations' AND column_name = 'rating_data'
  ) THEN
    ALTER TABLE customer_employee_conversations 
    ADD COLUMN rating_data jsonb DEFAULT NULL;
  END IF;
END $$;

-- Update existing messages to have appropriate type
UPDATE customer_employee_conversations
SET message_type = CASE
  WHEN image_url IS NOT NULL THEN 'image'
  ELSE 'text'
END
WHERE message_type = 'text';

-- Create index for message_type filtering
CREATE INDEX IF NOT EXISTS idx_conversations_message_type 
ON customer_employee_conversations(message_type);

-- Create index for conversation + type queries
CREATE INDEX IF NOT EXISTS idx_conversations_employee_type 
ON customer_employee_conversations(employee_id, message_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_customer_type 
ON customer_employee_conversations(customer_id, message_type, created_at DESC);