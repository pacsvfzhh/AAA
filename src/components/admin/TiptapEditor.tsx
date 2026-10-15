import React, { useEffect, useImperativeHandle, forwardRef, useRef, useState } from 'react';
import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { Mark, mergeAttributes, Node } from '@tiptap/core';
import type { CommandProps, RawCommands } from '@tiptap/core';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Video as VideoIcon,
  Undo,
  Redo,
  AlignLeft,
  AlignCenter,
  AlignRight,
  FileText,
  Highlighter,
  Copy,
  Trash2
} from 'lucide-react';
import { formatSupabaseError, supabase } from '../../lib/supabase';
import { uploadStorageObjectWithProgress } from '../../lib/storageUpload';
import { optimizeImageForWeb } from '../../lib/imageOptimizer';

// Custom Video extension for Tiptap
type VideoChain = {
  setVideo: (options: { src: string; poster?: string }) => { run: () => boolean };
};

const MAX_ANNOUNCEMENT_VIDEO_BYTES = 80 * 1024 * 1024;
const MAX_ANNOUNCEMENT_VIDEO_DURATION = 30 * 60;
const MAX_ANNOUNCEMENT_VIDEO_LONG_EDGE = 1920;
const MAX_ANNOUNCEMENT_VIDEO_SHORT_EDGE = 1080;
const MAX_ANNOUNCEMENT_VIDEOS = 3;
const MAX_ANNOUNCEMENT_IMAGES = 30;

interface VideoUploadMetadata {
  duration: number;
  width: number;
  height: number;
  poster: Blob;
}

async function validateMp4VideoCodec(file: File) {
  const sampleSize = Math.min(file.size, 2 * 1024 * 1024);
  const head = await file.slice(0, sampleSize).arrayBuffer();
  const tail = file.size > sampleSize
    ? await file.slice(Math.max(0, file.size - sampleSize)).arrayBuffer()
    : new ArrayBuffer(0);
  const decoder = new TextDecoder('latin1');
  const codecMarkers = `${decoder.decode(head)}${decoder.decode(tail)}`;
  const hasH264 = codecMarkers.includes('avc1') || codecMarkers.includes('avc3');
  const hasHevc = codecMarkers.includes('hvc1') || codecMarkers.includes('hev1');
  if (!hasH264) {
    throw new Error(hasHevc
      ? '检测到 HEVC/H.265 编码，部分 Android 与浏览器会黑屏；请转换为 H.264/AAC MP4'
      : '无法确认影片使用 H.264 编码，请重新导出为 H.264/AAC MP4');
  }
  if (codecMarkers.includes('soun') && !codecMarkers.includes('mp4a')) {
    throw new Error('影片音轨不是通用 AAC 编码，请重新导出为 H.264/AAC MP4');
  }
}

function inspectVideoForUpload(file: File): Promise<VideoUploadMetadata> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    const timeoutId = window.setTimeout(() => finishWithError('读取影片资料超时，请检查影片是否损坏'), 20000);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };
    const finishWithError = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.addEventListener('error', () => finishWithError('此 MP4 的影片编码无法在当前浏览器解码，请使用 H.264/AAC 格式'), { once: true });
    video.addEventListener('loadedmetadata', () => {
      const duration = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) {
        finishWithError('无法读取影片时长或画面尺寸，请重新导出影片');
        return;
      }
      if (duration > MAX_ANNOUNCEMENT_VIDEO_DURATION) {
        finishWithError('影片最长支持 30 分钟，请先剪辑后再上传');
        return;
      }
      if (Math.max(width, height) > MAX_ANNOUNCEMENT_VIDEO_LONG_EDGE || Math.min(width, height) > MAX_ANNOUNCEMENT_VIDEO_SHORT_EDGE) {
        finishWithError('影片最高支持横屏或竖屏 1080p，请降低分辨率后再上传');
        return;
      }

      video.currentTime = Math.min(Math.max(duration * 0.05, 0.1), 3);
      video.addEventListener('seeked', () => {
        const posterWidth = Math.min(width, 960);
        const posterHeight = Math.max(1, Math.round(height * (posterWidth / width)));
        const canvas = document.createElement('canvas');
        canvas.width = posterWidth;
        canvas.height = posterHeight;
        const context = canvas.getContext('2d');
        if (!context) {
          finishWithError('无法建立影片预览图');
          return;
        }

        try {
          context.drawImage(video, 0, 0, posterWidth, posterHeight);
        } catch {
          finishWithError('无法读取影片画面，请确认影片编码兼容浏览器');
          return;
        }

        canvas.toBlob(blob => {
          if (settled) return;
          if (!blob) {
            finishWithError('无法建立影片预览图');
            return;
          }
          settled = true;
          cleanup();
          resolve({ duration, width, height, poster: blob });
        }, 'image/jpeg', 0.78);
      }, { once: true });
    }, { once: true });
    video.src = objectUrl;
    video.load();
  });
}
type TextSizeChain = {
  toggleTextSize: (size: string) => { run: () => boolean };
};
type HighlightChain = {
  setHighlightBg: (color: string) => { run: () => boolean };
  unsetHighlightBg: () => { run: () => boolean };
};

