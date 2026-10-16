import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Calendar, Pin, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { marked } from 'marked';
import { sanitizeAnnouncementContent } from '../lib/sanitizeHTML';
import PageLoader from './employee/PageLoader';
import PanelColorBlocks from './employee/PanelColorBlocks';

marked.setOptions({ breaks: true, gfm: true });

interface AnnouncementDetailModalProps {
  title: string;
  content: string;
  publishAt: string;
  isPinned: boolean;
  onClose: () => void;
  CategoryIcon?: LucideIcon;
  dateLocale?: string;
  pinnedLabel?: string;
  closeLabel?: string;
  contentLoading?: boolean;
  isMobileDevice?: boolean;
  isIOS?: boolean;
}

// Layout jumps once, then everything after the image slides from its old spot via transform: no per-frame
// layout, so text neither stutters nor reflows. Skipped for images above the viewport (scroll anchoring handles those).
function glideFollowingContent(frame: HTMLElement, delta: number, container: HTMLElement) {
  if (Math.abs(delta) < 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const scroller = container.closest('.announcement-detail-scroll');
  if (scroller && frame.getBoundingClientRect().bottom - delta <= scroller.getBoundingClientRect().top) return;
  const timing: KeyframeAnimationOptions = { duration: 480, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };
  const following: Element[] = [];
  for (let node: Element | null = frame; node && node !== container; node = node.parentElement) {
    for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling) following.push(sibling);
  }
  const reach = window.innerHeight * 2;
  following.filter(element => element.getBoundingClientRect().top < reach).forEach(element => {
    element.animate(
      [{ transform: `translateY(${-delta}px)` }, { transform: 'translateY(0)' }],
      { ...timing, composite: 'add' },
    );
  });
}

