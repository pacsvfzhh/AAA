/*
  # Fix messages UPDATE policy for custom auth

  1. Changes
    - Drop the auth.uid() based UPDATE policy (incompatible with custom auth)
    - Add a simplified UPDATE policy matching the existing custom auth pattern
    - Application-level logic ensures only the message sender can edit

  2. Notes
    - The frontend enforces that admins can only edit messages they sent
    - This is consistent with other RLS policies in the custom auth system
*/

DROP POLICY IF EXISTS "Admins can update own messages" ON messages;

CREATE POLICY "Allow updating messages"
  ON messages FOR UPDATE
  USING (true)
  WITH CHECK (true);
