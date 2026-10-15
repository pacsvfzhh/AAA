/*
  # Enable Realtime for Customer Service Tables

  1. Changes
    - Enable realtime for customer_service_agents table
    - Enable realtime for customer_service_messages table
  
  2. Purpose
    - Allow real-time updates when admins create/update agents
    - Allow real-time messaging between admins and employees
    - Enable instant notification of new messages
*/

-- Enable realtime for customer_service_agents
ALTER PUBLICATION supabase_realtime ADD TABLE customer_service_agents;

-- Enable realtime for customer_service_messages
ALTER PUBLICATION supabase_realtime ADD TABLE customer_service_messages;
