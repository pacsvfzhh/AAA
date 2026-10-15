/*
  # Fix Realtime DELETE Events - Enable Full Replica Identity

  1. Changes
    - Set replica identity to FULL for customer_employee_conversations table
    - This ensures DELETE events include all column data in old_record
    - Required for realtime subscriptions to properly filter DELETE events

  2. Why This Is Needed
    - Default replica identity only sends primary key (id) in DELETE events
    - Realtime filters on employee_id need access to that column in old_record
    - FULL replica identity sends all columns, enabling proper filtering

  3. Performance Note
    - FULL replica identity has minimal overhead for small-medium tables
    - This table is not expected to have extremely high DELETE volume
*/

-- Enable FULL replica identity for customer_employee_conversations
ALTER TABLE customer_employee_conversations REPLICA IDENTITY FULL;