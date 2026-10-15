/*
  # Enable Realtime for Orders and Messages Tables

  1. Changes
    - Enable realtime replication for orders table
    - Enable realtime replication for messages table

  2. Purpose
    - Allow admin dashboard to receive real-time updates when:
      - Orders are created, updated, or completed
      - Messages are sent or read
    - Improve admin and employee experience with instant updates

  3. Impact
    - Admin Employee Management panel will show real-time order counts
    - Admin Dispatch Records panel will update instantly
    - Message Management will reflect read status changes immediately
*/

-- Enable realtime for orders table
ALTER PUBLICATION supabase_realtime ADD TABLE orders;

-- Enable realtime for messages table
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
