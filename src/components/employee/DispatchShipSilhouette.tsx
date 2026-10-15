import { useId } from 'react';

const HULL_FULL = 'M2 66c0-2 2-4 4-4h22l12-10h312l8-8h20l-6 12c-6 12-16 22-30 26H34C18 82 6 76 2 66z';
const BRIDGE = 'M318 14h30v38h-30zM312 12h42v4h-42zM330 2h6v12h-6zM340 8h4v6h-4z';
const STACK_ROWS = [
  { y: 40, xs: [48, 72, 96, 120, 144, 168, 192, 216, 240, 264, 288], tone: 'a' },
  { y: 28, xs: [56, 80, 104, 128, 152, 176, 200, 224, 248, 272], tone: 'b' },
  { y: 16, xs: [80, 104, 128, 152, 176, 200, 224, 248], tone: 'c' },
] as const;

export default function DispatchShipSilhouette() {
  const uid = useId().replace(/:/g, '');
  const clip = `shs-clip-${uid}`;
  const sheen = `shs-sheen-${uid}`;
  const hull = `shs-hull-${uid}`;
  return (
    <div className="shs" aria-hidden="true">
      <span className="shs-block shs-block-1" />
      <span className="shs-block shs-block-2" />
      <span className="shs-block shs-block-3" />
      <svg className="shs-ship" viewBox="0 0 400 86" fill="none">
        <defs>
          <linearGradient id={hull} x1="0" y1="44" x2="0" y2="84" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#bfdbfe" />
            <stop offset="1" stopColor="#dbeafe" stopOpacity="0.35" />
          </linearGradient>
          <linearGradient id={sheen} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <clipPath id={clip}>
            <path d={HULL_FULL} />
            <path d={BRIDGE} />
            <path d="M44 16h264v36H44z" />
          </clipPath>
        </defs>

        <g className="shs-body">
          {STACK_ROWS.map((row) => (
            <g key={row.y} className={`shs-row shs-row-${row.tone}`}>
              {row.xs.map((x, i) => (
                <rect key={x} className={`shs-box shs-box-${(i + row.y) % 4}`} x={x} y={row.y} width="22" height="11" rx="1" />
              ))}
            </g>
          ))}
          <path className="shs-bridge" d={BRIDGE} />
          <path d="M322 20h22M322 26h22" stroke="#ffffff" strokeOpacity="0.7" strokeWidth="2" />
          <path d="M300 12v40" stroke="#bfdbfe" strokeWidth="1.5" />
          <path d={HULL_FULL} fill={`url(#${hull})`} />
          <path d="M8 62h356" stroke="#ffffff" strokeOpacity="0.7" strokeWidth="1.2" />
        </g>

        <g clipPath={`url(#${clip})`}>
          <rect className="shs-sheen" x="-120" y="0" width="120" height="86" fill={`url(#${sheen})`} />
        </g>
      </svg>
      <span className="shs-water" />
    </div>
  );
}
