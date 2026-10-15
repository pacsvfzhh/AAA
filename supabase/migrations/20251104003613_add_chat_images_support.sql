/*
  # Add Image Support to Chat System

  1. Changes to customer_employee_conversations
    - Add message_type field ('text' or 'image')
    - Add image_url field for storing image paths

  2. Storage Bucket
    - Create chat_images bucket for storing chat images
    - Set up appropriate storage policies

  3. Security
    - Allow authenticated and public access to upload/view images
    - Images are organized by conversation participants
*/

-- Add fields to customer_employee_conversations for image support
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customer_employee_conversations' AND column_name = 'message_type'
  ) THEN
    ALTER TABLE customer_employee_conversations ADD COLUMN message_type text DEFAULT 'text' CHECK (message_type IN ('text', 'image'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customer_employee_conversations' AND column_name = 'image_url'
  ) THEN
    ALTER TABLE customer_employee_conversations ADD COLUMN image_url text;
  END IF;
END $$;

-- Create storage bucket for chat images
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-images', 'chat-images', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for chat-images bucket
DO $$
BEGIN
  -- Drop existing policies if they exist
  DROP POLICY IF EXISTS "Anyone can upload chat images" ON storage.objects;
  DROP POLICY IF EXISTS "Anyone can view chat images" ON storage.objects;
  DROP POLICY IF EXISTS "Anyone can update chat images" ON storage.objects;
  DROP POLICY IF EXISTS "Anyone can delete chat images" ON storage.objects;
END $$;

-- Allow anyone to upload chat images
CREATE POLICY "Anyone can upload chat images"
  ON storage.objects FOR INSERT
  TO public
  WITH CHECK (bucket_id = 'chat-images');

-- Allow anyone to view chat images
CREATE POLICY "Anyone can view chat images"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'chat-images');

-- Allow anyone to update chat images
CREATE POLICY "Anyone can update chat images"
  ON storage.objects FOR UPDATE
  TO public
  USING (bucket_id = 'chat-images');

-- Allow anyone to delete chat images
CREATE POLICY "Anyone can delete chat images"
  ON storage.objects FOR DELETE
  TO public
  USING (bucket_id = 'chat-images');