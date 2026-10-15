/*
  # Add Announcement Admin Grouping Feature

  1. Overview
    - Enable announcements to be scoped by admin (secondary admins)
    - Allow super admin to create global announcements visible to all employees
    - Employees only see announcements from their creating admin + global announcements

  2. Changes
    - Add `is_global` column to announcements table
      - Boolean field to mark announcements as visible to all employees
      - Defaults to false (admin-specific)
      - Super admin can create global announcements
    
  3. Performance
    - Add index on `announcements(created_by)` for efficient filtering
    - Existing `idx_announcements_publish_at` will continue to work

  4. Data Migration
    - Set existing announcements created by super admin as global
    - This ensures backward compatibility

  5. Security
    - No RLS changes needed
    - Authorization handled at application layer
*/

-- Add is_global column to announcements
ALTER TABLE announcements 
ADD COLUMN IF NOT EXISTS is_global BOOLEAN DEFAULT false;

-- Add index for efficient filtering by creator
CREATE INDEX IF NOT EXISTS idx_announcements_created_by 
ON announcements(created_by);

-- Set existing super admin announcements as global for backward compatibility
UPDATE announcements 
SET is_global = true
WHERE created_by IN (
  SELECT id FROM admins WHERE role = 'super_admin'
);