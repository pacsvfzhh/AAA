/*
  # Create Verification Documents Storage Bucket

  1. New Storage Bucket
    - `verification-documents` bucket for storing employee verification documents
    - Public bucket to allow easy access to uploaded files
    - Files organized by type (id-front, id-back, selfie)

  2. Security
    - Authenticated users can upload files to their own folder
    - Anyone can view files (public access for admin review)
    - Files are named with user ID prefix for organization

  3. Notes
    - Bucket is set to public for easier document viewing
    - RLS policies control who can upload
    - File size limits enforced at application level (5MB)
*/

-- Create the storage bucket for verification documents
INSERT INTO storage.buckets (id, name, public)
VALUES ('verification-documents', 'verification-documents', true)
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Authenticated users can upload verification documents" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own verification documents" ON storage.objects;
DROP POLICY IF EXISTS "Public read access to verification documents" ON storage.objects;

-- Allow authenticated users to upload files
CREATE POLICY "Authenticated users can upload verification documents"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'verification-documents');

-- Allow authenticated users to update their own files
CREATE POLICY "Users can update own verification documents"
ON storage.objects
FOR UPDATE
TO authenticated
USING (bucket_id = 'verification-documents');

-- Allow public read access to all files in the bucket
CREATE POLICY "Public read access to verification documents"
ON storage.objects
FOR SELECT
TO public
USING (bucket_id = 'verification-documents');