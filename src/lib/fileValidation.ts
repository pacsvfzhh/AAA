export interface FileValidationOptions {
  maxSize?: number;
  allowedTypes?: string[];
  allowedExtensions?: string[];
  checkMagicBytes?: boolean;
}

export interface FileValidationResult {
  valid: boolean;
  error?: string;
  sanitizedName?: string;
}

const FILE_TYPE_LIMITS = {
  image: 50 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg'];
const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

const MIME_TO_EXTENSION: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
  'video/ogg': ['.ogg', '.ogv'],
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
};

const MAGIC_BYTES: Record<string, number[][]> = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
};

export function sanitizeFileName(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf('.');
  const name = lastDotIndex >= 0 ? fileName.substring(0, lastDotIndex) : fileName;
  const ext = lastDotIndex >= 0 ? fileName.substring(lastDotIndex) : '';

  let sanitizedName = name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .substring(0, 100);

  if (!sanitizedName || sanitizedName.trim() === '' || /^_+$/.test(sanitizedName)) {
    sanitizedName = 'file';
  }

  const reserved = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4',
                    'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2',
                    'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
  if (reserved.includes(sanitizedName.toUpperCase())) {
    sanitizedName = `file_${sanitizedName}`;
  }

  const sanitizedExt = ext
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '');

  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);

  return `${sanitizedName}_${timestamp}_${random}${sanitizedExt}`;
}

async function checkMagicBytes(file: File): Promise<boolean> {
  if (file.type === 'video/mp4') {
    return checkMp4MagicBytes(file);
  }

  const magicBytesPatterns = MAGIC_BYTES[file.type];
  if (!magicBytesPatterns || magicBytesPatterns.length === 0) {
    return true;
  }

  try {
    const arrayBuffer = await file.slice(0, 12).arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    for (const pattern of magicBytesPatterns) {
      let matches = true;
      for (let i = 0; i < pattern.length; i++) {
        if (bytes[i] !== pattern[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error('Failed to check magic bytes:', error);
    return false;
  }
}

async function checkMp4MagicBytes(file: File): Promise<boolean> {
  try {
    const arrayBuffer = await file.slice(0, 12).arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.length < 8) {
      return false;
    }

    return bytes[4] === 0x66 &&
           bytes[5] === 0x74 &&
           bytes[6] === 0x79 &&
           bytes[7] === 0x70;
  } catch (error) {
    console.error('Failed to check MP4 magic bytes:', error);
    return false;
  }
}

function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  return lastDot >= 0 ? fileName.substring(lastDot).toLowerCase() : '';
}

function validateMimeTypeExtension(mimeType: string, fileName: string): boolean {
  const extension = getFileExtension(fileName);
  const allowedExtensions = MIME_TO_EXTENSION[mimeType];

  if (!allowedExtensions) {
    return false;
  }

  return allowedExtensions.includes(extension);
}

export async function validateFile(
  file: File,
  options?: FileValidationOptions
): Promise<FileValidationResult> {
  const {
    maxSize,
    allowedTypes = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES, ...ALLOWED_DOCUMENT_TYPES],
    allowedExtensions,
    checkMagicBytes: shouldCheckMagicBytes = true,
  } = options || {};

  if (!file || !(file instanceof File)) {
    return { valid: false, error: '无效的文件对象' };
  }

  if (file.size === 0) {
    return { valid: false, error: '文件不能为空' };
  }

  if (!allowedTypes.includes(file.type)) {
    return {
      valid: false,
      error: `不支持的文件类型: ${file.type}。允许的类型: ${allowedTypes.join(', ')}`,
    };
  }

  const extension = getFileExtension(file.name);
  if (allowedExtensions && allowedExtensions.length > 0) {
    if (!allowedExtensions.includes(extension)) {
      return {
        valid: false,
        error: `不支持的文件扩展名: ${extension}。允许的扩展名: ${allowedExtensions.join(', ')}`,
      };
    }
  }

  if (!validateMimeTypeExtension(file.type, file.name)) {
    return {
      valid: false,
      error: `文件类型 ${file.type} 与扩展名 ${extension} 不匹配`,
    };
  }

  const effectiveMaxSize = maxSize || (
    file.type.startsWith('image/') ? FILE_TYPE_LIMITS.image :
    file.type.startsWith('video/') ? FILE_TYPE_LIMITS.video :
    FILE_TYPE_LIMITS.document
  );

  if (file.size > effectiveMaxSize) {
    const maxSizeMB = (effectiveMaxSize / (1024 * 1024)).toFixed(2);
    return {
      valid: false,
      error: `文件大小超过限制 (最大: ${maxSizeMB} MB)`,
    };
  }

  if (shouldCheckMagicBytes) {
    const magicBytesValid = await checkMagicBytes(file);
    if (!magicBytesValid) {
      return {
        valid: false,
        error: '文件内容与声明的类型不匹配（可能是伪装文件）',
      };
    }
  }

  const sanitizedName = sanitizeFileName(file.name);

  return {
    valid: true,
    sanitizedName,
  };
}

export async function validateImageFile(file: File): Promise<FileValidationResult> {
  return validateFile(file, {
    maxSize: FILE_TYPE_LIMITS.image,
    allowedTypes: ALLOWED_IMAGE_TYPES,
    checkMagicBytes: true,
  });
}

export async function validateVideoFile(file: File): Promise<FileValidationResult> {
  return validateFile(file, {
    maxSize: FILE_TYPE_LIMITS.video,
    allowedTypes: ALLOWED_VIDEO_TYPES,
    checkMagicBytes: true,
  });
}

export async function validateDocumentFile(file: File): Promise<FileValidationResult> {
  return validateFile(file, {
    maxSize: FILE_TYPE_LIMITS.document,
    allowedTypes: ALLOWED_DOCUMENT_TYPES,
    checkMagicBytes: true,
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
