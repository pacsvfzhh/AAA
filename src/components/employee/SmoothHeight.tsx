import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface SmoothHeightProps {
  animate: boolean;
  outerClassName?: string;
  innerClassName?: string;
  duration?: number;
  children: ReactNode;
}

const verticalPadding = (el: HTMLElement) => {
  const style = getComputedStyle(el);
  return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
};

export default function SmoothHeight({ animate, outerClassName = '', innerClassName = '', duration = 650, children }: SmoothHeightProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

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

  const style = height !== null ? {
    height,
    overflow: 'hidden' as const,
    transition: `height ${duration}ms cubic-bezier(0.45, 0, 0.2, 1)`,
  } : undefined;

  return (
    <div
      ref={outerRef}
      className={outerClassName}
      style={style}
    >
      <div ref={innerRef} className={innerClassName}>{children}</div>
    </div>
  );
}
