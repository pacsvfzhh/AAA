/*
  # Create Announcement Categories System
  
  1. New Table
    - `announcement_categories` - Store custom announcement categories
      - `id` (uuid, primary key)
      - `name` (text, unique) - Category name
      - `display_order` (integer) - Display order (1-10)
      - `icon_name` (text) - Icon identifier for frontend
      - `color_scheme` (text) - Color scheme identifier
      - `is_active` (boolean) - Whether category is active
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
  
  2. Purpose
    - Allow super admins to create custom announcement categories
    - Support up to 10 categories with customizable names
    - Each category has visual settings (icon, color)
    - Replace hardcoded categories with database-driven system
  
  3. Security
    - Enable RLS
    - All users can read categories
    - Only super admins can manage categories
  
  4. Migration Strategy
    - Create table with default categories
    - Remove CHECK constraint from announcements.category
    - Add foreign key relationship (optional for flexibility)
*/

-- Create announcement_categories table
CREATE TABLE IF NOT EXISTS announcement_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  display_order integer NOT NULL CHECK (display_order >= 1 AND display_order <= 10),
  icon_name text NOT NULL DEFAULT 'bell',
  color_scheme text NOT NULL DEFAULT 'slate',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT unique_display_order UNIQUE (display_order)
);

-- Enable RLS
ALTER TABLE announcement_categories ENABLE ROW LEVEL SECURITY;

-- Allow everyone to read categories
CREATE POLICY "Anyone can view announcement categories"
  ON announcement_categories FOR SELECT
  USING (true);

-- Only super admins can insert categories
CREATE POLICY "Super admins can insert categories"
  ON announcement_categories FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE admins.id = auth.uid() 
      AND admins.role = 'super_admin'
    )
  );

-- Only super admins can update categories
CREATE POLICY "Super admins can update categories"
  ON announcement_categories FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE admins.id = auth.uid() 
      AND admins.role = 'super_admin'
    )
  );

-- Only super admins can delete categories
CREATE POLICY "Super admins can delete categories"
  ON announcement_categories FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE admins.id = auth.uid() 
      AND admins.role = 'super_admin'
    )
  );

-- Insert default categories
INSERT INTO announcement_categories (name, display_order, icon_name, color_scheme) VALUES
  ('General', 1, 'bell', 'slate'),
  ('Important', 2, 'sparkles', 'red'),
  ('System', 3, 'bell', 'blue'),
  ('Promotion', 4, 'sparkles', 'green'),
  ('Policy', 5, 'bell', 'yellow'),
  ('News', 6, 'radio', 'purple')
ON CONFLICT (name) DO NOTHING;

-- Remove old CHECK constraint on announcements.category
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'announcements_category_check'
  ) THEN
    ALTER TABLE announcements DROP CONSTRAINT announcements_category_check;
  END IF;
END $$;

-- Add index for ordering
CREATE INDEX IF NOT EXISTS idx_announcement_categories_order ON announcement_categories(display_order) WHERE is_active = true;

-- Enable realtime for categories
ALTER PUBLICATION supabase_realtime ADD TABLE announcement_categories;