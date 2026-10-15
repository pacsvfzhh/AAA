/*
# Add title column to cs_message_templates and customer_employee_conversations

1. Modified Tables
   - `cs_message_templates`: Added `title` text column (nullable) for rich card titles
   - `customer_employee_conversations`: Added `title` text column (nullable) for rich card message titles

2. Purpose
   - Rich card templates and messages can now carry a title displayed in the card header
   - Similar to how announcements have titles, rich cards now show a customizable heading
*/

ALTER TABLE cs_message_templates ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE customer_employee_conversations ADD COLUMN IF NOT EXISTS title text;
