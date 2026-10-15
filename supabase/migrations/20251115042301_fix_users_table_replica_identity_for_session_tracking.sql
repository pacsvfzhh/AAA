/*
  # Fix Users Table Replica Identity for Session Tracking

  1. Issue
    - Users table uses default replica identity (only returns primary key on UPDATE)
    - Real-time subscriptions cannot detect current_session_token changes
    - This allows multiple browser logins without kicking out old sessions

  2. Solution
    - Set replica identity to FULL for users table
    - This allows real-time subscriptions to receive all column values on UPDATE
    - Enables detection of session token changes in real-time

  3. Security
    - Only affects real-time replication behavior
    - RLS policies still apply to all subscriptions
    - Users can only subscribe to their own data updates
*/

-- Set replica identity to FULL for users table
-- This allows real-time subscriptions to receive complete UPDATE data
ALTER TABLE users REPLICA IDENTITY FULL;

-- Verify the change
COMMENT ON TABLE users IS 'Employee/user accounts with full replica identity for real-time session tracking';
