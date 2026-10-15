/*
# Update cs_message_templates content_type constraint

1. Changes
   - Replace 'markdown' with 'richtext' in the content_type CHECK constraint
   - Update any existing 'markdown' rows to 'richtext'

2. Notes
   - Rich text templates store HTML content (from contentEditable paste, supporting Word doc formatting)
   - Plain text templates remain unchanged
*/

-- Drop old constraint first
ALTER TABLE cs_message_templates DROP CONSTRAINT IF EXISTS cs_message_templates_content_type_check;

-- Update existing markdown rows to richtext
UPDATE cs_message_templates SET content_type = 'richtext' WHERE content_type = 'markdown';

-- Add new constraint
ALTER TABLE cs_message_templates ADD CONSTRAINT cs_message_templates_content_type_check CHECK (content_type IN ('text', 'richtext'));
