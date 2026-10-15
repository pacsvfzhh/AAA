import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface SmoothHeightProps {
  animate: boolean;
  holdMax?: boolean;
  outerClassName?: string;
  innerClassName?: string;
  duration?: number;
  children: ReactNode;
}

const verticalPadding = (el: HTMLElement) => {
  const style = getComputedStyle(el);
  return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
};

// outerClassName may add padding (e.g. to cover content that bleeds into the parent's padding);
// the animated height includes it so nothing gets clipped.
// holdMax keeps the tallest height seen (reset on width change) so the box never shrinks between states.
export default function SmoothHeight({ animate, holdMax = false, outerClassName = '', innerClassName = '', duration = 650, children }: SmoothHeightProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [minHeight, setMinHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!animate || !outer || !inner) {
      setHeight(null);
      return;
    }
    const measure = () => {
      const next = inner.offsetHeight;
      if (next > 0) setHeight(next + verticalPadding(outer));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [animate]);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!holdMax || !outer || !inner) {
      setMinHeight(null);
      return;
    }
    let max = 0;
    let width = inner.offsetWidth;
    // The held min-height can stretch inner (flex-1), so the natural height is read with it lifted for a moment.
    const naturalHeight = () => {
      const held = outer.style.minHeight;
      outer.style.minHeight = '';
      const natural = inner.offsetHeight;
      outer.style.minHeight = held;
      return natural;
    };
    const measure = () => {
      if (inner.offsetWidth !== width) {
        width = inner.offsetWidth;
        max = 0;
      }
      const natural = naturalHeight();
      const next = natural + verticalPadding(outer);
      if (natural > 0 && next > max) {
        max = next;
        setMinHeight(next);
      }
    };
    // Viewport height changes (device switch, rotation) can change the natural height without changing the width.
    const onResize = () => {
      max = 0;
      schedule();
    };
    // Changing min-height inside the observer callback would resize inner again in the same frame (ResizeObserver loop error).
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(inner);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [holdMax]);

  const style = {
    ...(minHeight !== null ? { minHeight } : null),
    ...(height !== null ? {
      height: minHeight !== null ? Math.max(height, minHeight) : height,
      overflow: 'hidden' as const,
      transition: `height ${duration}ms cubic-bezier(0.45, 0, 0.2, 1)`,
    } : null),
  };

  return (
    <div
      ref={outerRef}
      className={outerClassName}
      style={minHeight !== null || height !== null ? style : undefined}
    >
      <div ref={innerRef} className={innerClassName}>{children}</div>
    </div>
  );
}
