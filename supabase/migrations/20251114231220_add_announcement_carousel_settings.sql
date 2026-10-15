/*
  # Add Announcement Carousel Settings
  
  1. New Configuration Settings
    - `announcement_carousel_enabled` - Boolean flag to enable/disable auto-scroll
    - `announcement_carousel_speed` - Speed multiplier for auto-scroll (0.1 to 5.0)
  
  2. Purpose
    - Allows super admin to control the announcement board auto-scroll behavior
    - Can enable/disable carousel
    - Can adjust scroll speed for optimal readability
  
  3. Default Values
    - Enabled: true (carousel on by default)
    - Speed: 0.6 (default scroll speed)
*/

-- Insert announcement carousel settings if they don't exist
INSERT INTO system_configs (key, value, description)
VALUES 
  ('announcement_carousel_enabled', 'true'::jsonb, 'Enable or disable automatic scrolling of announcements on employee dashboard'),
  ('announcement_carousel_speed', '0.6'::jsonb, 'Speed of announcement auto-scroll (0.1 = very slow, 5.0 = very fast)')
ON CONFLICT (key) DO NOTHING;