export default function AnnouncementDetailModal({
  title,
  content,
  publishAt,
  isPinned,
  onClose,
  CategoryIcon = Bell,
  dateLocale,
  pinnedLabel = 'Pinned',
  closeLabel = 'Close',
  contentLoading = false,
  isMobileDevice = typeof window !== 'undefined' && window.innerWidth < 600,
  isIOS = false,
}: AnnouncementDetailModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [imageLoaderHosts, setImageLoaderHosts] = useState<HTMLElement[]>([]);
  const sanitizedContent = useMemo(() => {
    if (!content) return '';
    const rendered = content.trim().startsWith('<') ? content : marked(content);
    return sanitizeAnnouncementContent(typeof rendered === 'string' ? rendered : '');
  }, [content]);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const imageCleanups: Array<() => void> = [];
    const loaderHosts: HTMLElement[] = [];
    container.querySelectorAll('img').forEach(img => {
      if ((img.complete && img.naturalWidth > 0) || img.parentElement?.classList.contains('announcement-img-frame')) return;
      const frame = document.createElement('span');
      frame.className = 'announcement-img-frame';
      const width = Number(img.getAttribute('width'));
      const height = Number(img.getAttribute('height'));
      if (width > 0 && height > 0) frame.style.aspectRatio = `${width} / ${height}`;
      const loaderHost = document.createElement('span');
      loaderHost.className = 'announcement-img-loader';
      img.parentNode?.insertBefore(frame, img);
      frame.append(loaderHost, img);
      loaderHosts.push(loaderHost);
      const placeholderHeight = frame.offsetHeight;

      let cancelled = false;
      let unmountTimer: number | undefined;
      // The browser sizes the <img> the moment it loads, before decode finishes; hold the placeholder height until the reveal.
      const holdPlaceholder = () => { frame.style.height = `${placeholderHeight}px`; };
      const settle = (failed: boolean) => {
        if (cancelled) return;
        const startHeight = frame.offsetHeight;
        frame.style.height = '';
        // The loader keeps its placeholder size while fading out, so the frame resizing never stretches it.
        frame.style.setProperty('--placeholder-height', `${startHeight}px`);
        // Without known dimensions the frame resizes, so let the content below slide clear before the image fades in over it.
        if (!frame.style.aspectRatio && !failed) frame.style.setProperty('--img-fade-delay', '.28s');
        frame.classList.add('is-loaded');
        if (failed) frame.classList.add('is-error');
        glideFollowingContent(frame, frame.offsetHeight - startHeight, container);
        unmountTimer = window.setTimeout(() => {
          setImageLoaderHosts(prev => prev.filter(host => host !== loaderHost));
        }, 450);
      };
      const reveal = () => {
        holdPlaceholder();
        // Decode before fading so large images don't drop the first animation frames.
        (img.decode ? img.decode() : Promise.resolve()).catch(() => undefined).then(() => settle(false));
      };
      const fail = () => {
        holdPlaceholder();
        settle(true);
      };
      img.addEventListener('load', reveal, { once: true });
      img.addEventListener('error', fail, { once: true });
      imageCleanups.push(() => {
        cancelled = true;
        window.clearTimeout(unmountTimer);
        img.removeEventListener('load', reveal);
        img.removeEventListener('error', fail);
      });
    });
    setImageLoaderHosts(loaderHosts);

    container.querySelectorAll('video').forEach(video => {
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      if (video.parentElement?.classList.contains('announcement-video-shell')) return;

      const shell = document.createElement('div');
      shell.className = 'announcement-video-shell';
      const status = document.createElement('div');
      status.className = 'announcement-video-status';
      status.textContent = video.poster ? '正在载入影片…' : '正在建立影片预览…';
      video.parentNode?.insertBefore(shell, video);
      shell.append(video, status);

      const hideStatus = () => status.classList.add('is-hidden');
      const showStatus = (message: string, isError = false) => {
        status.replaceChildren(document.createTextNode(message));
        if (isError && (video.currentSrc || video.src)) {
          const fallbackLink = document.createElement('a');
          fallbackLink.href = video.currentSrc || video.src;
          fallbackLink.target = '_blank';
          fallbackLink.rel = 'noopener noreferrer';
          fallbackLink.textContent = '打开原始影片';
          fallbackLink.className = 'announcement-video-fallback';
          status.appendChild(fallbackLink);
        }
        status.classList.toggle('is-error', isError);
        status.classList.remove('is-hidden');
      };
      const captureLegacyPoster = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          shell.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
        }
        if (video.poster || !Number.isFinite(video.duration) || video.duration <= 0) {
          hideStatus();
          return;
        }
        const captureTime = Math.min(Math.max(video.duration * 0.05, 0.1), 2);
        const capture = () => {
          try {
            const width = Math.min(video.videoWidth, 960);
            const height = Math.max(1, Math.round(video.videoHeight * (width / video.videoWidth)));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            if (!context || width <= 0) throw new Error('Frame unavailable');
            context.drawImage(video, 0, 0, width, height);
            video.poster = canvas.toDataURL('image/jpeg', 0.75);
          } catch {
            showStatus('影片已就绪，点击播放', false);
            return;
          }
          video.currentTime = 0;
          hideStatus();
        };
        video.addEventListener('seeked', capture, { once: true });
        video.currentTime = captureTime;
      };

      video.addEventListener('loadedmetadata', captureLegacyPoster, { once: true });
      video.addEventListener('canplay', hideStatus);
      video.addEventListener('playing', hideStatus);
      video.addEventListener('waiting', () => showStatus('正在缓冲影片…'));
      video.addEventListener('error', () => showStatus('此影片无法播放，请使用 MP4（H.264/AAC）格式', true));
      if (video.readyState >= 1) captureLegacyPoster();
    });

    return () => {
      imageCleanups.forEach(cleanup => cleanup());
      setImageLoaderHosts([]);
    };
  }, [sanitizedContent]);

  return createPortal(
    <div
      className="employee-modal-backdrop fixed inset-0 z-[10000] flex touch-none items-stretch justify-stretch overflow-hidden p-0 xl:items-center xl:justify-center xl:p-6"
      onClick={onClose}
      style={{
        background: isMobileDevice ? 'rgba(15, 23, 42, 0.7)' : 'rgba(15, 23, 42, 0.6)',
        backdropFilter: isMobileDevice ? 'none' : 'blur(4px)',
        WebkitBackdropFilter: isMobileDevice ? 'none' : 'blur(4px)',
        animation: isIOS ? 'none' : 'announcement-detail-fade 0.2s ease-out',
        willChange: isIOS ? 'auto' : 'opacity',
        WebkitTapHighlightColor: 'transparent',
        overscrollBehavior: 'contain',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="announcement-detail-title"
        className="employee-modal-surface relative flex h-full w-full flex-col overflow-hidden rounded-none bg-white xl:h-auto xl:max-h-[85vh] xl:w-[680px] xl:max-w-3xl xl:rounded-2xl"
        onClick={event => event.stopPropagation()}
        style={{
          animation: isMobileDevice ? 'none' : 'announcement-detail-scale 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
          boxShadow: isMobileDevice ? 'none' : '0 25px 60px -12px rgba(0, 0, 0, 0.25)',
        }}
      >
        <div
          className="relative shrink-0 overflow-hidden"
          style={{
            paddingTop: isMobileDevice ? 'calc(env(safe-area-inset-top) + 12px)' : '20px',
            paddingBottom: '12px',
            paddingLeft: '20px',
            paddingRight: '20px',
            background: 'linear-gradient(135deg, #1e40af 0%, #2563eb 40%, #3b82f6 70%, #1d4ed8 100%)',
          }}
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute -left-10 -top-14 h-32 w-32 rotate-[18deg] rounded-[30%] bg-white/10" />
            <div className="absolute -bottom-12 left-[26%] h-28 w-28 -rotate-[18deg] rounded-[30%] bg-cyan-300/15" />
            <div className="absolute bottom-3 left-[52%] h-9 w-9 rotate-12 rounded-xl bg-white/[0.07]" />
            <div className="absolute left-[40%] top-3 h-4 w-4 -rotate-6 rounded-md bg-sky-200/15" />
            <div className="absolute left-0 right-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
          </div>

          <button
            type="button"
            onClick={onClose}
            className="announcement-detail-close emp-close-btn emp-close-btn--wrap group absolute right-3 top-3 z-20 flex items-center justify-center rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            style={{
              touchAction: 'manipulation',
              top: isMobileDevice ? 'calc(env(safe-area-inset-top) + 12px)' : '16px',
            }}
            aria-label={closeLabel}
          >
            <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-white/15 backdrop-blur-sm transition-all group-hover:bg-white/25 group-active:scale-90 group-active:bg-white/30">
              <X className="h-4 w-4 shrink-0 text-white" />
            </span>
          </button>

          <div className="relative z-10">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {isPinned && (
                <div className="flex items-center gap-1 rounded-full bg-amber-500 px-2.5 py-1 shadow-sm shadow-amber-700/30">
                  <Pin className="h-3 w-3 fill-white text-white" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-white">{pinnedLabel}</span>
                </div>
              )}
              <div className="flex items-center gap-1.5 rounded-full border border-white/20 bg-white/15 px-2.5 py-1">
                <Calendar className="h-3 w-3 text-blue-100" />
                <span className="text-[10px] font-medium text-blue-50 sm:text-xs">
                  {new Date(publishAt).toLocaleDateString(dateLocale, {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="shrink-0 rounded-xl border border-white/20 bg-white/15 p-2.5 shadow-lg shadow-blue-900/20 backdrop-blur-sm">
                <CategoryIcon className="h-6 w-6 text-white" />
              </div>
              <h2 id="announcement-detail-title" className="break-words pr-8 text-lg font-bold leading-snug text-white sm:text-xl">
                {title}
              </h2>
            </div>
          </div>

          <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-blue-400/30 via-blue-300/50 to-blue-400/30" />
        </div>

        <div
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
          style={{ background: 'linear-gradient(160deg, #ffffff 0%, #f0f7ff 40%, #e6f2fe 100%)' }}
        >
        <PanelColorBlocks />
        <div className="pointer-events-none absolute left-6 right-6 top-0 z-10 h-[2px] rounded-full bg-gradient-to-r from-transparent via-blue-300 to-transparent" aria-hidden="true" />
        <div
          className="announcement-detail-scroll relative min-h-0 flex-1 overflow-y-auto"
          style={{
            WebkitOverflowScrolling: 'touch',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
            padding: isMobileDevice ? '12px 16px 16px' : '20px 24px 24px',
          }}
        >
          <div className="relative" style={{ minHeight: contentLoading ? '60vh' : 'auto' }}>
            {contentLoading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <PageLoader variant="panel" className="!min-h-0" />
              </div>
            ) : (
              <div
                ref={contentRef}
                className="announcement-detail-content relative"
                style={{ fontSize: '15px', lineHeight: '1.6', color: '#374151' }}
                dangerouslySetInnerHTML={{ __html: sanitizedContent }}
              />
            )}
            {imageLoaderHosts.map(host => createPortal(<PageLoader variant="inline" className="!min-h-0 !py-0" />, host))}
          </div>
        </div>
        </div>

        <div
          className="relative hidden min-h-[68px] shrink-0 border-t border-slate-100 bg-slate-50/80 sm:flex"
          style={{
            paddingTop: '12px',
            paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)',
            paddingLeft: '20px',
            paddingRight: '20px',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            className="relative min-h-[44px] w-full rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-blue-600 hover:shadow-lg hover:shadow-blue-600/30 active:scale-[0.98] active:from-blue-800 active:to-blue-700"
            style={{ touchAction: 'manipulation' }}
          >
            {closeLabel}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes announcement-detail-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes announcement-detail-scale { from { opacity: 0; transform: scale(.95); } to { opacity: 1; transform: scale(1); } }
        button.announcement-detail-close { box-sizing: border-box; width: 44px !important; height: 44px !important; min-width: 44px !important; min-height: 44px !important; padding: 0 !important; }
        .announcement-detail-scroll::-webkit-scrollbar { display: none; }
        .announcement-detail-content { overflow-x: hidden; overflow-wrap: break-word; word-break: break-word; }
        .announcement-detail-content h1,
        .announcement-detail-content h2,
        .announcement-detail-content h3,
        .announcement-detail-content h4 { color: #111827; font-weight: 700; margin-top: 1.1em; margin-bottom: .35em; }
        .announcement-detail-content h1 { font-size: 1.5rem; line-height: 1.3; }
        .announcement-detail-content h2 { font-size: 1.25rem; line-height: 1.35; }
        .announcement-detail-content h3 { font-size: 1.125rem; line-height: 1.4; }
        .announcement-detail-content h4 { font-size: 1rem; line-height: 1.4; }
        .announcement-detail-content > *:first-child { margin-top: 0; }
        @keyframes announcement-img-shimmer { from { background-position: 150% 0; } to { background-position: -50% 0; } }
        .announcement-img-frame { position: relative; display: block; width: 100%; min-height: 200px; margin: 1rem auto; border-radius: .75rem; }
        .announcement-img-frame::before { content: ''; position: absolute; inset: 0; border-radius: inherit; border: 1px solid #e0ecff; background: linear-gradient(100deg, #f8fafc 20%, #eff6ff 45%, #f8fafc 70%) 0 0 / 200% 100%; animation: announcement-img-shimmer 2.4s linear infinite; transition: opacity .45s ease; }
        .announcement-img-loader { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: inherit; transition: opacity .35s ease; }
        .announcement-img-frame.is-loaded .announcement-img-loader { opacity: 0; pointer-events: none; bottom: auto; height: var(--placeholder-height, 100%); transition-duration: .2s; }
        .announcement-detail-content .announcement-img-frame > img { position: relative; z-index: 1; margin: 0 auto; opacity: 0; transition: opacity .4s ease-out var(--img-fade-delay, 0s); }
        .announcement-img-frame.is-loaded { min-height: 0; aspect-ratio: auto !important; }
        .announcement-img-frame.is-loaded::before { opacity: 0; animation: none; transition-duration: .2s; bottom: auto; height: var(--placeholder-height, 100%); }
        .announcement-detail-content .announcement-img-frame.is-loaded > img { opacity: 1; }
        .announcement-detail-content > :first-child > .announcement-img-frame:first-child { margin-top: 0; }
        @media (prefers-reduced-motion: reduce) {
          .announcement-img-frame::before { animation: none; }
          .announcement-detail-content .announcement-img-frame > img { transition: none; }
        }
        .announcement-detail-content > :first-child > img:first-child,
        .announcement-detail-content > img:first-child { margin-top: 0; }
        .announcement-detail-content > *:last-child { margin-bottom: 0; }
        .announcement-detail-content p { margin: 0 0 .65em; color: #374151; }
        .announcement-detail-content p:empty { display: none; }
        .announcement-detail-content ul,
        .announcement-detail-content ol { margin: .4em 0 .7em; padding-left: 1.5em; }
        .announcement-detail-content ul { list-style: disc; }
        .announcement-detail-content ol { list-style: decimal; }
        .announcement-detail-content li { margin-bottom: .2em; color: #374151; }
        .announcement-detail-content strong,
        .announcement-detail-content b { color: #111827; font-weight: 700; }
        .announcement-detail-content a { color: #2563eb; text-decoration: none; border-bottom: 1px solid rgba(37,99,235,.3); }
        .announcement-detail-content blockquote { margin: .75em 0; padding: .65em .9em; border-left: 3px solid #3b82f6; border-radius: 0 .375rem .375rem 0; background: #f8fafc; color: #4b5563; }
        .announcement-detail-content hr { margin: 1.1em 0; border: 0; height: 1px; background: #e5e7eb; }
        .announcement-detail-content table { display: block; width: 100%; max-width: 100%; margin: 1rem 0; overflow-x: auto; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: .5rem; }
        .announcement-detail-content th,
        .announcement-detail-content td { padding: .625rem .75rem; border-bottom: 1px solid #f3f4f6; text-align: left; }
        .announcement-detail-content th { background: #f9fafb; color: #374151; font-size: 12px; font-weight: 600; }
        .announcement-detail-content img { display: block; max-width: 100%; height: auto; margin: 1rem auto; border: 1px solid #e2e8f0; border-radius: .75rem; background: #f8fafc; box-shadow: 0 4px 8px rgba(0,0,0,.08); }
        .announcement-detail-content .video-wrapper { display: block !important; width: fit-content !important; max-width: 100% !important; margin: 1rem auto !important; }
        .announcement-video-shell { position: relative; width: 100%; max-width: 800px; margin: 1rem auto; overflow: hidden; border: 1px solid #cbd5e1; border-radius: .75rem; background: #0f172a; aspect-ratio: 16 / 9; box-shadow: 0 4px 12px rgba(0,0,0,.1); }
        .announcement-detail-content .announcement-video-shell video { display: block; width: 100%; height: 100%; min-height: 180px; margin: 0; border: 0; border-radius: 0; background: #0f172a; object-fit: contain; box-shadow: none; }
        .announcement-video-status { pointer-events: none; position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .75rem; padding: 1rem; background: linear-gradient(135deg,rgba(15,23,42,.76),rgba(30,41,59,.58)); color: #e0f2fe; font-size: 12px; font-weight: 700; text-align: center; transition: opacity .2s ease; }
        .announcement-video-status.is-hidden { opacity: 0; visibility: hidden; }
        .announcement-video-status.is-error { pointer-events: auto; background: linear-gradient(135deg,rgba(69,10,10,.9),rgba(127,29,29,.82)); color: #fee2e2; }
        .announcement-video-fallback { border: 1px solid rgba(254,202,202,.45); border-radius: .5rem; background: rgba(255,255,255,.12); padding: .4rem .75rem; color: #fff; font-size: 11px; font-weight: 800; text-decoration: none; }
        .announcement-video-fallback:hover { background: rgba(255,255,255,.2); }
        .announcement-detail-content video:not(.announcement-video-shell video) { display: block; width: 100%; max-width: min(800px, 100%); height: auto; margin: 1rem auto; border: 1px solid #e2e8f0; border-radius: .75rem; background: #0f172a; object-fit: contain; box-shadow: 0 4px 12px rgba(0,0,0,.1); }
        @media (max-width: 639px) {
          .announcement-detail-content { padding: 0 4px; font-size: 15px !important; line-height: 1.6 !important; letter-spacing: .005em; }
          .announcement-detail-content h1 { font-size: 1.375rem; }
          .announcement-detail-content h2 { font-size: 1.2rem; }
          .announcement-detail-content h3 { font-size: 1.075rem; }
          .announcement-detail-content p { margin-bottom: .65rem; font-size: 15px; line-height: 1.6; }
          .announcement-detail-content blockquote { padding: .75rem 1rem; font-size: 14px; }
          .announcement-detail-content table { display: block; width: 100%; overflow-x: auto; font-size: 13px; }
          .announcement-detail-content .video-wrapper { width: 100% !important; margin: 1.5rem 0 !important; }
          .announcement-video-shell { margin: 1rem 0; }
          .announcement-detail-content .announcement-video-shell video { min-height: 160px; }
        }
        @media (max-width: 359px) {
          .announcement-detail-content { padding: 0; font-size: 14px !important; line-height: 1.55 !important; }
          .announcement-detail-content p,
          .announcement-detail-content li { font-size: 14px; line-height: 1.55; }
          .announcement-detail-content h1 { font-size: 1.25rem; }
          .announcement-detail-content h2 { font-size: 1.125rem; }
          .announcement-detail-content h3 { font-size: 1rem; }
          .announcement-detail-content blockquote { padding: .6rem .8rem; font-size: 13px; }
        }
      `}</style>
    </div>,
    document.body,
  );
}