const Video = Node.create({
  name: 'video',

  group: 'block',

  atom: true,

  draggable: true,

  addAttributes() {
    return {
      src: {
        default: null,
      },
      controls: {
        default: true,
      },
      width: {
        default: '100%',
      },
      poster: {
        default: null,
      },
      preload: {
        default: 'metadata',
      },
      playsinline: {
        default: 'true',
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'video',
        getAttrs: (element) => {
          if (typeof element === 'string') return false;
          return {
            src: element.getAttribute('src'),
            poster: element.getAttribute('poster'),
            preload: element.getAttribute('preload') || 'metadata',
            playsinline: element.getAttribute('playsinline') || 'true',
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes, {
      class: 'max-w-full h-auto rounded-lg my-4',
      controls: 'true',
      preload: 'metadata',
      playsinline: 'true',
      src: HTMLAttributes.src,
      poster: HTMLAttributes.poster,
    })];
  },

  addCommands() {
    return {
      setVideo: (options: { src: string; poster?: string }) => ({ commands }: CommandProps) => {
        return commands.insertContent({
          type: this.name,
          attrs: options,
        });
      },
    } as unknown as Partial<RawCommands>;
  },
});

const HighlightMark = Mark.create({
  name: 'highlightBg',
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: el => el.getAttribute('data-bg-color'),
        renderHTML: attrs => {
          if (!attrs.color) return {};
          return { 'data-bg-color': attrs.color, style: `background-color: ${attrs.color}; padding: 0 2px; border-radius: 2px;` };
        },
      },
    };
  },
  parseHTML() { return [{ tag: 'span[data-bg-color]' }]; },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes), 0]; },
  addCommands() {
    return {
      setHighlightBg: (color: string) => ({ commands }: CommandProps) => commands.setMark(this.name, { color }),
      unsetHighlightBg: () => ({ commands }: CommandProps) => commands.unsetMark(this.name),
    } as unknown as Partial<RawCommands>;
  },
});

const QUICK_COPY_GROUP_CLASS_PREFIX = 'message-quick-copy-group-';

