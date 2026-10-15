import DOMPurify from 'dompurify';

export interface SanitizeOptions {
  allowedTags?: string[];
  allowedAttributes?: string[];
  allowDataAttributes?: boolean;
}

const FONT_SIZE_MAP: Record<string, string> = {
  '1': '0.625rem',
  '2': '0.75rem',
  '3': '1rem',
  '4': '1.125rem',
  '5': '1.25rem',
  '6': '1.5rem',
  '7': '1.875rem',
};

function stripBackgroundStyles(html: string): string {
  if (!html) return '';
  return html.replace(/\sstyle="[^"]*"/gi, (match) => {
    const styleContent = match.slice(8, -1);
    const cleaned = styleContent
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.match(/^background(-image)?:/i) && !s.startsWith('--tw-'))
      .join('; ');
    if (!cleaned) return '';
    return ` style="${cleaned}"`;
  });
}

function convertFontSizeToInline(html: string): string {
  return html.replace(/<font([^>]*)size="(\d)"([^>]*)>/gi, (_match, before, size, after) => {
    const fontSize = FONT_SIZE_MAP[size] || '1rem';
    const existingStyle = (before + after).match(/style="([^"]*)"/);
    if (existingStyle) {
      const newBefore = (before + after).replace(/style="([^"]*)"/, `style="$1; font-size: ${fontSize}"`);
      return `<font${newBefore}>`;
    }
    return `<font${before}size="${size}"${after} style="font-size: ${fontSize}">`;
  });
}

function convertFontColorToInline(html: string): string {
  return html.replace(/<font([^>]*)color="([^"]*)"([^>]*)>/gi, (_match, before, color, after) => {
    const existingStyle = (before + after).match(/style="([^"]*)"/);
    if (existingStyle) {
      const combined = (before + after).replace(/style="([^"]*)"/, `style="$1; color: ${color}"`);
      return `<font${combined}>`;
    }
    return `<font${before}color="${color}"${after} style="color: ${color}">`;
  });
}

/**
 * 清理 HTML 内容，防止 XSS 攻击
 */
export function sanitizeHTML(
  html: string,
  options?: SanitizeOptions
): string {
  const defaultConfig = {
    ALLOWED_TAGS: [
      // 文本格式
      'p', 'br', 'span', 'div',
      // 标题
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      // 格式化
      'strong', 'em', 'u', 's', 'b', 'i', 'font',
      // 列表
      'ul', 'ol', 'li',
      // 引用和代码
      'blockquote', 'code', 'pre',
      // 链接和图片
      'a', 'img',
      // 表格
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      // 其他
      'hr'
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'class', 'style',
      'target', 'rel', 'width', 'height', 'size'
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // 只允许 http/https 协议
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[-a-z+.]+(?:[^-a-z+.:]|$))/i,
  };

  // 合并自定义配置
  const config = {
    ...defaultConfig,
    ...(options?.allowedTags && { ALLOWED_TAGS: options.allowedTags }),
    ...(options?.allowedAttributes && { ALLOWED_ATTR: options.allowedAttributes }),
    ...(options?.allowDataAttributes !== undefined && {
      ALLOW_DATA_ATTR: options.allowDataAttributes
    }),
  };

  try {
    const sanitized = DOMPurify.sanitize(html, config);
    const cleaned = stripBackgroundStyles(sanitized);
    return convertFontSizeToInline(cleaned);
  } catch (error) {
    console.error('DOMPurify sanitization error:', error);
    return '';
  }
}

/**
 * 专门用于公告内容的清理
 */
