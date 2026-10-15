/*
  # Add Dispatch Order Mode Configuration
  
  1. Purpose
    - Allow admin to configure how orders are dispatched to employees
    - Options: 'random' (default) or 'sequential'
    
  2. Changes
    - Add new config key 'dispatch_order_mode' to dispatch_config table
    - Default value is 'random' to maintain current behavior
    
  3. Notes
    - 'random': Orders are randomly selected from available pool
    - 'sequential': Orders are selected in creation order (oldest first)
*/

-- Insert dispatch order mode config
INSERT INTO dispatch_config (config_key, config_value, description)
VALUES (
  'dispatch_order_mode',
  'random',
  '派单模式：random（随机）或 sequential（顺序）'
)
ON CONFLICT (config_key) DO NOTHING;