const QuickCopyMark = Mark.create({
  name: 'quickCopy',
  inclusive: false,
  addAttributes() {
    return {
      groupId: {
        default: null,
        parseHTML: element => Array.from(element.classList)
          .find(className => className.startsWith(QUICK_COPY_GROUP_CLASS_PREFIX))
          ?.slice(QUICK_COPY_GROUP_CLASS_PREFIX.length) || null,
        renderHTML: attributes => ({
          class: attributes.groupId
            ? `message-quick-copy ${QUICK_COPY_GROUP_CLASS_PREFIX}${attributes.groupId}`
            : 'message-quick-copy',
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span.message-quick-copy' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});

function removeSelectedQuickCopyGroups(editor: Editor) {
  const markType = editor.schema.marks.quickCopy;
  if (!markType) return;

  const { from, to } = editor.state.selection;
  const selectedGroupIds = new Set<string>();
  let containsUngroupedMark = false;

  editor.state.doc.nodesBetween(from, to, node => {
    const mark = node.marks.find(nodeMark => nodeMark.type === markType);
    if (!mark) return;

    const groupId = typeof mark.attrs.groupId === 'string' ? mark.attrs.groupId : '';
    if (groupId) {
      selectedGroupIds.add(groupId);
    } else {
      containsUngroupedMark = true;
    }
  });

  const transaction = editor.state.tr;

  if (containsUngroupedMark) {
    transaction.removeMark(from, to, markType);
  }

  if (selectedGroupIds.size > 0) {
    editor.state.doc.descendants((node, position) => {
      if (!node.isInline) return;

      const mark = node.marks.find(nodeMark => (
        nodeMark.type === markType
        && selectedGroupIds.has(String(nodeMark.attrs.groupId || ''))
      ));
      if (mark) transaction.removeMark(position, position + node.nodeSize, markType);
    });
  }

  if (!transaction.docChanged) {
    editor.chain().focus().unsetMark('quickCopy').run();
    return;
  }

  editor.view.dispatch(transaction);
  editor.commands.focus();
}

// Custom text size extension for inline formatting
const TextSize = Mark.create({
  name: 'textSize',

  addOptions() {
    return {
      types: ['textStyle'],
    };
  },

  addAttributes() {
    return {
      size: {
        default: null,
        parseHTML: element => element.getAttribute('data-size'),
        renderHTML: attributes => {
          if (!attributes.size) {
            return {};
          }
          return {
            'data-size': attributes.size,
            style: `font-size: ${attributes.size}; font-weight: bold;`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-size]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setTextSize: (size: string) => ({ commands }: CommandProps) => {
        return commands.setMark(this.name, { size });
      },
      toggleTextSize: (size: string) => ({ commands, editor }: CommandProps) => {
        const isActive = editor.isActive(this.name, { size });
        if (isActive) {
          return commands.unsetMark(this.name);
        }
        return commands.setMark(this.name, { size });
      },
      unsetTextSize: () => ({ commands }: CommandProps) => {
        return commands.unsetMark(this.name);
      },
    } as unknown as Partial<RawCommands>;
  },
});

interface TiptapEditorProps {
  content: string;
  onChange: (content: string) => void;
  placeholder?: string;
  editable?: boolean;
  adminId: string;
  theme?: 'dark' | 'light';
  enableQuickCopy?: boolean;
  onClearAll?: () => void;
}

export interface TiptapEditorRef {
  insertImage: (url: string) => void;
  insertVideo: (url: string) => void;
  getEditor: () => Editor | null;
  getContent: () => string;
}

const TiptapEditor = forwardRef<TiptapEditorRef, TiptapEditorProps>(({
  content,
  onChange,
  placeholder = '開始輸入公告內容……',
  editable = true,
  adminId,
  theme = 'dark',
  enableQuickCopy = false,
  onClearAll
}, ref) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const wordInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showBgColorPicker, setShowBgColorPicker] = useState(false);
  const isInitialMount = useRef(true);
  const isSyncing = useRef(false);

  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3]
        },
        paragraph: {
          HTMLAttributes: {
            class: 'my-2'
          }
        },
        bulletList: {
          keepMarks: false,
          keepAttributes: false,
          HTMLAttributes: {
            class: 'list-disc pl-6'
          }
        },
        orderedList: {
          keepMarks: false,
          keepAttributes: false,
          HTMLAttributes: {
            class: 'list-decimal pl-6'
          }
        },
        listItem: {
          HTMLAttributes: {
            class: 'ml-0'
          }
        },
        codeBlock: false
      }),
      Image.configure({
        inline: true,
        allowBase64: true,
        HTMLAttributes: {
          class: 'max-w-full h-auto rounded-lg my-4'
        }
      }),
      Video,
      Placeholder.configure({
        placeholder
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      TextStyle,
      Color,
      TextSize,
      HighlightMark,
      ...(enableQuickCopy ? [QuickCopyMark] : [])
    ],
    content,
    editable,
    onUpdate: ({ editor }) => {
      if (!isSyncing.current) {
        const html = editor.getHTML();
        onChange(html);
      }
    },
    editorProps: {
      attributes: {
        class: `prose ${theme === 'light' ? '' : 'prose-invert'} prose-slate max-w-none focus:outline-none min-h-[300px] px-4 py-3`
      }
    },
    parseOptions: {
      preserveWhitespace: 'full'
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: {
        attributes: {
          class: `prose ${theme === 'light' ? '' : 'prose-invert'} prose-slate max-w-none focus:outline-none min-h-[300px] px-4 py-3`
        }
      }
    });
  }, [editor, theme]);

  useEffect(() => {
    if (!editor) return;

    // Skip on initial mount - content is already set in useEditor
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    // Only update if content is significantly different
    const currentHTML = editor.getHTML();
    const normalizedCurrent = currentHTML.replace(/>\s+</g, '><').trim();
    const normalizedNew = content.replace(/>\s+</g, '><').trim();

    if (normalizedNew !== normalizedCurrent && content !== '') {
      isSyncing.current = true;

      editor.commands.setContent(content, { emitUpdate: false });

      // Focus editor immediately after content update so toolbar buttons work
      setTimeout(() => {
        if (editor && !editor.isDestroyed) {
          editor.commands.focus('end');
          // Force focus by triggering a selection
          const { from, to } = editor.state.selection;
          editor.view.focus();
          editor.commands.setTextSelection({ from, to });
        }
        isSyncing.current = false;
      }, 100);
    }
  }, [content, editor]);

  const uploadFileWithProgress = async (
    file: Blob,
    fileName: string,
    bucketName: string,
    onProgress: (progress: number, loaded: number, total: number) => void
  ): Promise<{ data: { path: string } | null; error: { message: string } | null }> => {
    try {
      await uploadStorageObjectWithProgress({
        bucket: bucketName,
        path: fileName,
        body: file,
        onProgress,
      });
      return { data: { path: fileName }, error: null };
    } catch (error) {
      return {
        data: null,
        error: { message: error instanceof Error ? error.message : '上傳失敗' },
      };
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    console.log('Image upload triggered, files:', files);

    if (!files || files.length === 0) {
      console.log('No files selected');
      return;
    }

    const existingImageCount = editor ? (editor.getHTML().match(/<img\b/gi) || []).length : 0;
    if (existingImageCount + files.length > MAX_ANNOUNCEMENT_IMAGES) {
      setUploadStatus(`錯誤：每则内容最多 ${MAX_ANNOUNCEMENT_IMAGES} 张图片`);
      setTimeout(() => setUploadStatus(''), 4000);
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setUploadStatus(`正在上傳 ${files.length} 張圖片……`);

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const baseProgress = (i / files.length) * 100;
        const fileProgressRange = 100 / files.length;

        const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
        console.log(`Processing file: ${file.name}, type: ${file.type}, size: ${fileSizeMB}MB`);
        setUploadStatus(`正在上傳圖片 ${i + 1}/${files.length}：${file.name}（${fileSizeMB}MB）`);

        if (!file.type.startsWith('image/')) {
          console.log('File type rejected:', file.type);
          setUploadStatus(`錯誤：${file.name} 不是圖片檔案`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        if (file.size > 10 * 1024 * 1024) {
          console.log('File too large:', file.size);
          setUploadStatus(`錯誤：${file.name} 超過 10MB`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        setUploadStatus(`正在优化图片 ${i + 1}/${files.length}：${file.name}`);
        const optimizedFile = file.type === 'image/gif' ? file : await optimizeImageForWeb(file);
        const optimizedExtension = optimizedFile.type === 'image/png' ? 'png' : optimizedFile.type === 'image/webp' ? 'webp' : file.type === 'image/gif' ? 'gif' : 'jpg';
        const fileName = `${adminId}/${Date.now()}-${Math.random().toString(36).substring(7)}.${optimizedExtension}`;
        console.log('Uploading to storage:', fileName);

        const { data: uploadData, error: uploadError } = await uploadFileWithProgress(
          optimizedFile,
          fileName,
          'announcement-images',
          (fileProgress, loaded, total) => {
            const totalProgress = baseProgress + (fileProgress / 100) * fileProgressRange;
            setUploadProgress(Math.round(totalProgress));
            const loadedMB = (loaded / (1024 * 1024)).toFixed(2);
            const totalMB = (total / (1024 * 1024)).toFixed(2);
            setUploadStatus(`正在上傳优化后的图片 ${i + 1}/${files.length}：${loadedMB}MB / ${totalMB}MB（${fileProgress}%）`);
          }
        );

        console.log('Upload result:', { uploadData, uploadError });

        if (uploadError) {
          console.error('Upload error:', uploadError);
          setUploadStatus(`上傳 ${file.name} 時發生錯誤：${uploadError.message}`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        const { data: { publicUrl } } = supabase.storage
          .from('announcement-images')
          .getPublicUrl(fileName);

        console.log('Public URL:', publicUrl);

        if (editor) {
          console.log('Inserting image into editor');
          editor.chain().focus().setImage({ src: publicUrl }).run();
        }
      }

      setUploadProgress(100);
      setUploadStatus('上傳完成！');
      setTimeout(() => {
        setUploadStatus('');
        setUploadProgress(0);
      }, 2000);
    } catch (error: unknown) {
      console.error('Error uploading image:', error);
      setUploadStatus(`錯誤：${formatSupabaseError(error)}`);
      setTimeout(() => {
        setUploadStatus('');
        setUploadProgress(0);
      }, 3000);
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleImageButtonClick = () => {
    fileInputRef.current?.click();
  };

  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const existingVideoCount = editor ? (editor.getHTML().match(/<video\b/gi) || []).length : 0;
    if (existingVideoCount + files.length > MAX_ANNOUNCEMENT_VIDEOS) {
      setUploadStatus(`錯誤：每则公告最多 ${MAX_ANNOUNCEMENT_VIDEOS} 段影片`);
      setTimeout(() => setUploadStatus(''), 4000);
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
        const hasMp4Extension = file.name.toLowerCase().endsWith('.mp4');
        const isMp4 = file.type === 'video/mp4' || (file.type === '' && hasMp4Extension);
        if (!isMp4) throw new Error(`${file.name} 不是 MP4。为确保手机与电脑兼容，请使用 H.264/AAC MP4`);
        if (file.size > MAX_ANNOUNCEMENT_VIDEO_BYTES) throw new Error(`${file.name} 超过 80MB，请压缩为 1080p 网页版本后上传`);
        if (document.createElement('video').canPlayType('video/mp4') === '') throw new Error('当前浏览器不支持 MP4 影片上传预览');

        setUploadStatus(`正在检查影片 ${i + 1}/${files.length}：${file.name}（${fileSizeMB}MB）`);
        await validateMp4VideoCodec(file);
        const metadata = await inspectVideoForUpload(file);
        const durationMinutes = Math.ceil(metadata.duration / 60);
        const uploadToken = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const videoPath = `${adminId}/${uploadToken}.mp4`;
        const posterPath = `${adminId}/${uploadToken}-poster.jpg`;
        const baseProgress = (i / files.length) * 100;
        const fileProgressRange = 100 / files.length;

        setUploadStatus(`正在上傳影片 ${i + 1}/${files.length}：${metadata.width}×${metadata.height} · 约 ${durationMinutes} 分钟`);
        const { error: videoUploadError } = await uploadFileWithProgress(
          file,
          videoPath,
          'announcement-images',
          (fileProgress, loaded, total) => {
            const totalProgress = baseProgress + (fileProgress / 100) * fileProgressRange * 0.95;
            setUploadProgress(Math.round(totalProgress));
            const loadedMB = (loaded / (1024 * 1024)).toFixed(1);
            const totalMB = (total / (1024 * 1024)).toFixed(1);
            setUploadStatus(`正在上傳影片 ${i + 1}/${files.length}：${loadedMB} / ${totalMB}MB（${fileProgress}%）`);
          }
        );
        if (videoUploadError) throw new Error(videoUploadError.message);

        setUploadStatus(`正在建立影片预览图 ${i + 1}/${files.length}……`);
        const optimizedPoster = await optimizeImageForWeb(metadata.poster);
        const { error: posterUploadError } = await uploadFileWithProgress(
          optimizedPoster,
          posterPath,
          'announcement-images',
          () => undefined,
        );
        if (posterUploadError) {
          await supabase.storage.from('announcement-images').remove([videoPath]);
          throw new Error(`预览图上传失败：${posterUploadError.message}`);
        }

        const storage = supabase.storage.from('announcement-images');
        const videoUrl = storage.getPublicUrl(videoPath).data.publicUrl;
        const posterUrl = storage.getPublicUrl(posterPath).data.publicUrl;
        setUploadProgress(Math.round(baseProgress + fileProgressRange));
        if (editor) {
          (editor.chain().focus() as unknown as VideoChain).setVideo({ src: videoUrl, poster: posterUrl }).run();
        }
      }

      setUploadProgress(100);
      setUploadStatus('影片与预览图上传完成！');
      setTimeout(() => {
        setUploadStatus('');
        setUploadProgress(0);
      }, 2500);
    } catch (error: unknown) {
      console.error('Error uploading video:', error);
      setUploadStatus(`錯誤：${formatSupabaseError(error)}`);
      setTimeout(() => {
        setUploadStatus('');
        setUploadProgress(0);
      }, 5000);
    } finally {
      setUploading(false);
      if (videoInputRef.current) videoInputRef.current.value = '';
    }
  };

  const handleVideoButtonClick = () => {
    videoInputRef.current?.click();
  };

  const handleWordImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.docx')) {
      setUploadStatus('錯誤：請選擇 .docx 檔案');
      setTimeout(() => setUploadStatus(''), 3000);
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setUploadStatus('正在讀取 Word 文件……');

    try {
      const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('progress', event => {
          if (!event.lengthComputable) return;
          setUploadProgress(Math.round((event.loaded / event.total) * 20));
        });
        reader.addEventListener('load', () => {
          if (reader.result instanceof ArrayBuffer) resolve(reader.result);
          else reject(new Error('無法讀取 Word 文件'));
        });
        reader.addEventListener('error', () => reject(reader.error || new Error('無法讀取 Word 文件')));
        reader.readAsArrayBuffer(file);
      });
      setUploadProgress(20);
      setUploadStatus('正在載入 Word 轉換器……');
      const mammothModule = await import('mammoth');
      const mammoth = mammothModule.default || mammothModule;
      setUploadProgress(25);
      setUploadStatus('正在轉換 Word 文件……');

      const pendingImages: Array<{
        token: string;
        blob: Blob;
        contentType: string;
        base64: string;
      }> = [];
      const collectImageDuringConversion = async (image: {
        contentType: string;
        read: (encoding?: string) => Promise<string | Buffer>;
      }) => {
        const imageData = await image.read('base64');
        const base64 = typeof imageData === 'string' ? imageData : imageData.toString('base64');
        const contentType = image.contentType || 'image/png';
        const byteString = atob(base64);
        const bytes = new Uint8Array(byteString.length);
        for (let index = 0; index < byteString.length; index++) {
          bytes[index] = byteString.charCodeAt(index);
        }
        const token = `word-import-image-${Date.now()}-${pendingImages.length}-${Math.random().toString(36).slice(2)}`;
        pendingImages.push({ token, blob: new Blob([bytes], { type: contentType }), contentType, base64 });
        return { src: token };
      };

      const convertOptions = mammoth.images?.imgElement
        ? { convertImage: mammoth.images.imgElement(collectImageDuringConversion) }
        : {};

      const result = await mammoth.convertToHtml({ arrayBuffer }, convertOptions);
      let importedHtml = result.value;
      setUploadStatus('正在优化 Word 图片……');
      const preparedImages = await Promise.all(pendingImages.map(async image => {
        if (image.contentType === 'image/gif') return image;
        const optimizedBlob = await optimizeImageForWeb(image.blob);
        return { ...image, blob: optimizedBlob, contentType: optimizedBlob.type || image.contentType };
      }));
      const totalImageBytes = preparedImages.reduce((total, image) => total + image.blob.size, 0);
      let uploadedImageBytes = 0;

      for (let index = 0; index < preparedImages.length; index++) {
        const image = preparedImages[index];
        let ext = image.contentType.split('/')[1] || 'png';
        if (ext === 'jpeg') ext = 'jpg';
        const fileName = `${adminId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

        try {
          await uploadStorageObjectWithProgress({
            bucket: 'chat-images',
            path: fileName,
            body: image.blob,
            contentType: image.contentType,
            onProgress: (_percentage, loaded) => {
              const transferred = uploadedImageBytes + loaded;
              const imageProgress = totalImageBytes > 0 ? transferred / totalImageBytes : 1;
              setUploadProgress(25 + Math.round(imageProgress * 65));
              const loadedMB = (transferred / (1024 * 1024)).toFixed(2);
              const totalMB = (totalImageBytes / (1024 * 1024)).toFixed(2);
              setUploadStatus(`正在上傳 Word 圖片 ${index + 1}/${preparedImages.length}：${loadedMB}MB / ${totalMB}MB`);
            },
          });
          const { data: { publicUrl } } = supabase.storage
            .from('chat-images')
            .getPublicUrl(fileName);
          importedHtml = importedHtml.split(image.token).join(publicUrl);
        } catch (error) {
          console.error('Error uploading Word image:', error);
          importedHtml = importedHtml
            .split(image.token)
            .join(`data:${image.contentType};base64,${image.base64}`);
        }
        uploadedImageBytes += image.blob.size;
      }

      setUploadProgress(95);
      setUploadStatus('正在套用 Word 內容……');

      if (importedHtml) {
        if (editor) {
          editor.chain().focus().insertContent(importedHtml).run();
        }
        setUploadProgress(100);
        setUploadStatus(preparedImages.length > 0
          ? `Word 文件已匯入，包含 ${preparedImages.length} 張优化图片！`
          : 'Word 文件已成功匯入！');
      } else {
        setUploadStatus('錯誤：無法解析文件');
      }

      if (result.messages.length > 0) {
        console.warn('Word import warnings:', result.messages);
      }
    } catch (error: unknown) {
      console.error('Error importing Word document:', formatSupabaseError(error));
      setUploadProgress(0);
      setUploadStatus(`錯誤：${formatSupabaseError(error)}`);
    } finally {
      setUploading(false);
      setTimeout(() => setUploadStatus(''), 3000);
      if (wordInputRef.current) {
        wordInputRef.current.value = '';
      }
    }
  };

  const handleWordButtonClick = () => {
    wordInputRef.current?.click();
  };

  useImperativeHandle(ref, () => ({
    insertImage: (url: string) => {
      if (editor) {
        editor.chain().focus().setImage({ src: url }).run();
      }
    },
    insertVideo: (url: string) => {
      if (editor) {
        (editor.chain().focus() as unknown as VideoChain).setVideo({ src: url }).run();
      }
    },
    getEditor: () => editor,
    getContent: () => {
      if (editor) {
        return editor.getHTML();
      }
      return '';
    }
  }));

  if (!editor) {
    return null;
  }

  const MenuButton = ({
    onClick,
    active,
    children,
    title,
    disabled
  }: {
    onClick: () => void;
    active?: boolean;
    children: React.ReactNode;
    title: string;
    disabled?: boolean;
  }) => {
    return (
      <button
        type="button"
        onMouseDown={(e) => {
          // Prevent default to keep the editor selection
          e.preventDefault();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }}
        title={title}
        disabled={disabled}
        className={`
          p-1.5 rounded-md transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
          ${active
            ? theme === 'light' ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'bg-blue-600 text-white'
            : theme === 'light' ? 'text-slate-500 hover:text-slate-800 hover:bg-slate-200' : 'text-slate-400 hover:text-white hover:bg-slate-700'
          }
        `}
      >
        {children}
      </button>
    );
  };

  return (
    <>
      <style>{`
        .ProseMirror ul,
        .ProseMirror ol {
          padding-left: 2rem !important;
          margin: 1rem 0 !important;
        }
        .ProseMirror ul {
          list-style-type: disc !important;
        }
        .ProseMirror ol {
          list-style-type: decimal !important;
        }
        .ProseMirror li {
          display: list-item !important;
          list-style-position: outside !important;
          margin-left: 0 !important;
          padding-left: 0 !important;
        }
        .ProseMirror ul ul {
          list-style-type: circle !important;
          margin: 0.5rem 0 !important;
        }
        .ProseMirror ol ol {
          list-style-type: lower-alpha !important;
          margin: 0.5rem 0 !important;
        }
        .ProseMirror li p {
          margin: 0 !important;
        }
        .ProseMirror video {
          max-width: 100%;
          height: auto;
          border-radius: 0.5rem;
          margin: 1rem 0;
          display: block;
          background: rgba(0, 0, 0, 0.3);
        }
        .ProseMirror .message-quick-copy {
          border-radius: 0.25rem;
          background: rgba(14, 165, 233, 0.14);
          box-shadow: inset 0 -2px 0 rgba(2, 132, 199, 0.75);
          padding: 0 0.125rem;
        }
        .tiptap-editor-wrapper {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
        }
        .tiptap-editor-wrapper::-webkit-scrollbar {
          width: 8px;
        }
        .tiptap-editor-wrapper::-webkit-scrollbar-track {
          background: rgba(51, 65, 85, 0.3);
          border-radius: 4px;
        }
        .tiptap-editor-wrapper::-webkit-scrollbar-thumb {
          background: rgba(59, 130, 246, 0.5);
          border-radius: 4px;
        }
        .tiptap-editor-wrapper::-webkit-scrollbar-thumb:hover {
          background: rgba(59, 130, 246, 0.7);
        }
        @keyframes shimmer {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(200%);
          }
        }
        .animate-shimmer {
          animation: shimmer 2s infinite;
        }
      `}</style>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleImageUpload}
        multiple
        className="hidden"
        disabled={uploading}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,.mp4"
        onChange={handleVideoUpload}
        multiple
        className="hidden"
        disabled={uploading}
      />
      <input
        ref={wordInputRef}
        type="file"
        accept=".docx"
        onChange={handleWordImport}
        className="hidden"
        disabled={uploading}
      />

      <div className={`rounded-lg overflow-hidden flex flex-col h-full ${theme === 'light' ? 'border-0 bg-white' : 'border border-slate-700 bg-slate-900'}`}>
        {editable && (
          <div className={`flex flex-wrap items-center gap-1 p-2 border-b flex-shrink-0 ${theme === 'light' ? 'border-slate-200 bg-slate-50/80' : 'border-slate-700 bg-slate-800/50'}`}>
            <MenuButton
              onClick={() => editor.chain().focus().toggleBold().run()}
              active={editor.isActive('bold')}
              title="粗體（Ctrl+B）"
            >
              <Bold className="w-4 h-4" />
            </MenuButton>

            <MenuButton
              onClick={() => editor.chain().focus().toggleItalic().run()}
              active={editor.isActive('italic')}
              title="斜體（Ctrl+I）"
            >
              <Italic className="w-4 h-4" />
            </MenuButton>

            <div className={`w-px h-6 mx-1 ${theme === 'light' ? 'bg-slate-200' : 'bg-slate-700'}`} />

            <MenuButton
              onClick={() => (editor.chain().focus() as unknown as TextSizeChain).toggleTextSize('2em').run()}
              active={editor.isActive('textSize', { size: '2em' })}
              title="大字（H1 大小）"
            >
              <Heading1 className="w-4 h-4" />
            </MenuButton>

            <MenuButton
              onClick={() => (editor.chain().focus() as unknown as TextSizeChain).toggleTextSize('1.5em').run()}
              active={editor.isActive('textSize', { size: '1.5em' })}
              title="中等文字（H2 大小）"
            >
              <Heading2 className="w-4 h-4" />
            </MenuButton>

            <MenuButton
              onClick={() => (editor.chain().focus() as unknown as TextSizeChain).toggleTextSize('1.25em').run()}
              active={editor.isActive('textSize', { size: '1.25em' })}
              title="小標題（H3 大小）"
            >
              <Heading3 className="w-4 h-4" />
            </MenuButton>

            <div className={`w-px h-6 mx-1 ${theme === 'light' ? 'bg-slate-200' : 'bg-slate-700'}`} />

            <MenuButton
              onClick={() => {
                const { state } = editor;
                const { from, to, empty } = state.selection;

                if (empty) {
                  // No selection, toggle list for current block
                  editor.commands.toggleBulletList();
                } else {
                  const $from = state.doc.resolve(from);
                  const $to = state.doc.resolve(to);

                  // Check if selection is at block boundaries
                  const isAtBlockStart = from === $from.start($from.depth);
                  const isAtBlockEnd = to === $to.end($to.depth);

                  if (isAtBlockStart && isAtBlockEnd) {
                    // Selection spans complete blocks, safe to toggle
                    editor.commands.toggleBulletList();
                  } else {
                    // Partial selection - split the paragraph first, then apply list
                    const chain = editor.chain();

                    // If not at end, split after selection
                    if (!isAtBlockEnd) {
                      chain.setTextSelection(to).splitBlock();
                    }

                    // If not at start, split before selection
                    if (!isAtBlockStart) {
                      chain.setTextSelection(from).splitBlock();
                    }

                    // Now toggle list on the newly created block
                    chain.toggleBulletList().run();
                  }
                }
              }}
              active={editor.isActive('bulletList')}
              title="項目符號清單"
            >
              <List className="w-4 h-4" />
            </MenuButton>

            <MenuButton
              onClick={() => {
                const { state } = editor;
                const { from, to, empty } = state.selection;

                if (empty) {
                  // No selection, toggle list for current block
                  editor.commands.toggleOrderedList();
                } else {
                  const $from = state.doc.resolve(from);
                  const $to = state.doc.resolve(to);

                  // Check if selection is at block boundaries
                  const isAtBlockStart = from === $from.start($from.depth);
                  const isAtBlockEnd = to === $to.end($to.depth);

                  if (isAtBlockStart && isAtBlockEnd) {
                    // Selection spans complete blocks, safe to toggle
                    editor.commands.toggleOrderedList();
                  } else {
                    // Partial selection - split the paragraph first, then apply list
                    const chain = editor.chain();

                    // If not at end, split after selection
                    if (!isAtBlockEnd) {
                      chain.setTextSelection(to).splitBlock();
                    }

                    // If not at start, split before selection
                    if (!isAtBlockStart) {
                      chain.setTextSelection(from).splitBlock();
                    }

                    // Now toggle list on the newly created block
                    chain.toggleOrderedList().run();
                  }
                }
              }}
              active={editor.isActive('orderedList')}
              title="編號清單"
            >
              <ListOrdered className="w-4 h-4" />
            </MenuButton>

            <div className={`w-px h-6 mx-1 ${theme === 'light' ? 'bg-slate-200' : 'bg-slate-700'}`} />

            <MenuButton
              onClick={() => editor.chain().focus().setTextAlign('left').run()}
              active={editor.isActive({ textAlign: 'left' })}
              title="靠左對齊"
            >
              <AlignLeft className="w-4 h-4" />
            </MenuButton>

            <MenuButton
              onClick={() => editor.chain().focus().setTextAlign('center').run()}
              active={editor.isActive({ textAlign: 'center' })}
              title="置中對齊"
            >
              <AlignCenter className="w-4 h-4" />
            </MenuButton>

            <MenuButton
              onClick={() => editor.chain().focus().setTextAlign('right').run()}
              active={editor.isActive({ textAlign: 'right' })}
              title="靠右對齊"
            >
              <AlignRight className="w-4 h-4" />
            </MenuButton>

            <div className={`w-px h-6 mx-1 ${theme === 'light' ? 'bg-slate-200' : 'bg-slate-700'}`} />

            <div className="relative">
              <MenuButton
                onClick={() => { setShowColorPicker(!showColorPicker); setShowBgColorPicker(false); }}
                title="文字顏色"
              >
                <div className="flex flex-col items-center gap-0">
                  <span className="text-xs font-semibold leading-none">A</span>
                  <div
                    className="w-4 h-1 rounded-sm mt-0.5"
                    style={{ backgroundColor: editor.getAttributes('textStyle').color || (theme === 'light' ? '#000000' : '#ffffff') }}
                  />
                </div>
              </MenuButton>
              {showColorPicker && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowColorPicker(false)}
                  />
                  <div className={`absolute top-full left-0 mt-1 p-2.5 rounded-lg shadow-xl z-20 grid grid-cols-5 gap-1.5 min-w-[160px] ${theme === 'light' ? 'bg-white border border-slate-200 shadow-lg' : 'bg-slate-800 border border-slate-700'}`}>
                    {(theme === 'light' ? ['#000000', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#6366f1', '#14b8a6', '#ffffff'] : ['#ffffff', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#6366f1', '#14b8a6', '#000000']).map(color => (
                      <button
                        key={color}
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          editor.chain().focus().setColor(color).run();
                          setShowColorPicker(false);
                        }}
                        className={`w-7 h-7 rounded-md border-2 hover:scale-110 hover:border-blue-500 transition-all cursor-pointer ${theme === 'light' ? 'border-slate-200' : 'border-slate-600'}`}
                        style={{ backgroundColor: color }}
                        title={color}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="relative">
              <MenuButton
                onClick={() => { setShowBgColorPicker(!showBgColorPicker); setShowColorPicker(false); }}
                active={editor.isActive('highlightBg')}
                title="背景顏色"
              >
                <Highlighter className="w-4 h-4" />
              </MenuButton>
              {showBgColorPicker && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowBgColorPicker(false)}
                  />
                  <div className={`absolute top-full left-0 mt-1 p-2.5 rounded-lg shadow-xl z-20 min-w-[160px] ${theme === 'light' ? 'bg-white border border-slate-200 shadow-lg' : 'bg-slate-800 border border-slate-700'}`}>
                    <div className="grid grid-cols-5 gap-1.5">
                      {['#fef08a', '#bbf7d0', '#bfdbfe', '#fecaca', '#e9d5ff', '#fed7aa', '#fce7f3', '#ccfbf1', '#e2e8f0', '#fde68a'].map(color => (
                        <button
                          key={color}
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            (editor.chain().focus() as unknown as HighlightChain).setHighlightBg(color).run();
                            setShowBgColorPicker(false);
                          }}
                          className={`w-7 h-7 rounded-md border-2 hover:scale-110 hover:border-blue-500 transition-all cursor-pointer ${theme === 'light' ? 'border-slate-200' : 'border-slate-600'}`}
                          style={{ backgroundColor: color }}
                          title={color}
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        (editor.chain().focus() as unknown as HighlightChain).unsetHighlightBg().run();
                        setShowBgColorPicker(false);
                      }}
                      className={`w-full mt-2 px-2 py-1 text-[11px] font-bold rounded-md transition-all text-center ${theme === 'light' ? 'text-red-500 bg-red-50 border border-red-200 hover:bg-red-100' : 'text-red-400 bg-red-900/30 border border-red-700/50 hover:bg-red-900/50'}`}
                    >
                      清除
                    </button>
                  </div>
                </>
              )}
            </div>

            {enableQuickCopy && (
              <MenuButton
                onClick={() => {
                  if (editor.isActive('quickCopy')) {
                    removeSelectedQuickCopyGroups(editor);
                    return;
                  }

                  const groupId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
                  editor.chain().focus().setMark('quickCopy', { groupId }).run();
                }}
                active={editor.isActive('quickCopy')}
                disabled={editor.state.selection.empty}
                title="將選取文字設為快速複製"
              >
                <span className="flex items-center gap-1 whitespace-nowrap px-0.5 text-[11px] font-bold">
                  <Copy className="h-3.5 w-3.5" />
                  快速複製
                </span>
              </MenuButton>
            )}

            <div className={`w-px h-6 mx-1 ${theme === 'light' ? 'bg-slate-200' : 'bg-slate-700'}`} />

            <MenuButton
              onClick={handleImageButtonClick}
              disabled={uploading}
              title={uploading ? uploadStatus : "上傳圖片"}
            >
              <ImageIcon className="w-4 h-4" />
            </MenuButton>

            <MenuButton
              onClick={handleVideoButtonClick}
              disabled={uploading}
              title={uploading ? uploadStatus : "上傳影片（MP4 · H.264/AAC · 最大 80MB · 1080p）"}
            >
              <VideoIcon className="w-4 h-4" />
            </MenuButton>

            <MenuButton
              onClick={handleWordButtonClick}
              disabled={uploading}
              title="匯入 Word 文件（.docx）"
            >
              <FileText className="w-4 h-4" />
            </MenuButton>

            <div className="flex-1" />

            <MenuButton
              onClick={() => editor.chain().focus().undo().run()}
              disabled={!editor.can().chain().focus().undo().run()}
              title="復原（Ctrl+Z）"
            >
              <Undo className="w-4 h-4" />
            </MenuButton>

            <MenuButton
              onClick={() => editor.chain().focus().redo().run()}
              disabled={!editor.can().chain().focus().redo().run()}
              title="重做（Ctrl+Y）"
            >
              <Redo className="w-4 h-4" />
            </MenuButton>

            {onClearAll && (
              <button
                type="button"
                onClick={() => {
                  editor.chain().focus().clearContent().run();
                  onClearAll();
                }}
                title="一键清空输入框内容"
                aria-label="一键清空输入框内容"
                className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-red-400 bg-gradient-to-r from-red-500 to-orange-500 px-2.5 text-[11px] font-black text-white shadow-sm shadow-red-500/25 transition-all hover:border-red-300 hover:from-red-400 hover:to-orange-400 hover:shadow-md hover:shadow-red-500/35 active:scale-[0.98]"
              >
                <Trash2 className="h-3.5 w-3.5" />
                一键清空输入框内容
              </button>
            )}
          </div>
        )}

        <div
          className="tiptap-editor-wrapper"
          onClick={() => editor?.commands.focus()}
        >
          <EditorContent editor={editor} className={theme === 'light' ? 'text-slate-800' : 'text-white'} />
        </div>

        {uploadStatus && (
          <div className={`min-w-0 overflow-hidden px-4 py-3 border-t space-y-2 ${theme === 'light' ? 'bg-slate-50 border-slate-200' : 'bg-slate-800/50 border-slate-700'}`}>
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className={`min-w-0 flex-1 truncate text-xs font-medium ${theme === 'light' ? 'text-slate-600' : 'text-slate-300'}`} title={uploadStatus}>
                {uploading && '⏳ '}{uploadStatus}
              </span>
              {uploading && (
                <span className="shrink-0 text-xs text-blue-500 font-bold tabular-nums">
                  {uploadProgress}%
                </span>
              )}
            </div>
            {uploading && (
              <div className={`w-full rounded-full h-2 overflow-hidden ${theme === 'light' ? 'bg-blue-100' : 'bg-slate-700'}`}>
                <div
                  className="bg-gradient-to-r from-blue-500 to-cyan-500 h-full transition-all duration-300 ease-out"
                  style={{ width: `${uploadProgress}%` }}
                >
                  <div className="h-full w-full bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
});

TiptapEditor.displayName = 'TiptapEditor';

export default TiptapEditor;
