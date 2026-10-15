/*
  # Enable realtime for account_locks table

  1. Changes
    - Enable realtime updates for account_locks table
    - This allows the admin dashboard to receive real-time notifications when locks are created, updated, or unlocked
    - Ensures the lock count badge updates immediately without requiring page refresh
  
  2. Security
    - Realtime subscriptions still respect RLS policies
    - Only authorized admins can see lock changes based on existing policies
*/

-- Enable realtime for account_locks table
ALTER PUBLICATION supabase_realtime ADD TABLE account_locks;
