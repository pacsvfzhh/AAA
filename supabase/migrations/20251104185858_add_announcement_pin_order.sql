/*
  # Add Announcement Pin Order Feature

  1. Overview
    - Add pin_order field to control the display order of pinned announcements
    - Lower numbers appear first (1, 2, 3...)
    - Only applies to pinned announcements
    - Enables precise control over announcement priority
    
  2. Changes
    - Add `pin_order` column to announcements table
      - Integer field for sorting pinned announcements
      - Defaults to 999 (lowest priority)
      - Allows values from 1 to 999
    
  3. Migration Strategy
    - Existing pinned announcements get default order 999
    - New pinned announcements can specify custom order
    
  4. Sorting Logic (Employee Side)
    - Pinned announcements: ORDER BY pin_order ASC, publish_at DESC
    - Regular announcements: ORDER BY publish_at DESC
*/

-- Add pin_order column to announcements
ALTER TABLE announcements 
ADD COLUMN IF NOT EXISTS pin_order INTEGER DEFAULT 999 CHECK (pin_order >= 1 AND pin_order <= 999);

-- Create index for efficient sorting
CREATE INDEX IF NOT EXISTS idx_announcements_pin_order 
ON announcements(is_pinned, pin_order, publish_at DESC);

-- Update existing pinned announcements to have sequential order
WITH numbered_pins AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY publish_at DESC) as rn
  FROM announcements
  WHERE is_pinned = true
)
UPDATE announcements
SET pin_order = numbered_pins.rn
FROM numbered_pins
WHERE announcements.id = numbered_pins.id;
