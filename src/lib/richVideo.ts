export interface VideoLabels {
  playVideo: string;
  loadingVideo: string;
  videoUnavailable: string;
  openVideo: string;
  pauseVideo: string;
  muteVideo: string;
  unmuteVideo: string;
  enterFullscreen: string;
  exitFullscreen: string;
  videoProgress: string;
}

export const adminVideoLabels: VideoLabels = {
  playVideo: '播放影片',
  loadingVideo: '正在載入影片…',
  videoUnavailable: '影片暫時無法播放',
  openVideo: '開啟原始影片',
  pauseVideo: '暫停影片',
  muteVideo: '靜音',
  unmuteVideo: '取消靜音',
  enterFullscreen: '全螢幕',
  exitFullscreen: '退出全螢幕',
  videoProgress: '影片進度',
};

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
  volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5a1 1 0 0 0 1 1h3l4.4 3.6a.8.8 0 0 0 1.3-.62V5.52a.8.8 0 0 0-1.3-.62L8 8.5H5a1 1 0 0 0-1 1Z"/><path class="rich-video-icon-stroke" d="M16.5 8.8a4.5 4.5 0 0 1 0 6.4M18.9 6.4a8 8 0 0 1 0 11.2"/></svg>',
  muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5a1 1 0 0 0 1 1h3l4.4 3.6a.8.8 0 0 0 1.3-.62V5.52a.8.8 0 0 0-1.3-.62L8 8.5H5a1 1 0 0 0-1 1Z"/><path class="rich-video-icon-stroke" d="m16.5 9.5 5 5m0-5-5 5"/></svg>',
  expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="rich-video-icon-stroke" d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="rich-video-icon-stroke" d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/></svg>',
};

const CONTROLS_HIDE_DELAY = 2600;
const PREVIEW_READY_TIMEOUT = 10000;

// Reopening the same content within a session reuses the captured preview frame and size, so the video shows at
// its final shape immediately instead of starting at 16:9 and re-capturing. Blob URLs here live for the session.
const previewCache = new Map<string, { width?: number; height?: number; duration?: number; poster?: string }>();

type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type IOSVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitSupportsFullscreen?: boolean };

export function formatVideoTime(value: number) {
  const total = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function getVideoPreviewTimes(duration: number) {
  return [...new Set([0.001, 0.1, 0.5, 1, 2, 3, 5].map(time => Math.min(time, duration / 2)))];
}

export function isBlackVideoPreview(source: CanvasImageSource) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return false;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let visiblePixels = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (Math.max(data[index], data[index + 1], data[index + 2]) > 20) visiblePixels++;
  }
  return visiblePixels < canvas.width * canvas.height * 0.01;
}

function createLoader(label: string) {
  const loader = document.createElement('div');
  loader.className = 'rich-video-loader';
  loader.setAttribute('role', 'status');
  const inner = document.createElement('span');
  inner.className = 'rich-video-loader-inner';
  const glow = document.createElement('span');
  glow.className = 'rich-video-loader-glow';
  const ring = document.createElement('span');
  ring.className = 'rich-video-loader-ring';
  const spin = document.createElement('span');
  spin.className = 'rich-video-loader-spin';
  const dot = document.createElement('span');
  dot.className = 'rich-video-loader-dot';
  ring.append(spin, dot);
  const text = document.createElement('span');
  text.className = 'rich-video-loader-label';
  text.textContent = label;
  inner.append(glow, ring, text);
  loader.append(inner);
  return loader;
}

function createIconButton(className: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `rich-video-control ${className}`;
  return button;
}

