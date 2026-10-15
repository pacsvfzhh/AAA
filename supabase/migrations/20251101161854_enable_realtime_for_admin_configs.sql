/*
  # Enable Realtime for admin_configs table
  
  1. Changes
    - Enable realtime replication for admin_configs table
    - This allows live updates when company name or other configs change
    
  2. Security
    - Realtime respects existing RLS policies
    - Only authorized users can see/receive updates
*/

-- Enable realtime for admin_configs table
ALTER PUBLICATION supabase_realtime ADD TABLE admin_configs;