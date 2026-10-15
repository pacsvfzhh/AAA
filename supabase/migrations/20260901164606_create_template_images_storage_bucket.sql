/*
# Create template-images storage bucket

1. Storage Bucket
   - `template-images`: public bucket for storing compressed images extracted
     from templates, auto messages, and rich card content.
   - Replaces inline base64 data with lightweight URL references.

2. Security
   - Anyone can view images (public read for chat display).
   - Anyone can upload (custom auth system handles access control).
   - Anyone can update/delete their uploaded images.

3. Notes
   - Images are organized by source type: templates/, auto-messages/, rich-cards/
   - This bucket supports the image optimization system that extracts base64
     images from content, compresses them, and stores them separately.
*/

-- Create storage bucket for template images
INSERT INTO storage.buckets (id, name, public)
VALUES ('template-images', 'template-images', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for template-images bucket
DO $$
BEGIN
  DROP POLICY IF EXISTS "Anyone can upload template images" ON storage.objects;
  DROP POLICY IF EXISTS "Anyone can view template images" ON storage.objects;
  DROP POLICY IF EXISTS "Anyone can update template images" ON storage.objects;
  DROP POLICY IF EXISTS "Anyone can delete template images" ON storage.objects;
END $$;

CREATE POLICY "Anyone can upload template images"
  ON storage.objects FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'template-images');

CREATE POLICY "Anyone can view template images"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'template-images');

CREATE POLICY "Anyone can update template images"
  ON storage.objects FOR UPDATE
  TO anon, authenticated
  USING (bucket_id = 'template-images');

CREATE POLICY "Anyone can delete template images"
  ON storage.objects FOR DELETE
  TO anon, authenticated
  USING (bucket_id = 'template-images');