export function sanitizeAnnouncementContent(html: string): string {
  const sanitized = sanitizeHTML(html, {
    allowedTags: [
      'p', 'br', 'div', 'span',
      'h1', 'h2', 'h3', 'h4',
      'strong', 'em', 'u', 'b', 'i', 's', 'strike', 'del', 'font',
      'ul', 'ol', 'li',
      'blockquote', 'code', 'pre',
      'a', 'img', 'video', 'source',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'hr'
    ],
    allowedAttributes: [
      'href', 'src', 'alt', 'title', 'class', 'style',
      'target', 'rel', 'width', 'height', 'size', 'color', 'loading', 'decoding',
      'controls', 'autoplay', 'loop', 'muted', 'poster', 'preload', 'playsinline',
      'crossorigin', 'type', 'data-video-processed'
    ]
  });

  // Keep controls so contexts without the custom play-button overlay (e.g. admin preview)
  // still have a working player. The employee board removes controls at runtime and wraps
  // each video with its own play button.
  let processed = sanitized;

  processed = processed.replace(/<img(?![^>]*loading=)/gi, '<img loading="lazy"');
  processed = processed.replace(/<img(?![^>]*decoding=)/gi, '<img decoding="async"');

  // Ensure all videos have preload="metadata" for poster frame loading
  processed = processed.replace(/<video(?![^>]*preload=)/gi, '<video preload="metadata"');
  processed = processed.replace(/<video(?![^>]*controls)/gi, '<video controls');

  // Add playsinline for iOS compatibility
  processed = processed.replace(/<video(?![^>]*playsinline)/gi, '<video playsinline');

  // Allow legacy videos to capture a poster frame when Storage CORS permits it.
  processed = processed.replace(/<video(?![^>]*crossorigin=)/gi, '<video crossorigin="anonymous"');

  return processed;
}

/**
 * 专门用于用户输入的简单文本清理
 */
export function sanitizeUserInput(html: string): string {
  return sanitizeHTML(html, {
    allowedTags: ['p', 'br', 'strong', 'em', 'u'],
    allowedAttributes: []
  });
}

/**
 * Strip Tailwind CSS variables and computed styles from inline style attributes.
 * Used when extracting innerHTML from contentEditable elements that inherit
 * Tailwind's CSS custom properties (--tw-*) via the cascade.
 */
export function stripTailwindStyles(html: string): string {
  if (!html) return '';
  return html.replace(/\sstyle="[^"]*"/gi, (match) => {
    const styleContent = match.slice(8, -1); // extract between style=" and "
    const cleaned = styleContent
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--tw-'))
      .join('; ');
    if (!cleaned) return '';
    return ` style="${cleaned}"`;
  });
}

/**
 * Sanitize chat message content for display on the employee side.
 * Strips Tailwind CSS variables and limits allowed tags/attributes.
 */
function cleanWordStyles(html: string): string {
  if (!html) return '';
  return html
    .replace(/class="Mso[^"]*"/gi, '')
    .replace(/\s*mso-[^;:"]+:[^;"]+(;|(?="))/gi, '')
    .replace(/<o:p>\s*<\/o:p>/gi, '')
    .replace(/\sstyle="[^"]*"/gi, (match) => {
      const styleContent = match.slice(8, -1);
      const cleaned = styleContent
        .split(';')
        .map(s => s.trim())
        .filter(s => {
          if (!s) return false;
          if (s.startsWith('--tw-')) return false;
          if (/^mso-/i.test(s)) return false;
          if (/^(background-image|background-attachment|background-repeat|background-position)/i.test(s)) return false;
          return true;
        })
        .join('; ');
      if (!cleaned) return '';
      return ` style="${cleaned}"`;
    });
}

export function sanitizeChatMessage(html: string): string {
  const stripped = cleanWordStyles(stripTailwindStyles(html));
  const withFontSize = convertFontSizeToInline(stripped);
  const withFontColor = convertFontColorToInline(withFontSize);
  return DOMPurify.sanitize(withFontColor, {
    ALLOWED_TAGS: [
      'p', 'br', 'div', 'span', 'strong', 'em', 'u', 'b', 'i', 'font', 's', 'strike', 'del',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li',
      'blockquote', 'code', 'pre',
      'a', 'img', 'hr', 'video', 'source',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    ALLOWED_ATTR: ['style', 'class', 'size', 'color', 'href', 'target', 'rel', 'src', 'alt', 'width', 'height', 'controls', 'autoplay', 'loop', 'muted', 'poster', 'preload', 'playsinline', 'type'],
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[-a-z+.]+(?:[^-a-z+.:]|$))/i,
  });
}
