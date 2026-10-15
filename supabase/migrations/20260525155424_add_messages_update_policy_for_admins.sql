/*
  # Add UPDATE policy for messages table

  1. Security Changes
    - Add UPDATE policy on `messages` table to allow admins to edit messages they sent
    - Admins can only update their own messages (sender_id must match)

  2. Notes
    - This enables the admin message editing feature in the message management panel
    - Only the title and content fields will be editable from the frontend
*/

CREATE POLICY "Admins can update own messages"
  ON messages
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.id = messages.sender_id
      AND admins.id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.id = messages.sender_id
      AND admins.id = auth.uid()
    )
  );
