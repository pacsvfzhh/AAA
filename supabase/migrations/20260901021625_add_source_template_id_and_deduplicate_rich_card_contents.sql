/*
# Add source_template_id to rich_card_contents and deduplicate

1. Modified Tables
   - `rich_card_contents`: Added `source_template_id` (uuid, nullable) to track which template a content row was created from
2. New Indexes
   - Unique index on `source_template_id` (where not null) so each template gets at most one content row
3. Data Fixes
   - For each template that has multiple duplicate content rows, keep one and update all conversation references to point to the kept row
   - Fix 3 broken rich_card messages that have no rich_card_content_id
4. Important Notes
   - This eliminates the pattern of creating a new 5.3MB content row for every Rich Card send
   - Future sends will look up existing content by template_id and reuse it
*/

-- Step 1: Add source_template_id column
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rich_card_contents' AND column_name = 'source_template_id') THEN
    ALTER TABLE rich_card_contents ADD COLUMN source_template_id uuid;
  END IF;
END $$;

-- Step 2: Backfill source_template_id for existing rows by matching content
-- Match rich_card_contents to cs_message_templates by identical content
UPDATE rich_card_contents rc
SET source_template_id = tpl.id
FROM cs_message_templates tpl
WHERE tpl.content_type = 'rich_card'
  AND rc.html_content = tpl.content
  AND rc.source_template_id IS NULL;

-- Step 3: Deduplicate - for each template_id, keep the oldest row and repoint all references
DO $$
DECLARE
  tpl_id uuid;
  keep_id uuid;
BEGIN
  FOR tpl_id IN
    SELECT DISTINCT source_template_id FROM rich_card_contents WHERE source_template_id IS NOT NULL
  LOOP
    -- Pick the oldest row to keep
    SELECT id INTO keep_id FROM rich_card_contents
    WHERE source_template_id = tpl_id
    ORDER BY created_at ASC
    LIMIT 1;

    -- Repoint all conversation references from duplicate rows to the kept row
    UPDATE customer_employee_conversations c
    SET rich_card_content_id = keep_id
    FROM rich_card_contents rc
    WHERE c.rich_card_content_id = rc.id
      AND rc.source_template_id = tpl_id
      AND rc.id != keep_id;

    -- Delete duplicate rows
    DELETE FROM rich_card_contents
    WHERE source_template_id = tpl_id AND id != keep_id;
  END LOOP;
END $$;

-- Step 4: Fix broken messages (rich_card type with no content_id)
-- For each broken message, find the content row that matches its template title
DO $$
DECLARE
  broken_rec RECORD;
  content_id uuid;
BEGIN
  FOR broken_rec IN
    SELECT c.id, c.title
    FROM customer_employee_conversations c
    WHERE c.message_type = 'rich_card'
      AND c.rich_card_content_id IS NULL
  LOOP
    -- Try to find a matching rich_card_contents row via template
    SELECT rc.id INTO content_id
    FROM rich_card_contents rc
    JOIN cs_message_templates tpl ON tpl.id = rc.source_template_id
    WHERE tpl.title = broken_rec.title
    LIMIT 1;

    IF content_id IS NOT NULL THEN
      UPDATE customer_employee_conversations SET rich_card_content_id = content_id WHERE id = broken_rec.id;
    END IF;
  END LOOP;
END $$;

-- Step 5: Create unique index so each template gets at most one content row
CREATE UNIQUE INDEX IF NOT EXISTS idx_rich_card_contents_source_template_id
  ON rich_card_contents (source_template_id) WHERE source_template_id IS NOT NULL;
