/*
  # Enable Realtime for Admin Tables

  1. Changes
    - Enable realtime replication for verification_requests table
    - Enable realtime replication for withdrawals table
    - Enable realtime replication for users table
  
  2. Purpose
    - Allow admin dashboard to receive real-time updates when:
      - Employees submit verification requests
      - Employees submit withdrawal requests
      - User verification status changes
    - Improve admin experience with instant notifications
*/

-- Enable realtime for verification_requests table
ALTER PUBLICATION supabase_realtime ADD TABLE verification_requests;

-- Enable realtime for withdrawals table
ALTER PUBLICATION supabase_realtime ADD TABLE withdrawals;

-- Enable realtime for users table
ALTER PUBLICATION supabase_realtime ADD TABLE users;
