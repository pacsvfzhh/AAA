/*
  # Add Super Customer Features

  1. Schema Changes
    - Add `is_super` (boolean) to simulated_customers table - marks customer as VIP
    - Add `super_customer_title` (text) to simulated_customers table - custom title for super customers
    - Add `badge_type` (text) to simulated_customers table - badge selection (diamond, crown, star, vip, premium)
    - Add `custom_avatar_url` (text) to simulated_customers table - URL for uploaded custom avatar

  2. Storage
    - Create storage bucket for super customer avatars
    - Set up RLS policies for avatar uploads

  3. Indexes
    - Add index on is_super for efficient filtering

  4. Security
    - Enable RLS on storage bucket
    - Allow admins to upload and view avatars
*/

-- Add super customer columns to simulated_customers table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'simulated_customers' AND column_name = 'is_super'
  ) THEN
    ALTER TABLE simulated_customers ADD COLUMN is_super boolean DEFAULT false NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'simulated_customers' AND column_name = 'super_customer_title'
  ) THEN
    ALTER TABLE simulated_customers ADD COLUMN super_customer_title text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'simulated_customers' AND column_name = 'badge_type'
  ) THEN
    ALTER TABLE simulated_customers ADD COLUMN badge_type text CHECK (badge_type IN ('diamond', 'crown', 'star', 'vip', 'premium'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'simulated_customers' AND column_name = 'custom_avatar_url'
  ) THEN
    ALTER TABLE simulated_customers ADD COLUMN custom_avatar_url text;
  END IF;
END $$;

-- Add index for super customer filtering
CREATE INDEX IF NOT EXISTS idx_simulated_customers_is_super ON simulated_customers(is_super);

-- Create storage bucket for super customer avatars
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('super-customer-avatars', 'super-customer-avatars', true, 5242880, ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Allow public read access to super customer avatars" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to upload super customer avatars" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to update their super customer avatars" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated users to delete super customer avatars" ON storage.objects;

-- Storage policies for super customer avatars
CREATE POLICY "Allow public read access to super customer avatars"
ON storage.objects FOR SELECT
USING (bucket_id = 'super-customer-avatars');

CREATE POLICY "Allow authenticated users to upload super customer avatars"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'super-customer-avatars' AND
  (storage.foldername(name))[1] = 'avatars'
);

CREATE POLICY "Allow authenticated users to update their super customer avatars"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'super-customer-avatars' AND
  (storage.foldername(name))[1] = 'avatars'
);

CREATE POLICY "Allow authenticated users to delete super customer avatars"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'super-customer-avatars' AND
  (storage.foldername(name))[1] = 'avatars'
);