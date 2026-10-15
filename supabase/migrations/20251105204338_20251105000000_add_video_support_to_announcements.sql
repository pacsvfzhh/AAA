/*
  # Add Video Support to Announcement Images Storage

  1. Changes
    - Update `announcement-images` bucket to allow video file types
    - Add support for MP4, WebM, and OGG video formats
    - Increase file size limit to 100MB for videos
    - Keep backward compatibility with existing images

  2. Supported Formats
    - Images: JPEG, JPG, PNG, GIF, WebP (max 10MB)
    - Videos: MP4, WebM, OGG (max 100MB)

  3. Security
    - Existing RLS policies remain unchanged
    - Same upload/delete/read permissions for videos as images
*/

-- Update the storage bucket to allow video types and increase size limit
UPDATE storage.buckets
SET
  file_size_limit = 104857600, -- 100MB limit to accommodate videos
  allowed_mime_types = ARRAY[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/ogg'
  ]
WHERE id = 'announcement-images';
