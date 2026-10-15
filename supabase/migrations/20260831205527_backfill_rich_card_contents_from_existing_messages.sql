/*
# Backfill existing rich_card messages: move heavy HTML to rich_card_contents

## Problem
Existing rich_card messages have full HTML content (up to 5+ MB) stored directly in
`message_content`. Every `select('*')` query transfers this massive data, causing
extreme slowness when loading conversation lists and chat windows.

## Solution
For each existing rich_card message without a `rich_card_content_id`:
1. Insert the full HTML into `rich_card_contents`
2. Update the message with the content reference ID
3. Replace `message_content` with a short plain-text preview (first 200 chars)

This is a one-time data migration. After this, ALL rich_card messages (old and new)
will have lightweight `message_content`, making `select('*')` fast.
*/

DO $$
DECLARE
  msg_record RECORD;
  new_content_id uuid;
  preview_text text;
BEGIN
  FOR msg_record IN
    SELECT id, message_content
    FROM customer_employee_conversations
    WHERE message_type = 'rich_card'
      AND rich_card_content_id IS NULL
      AND length(message_content) > 500
  LOOP
    -- Insert full HTML into rich_card_contents
    INSERT INTO rich_card_contents (html_content)
    VALUES (msg_record.message_content)
    RETURNING id INTO new_content_id;

    -- Generate plain-text preview
    preview_text := regexp_replace(msg_record.message_content, '<[^>]*>', '', 'g');
    preview_text := replace(preview_text, '&nbsp;', ' ');
    preview_text := replace(preview_text, '&amp;', '&');
    preview_text := replace(preview_text, '&lt;', '<');
    preview_text := replace(preview_text, '&gt;', '>');
    preview_text := replace(preview_text, '&quot;', '"');
    preview_text := regexp_replace(preview_text, '\s+', ' ', 'g');
    preview_text := trim(preview_text);
    preview_text := left(preview_text, 200);

    -- Update message with content reference and lightweight preview
    UPDATE customer_employee_conversations
    SET rich_card_content_id = new_content_id,
        message_content = preview_text
    WHERE id = msg_record.id;
  END LOOP;
END $$;
