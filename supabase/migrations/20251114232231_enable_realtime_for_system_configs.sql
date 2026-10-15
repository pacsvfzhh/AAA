/*
  # Enable Realtime for System Configs
  
  1. Changes
    - Enable realtime updates for system_configs table
    - Set replica identity to FULL to support real-time updates with all columns
    - Add table to supabase_realtime publication
  
  2. Purpose
    - Allow employee dashboards to receive instant updates when carousel settings change
    - No need for page refresh when admin changes settings
*/

-- Enable replica identity for real-time updates
ALTER TABLE system_configs REPLICA IDENTITY FULL;

-- Add to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE system_configs;