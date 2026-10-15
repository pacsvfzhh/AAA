/*
  # Enforce Single Group Per Employee

  1. Changes
    - Drop old composite unique constraint on (group_id, user_id)
    - Add new unique constraint on (user_id) to ensure each employee can only be in one group

  2. Rationale
    - Prevents conflicts where an employee could be in multiple dispatch groups
    - Ensures clean separation of employees across groups
    - Simplifies order dispatch logic by guaranteeing one group per employee

  3. Migration Strategy
    - Check for existing violations
    - Remove duplicates keeping the most recent assignment
    - Apply new constraint

  4. Impact
    - Employees can only be assigned to ONE dispatch group at a time
    - Moving an employee to a new group requires removing them from the old group first
    - This is already handled in the UI (DELETE before INSERT)
*/

-- First, remove any duplicate assignments (keep the most recent one for each user)
DO $$
DECLARE
  duplicate_user_id uuid;
BEGIN
  FOR duplicate_user_id IN
    SELECT user_id
    FROM dispatch_group_members
    GROUP BY user_id
    HAVING COUNT(*) > 1
  LOOP
    -- Keep only the most recent assignment
    DELETE FROM dispatch_group_members
    WHERE user_id = duplicate_user_id
    AND id NOT IN (
      SELECT id
      FROM dispatch_group_members
      WHERE user_id = duplicate_user_id
      ORDER BY assigned_at DESC
      LIMIT 1
    );
  END LOOP;
END $$;

-- Drop the old composite unique constraint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'dispatch_group_members_group_id_user_id_key'
  ) THEN
    ALTER TABLE dispatch_group_members
    DROP CONSTRAINT dispatch_group_members_group_id_user_id_key;
  END IF;
END $$;

-- Add new unique constraint on user_id to ensure one group per employee
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'dispatch_group_members_user_id_key'
  ) THEN
    ALTER TABLE dispatch_group_members
    ADD CONSTRAINT dispatch_group_members_user_id_key UNIQUE (user_id);
  END IF;
END $$;

-- Create a helpful comment
COMMENT ON CONSTRAINT dispatch_group_members_user_id_key ON dispatch_group_members IS
  'Ensures each employee can only be assigned to one dispatch group at a time';