export function enhanceRichVideos(container: HTMLElement, labels: VideoLabels = adminVideoLabels) {
  const cleanups: Array<() => void> = [];

  container.querySelectorAll('video').forEach(video => {
    if (video.parentElement?.classList.contains('rich-video-stage')) return;

    const shell = document.createElement('div');
    shell.className = 'rich-video-shell';
    const stage = document.createElement('div');
    stage.className = 'rich-video-stage';
    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'rich-video-cover';
    playButton.setAttribute('aria-label', labels.playVideo);
    const playIcon = document.createElement('span');
    playIcon.className = 'rich-video-play-icon';
    playIcon.setAttribute('aria-hidden', 'true');
    const duration = document.createElement('span');
    duration.className = 'rich-video-duration';
    duration.hidden = true;
    playButton.append(playIcon, duration);

    const loader = createLoader(labels.loadingVideo);
    const status = document.createElement('div');
    status.className = 'rich-video-status';
    status.setAttribute('role', 'status');
    status.hidden = true;

    const controls = document.createElement('div');
    controls.className = 'rich-video-controls';
    const progress = document.createElement('input');
    progress.type = 'range';
    progress.className = 'rich-video-progress';
    progress.min = '0';
    progress.max = '1000';
    progress.step = '1';
    progress.value = '0';
    progress.setAttribute('aria-label', labels.videoProgress);
    const toggleButton = createIconButton('rich-video-toggle');
    const time = document.createElement('span');
    time.className = 'rich-video-time';
    time.textContent = '0:00 / 0:00';
    const spacer = document.createElement('span');
    spacer.className = 'rich-video-control-spacer';
    const muteButton = createIconButton('rich-video-mute');
    const fullscreenButton = createIconButton('rich-video-fullscreen');
    const buttonRow = document.createElement('div');
    buttonRow.className = 'rich-video-control-row';
    buttonRow.append(toggleButton, time, spacer, muteButton, fullscreenButton);
    controls.append(progress, buttonRow);

    video.parentNode?.insertBefore(shell, video);
    shell.append(stage);
    stage.append(video, loader, playButton, status, controls);

    const originalPoster = video.getAttribute('poster');
    const cacheKey = video.currentSrc || video.getAttribute('src') || video.querySelector('source')?.getAttribute('src') || '';
    const cached = cacheKey ? previewCache.get(cacheKey) : undefined;
    const remember = (entry: { width?: number; height?: number; duration?: number; poster?: string }) => {
      if (!cacheKey) return;
      previewCache.set(cacheKey, { ...previewCache.get(cacheKey), ...entry });
    };
    let disposed = false;
    let started = false;
    let ready = false;
    let capturePending = !video.poster;
    let generatedPoster: string | undefined;
    let captureFrame = 0;
    let captureQueued = false;
    let previewTimes: number[] = [];
    let previewIndex = 0;
    let playTransitionTimer: number | undefined;
    let hideControlsTimer: number | undefined;
    let progressFrame = 0;
    let scrubbing = false;
    const readyTimer = window.setTimeout(() => markReady(), PREVIEW_READY_TIMEOUT);
    const posterImage = new Image();
    posterImage.crossOrigin = 'anonymous';
    const listen = (name: string, handler: () => void) => {
      video.addEventListener(name, handler);
      cleanups.push(() => video.removeEventListener(name, handler));
    };

    function markReady() {
      if (ready || disposed) return;
      ready = true;
      window.clearTimeout(readyTimer);
      shell.classList.add('is-ready');
    }

    const fullscreenDocument = document as FullscreenDocument;
    const iosVideo = video as IOSVideo;
    const fullscreenStage = stage as FullscreenElement;
    const canElementFullscreen = Boolean(fullscreenStage.requestFullscreen || fullscreenStage.webkitRequestFullscreen);
    const canFullscreen = canElementFullscreen || typeof iosVideo.webkitEnterFullscreen === 'function';
    fullscreenButton.hidden = !canFullscreen;
    const isStageFullscreen = () => (fullscreenDocument.fullscreenElement || fullscreenDocument.webkitFullscreenElement) === stage;

    const renderToggle = () => {
      const paused = video.paused || video.ended;
      toggleButton.innerHTML = paused ? ICONS.play : ICONS.pause;
      toggleButton.setAttribute('aria-label', paused ? labels.playVideo : labels.pauseVideo);
    };
    const renderMute = () => {
      const muted = video.muted || video.volume === 0;
      muteButton.innerHTML = muted ? ICONS.muted : ICONS.volume;
      muteButton.setAttribute('aria-label', muted ? labels.unmuteVideo : labels.muteVideo);
      muteButton.setAttribute('aria-pressed', String(muted));
    };
    const renderFullscreen = () => {
      const active = isStageFullscreen();
      shell.classList.toggle('is-fullscreen', active);
      fullscreenButton.innerHTML = active ? ICONS.collapse : ICONS.expand;
      fullscreenButton.setAttribute('aria-label', active ? labels.exitFullscreen : labels.enterFullscreen);
    };
    const renderProgress = () => {
      const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const current = Math.min(video.currentTime || 0, total || Infinity);
      if (!scrubbing) progress.value = String(total ? Math.round((current / total) * 1000) : 0);
      let buffered = 0;
      for (let index = 0; index < video.buffered.length; index++) {
        if (video.buffered.start(index) <= current + 0.5) buffered = Math.max(buffered, video.buffered.end(index));
      }
      controls.style.setProperty('--rich-video-progress', `${Number(progress.value) / 10}%`);
      controls.style.setProperty('--rich-video-buffered', `${total ? Math.min(100, (buffered / total) * 100) : 0}%`);
      time.textContent = `${formatVideoTime(scrubbing && total ? (Number(progress.value) / 1000) * total : current)} / ${formatVideoTime(total)}`;
      progress.setAttribute('aria-valuetext', time.textContent);
    };
    const tickProgress = () => {
      renderProgress();
      progressFrame = video.paused ? 0 : requestAnimationFrame(tickProgress);
    };

    // Only keyboard focus pins the bar; focus left behind by a mouse click or tap must not keep it on screen.
    const controlsHaveFocus = () => {
      const active = document.activeElement;
      return active instanceof HTMLElement && controls.contains(active) && active.matches(':focus-visible');
    };
    const scheduleHideControls = () => {
      window.clearTimeout(hideControlsTimer);
      if (video.paused || scrubbing) return;
      hideControlsTimer = window.setTimeout(() => {
        if (video.paused || scrubbing || controlsHaveFocus()) return;
        shell.classList.remove('controls-visible');
      }, CONTROLS_HIDE_DELAY);
    };
    const revealControls = () => {
      if (!started) return;
      shell.classList.add('controls-visible');
      scheduleHideControls();
    };

    const resetPlayTransition = () => {
      window.clearTimeout(playTransitionTimer);
      playTransitionTimer = undefined;
      shell.classList.remove('is-starting');
    };
    const hidePlayButton = () => {
      if (playButton.hidden || playTransitionTimer !== undefined) return;
      shell.classList.add('is-starting');
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        playButton.hidden = true;
        shell.classList.remove('is-starting');
        return;
      }
      playTransitionTimer = window.setTimeout(() => {
        playTransitionTimer = undefined;
        playButton.hidden = !video.paused;
        shell.classList.remove('is-starting');
      }, 200);
    };
    const setSize = (width: number, height: number) => {
      if (!(width > 0 && height > 0)) return;
      stage.style.aspectRatio = `${width} / ${height}`;
      shell.style.setProperty('--rich-video-width', `${Math.min(800, Math.round(480 * width / height))}px`);
      remember({ width, height });
    };
    const showDuration = (seconds: number) => {
      if (!(Number.isFinite(seconds) && seconds > 0)) return;
      duration.textContent = formatVideoTime(Math.ceil(seconds));
      duration.hidden = false;
    };
    const watchPoster = () => {
      posterImage.onload = () => {
        if (disposed) return;
        if (!video.videoWidth) setSize(posterImage.naturalWidth, posterImage.naturalHeight);
        if (started || generatedPoster) {
          markReady();
          return;
        }
        try {
          if (isBlackVideoPreview(posterImage)) {
            capturePending = true;
            preparePreview();
            return;
          }
        } catch {
          // A readable poster remains usable when its host does not permit pixel inspection.
        }
        markReady();
      };
      posterImage.onerror = () => {
        if (disposed || started) return;
        video.removeAttribute('poster');
        capturePending = true;
        preparePreview();
      };
      posterImage.src = video.poster;
    };
    const showError = () => {
      if (disposed) return;
      markReady();
      resetPlayTransition();
      capturePending = false;
      shell.classList.add('is-error');
      shell.classList.remove('is-buffering', 'controls-visible');
      playButton.hidden = true;
      status.replaceChildren(document.createTextNode(labels.videoUnavailable));
      const source = video.currentSrc || video.src || video.querySelector('source')?.src;
      if (source && /^https?:/.test(source)) {
        const link = document.createElement('a');
        link.href = source;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = labels.openVideo;
        status.append(link);
      }
      status.hidden = false;
    };
    const captureOpeningFrame = () => {
      if (disposed || started || !capturePending || video.readyState < 2 || video.seeking) return;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      try {
        const context = canvas.getContext('2d');
        if (!context) {
          capturePending = false;
          markReady();
          return;
        }
        if (isBlackVideoPreview(video) && previewIndex < previewTimes.length - 1) {
          video.currentTime = previewTimes[++previewIndex];
          return;
        }
        capturePending = false;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          if (disposed || started) return;
          if (!blob) {
            markReady();
            return;
          }
          generatedPoster = URL.createObjectURL(blob);
          remember({ poster: generatedPoster });
          video.poster = generatedPoster;
          watchPoster();
        }, 'image/jpeg', 0.8);
      } catch {
        capturePending = false;
        // Cross-origin videos can still display their decoded opening frame without a canvas poster.
        markReady();
      }
    };
    const queueCapture = () => {
      if (disposed || started || !capturePending || captureQueued) return;
      captureQueued = true;
      // Some decoders report loadeddata before the first frame can be drawn to a canvas.
      captureFrame = requestAnimationFrame(() => {
        captureFrame = requestAnimationFrame(() => {
          captureQueued = false;
          captureOpeningFrame();
        });
      });
    };
    const preparePreview = () => {
      if (disposed) return;
      setSize(video.videoWidth, video.videoHeight);
      renderProgress();
      if (Number.isFinite(video.duration) && video.duration > 0) {
        showDuration(video.duration);
        remember({ duration: video.duration });
      }
      if (!capturePending || started || previewTimes.length) return;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        previewTimes = getVideoPreviewTimes(video.duration);
        video.currentTime = previewTimes[0];
      }
    };
    const onPlay = () => {
      started = true;
      capturePending = false;
      markReady();
      shell.classList.add('has-started');
      const wasFocused = document.activeElement === playButton;
      hidePlayButton();
      video.tabIndex = 0;
      if (wasFocused) toggleButton.focus({ preventScroll: true });
      status.hidden = true;
      renderToggle();
      revealControls();
      cancelAnimationFrame(progressFrame);
      progressFrame = requestAnimationFrame(tickProgress);
    };
    const onPlaying = () => {
      onPlay();
      shell.classList.remove('is-buffering');
    };
    const onWaiting = () => {
      if (!started || video.paused) return;
      shell.classList.add('is-buffering');
    };
    const onEnded = () => {
      resetPlayTransition();
      started = false;
      shell.classList.remove('has-started', 'is-buffering', 'controls-visible');
      window.clearTimeout(hideControlsTimer);
      status.hidden = true;
      playButton.hidden = false;
      renderToggle();
      renderProgress();
    };
    const onPause = () => {
      renderToggle();
      renderProgress();
      if (disposed || !started || video.error) return;
      resetPlayTransition();
      shell.classList.remove('is-buffering');
      shell.classList.add('controls-visible');
      window.clearTimeout(hideControlsTimer);
      status.hidden = true;
      playButton.hidden = false;
    };
    const play = () => {
      if (shell.classList.contains('is-starting')) return;
      shell.classList.add('is-starting');
      capturePending = false;
      if (!started && previewTimes.length) video.currentTime = 0;
      video.play().catch(() => {
        if (disposed || video.error || !video.paused) return;
        resetPlayTransition();
        shell.classList.remove('is-buffering');
        playButton.hidden = false;
        status.hidden = true;
      });
    };
    const togglePlayback = () => {
      if (video.paused || video.ended) play();
      else video.pause();
    };
    const toggleMute = () => {
      if (video.muted || video.volume === 0) {
        video.muted = false;
        if (video.volume === 0) video.volume = 1;
      } else {
        video.muted = true;
      }
      renderMute();
      revealControls();
    };
    const toggleFullscreen = () => {
      revealControls();
      if (isStageFullscreen()) {
        void Promise.resolve(fullscreenDocument.exitFullscreen ? fullscreenDocument.exitFullscreen() : fullscreenDocument.webkitExitFullscreen?.()).catch(() => undefined);
        return;
      }
      if (canElementFullscreen) {
        const request = fullscreenStage.requestFullscreen
          ? fullscreenStage.requestFullscreen({ navigationUI: 'hide' })
          : fullscreenStage.webkitRequestFullscreen?.();
        void Promise.resolve(request).catch(() => undefined);
      } else {
        iosVideo.webkitEnterFullscreen?.();
      }
    };
    const seekToProgress = () => {
      if (!(Number.isFinite(video.duration) && video.duration > 0)) return;
      video.currentTime = (Number(progress.value) / 1000) * video.duration;
      renderProgress();
    };
    const onProgressInput = () => {
      scrubbing = true;
      shell.classList.add('controls-visible');
      window.clearTimeout(hideControlsTimer);
      seekToProgress();
    };
    const onProgressChange = () => {
      seekToProgress();
      scrubbing = false;
      renderProgress();
      scheduleHideControls();
    };
    const onProgressPointerUp = () => {
      if (!scrubbing) return;
      scrubbing = false;
      renderProgress();
      scheduleHideControls();
    };

    let touchStart: { x: number; y: number } | undefined;
    let touchHandled = false;
    const onPointerDown = (event: PointerEvent) => {
      touchHandled = false;
      touchStart = event.pointerType === 'touch' ? { x: event.clientX, y: event.clientY } : undefined;
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = touchStart;
      touchStart = undefined;
      if (!start || event.target !== video || !started) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return;
      event.preventDefault();
      event.stopPropagation();
      touchHandled = true;
      // A tap first brings the hidden controls back; the next tap pauses or resumes.
      if (!shell.classList.contains('controls-visible')) revealControls();
      else togglePlayback();
    };
    const onVideoClick = (event: MouseEvent) => {
      if (event.target !== video || event.detail === 0) return;
      if (touchHandled) {
        touchHandled = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!started) return;
      event.preventDefault();
      togglePlayback();
      revealControls();
    };
    const onStageMouseMove = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') revealControls();
    };
    const onStageMouseLeave = () => {
      if (!video.paused && !scrubbing && !controlsHaveFocus()) shell.classList.remove('controls-visible');
    };
    const onStageKeyDown = (event: KeyboardEvent) => {
      if (!started || event.target === progress) return;
      const target = event.target as HTMLElement;
      if (target !== video && target !== stage) return;
      if (event.key === ' ' || event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (event.key === 'ArrowLeft' ? -5 : 5)));
      } else if (event.key === 'f' || event.key === 'F') {
        if (canFullscreen) toggleFullscreen();
      } else if (event.key === 'm' || event.key === 'M') {
        toggleMute();
      } else {
        return;
      }
      revealControls();
    };
    const onFullscreenChange = () => renderFullscreen();

    video.autoplay = false;
    video.removeAttribute('autoplay');
    video.controls = false;
    video.preload = 'metadata';
    video.playsInline = true;
    video.setAttribute('webkit-playsinline', 'true');
    renderToggle();
    renderMute();
    renderFullscreen();
    playButton.addEventListener('click', play);
    toggleButton.addEventListener('click', togglePlayback);
    muteButton.addEventListener('click', toggleMute);
    fullscreenButton.addEventListener('click', toggleFullscreen);
    progress.addEventListener('input', onProgressInput);
    progress.addEventListener('change', onProgressChange);
    progress.addEventListener('pointerup', onProgressPointerUp);
    controls.addEventListener('focusin', revealControls);
    controls.addEventListener('focusout', scheduleHideControls);
    stage.addEventListener('pointerdown', onPointerDown, true);
    stage.addEventListener('pointerup', onPointerUp, true);
    stage.addEventListener('click', onVideoClick, true);
    stage.addEventListener('pointermove', onStageMouseMove);
    stage.addEventListener('mouseleave', onStageMouseLeave);
    stage.addEventListener('keydown', onStageKeyDown);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    listen('loadedmetadata', preparePreview);
    listen('durationchange', renderProgress);
    listen('loadeddata', queueCapture);
    listen('seeked', queueCapture);
    listen('seeked', renderProgress);
    listen('timeupdate', renderProgress);
    listen('progress', renderProgress);
    listen('volumechange', renderMute);
    listen('play', onPlay);
    listen('playing', onPlaying);
    listen('waiting', onWaiting);
    listen('canplay', () => shell.classList.remove('is-buffering'));
    listen('pause', onPause);
    listen('ended', onEnded);
    listen('error', showError);
    if (cached?.width && cached.height) setSize(cached.width, cached.height);
    if (cached?.duration) showDuration(cached.duration);
    if (cached?.poster) {
      generatedPoster = cached.poster;
      capturePending = false;
      video.poster = cached.poster;
      markReady();
    } else if (cached && video.poster && !capturePending) {
      markReady();
    }
    if (video.poster) watchPoster();
    if (video.readyState >= 1) preparePreview();
    if (video.readyState >= 2) queueCapture();
    if (video.error) showError();

    cleanups.push(() => {
      disposed = true;
      resetPlayTransition();
      window.clearTimeout(readyTimer);
      window.clearTimeout(hideControlsTimer);
      cancelAnimationFrame(captureFrame);
      cancelAnimationFrame(progressFrame);
      posterImage.onload = null;
      posterImage.onerror = null;
      playButton.removeEventListener('click', play);
      toggleButton.removeEventListener('click', togglePlayback);
      muteButton.removeEventListener('click', toggleMute);
      fullscreenButton.removeEventListener('click', toggleFullscreen);
      progress.removeEventListener('input', onProgressInput);
      progress.removeEventListener('change', onProgressChange);
      progress.removeEventListener('pointerup', onProgressPointerUp);
      controls.removeEventListener('focusin', revealControls);
      controls.removeEventListener('focusout', scheduleHideControls);
      stage.removeEventListener('pointerdown', onPointerDown, true);
      stage.removeEventListener('pointerup', onPointerUp, true);
      stage.removeEventListener('click', onVideoClick, true);
      stage.removeEventListener('pointermove', onStageMouseMove);
      stage.removeEventListener('mouseleave', onStageMouseLeave);
      stage.removeEventListener('keydown', onStageKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      if (isStageFullscreen()) void Promise.resolve(fullscreenDocument.exitFullscreen?.()).catch(() => undefined);
      video.pause();
      video.controls = true;
      if (generatedPoster) {
        if (originalPoster) video.setAttribute('poster', originalPoster);
        else video.removeAttribute('poster');
        if (previewCache.get(cacheKey)?.poster !== generatedPoster) URL.revokeObjectURL(generatedPoster);
      }
      shell.replaceWith(video);
    });
  });

  return () => cleanups.forEach(cleanup => cleanup());
}
