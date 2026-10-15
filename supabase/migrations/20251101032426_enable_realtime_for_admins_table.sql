/*
  # Enable Realtime for Admins Table

  1. Changes
    - Enable realtime replication for admins table
  
  2. Purpose
    - Allow message management panel to receive real-time updates when:
      - New admins are created
      - Admin information is updated
      - Admins are deleted
    - Ensures admin groups list stays synchronized across all admin dashboards
*/

-- Enable realtime for admins table
ALTER PUBLICATION supabase_realtime ADD TABLE admins;
