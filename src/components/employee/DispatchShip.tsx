interface DispatchShipProps {
  idPrefix: string;
  className?: string;
  viewBox?: string;
  waterline?: boolean;
}

const BOX_COLORS = ['#2563eb', '#0ea5e9', '#1d4ed8', '#38bdf8', '#6366f1', '#0891b2', '#3b82f6', '#60a5fa', '#1e40af', '#22d3ee'];
const TIERS = [4, 5, 5, 5, 5, 5, 5, 5, 5, 4, 3];
const DECK = 170;
const BOX_H = 16.5;

const containers = TIERS.flatMap((tiers, bay) => {
  const x = 252 + bay * 41 + Math.floor(bay / 2) * 4;
  return Array.from({ length: tiers }, (_, tier) => ({
    x,
    y: DECK - (tier + 1) * BOX_H,
    fill: BOX_COLORS[(bay * 7 + tier * 3) % BOX_COLORS.length],
    key: `${bay}-${tier}`,
  }));
});

const bayGaps = [1, 3, 5, 7, 9].map((bay) => 252 + (bay + 1) * 41 + Math.floor(bay / 2) * 4 + 1);

export default function DispatchShip({ idPrefix, className = '', viewBox = '80 40 720 230', waterline = false }: DispatchShipProps) {
  const water = `${idPrefix}-water`;
  const hull = `${idPrefix}-hull`;
  const hullClip = `${idPrefix}-hull-clip`;
  const cabin = `${idPrefix}-cabin`;
  const ribs = `${idPrefix}-ribs`;
  const glass = `${idPrefix}-glass`;
  const hullPath = 'M92 172H700C735 170 760 162 782 146L771 194C765 220 757 238 744 250C758 254 762 262 750 266H190C140 266 112 254 102 232L92 200Z';

  return (
    <svg className={className} viewBox={viewBox} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={hull} x1="0" y1="146" x2="0" y2="266" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7dd3fc" />
          <stop offset="0.45" stopColor="#2563eb" />
          <stop offset="1" stopColor="#1e3a8a" />
        </linearGradient>
        <linearGradient id={cabin} x1="0" y1="60" x2="0" y2="172" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f0f9ff" />
          <stop offset="1" stopColor="#bae6fd" />
        </linearGradient>
        <linearGradient id={glass} x1="128" y1="0" x2="258" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1e3a8a" />
          <stop offset="0.5" stopColor="#1d4ed8" />
          <stop offset="1" stopColor="#1e3a8a" />
        </linearGradient>
        <pattern id={ribs} width="3.4" height="4" patternUnits="userSpaceOnUse">
          <rect width="1" height="4" fill="#fff" fillOpacity="0.22" />
        </pattern>
        <clipPath id={hullClip}>
          <path d={hullPath} />
        </clipPath>
        {waterline && (
          <>
            <linearGradient id={`${water}-fade`} x1="0" y1="233" x2="0" y2="262" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff" />
              <stop offset="0.4" stopColor="#8a8a8a" />
              <stop offset="1" stopColor="#000" />
            </linearGradient>
            <mask id={`${water}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="800" height="300">
              <rect width="800" height="300" fill={`url(#${water}-fade)`} />
            </mask>
            <filter id={`${water}-soft`} x="-5%" y="-150%" width="110%" height="400%">
              <feGaussianBlur stdDeviation="3" />
            </filter>
          </>
        )}
      </defs>

      <g mask={waterline ? `url(#${water}-mask)` : undefined}>
        {/* Containers */}
        {containers.map((c) => (
          <g key={c.key}>
            <rect x={c.x} y={c.y} width="39" height={BOX_H - 1.2} rx="1" fill={c.fill} />
            <rect x={c.x} y={c.y} width="39" height={BOX_H - 1.2} rx="1" fill={`url(#${ribs})`} />
            <path d={`M${c.x + 1} ${c.y + 0.8}h37`} stroke="#fff" strokeOpacity="0.45" strokeWidth="1" />
          </g>
        ))}
        {/* Lashing bridges between bay pairs */}
        {bayGaps.map((x) => (
          <path key={x} d={`M${x} ${DECK}V${DECK - 2 * BOX_H - 4}`} stroke="#1e3a8a" strokeOpacity="0.55" strokeWidth="2" />
        ))}
        <path d="M252 170H712" stroke="#1e3a8a" strokeOpacity="0.5" strokeWidth="3" />

        {/* Breakwater and forecastle */}
        <path d="M712 172C714 150 720 138 732 134L740 172Z" fill="#93c5fd" />
        <path d="M724 158H778" stroke="#1e40af" strokeOpacity="0.55" strokeWidth="1.4" />
        {[730, 740, 750, 760, 770].map((x) => (
          <path key={x} d={`M${x} 158V${x > 765 ? 152 : 164}`} stroke="#1e40af" strokeOpacity="0.5" strokeWidth="1.2" />
        ))}
        <path d="M756 158V108M748 120H764" stroke="#1e3a8a" strokeOpacity="0.7" strokeWidth="2.2" strokeLinecap="round" />
        <circle className="dispatch-ship-light" cx="756" cy="106" r="2.6" fill="#fde68a" />

        {/* Funnel */}
        <path d="M110 170L115 86Q116 78 123 78H140Q147 78 146 86L143 170Z" fill="#60a5fa" />
        <path d="M114 96H145V104H113Z" fill="#22d3ee" />
        <path d="M115 86Q116 78 123 78H140Q147 78 146 86Z" fill="#1e3a8a" />
        <path d="M124 78V70M134 78V66" stroke="#1e3a8a" strokeOpacity="0.6" strokeWidth="3" strokeLinecap="round" />

        {/* Superstructure */}
        <path d="M150 170V100H246V170Z" fill={`url(#${cabin})`} />
        <path d="M158 100V84H240V100Z" fill={`url(#${cabin})`} />
        <path d="M128 84V68Q128 64 132 64H254Q258 64 258 68V84Z" fill="#e0f2fe" />
        <path d="M132 70H254V79H132Z" fill={`url(#${glass})`} />
        <path d="M138 71.5L150 71.5M170 71.5L196 71.5M214 71.5L236 71.5" stroke="#fff" strokeOpacity="0.7" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M128 84H258" stroke="#1e40af" strokeOpacity="0.5" strokeWidth="1.5" />
        {[108, 122, 136, 150].map((y) =>
          Array.from({ length: 8 }, (_, i) => (
            <rect key={`${y}-${i}`} x={157 + i * 10.6} y={y} width="6" height="5" rx="1" fill="#1e40af" fillOpacity="0.7" />
          )),
        )}
        {[103, 117, 131, 145, 159].map((y) => (
          <path key={y} d={`M150 ${y}H246`} stroke="#0c4a6e" strokeOpacity="0.18" strokeWidth="1" />
        ))}
        <rect x="165" y="88" width="68" height="6" rx="1" fill="#1e40af" fillOpacity="0.55" />

        {/* Mast, radar and antennas */}
        <path d="M200 64V46M188 50H212M191 56H209" stroke="#1e3a8a" strokeOpacity="0.75" strokeWidth="2.2" strokeLinecap="round" />
        <ellipse cx="172" cy="58" rx="12" ry="2.6" fill="#1e3a8a" fillOpacity="0.7" />
        <path d="M172 61V64M232 64V48M240 64V54" stroke="#1e3a8a" strokeOpacity="0.6" strokeWidth="1.6" strokeLinecap="round" />
        <circle className="dispatch-ship-light" cx="200" cy="44" r="2.6" fill="#fde68a" style={{ animationDelay: '-1.2s' }} />

        {/* Lifeboat */}
        <path d="M98 160L120 150" stroke="#1e3a8a" strokeOpacity="0.5" strokeWidth="1.6" />
        <rect x="100" y="148" width="22" height="9" rx="4.5" transform="rotate(-22 111 152)" fill="#fdba74" />

        {/* Stern flag pole */}
        <path d="M95 172V148" stroke="#1e3a8a" strokeOpacity="0.6" strokeWidth="1.6" />
        <path d="M95 148L106 151L95 155Z" fill="#38bdf8" />

        {/* Hull */}
        <path d={hullPath} fill={`url(#${hull})`} />
        <g clipPath={`url(#${hullClip})`}>
          <rect x="80" y="238" width="720" height="40" fill="#1e3a8a" fillOpacity="0.75" />
          <path d="M80 237H800" stroke="#e0f2fe" strokeOpacity="0.8" strokeWidth="2" />
          <path d="M80 198H800M80 218H800" stroke="#fff" strokeOpacity="0.1" strokeWidth="1" />
          {[160, 175, 190, 205, 220, 235].map((x) => (
            <circle key={x} cx={x} cy="190" r="2.4" fill="#e0f2fe" fillOpacity="0.75" />
          ))}
          {[0, 1, 2, 3].map((i) => (
            <path key={i} d={`M742 ${242 + i * 5}h6M118 ${242 + i * 5}h6`} stroke="#e0f2fe" strokeOpacity="0.6" strokeWidth="1" />
          ))}
        </g>
        <path d="M92 172H700C735 170 760 162 782 146" stroke="#f0f9ff" strokeOpacity="0.85" strokeWidth="2.2" />
        <ellipse cx="748" cy="182" rx="5.5" ry="4" fill="#172554" fillOpacity="0.8" />
        <path d="M748 186V198M743 194Q748 200 753 194" stroke="#172554" strokeOpacity="0.6" strokeWidth="1.4" strokeLinecap="round" />
      </g>
      {waterline && (
        <g>
          <ellipse cx="436" cy="254" rx="320" ry="9" fill="#1e3a8a" fillOpacity="0.14" filter={`url(#${water}-soft)`} />
          <path d="M170 252H300M360 258H520M580 252H700" stroke="#bae6fd" strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round" />
          <ellipse cx="436" cy="237.5" rx="352" ry="3.4" fill="#fff" fillOpacity="0.55" filter={`url(#${water}-soft)`} />
          <path d="M96 238Q84 233 66 240M768 238Q786 232 800 239" stroke="#fff" strokeOpacity="0.75" strokeWidth="2" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}
