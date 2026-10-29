import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Calendar, Pin, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { marked } from 'marked';
import { sanitizeAnnouncementContent } from '../lib/sanitizeHTML';
import { adminVideoLabels, enhanceRichVideos, type VideoLabels } from '../lib/richVideo';
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
  videoLabels?: VideoLabels;
}

const GATE_LOADER_DELAY_MS = 220;
const IMAGE_PLACEHOLDER_DELAY_MS = 160;

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
  videoLabels = adminVideoLabels,
}: AnnouncementDetailModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [imageLoaderHosts, setImageLoaderHosts] = useState<HTMLElement[]>([]);
  const sanitizedContent = useMemo(() => {
    if (!content) return '';
    const rendered = content.trim().startsWith('<') ? content : marked(content);
    return sanitizeAnnouncementContent(typeof rendered === 'string' ? rendered : '');
  }, [content]);

  const [contentReady, setContentReady] = useState(false);
  const [showGateLoader, setShowGateLoader] = useState(false);

  // Images are given their exact box (aspect ratio and width) as soon as the browser knows their size, which is
  // usually long before the pixels arrive. Content stays hidden behind the page loader until then (max 1.2s),
  // so the reveal never moves text; images only fade in place.
  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const imageCleanups: Array<() => void> = [];
    const loaderHosts: HTMLElement[] = [];
    let waiting = 0;
    let scanning = true;
    let revealed = false;
    let gateTimer: number | undefined;
    let loaderTimer: number | undefined;
    const openGate = () => {
      if (revealed) return;
      revealed = true;
      window.clearTimeout(gateTimer);
      window.clearTimeout(loaderTimer);
      setContentReady(true);
    };
    imageCleanups.push(() => {
      window.clearTimeout(gateTimer);
      window.clearTimeout(loaderTimer);
    });

    container.querySelectorAll('img').forEach(img => {
      if ((img.complete && img.naturalWidth > 0) || img.parentElement?.classList.contains('announcement-img-frame')) return;
      const frame = document.createElement('span');
      frame.className = 'announcement-img-frame';
      const shimmer = document.createElement('span');
      shimmer.className = 'announcement-img-shimmer';
      const loaderHost = document.createElement('span');
      loaderHost.className = 'announcement-img-loader';
      img.parentNode?.insertBefore(frame, img);
      frame.append(shimmer, loaderHost, img);
      // Lazy images below the fold never report a size while the text is hidden, which would stall the reveal.
      img.loading = 'eager';
      loaderHosts.push(loaderHost);
      const placeholderHeight = frame.offsetHeight;
      const frameCreatedAt = performance.now();

      let cancelled = false;
      let sized = false;
      let counted = true;
      let pollId = 0;
      let unmountTimer: number | undefined;
      waiting++;
      const resolveGate = () => {
        if (!counted) return;
        counted = false;
        waiting--;
        if (!scanning && waiting === 0) openGate();
      };
      const applySize = () => {
        if (sized || cancelled) return;
        const attrWidth = Number(img.getAttribute('width'));
        const attrHeight = Number(img.getAttribute('height'));
        const useAttrs = attrWidth > 0 && attrHeight > 0;
        const w = useAttrs ? attrWidth : img.naturalWidth;
        const h = useAttrs ? attrHeight : img.naturalHeight;
        if (!(w > 0 && h > 0)) return;
        sized = true;
        const before = frame.offsetHeight;
        frame.style.aspectRatio = `${w} / ${h}`;
        frame.style.maxWidth = `${w}px`;
        frame.classList.add('has-size');
        if (revealed) glideFollowingContent(frame, frame.offsetHeight - before, container);
        resolveGate();
      };
      const pollSize = () => {
        if (sized || cancelled) return;
        applySize();
        if (!sized) pollId = requestAnimationFrame(pollSize);
      };
      applySize();
      if (!sized) pollId = requestAnimationFrame(pollSize);
      // Fallback for images whose size only shows up at load: the browser sizes the <img> before decode finishes, so hold the placeholder height until the reveal.
      const holdPlaceholder = () => { if (!sized) frame.style.height = `${placeholderHeight}px`; };
      const settle = (failed: boolean) => {
        if (cancelled) return;
        resolveGate();
        const startHeight = frame.offsetHeight;
        frame.style.height = '';
        // The loader keeps its placeholder size while fading out, so the frame resizing never stretches it.
        frame.style.setProperty('--placeholder-height', `${startHeight}px`);
        // While the image is held it is already laid out at its real size, so the growth is known before the class flips.
        const growth = failed || sized ? 0 : img.offsetHeight - startHeight;
        // Growing: the content below slides clear first, then the image crossfades with the lingering placeholder.
        if (growth > 1) {
          frame.style.setProperty('--img-fade-delay', '.28s');
          frame.style.setProperty('--placeholder-fade', '.5s');
        } else {
          frame.style.setProperty('--placeholder-fade', sized ? '.4s' : '.2s');
        }
        // Cached images (reopening) finish before the delayed placeholder ever shows, so they appear without a placeholder fade.
        if (performance.now() - frameCreatedAt < IMAGE_PLACEHOLDER_DELAY_MS) frame.classList.add('is-instant');
        frame.classList.add('is-loaded');
        if (failed) frame.classList.add('is-error');
        if (!sized) glideFollowingContent(frame, frame.offsetHeight - startHeight, container);
        unmountTimer = window.setTimeout(() => {
          setImageLoaderHosts(prev => prev.filter(host => host !== loaderHost));
        }, 900);
      };
      const reveal = () => {
        holdPlaceholder();
        // Decode before fading so large images don't drop the first animation frames.
        (img.decode ? img.decode() : Promise.resolve()).catch(() => undefined)
          .then(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
          .then(() => settle(false));
      };
      const fail = () => {
        holdPlaceholder();
        settle(true);
      };
      img.addEventListener('load', reveal, { once: true });
      img.addEventListener('error', fail, { once: true });
      imageCleanups.push(() => {
        cancelled = true;
        cancelAnimationFrame(pollId);
        window.clearTimeout(unmountTimer);
        img.removeEventListener('load', reveal);
        img.removeEventListener('error', fail);
      });
    });
    setImageLoaderHosts(loaderHosts);
    scanning = false;
    setShowGateLoader(false);
    if (waiting === 0) {
      openGate();
    } else {
      setContentReady(false);
      // Reopened announcements usually size their cached images within a frame or two; only a real wait shows the loader.
      loaderTimer = window.setTimeout(() => {
        if (!revealed) setShowGateLoader(true);
      }, GATE_LOADER_DELAY_MS);
      gateTimer = window.setTimeout(openGate, 1200);
    }

    imageCleanups.push(enhanceRichVideos(container, videoLabels));

    return () => {
      imageCleanups.forEach(cleanup => cleanup());
      setImageLoaderHosts([]);
    };
  }, [sanitizedContent, contentLoading, videoLabels]);

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
          <div className="relative" style={{ minHeight: contentLoading || (!contentReady && showGateLoader && sanitizedContent) ? '60vh' : 'auto' }}>
            {contentLoading || (!contentReady && showGateLoader && sanitizedContent) ? (
              <div className="absolute inset-0 flex items-center justify-center" style={{ animation: 'announcement-detail-fade .2s ease-out' }}>
                <PageLoader variant="panel" className="!min-h-0" />
              </div>
            ) : null}
            {!contentLoading && (
              <div
                ref={contentRef}
                className="announcement-detail-content relative"
                style={{
                  fontSize: '15px',
                  lineHeight: '1.6',
                  color: '#374151',
                  // Behind the loader the content is laid out (so images can be measured) but takes no space; during the short
                  // grace period before the loader it keeps its real height, invisibly, so a quick reveal does not resize the panel.
                  height: contentReady || !showGateLoader ? 'auto' : 0,
                  overflow: contentReady ? 'visible' : 'hidden',
                  opacity: contentReady ? 1 : 0,
                  pointerEvents: contentReady ? 'auto' : 'none',
                  transition: 'opacity .18s ease-out',
                }}
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
        @keyframes announcement-img-sweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
        .announcement-img-frame { position: relative; display: block; width: 100%; min-height: 200px; margin: 1rem auto; border-radius: .75rem; }
        .announcement-img-frame::before { content: ''; position: absolute; inset: 0; border-radius: inherit; border: 1px solid #e0ecff; background: #f4f8fd; transition: opacity var(--placeholder-fade, .35s) ease; }
        .announcement-img-shimmer { position: absolute; inset: 0; overflow: hidden; border-radius: inherit; pointer-events: none; transition: opacity var(--placeholder-fade, .35s) ease; }
        .announcement-img-shimmer::before { content: ''; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 25%, rgb(219 234 254 / 85%) 50%, transparent 75%); animation: announcement-img-sweep 1.8s ease-in-out infinite; will-change: transform; }
        .announcement-img-loader { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: inherit; transition: opacity var(--placeholder-fade, .35s) ease; }
        .announcement-img-frame.is-loaded .announcement-img-loader,
        .announcement-img-frame.is-loaded .announcement-img-shimmer { opacity: 0; pointer-events: none; bottom: auto; height: var(--placeholder-height, 100%); }
        .announcement-detail-content .announcement-img-frame > img { position: relative; z-index: 1; margin: 0 auto; opacity: 0; will-change: opacity; transition: opacity .4s ease-out var(--img-fade-delay, 0s); }
        .announcement-img-frame.is-loaded .announcement-img-shimmer::before { animation-play-state: paused; }
        @keyframes announcement-placeholder-in { from { opacity: 0; } }
        .announcement-img-frame:not(.is-loaded)::before,
        .announcement-img-frame:not(.is-loaded) .announcement-img-shimmer,
        .announcement-img-frame:not(.is-loaded) .announcement-img-loader { animation: announcement-placeholder-in .2s ease-out ${IMAGE_PLACEHOLDER_DELAY_MS}ms backwards; }
        .announcement-img-frame.is-instant::before,
        .announcement-img-frame.is-instant .announcement-img-shimmer,
        .announcement-img-frame.is-instant .announcement-img-loader { transition: none; }
        .announcement-detail-content .announcement-img-frame.is-instant > img { transition-duration: .15s; transition-delay: 0s; }
        .announcement-img-frame.has-size { min-height: 0; }
        .announcement-detail-content .announcement-img-frame.has-size > img { width: 100%; height: 100%; margin: 0; }
        .announcement-img-frame.is-loaded:not(.has-size) { min-height: 0; }
        .announcement-img-frame.is-loaded::before { opacity: 0; bottom: auto; height: var(--placeholder-height, 100%); }
        .announcement-detail-content .announcement-img-frame.is-loaded > img { opacity: 1; }
        .announcement-detail-content > :first-child > .announcement-img-frame:first-child { margin-top: 0; }
        @media (prefers-reduced-motion: reduce) {
          .announcement-img-shimmer::before { animation: none; }
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
        .announcement-detail-content .video-wrapper { display: block !important; width: 100% !important; max-width: 100% !important; margin: 1rem auto !important; }
        @media (max-width: 639px) {
          .announcement-detail-content { padding: 0 4px; font-size: 15px !important; line-height: 1.6 !important; letter-spacing: .005em; }
          .announcement-detail-content h1 { font-size: 1.375rem; }
          .announcement-detail-content h2 { font-size: 1.2rem; }
          .announcement-detail-content h3 { font-size: 1.075rem; }
          .announcement-detail-content p { margin-bottom: .65rem; font-size: 15px; line-height: 1.6; }
          .announcement-detail-content blockquote { padding: .75rem 1rem; font-size: 14px; }
          .announcement-detail-content table { display: block; width: 100%; overflow-x: auto; font-size: 13px; }
          .announcement-detail-content .video-wrapper { width: 100% !important; margin: 1.5rem 0 !important; }
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
