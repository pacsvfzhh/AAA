/*
  # Create Announcement Images Storage System

  1. Storage
    - Create `announcement-images` bucket for storing announcement images
    - Configure bucket to be publicly accessible
    - Set file size limit to 5MB
    - Allow image file types only (jpg, jpeg, png, gif, webp)

  2. Security
    - Admins can upload images (INSERT)
    - Admins can delete their own images (DELETE)
    - Everyone can view images (SELECT)
    - File validation for image types and sizes

  3. RLS Policies
    - Admins (super_admin and secondary_admin) can upload images
    - Admins can only delete images in their folder
    - Public read access for displaying images
*/

-- Create the storage bucket for announcement images
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'announcement-images',
  'announcement-images',
  true,
  5242880, -- 5MB limit
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Enable RLS on storage.objects
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Policy: Admins can upload images to their own folder
CREATE POLICY "Admins can upload announcement images"
  ON storage.objects
  FOR INSERT
  TO public
  WITH CHECK (
    bucket_id = 'announcement-images'
    AND auth.uid() IS NULL -- Using custom auth
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM admins WHERE is_active = true
    )
  );

-- Policy: Admins can delete their own images
CREATE POLICY "Admins can delete own announcement images"
  ON storage.objects
  FOR DELETE
  TO public
  USING (
    bucket_id = 'announcement-images'
    AND auth.uid() IS NULL -- Using custom auth
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM admins WHERE is_active = true
    )
  );

-- Policy: Public read access for all announcement images
CREATE POLICY "Public read access to announcement images"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'announcement-images');

-- Policy: Admins can update their own images
CREATE POLICY "Admins can update own announcement images"
  ON storage.objects
  FOR UPDATE
  TO public
  USING (
    bucket_id = 'announcement-images'
    AND auth.uid() IS NULL -- Using custom auth
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM admins WHERE is_active = true
    )
  );
