import { supabase } from './supabase';

const BUCKET = 'template-images';
const MAX_WIDTH = 1200;
const JPEG_QUALITY = 0.85;
const SKIP_THRESHOLD = 50 * 1024; // 50KB - skip images smaller than this

function base64ToBlob(base64: string, mimeType: string): Blob {
  const byteChars = atob(base64);
  const byteArr = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteArr[i] = byteChars.charCodeAt(i);
  }
  return new Blob([byteArr], { type: mimeType });
}

function estimateBase64Size(base64: string): number {
  return Math.floor(base64.length * 0.75);
}

export async function optimizeImageForWeb(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      let w = img.naturalWidth;
      let h = img.naturalHeight;

      if (w > MAX_WIDTH) {
        h = Math.round(h * (MAX_WIDTH / w));
        w = MAX_WIDTH;
      }

      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(blob); return; }
      ctx.drawImage(img, 0, 0, w, h);

      const isPng = blob.type === 'image/png';
      if (isPng) {
        // Check if the image has transparency
        const imgData = ctx.getImageData(0, 0, w, h);
        let hasAlpha = false;
        for (let i = 3; i < imgData.data.length; i += 4) {
          if (imgData.data[i] < 255) { hasAlpha = true; break; }
        }
        if (hasAlpha) {
          canvas.toBlob(
            (b) => b ? resolve(b) : resolve(blob),
            'image/png'
          );
          return;
        }
      }

      canvas.toBlob(
        (b) => b ? resolve(b) : resolve(blob),
        'image/jpeg',
        JPEG_QUALITY
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for compression'));
    };
    img.src = url;
  });
}

async function uploadToStorage(blob: Blob, folder: string): Promise<string | null> {
  const ext = blob.type === 'image/png' ? 'png' : 'jpg';
  const path = `${folder}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, {
      contentType: blob.type,
      cacheControl: '31536000',
    });

  if (error) return null;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

const BASE64_IMG_RE = /(<img\s[^>]*src=")data:image\/(png|jpeg|jpg|gif|webp);base64,([^"]+)("[^>]*>)/gi;

export async function processContentImages(
  html: string,
  folder: string
): Promise<string> {
  const matches: { full: string; prefix: string; mimeSubType: string; data: string; suffix: string }[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(BASE64_IMG_RE.source, BASE64_IMG_RE.flags);

  while ((m = re.exec(html)) !== null) {
    matches.push({
      full: m[0],
      prefix: m[1],
      mimeSubType: m[2],
      data: m[3],
      suffix: m[4],
    });
  }

  if (matches.length === 0) return html;

  let result = html;

  for (const match of matches) {
    const rawSize = estimateBase64Size(match.data);
    if (rawSize < SKIP_THRESHOLD) continue;

    try {
      const mimeType = `image/${match.mimeSubType === 'jpg' ? 'jpeg' : match.mimeSubType}`;
      const blob = base64ToBlob(match.data, mimeType);
      const compressed = await optimizeImageForWeb(blob);
      const publicUrl = await uploadToStorage(compressed, folder);

      if (publicUrl) {
        result = result.replace(match.full, `${match.prefix}${publicUrl}${match.suffix}`);
      }
    } catch {
      // If any image fails, leave it as-is
    }
  }

  return result;
}

export function contentHasBase64Images(html: string): boolean {
  const re = new RegExp(BASE64_IMG_RE.source, BASE64_IMG_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (estimateBase64Size(m[3]) >= SKIP_THRESHOLD) return true;
  }
  return false;
}
