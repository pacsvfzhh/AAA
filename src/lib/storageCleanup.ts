import { supabase } from './supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

interface BucketFile {
  bucket: string;
  path: string;
}

const KNOWN_BUCKETS = ['template-images', 'chat-images', 'announcement-images'];

export function extractStorageFiles(html: string): BucketFile[] {
  if (!html || !SUPABASE_URL) return [];
  const files: BucketFile[] = [];
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/`;
  const regex = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^"'\\s)]+)`, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const fullPath = match[1];
    const bucket = KNOWN_BUCKETS.find(b => fullPath.startsWith(b + '/'));
    if (bucket) {
      files.push({ bucket, path: fullPath.slice(bucket.length + 1) });
    }
  }
  return files;
}

export async function deleteStorageFiles(files: BucketFile[]): Promise<void> {
  const byBucket = new Map<string, string[]>();
  for (const f of files) {
    const list = byBucket.get(f.bucket) || [];
    list.push(f.path);
    byBucket.set(f.bucket, list);
  }
  for (const [bucket, paths] of byBucket) {
    await supabase.storage.from(bucket).remove(paths);
  }
}

export async function cleanupContentImages(html: string): Promise<void> {
  const files = extractStorageFiles(html);
  if (files.length > 0) {
    await deleteStorageFiles(files);
  }
}
