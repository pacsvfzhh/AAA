import { useEffect, useState } from 'react';
import { useLanguage } from '../../lib/i18n/context';

const BLOCKS = [
  { x: -128, y: -78, size: 34, light: 'bg-blue-200/60', rot: -14, delay: 0 },
  { x: 104, y: -96, size: 26, light: 'bg-cyan-200/70', rot: 12, delay: 0.4 },
  { x: 118, y: 42, size: 38, light: 'bg-indigo-200/50', rot: 18, delay: 0.8 },
  { x: -112, y: 58, size: 24, light: 'bg-sky-200/70', rot: -8, delay: 1.2 },
  { x: -30, y: -128, size: 18, light: 'bg-blue-300/40', rot: 24, delay: 0.6 },
];

const VARIANTS = {
  page: {
    wrap: 'min-h-[calc(100dvh-var(--employee-header-height,64px)-140px)] lg:min-h-[calc(100dvh-300px)]',
    stage: 'h-40 w-40 sm:h-48 sm:w-48',
    ring: 'h-16 w-16 sm:h-[72px] sm:w-[72px]',
    border: 'border-4',
    text: '-mt-4 text-sm sm:text-base',
    scale: 1,
    blocks: 5,
  },
  panel: {
    wrap: 'flex-1 min-h-[260px] py-6 sm:min-h-[320px]',
    stage: 'h-36 w-36 sm:h-40 sm:w-40',
    ring: 'h-14 w-14 sm:h-16 sm:w-16',
    border: 'border-4',
    text: '-mt-3 text-sm',
    scale: 0.78,
    blocks: 5,
  },
  inline: {
    wrap: 'min-h-[180px] py-4',
    stage: 'h-28 w-28',
    ring: 'h-11 w-11',
    border: 'border-[3px]',
    text: '-mt-2 text-[13px]',
    scale: 0.6,
    blocks: 4,
  },
} as const;

// Tab switches replace one loader with another (lazy chunk -> tab placeholder -> page data);
// these let the next loader skip its fade-in and continue the animation phase seamlessly.
let liveLoaders = 0;
let lastLoaderGoneAt = -Infinity;

interface PageLoaderProps {
  label?: string;
  variant?: keyof typeof VARIANTS;
  tone?: 'light' | 'dark';
  className?: string;
}

export default function PageLoader({ label, variant = 'page', tone = 'light', className = '' }: PageLoaderProps) {
  const { t } = useLanguage();
  const [{ handoff, now }] = useState(() => {
    const at = performance.now();
    return { handoff: liveLoaders > 0 || at - lastLoaderGoneAt < 600, now: at };
  });

  useEffect(() => {
    liveLoaders += 1;
    return () => {
      liveLoaders -= 1;
      lastLoaderGoneAt = performance.now();
    };
  }, []);

  const v = VARIANTS[variant];
  const dark = tone === 'dark';
  const phase = (periodMs: number) => `${-(now % periodMs)}ms`;

  return (
    <div
      className={`keep-animation flex w-full flex-col items-center justify-center ${v.wrap} ${className}`}
      style={handoff ? undefined : { animation: 'emp-loader-in 360ms ease-out 120ms backwards' }}
      role="status"
      aria-live="polite"
    >
      <div className={`relative flex items-center justify-center ${v.stage}`}>
        <div className={`absolute h-3/4 w-3/4 rounded-full blur-2xl ${dark ? 'bg-cyan-400/25' : 'bg-gradient-to-br from-blue-100 to-cyan-100 opacity-70'}`}></div>
        {BLOCKS.slice(0, v.blocks).map((block, index) => {
          const size = Math.round(block.size * v.scale);
          return (
            <div
              key={index}
              className={`keep-animation absolute rounded-lg ${dark ? 'bg-white/15 ring-1 ring-white/20' : block.light}`}
              style={{
                width: size,
                height: size,
                left: `calc(50% + ${Math.round(block.x * v.scale) - size / 2}px)`,
                top: `calc(50% + ${Math.round(block.y * v.scale) - size / 2}px)`,
                ['--emp-rot' as string]: `${block.rot}deg`,
                transform: `rotate(${block.rot}deg)`,
                animation: `emp-loader-block 2.6s ease-in-out ${block.delay * 1000 - (now % 5200)}ms infinite alternate`,
              }}
              aria-hidden="true"
            ></div>
          );
        })}
        <div className={`relative ${v.ring}`}>
          <div className={`absolute inset-0 rounded-full ${v.border} ${dark ? 'border-white/20' : 'border-blue-100'}`}></div>
          <div
            className={`keep-animation absolute inset-0 animate-spin rounded-full ${v.border} border-transparent ${dark ? 'border-t-white border-r-cyan-300' : 'border-t-blue-500 border-r-cyan-400'}`}
            style={{ animationDelay: phase(1000) }}
          ></div>
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className={`keep-animation h-2.5 w-2.5 animate-pulse rounded-full ${dark ? 'bg-white/90' : 'bg-blue-500/80'}`}
              style={{ animationDelay: phase(2000) }}
            ></div>
          </div>
        </div>
      </div>
      <span className={`font-semibold tracking-wide ${v.text} ${dark ? 'text-white/90' : 'text-slate-500'}`}>{label ?? t.common.loading}</span>
    </div>
  );
}
