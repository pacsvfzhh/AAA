/*
  # Increase Message Content Length Limit

  1. Changes
    - Drop existing `messages_content_length` constraint
    - Add new constraint allowing up to 100,000 characters

  2. Security
    - Maintains data integrity with length validation
    - Prevents empty content
*/

-- Drop the old constraint
ALTER TABLE messages
DROP CONSTRAINT IF EXISTS messages_content_length;

-- Add new constraint with increased limit
ALTER TABLE messages
ADD CONSTRAINT messages_content_length
CHECK (char_length(content) > 0 AND char_length(content) <= 100000);
