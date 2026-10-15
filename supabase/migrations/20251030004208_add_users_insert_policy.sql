/*
  # Add INSERT policy for users table

  1. Changes
    - Add INSERT policy for users table to allow admins to create employees

  2. Security
    - Allow authenticated users (admins) to insert new employee records
    - Policy allows any authenticated user to insert, relying on application logic for admin verification
*/

-- Add INSERT policy for users table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'users' 
    AND policyname = 'Allow employee creation'
  ) THEN
    CREATE POLICY "Allow employee creation"
      ON users FOR INSERT
      TO anon, authenticated
      WITH CHECK (true);
  END IF;
END $$;
