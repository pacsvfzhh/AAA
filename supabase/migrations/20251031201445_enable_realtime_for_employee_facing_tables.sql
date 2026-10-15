/*
  # Enable Realtime for Employee-Facing Tables

  1. Changes
    - Enable realtime replication for announcements table
    - Enable realtime replication for product_types table
  
  2. Purpose
    - Allow employee dashboard to receive real-time updates when:
      - Admins create, update, or delete announcements
      - Admins create, update, or delete product types
      - Admins enable/disable product types
    - Improve employee experience with instant updates without page refresh
    - Ensure employees always see current product catalog and announcements
*/

-- Enable realtime for announcements table
ALTER PUBLICATION supabase_realtime ADD TABLE announcements;

-- Enable realtime for product_types table
ALTER PUBLICATION supabase_realtime ADD TABLE product_types;