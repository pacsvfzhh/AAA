/*
  # Add Admin Pinned Status

  1. Changes to `admins` table
    - Add `is_pinned` (boolean) - Whether secondary admin is pinned to top of list
    - Add index for pinned status for better query performance

  2. Purpose
    - Allow super admins to pin important secondary admins to top of list
    - Improve admin organization and accessibility in Employee Management panel

  3. Default Values
    - `is_pinned` defaults to false
    - Only applies to secondary_admin role (super admins are always shown first)
*/

-- Add is_pinned column to admins table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'admins' AND column_name = 'is_pinned'
  ) THEN
    ALTER TABLE admins ADD COLUMN is_pinned boolean DEFAULT false;
  END IF;
END $$;

-- Create index for better performance on pinned admins
CREATE INDEX IF NOT EXISTS idx_admins_is_pinned ON admins(is_pinned) WHERE is_pinned = true;