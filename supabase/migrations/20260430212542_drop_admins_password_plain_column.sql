/*
  # Remove plaintext password column from admins table

  1. Changes
    - Drop `password_plain` column from `admins` table
    - This column stored admin passwords in plaintext, which is a critical security risk
    - Authentication uses `password_hash` (bcrypt) and is unaffected

  2. Security
    - Eliminates exposure of admin plaintext passwords if database is read via anon key
    - No impact on login functionality

  3. Notes
    - Irreversible removal of plaintext values (hashes in `password_hash` remain intact)
    - Frontend code in `AdminManagement.tsx` has been updated to no longer write to this column
*/

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'admins'
      AND column_name = 'password_plain'
  ) THEN
    ALTER TABLE public.admins DROP COLUMN password_plain;
  END IF;
END $$;
