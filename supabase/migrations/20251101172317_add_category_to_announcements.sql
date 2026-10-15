/*
  # Add Category Column to Announcements
  
  1. Changes
    - Add `category` column to announcements table
    - Set default value to 'General' for existing announcements
    - Add index for better filtering performance
  
  2. Purpose
    - Allow categorization of announcements
    - Enable filtering by category on both admin and employee interfaces
    - Support predefined categories: General, Important, System, Promotion, Policy, News
  
  3. Notes
    - Existing announcements will be categorized as 'General'
    - Category is required (NOT NULL) to ensure all announcements have a category
*/

-- Add category column to announcements table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'announcements' AND column_name = 'category'
  ) THEN
    ALTER TABLE announcements ADD COLUMN category text NOT NULL DEFAULT 'General';
    
    -- Add check constraint for valid categories
    ALTER TABLE announcements ADD CONSTRAINT announcements_category_check 
      CHECK (category IN ('General', 'Important', 'System', 'Promotion', 'Policy', 'News'));
    
    -- Add index for category filtering
    CREATE INDEX idx_announcements_category ON announcements(category);
    
    -- Add composite index for category + publish_at for efficient sorting
    CREATE INDEX idx_announcements_category_publish_at ON announcements(category, publish_at DESC);
  END IF;
END $$;