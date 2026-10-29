import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useLanguage } from '../../lib/i18n/context';

const MIN_SCALE = 0.5;
const MAX_SCALE = 5;
const BUTTON_STEP = 0.25;
const SETTLE_TRANSITION = 'transform 0.2s ease-out';

interface Point { x: number; y: number }
interface View { scale: number; x: number; y: number }
interface Gesture { mode: 'pan' | 'pinch'; view: View; point: Point; distance: number }

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

interface ChatImageViewerProps {
  src: string;
  onClose: () => void;
}

// The transform lives in a ref and is written straight to the element: re-rendering per touch move made the whole chat redraw.
export default function ChatImageViewer({ src, onClose }: ChatImageViewerProps) {
  const { t } = useLanguage();
  const overlayRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const view = useRef<View>({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef(0);
  const [percent, setPercent] = useState(100);

  const paint = useCallback((animate: boolean) => {
    const image = imageRef.current;
    if (!image) return;
    const { scale, x, y } = view.current;
    image.style.transition = animate ? SETTLE_TRANSITION : 'none';
    image.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    const next = Math.round(scale * 100);
    setPercent(previous => (previous === next ? previous : next));
  }, []);

  const schedulePaint = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      paint(false);
    });
  }, [paint]);

  const surfaceCenter = useCallback((): Point => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 };
  }, []);

  // Keeps the image edges from leaving the screen; an image smaller than the screen stays centred.
  const clampPan = useCallback((next: View): View => {
    const surface = surfaceRef.current;
    const image = imageRef.current;
    if (!surface || !image) return next;
    // offsetWidth rounds to whole pixels, which leaves a gap of about a pixel at the edge of a zoomed image.
    const style = getComputedStyle(image);
    const width = parseFloat(style.width) || image.offsetWidth;
    const height = parseFloat(style.height) || image.offsetHeight;
    const bounds = surface.getBoundingClientRect();
    const maxX = Math.max(0, (width * next.scale - bounds.width) / 2);
    const maxY = Math.max(0, (height * next.scale - bounds.height) / 2);
    return {
      scale: next.scale,
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, []);

  // View at `scale` that keeps the image point under `anchor` (screen coordinates) where `base` had it.
  const zoomedView = useCallback((scale: number, anchor: Point, base: View): View => {
    const next = clampScale(scale);
    const ratio = next / base.scale;
    const center = surfaceCenter();
    return {
      scale: next,
      x: (anchor.x - center.x) - ratio * (anchor.x - center.x - base.x),
      y: (anchor.y - center.y) - ratio * (anchor.y - center.y - base.y),
    };
  }, [surfaceCenter]);

  // Restarts from the fingers that are down now, so lifting or adding a finger never makes the image jump.
  const beginGesture = useCallback(() => {
    const active = [...pointers.current.values()];
    if (active.length === 0) {
      gesture.current = null;
    } else if (active.length === 1) {
      gesture.current = { mode: 'pan', view: { ...view.current }, point: active[0], distance: 0 };
    } else {
      gesture.current = {
        mode: 'pinch',
        view: { ...view.current },
        point: midpoint(active[0], active[1]),
        distance: Math.max(1, distance(active[0], active[1])),
      };
    }
  }, []);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    // Wheel and Ctrl+wheel (trackpad pinch) must not scroll or zoom the page behind the viewer.
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const delta = event.deltaY * unit;
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0018));
      view.current = clampPan(zoomedView(view.current.scale * factor, { x: event.clientX, y: event.clientY }, view.current));
      paint(!event.ctrlKey && Math.abs(delta) >= 50);
    };

    // Safari reports pinches as gesture events: always cancel them (no page zoom), apply only trackpad pinches since touch pinches use pointer events.
    let gestureStartScale = 1;
    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartScale = view.current.scale;
    };
    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      if (pointers.current.size >= 2) return;
      const { scale, clientX, clientY } = event as Event & { scale?: number; clientX?: number; clientY?: number };
      if (!scale) return;
      const anchor = clientX === undefined || clientY === undefined ? surfaceCenter() : { x: clientX, y: clientY };
      view.current = clampPan(zoomedView(gestureStartScale * scale, anchor, view.current));
      paint(false);
    };
    const preventDefault = (event: Event) => event.preventDefault();

    const handleResize = () => {
      view.current = clampPan(view.current);
      paint(false);
    };

    overlay.addEventListener('wheel', handleWheel, { passive: false });
    overlay.addEventListener('gesturestart', handleGestureStart, { passive: false });
    overlay.addEventListener('gesturechange', handleGestureChange, { passive: false });
    overlay.addEventListener('gestureend', preventDefault, { passive: false });
    window.addEventListener('resize', handleResize);

    return () => {
      overlay.removeEventListener('wheel', handleWheel);
      overlay.removeEventListener('gesturestart', handleGestureStart);
      overlay.removeEventListener('gesturechange', handleGestureChange);
      overlay.removeEventListener('gestureend', preventDefault);
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [clampPan, paint, surfaceCenter, zoomedView]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer can already be gone when the event is handled.
    }
    beginGesture();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const active = [...pointers.current.values()];

    if (current.mode === 'pan') {
      view.current = clampPan({
        scale: current.view.scale,
        x: current.view.x + active[0].x - current.point.x,
        y: current.view.y + active[0].y - current.point.y,
      });
    } else if (active.length >= 2) {
      const middle = midpoint(active[0], active[1]);
      const zoomed = zoomedView(current.view.scale * distance(active[0], active[1]) / current.distance, current.point, current.view);
      view.current = clampPan({
        scale: zoomed.scale,
        x: zoomed.x + middle.x - current.point.x,
        y: zoomed.y + middle.y - current.point.y,
      });
    }
    schedulePaint();
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    beginGesture();
    if (pointers.current.size > 0) return;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    view.current = clampPan(view.current);
    paint(true);
  };

  const zoomBy = (step: number) => {
    view.current = clampPan(zoomedView(view.current.scale + step, surfaceCenter(), view.current));
    paint(true);
  };

  const resetView = () => {
    view.current = { scale: 1, x: 0, y: 0 };
    paint(true);
  };

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Preview"
      className="employee-modal-backdrop fixed inset-0 z-[99999] flex items-center justify-center bg-black/90"
      style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
    >
      <style>{`
        .cs-viewer-toolbar {
          top: calc(env(safe-area-inset-top) + 12px);
          right: calc(env(safe-area-inset-right) + 12px);
        }

        button.cs-viewer-btn {
          box-sizing: border-box;
          width: 40px !important;
          height: 40px !important;
          min-width: 40px !important;
          min-height: 40px !important;
          padding: 0 !important;
          flex: 0 0 auto;
        }

        @media (pointer: coarse), (max-width: 1023px) {
          button.cs-viewer-btn {
            width: 44px !important;
            height: 44px !important;
            min-width: 44px !important;
            min-height: 44px !important;
          }
        }

        @media (min-width: 640px) {
          .cs-viewer-toolbar {
            top: calc(env(safe-area-inset-top) + 20px);
            right: calc(env(safe-area-inset-right) + 20px);
          }
        }
      `}</style>

      <div className="cs-viewer-toolbar absolute z-10 flex items-center gap-1.5 sm:gap-2">
        <button
          type="button"
          onClick={() => zoomBy(-BUTTON_STEP)}
          className="cs-viewer-btn flex items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:bg-white/25"
          style={{ WebkitTapHighlightColor: 'transparent' }}
          aria-label="Zoom out"
        >
          <ZoomOut className="h-5 w-5 shrink-0" />
        </button>
        <span className="w-[64px] sm:w-[72px] text-center font-mono text-[17px] sm:text-[19px] leading-none font-semibold tabular-nums text-white/90">{percent}%</span>
        <button
          type="button"
          onClick={() => zoomBy(BUTTON_STEP)}
          className="cs-viewer-btn flex items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:bg-white/25"
          style={{ WebkitTapHighlightColor: 'transparent' }}
          aria-label="Zoom in"
        >
          <ZoomIn className="h-5 w-5 shrink-0" />
        </button>
        <button
          type="button"
          onClick={resetView}
          className="cs-viewer-btn flex items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:bg-white/25"
          style={{ WebkitTapHighlightColor: 'transparent' }}
          aria-label="Reset"
        >
          <RotateCcw className="h-5 w-5 shrink-0" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="cs-viewer-btn ml-1 flex items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 active:bg-white/30"
          style={{ WebkitTapHighlightColor: 'transparent' }}
          aria-label={t.common.close}
        >
          <X className="h-5 w-5 shrink-0" strokeWidth={2.25} />
        </button>
      </div>

      <div
        ref={surfaceRef}
        className="flex h-full w-full cursor-grab select-none items-center justify-center overflow-hidden active:cursor-grabbing"
        style={{ touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handlePointerEnd}
      >
        <img
          ref={imageRef}
          src={src}
          alt="Preview"
          className="max-h-[90vh] max-w-[95vw] select-none object-contain sm:max-h-[85vh] sm:max-w-[85vw]"
          style={{ touchAction: 'none', transformOrigin: 'center center' }}
          draggable={false}
        />
      </div>
    </div>,
    document.body,
  );
}
