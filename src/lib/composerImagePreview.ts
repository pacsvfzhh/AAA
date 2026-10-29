import { stripTailwindStyles } from './sanitizeHTML';

export type ComposerImageTheme = 'orange' | 'emerald';

export function prepareComposerImagePreviews(editor: HTMLElement, theme: ComposerImageTheme) {
  const themeStyle = theme === 'orange'
    ? {
        surface: 'border-orange-300/30 bg-gradient-to-br from-orange-950/95 via-slate-950/95 to-amber-950/80 shadow-[0_10px_30px_rgba(154,52,18,0.22)] ring-1 ring-orange-400/20',
        glow: 'from-orange-400/25 via-amber-300/10',
        ring: 'border-orange-100/15 border-t-orange-200 border-r-amber-300',
        icon: 'text-orange-100',
        core: 'bg-amber-100 shadow-[0_0_12px_rgba(251,146,60,0.9)]',
      }
    : {
        surface: 'border-emerald-300/30 bg-gradient-to-br from-emerald-950/95 via-slate-950/95 to-teal-950/80 shadow-[0_10px_30px_rgba(6,78,59,0.25)] ring-1 ring-emerald-400/20',
        glow: 'from-emerald-400/25 via-teal-300/10',
        ring: 'border-emerald-100/15 border-t-emerald-200 border-r-teal-300',
        icon: 'text-emerald-100',
        core: 'bg-teal-100 shadow-[0_0_12px_rgba(52,211,153,0.9)]',
      };

  editor.querySelectorAll('img').forEach(image => {
    if (image.closest('[data-composer-image-frame]')) return;

    const frame = document.createElement('span');
    frame.dataset.composerImageFrame = 'true';
    frame.className = 'relative inline-flex min-h-[72px] min-w-[72px] max-w-full items-center justify-center overflow-hidden rounded-xl align-middle';

    const loader = document.createElement('span');
    loader.dataset.composerImageLoader = 'true';
    loader.className = `absolute inset-0 z-10 flex items-center justify-center overflow-hidden rounded-xl border shadow-inner backdrop-blur-md ${themeStyle.surface}`;
    loader.setAttribute('role', 'status');
    loader.setAttribute('aria-label', '圖片載入中');
    loader.contentEditable = 'false';

    const glow = document.createElement('span');
    glow.className = `absolute h-16 w-16 animate-pulse rounded-full bg-gradient-to-br ${themeStyle.glow} to-transparent blur-xl`;
    glow.setAttribute('aria-hidden', 'true');

    const orbit = document.createElement('span');
    orbit.className = 'absolute h-12 w-12 rounded-full border border-white/15 shadow-[inset_0_0_12px_rgba(255,255,255,0.04)]';
    orbit.setAttribute('aria-hidden', 'true');

    const spinner = document.createElement('span');
    spinner.className = `absolute h-9 w-9 animate-spin rounded-full border-2 border-transparent ${themeStyle.ring} shadow-[0_0_16px_rgba(255,255,255,0.12)]`;
    spinner.setAttribute('aria-hidden', 'true');

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.6');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.classList.add('relative', 'z-10', 'h-4', 'w-4', themeStyle.icon);
    icon.setAttribute('aria-hidden', 'true');
    const imageOutline = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    imageOutline.setAttribute('x', '3.5');
    imageOutline.setAttribute('y', '4.5');
    imageOutline.setAttribute('width', '17');
    imageOutline.setAttribute('height', '15');
    imageOutline.setAttribute('rx', '2.5');
    const imageDetails = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    imageDetails.setAttribute('d', 'm4 15 4.5-4.5 3.5 3.5 3-3 5 5');
    const imageSun = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    imageSun.setAttribute('cx', '9');
    imageSun.setAttribute('cy', '8.5');
    imageSun.setAttribute('r', '1.25');
    icon.append(imageOutline, imageDetails, imageSun);

    const core = document.createElement('span');
    core.className = `absolute h-1.5 w-1.5 rounded-full ${themeStyle.core}`;
    core.setAttribute('aria-hidden', 'true');
    loader.append(glow, orbit, spinner, icon, core);

    image.classList.add('opacity-0', 'transition-opacity', 'duration-200');
    image.parentNode?.insertBefore(frame, image);
    frame.append(image, loader);

    let settled = false;
    const finishLoading = () => {
      if (settled) return;
      settled = true;
      image.classList.remove('opacity-0');
      loader.remove();
    };
    const decodeAndReveal = () => {
      if (typeof image.decode !== 'function') {
        finishLoading();
        return;
      }
      void image.decode().then(finishLoading, finishLoading);
    };

    image.addEventListener('load', decodeAndReveal, { once: true });
    image.addEventListener('error', finishLoading, { once: true });

    if (image.complete) {
      if (image.naturalWidth > 0) decodeAndReveal();
      else finishLoading();
    }
  });
}

export function cleanupComposerImagePreviews(editor: HTMLElement) {
  editor.querySelectorAll('[data-composer-image-frame]').forEach(frame => {
    if (!frame.querySelector('img')) frame.remove();
  });
}

export function getComposerContentForSend(editor: HTMLElement): string {
  const clone = editor.cloneNode(true) as HTMLElement;

  clone.querySelectorAll('[data-composer-image-loader]').forEach(loader => loader.remove());
  clone.querySelectorAll('[data-composer-image-frame]').forEach(frame => {
    const image = frame.querySelector('img');
    if (!image) {
      frame.remove();
      return;
    }
    image?.classList.remove('opacity-0', 'transition-opacity', 'duration-200');

    const parent = frame.parentNode;
    if (!parent) return;
    while (frame.firstChild) parent.insertBefore(frame.firstChild, frame);
    frame.remove();
  });

  return stripTailwindStyles(clone.innerHTML);
}
