/*
  # Add DELETE Policy to Customer Conversations
  
  1. Changes
    - Add DELETE policy for customer_employee_conversations table
    - This allows admins to delete individual messages or entire conversations
  
  2. Security
    - Open policy for custom auth (consistent with other policies)
*/

-- Add DELETE policy for customer_employee_conversations
CREATE POLICY "Anyone can delete messages"
  ON customer_employee_conversations FOR DELETE
  USING (true);
