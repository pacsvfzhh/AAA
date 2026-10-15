const TONES = {
  blue: {
    topCircle: 'bg-blue-200/35',
    bottomCircle: 'bg-sky-200/35',
    square: 'bg-indigo-200/30',
    smallSquare: 'bg-blue-300/25',
  },
  green: {
    topCircle: 'bg-emerald-200/40',
    bottomCircle: 'bg-teal-200/35',
    square: 'bg-green-200/35',
    smallSquare: 'bg-emerald-300/25',
  },
  rose: {
    topCircle: 'bg-rose-200/40',
    bottomCircle: 'bg-orange-200/35',
    square: 'bg-red-200/30',
    smallSquare: 'bg-rose-300/25',
  },
  gold: {
    topCircle: 'bg-amber-200/45',
    bottomCircle: 'bg-orange-200/35',
    square: 'bg-yellow-200/40',
    smallSquare: 'bg-amber-300/30',
  },
} as const;

export type PanelColorTone = keyof typeof TONES;

export default function PanelColorBlocks({ tone = 'blue', className = '' }: { tone?: PanelColorTone; className?: string }) {
  const colors = TONES[tone];
  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`} aria-hidden="true">
      <div className={`absolute -right-16 -top-16 h-56 w-56 rounded-full ${colors.topCircle}`}></div>
      <div className={`absolute -bottom-20 -left-16 h-64 w-64 rounded-full ${colors.bottomCircle}`}></div>
      <div className={`absolute left-7 top-[26%] h-14 w-14 rotate-12 rounded-2xl ${colors.square}`}></div>
      <div className={`absolute bottom-[24%] right-9 h-10 w-10 -rotate-6 rounded-xl ${colors.smallSquare}`}></div>
      {tone === 'gold' && (
        <div className="absolute right-[22%] top-[16%] h-3 w-3 rotate-45 rounded-[3px] bg-amber-400/40"></div>
      )}
    </div>
  );
}
