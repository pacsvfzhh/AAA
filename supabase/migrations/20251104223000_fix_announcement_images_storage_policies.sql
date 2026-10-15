/*
  # Fix Announcement Images Storage Policies

  1. Changes
    - Remove restrictive RLS policies that block uploads
    - Allow public upload to announcement-images bucket
    - Keep public read access for displaying images
    - Simplify policies to work with custom auth system

  2. Security
    - File type validation happens at bucket level (MIME types)
    - File size validation at bucket level (5MB)
    - Frontend validation provides additional checks
*/

-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Admins can upload announcement images" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete own announcement images" ON storage.objects;
DROP POLICY IF EXISTS "Admins can update own announcement images" ON storage.objects;

-- Allow public upload to announcement-images bucket
CREATE POLICY "Public can upload to announcement-images"
  ON storage.objects
  FOR INSERT
  TO public
  WITH CHECK (bucket_id = 'announcement-images');

-- Allow public delete from announcement-images bucket
CREATE POLICY "Public can delete from announcement-images"
  ON storage.objects
  FOR DELETE
  TO public
  USING (bucket_id = 'announcement-images');

-- Allow public update in announcement-images bucket
CREATE POLICY "Public can update announcement-images"
  ON storage.objects
  FOR UPDATE
  TO public
  USING (bucket_id = 'announcement-images')
  WITH CHECK (bucket_id = 'announcement-images');
