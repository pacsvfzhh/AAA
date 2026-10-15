import { supabase } from './supabase';

interface StorageUploadOptions {
  bucket: string;
  path: string;
  body: Blob;
  contentType?: string;
  upsert?: boolean;
  onProgress?: (percentage: number, loaded: number, total: number) => void;
}

export async function uploadStorageObjectWithProgress({
  bucket,
  path,
  body,
  contentType = body.type || 'application/octet-stream',
  upsert = false,
  onProgress,
}: StorageUploadOptions): Promise<void> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token || anonKey;
  const encodedPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/');

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', event => {
      if (!event.lengthComputable) return;
      onProgress?.(
        Math.round((event.loaded / event.total) * 100),
        event.loaded,
        event.total,
      );
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100, body.size, body.size);
        resolve();
        return;
      }

      let message = xhr.statusText || 'Upload failed';
      try {
        const response = JSON.parse(xhr.responseText) as { message?: string; error?: string };
        message = response.message || response.error || message;
      } catch {
        // Keep the HTTP status message when the response is not JSON.
      }
      reject(new Error(message));
    });

    xhr.addEventListener('error', () => reject(new Error('上传连接中断，请检查网络后重试')));
    xhr.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError')));
    xhr.addEventListener('timeout', () => reject(new Error('上传超时，请压缩文件或更换稳定网络后重试')));

    xhr.open('POST', `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`);
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader('apikey', anonKey);
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('cache-control', 'max-age=31536000');
    xhr.setRequestHeader('x-upsert', String(upsert));
    onProgress?.(0, 0, body.size);
    xhr.send(body);
  });
}
