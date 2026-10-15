/*
  # Add Employee Tags and Pinned Status

  1. Changes to `users` table
    - Add `tags` (text array) - Employee category tags for organization
    - Add `is_pinned` (boolean) - Whether employee is pinned to top of list
    - Add index for pinned status for better query performance

  2. Purpose
    - Allow admins to categorize employees with custom tags
    - Enable pinning important employees to top of list
    - Improve employee organization and accessibility

  3. Default Values
    - `tags` defaults to empty array
    - `is_pinned` defaults to false
*/

-- Add tags column to users table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'tags'
  ) THEN
    ALTER TABLE users ADD COLUMN tags text[] DEFAULT '{}';
  END IF;
END $$;

-- Add is_pinned column to users table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'is_pinned'
  ) THEN
    ALTER TABLE users ADD COLUMN is_pinned boolean DEFAULT false;
  END IF;
END $$;

-- Create index for better performance on pinned employees
CREATE INDEX IF NOT EXISTS idx_users_is_pinned ON users(is_pinned) WHERE is_pinned = true;

-- Create index for tag queries
CREATE INDEX IF NOT EXISTS idx_users_tags ON users USING GIN(tags);