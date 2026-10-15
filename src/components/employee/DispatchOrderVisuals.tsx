import type { CSSProperties } from 'react';
import { Package } from 'lucide-react';

const SPARKLE_COLORS = ['#fbbf24', '#fb923c', '#22d3ee', '#7dd3fc', '#a78bfa', '#f472b6', '#34d399', '#ffffff'];

const SPARKLES = Array.from({ length: 22 }, (_, i) => ({
  left: (i * 37 + 11) % 96 + 2,
  top: (i * 53 + 23) % 80 + 12,
  size: 2 + ((i * 7) % 5),
  color: SPARKLE_COLORS[i % SPARKLE_COLORS.length],
  duration: 5 + ((i * 13) % 7),
  delay: -((i * 17) % 11),
  drift: ((i % 5) - 2) * 9,
}));

export function OrderSparkles({ count = SPARKLES.length }: { count?: number }) {
  return (
    <div className="dispatch-sparkles pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {SPARKLES.slice(0, count).map((p, i) => (
        <span
          key={i}
          className="dispatch-sparkle"
          style={{
            left: `${p.left}%`,
            top: `${p.top}%`,
            width: p.size,
            height: p.size,
            '--sparkle-color': p.color,
            '--sparkle-drift': `${p.drift}px`,
            animationDuration: `${p.duration}s`,
            animationDelay: `${p.delay}s`,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}

export function AcceptRing() {
  return <span className="dispatch-accept-ring" aria-hidden="true" />;
}

export function OrderIcon3D({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  return (
    <div className={`dispatch-icon3d dispatch-icon3d-${size}`} aria-hidden="true">
      <span className="dispatch-icon3d-shadow" />
      <div className="dispatch-icon3d-float">
        <div className="dispatch-icon3d-tile">
          {[6, 5, 4, 3, 2, 1].map((n) => (
            <span key={n} className="dispatch-icon3d-layer" style={{ '--layer': n } as CSSProperties} />
          ))}
          <span className="dispatch-icon3d-face">
            <span className="dispatch-icon3d-gloss" />
          </span>
          <Package className="dispatch-icon3d-glyph" />
        </div>
      </div>
    </div>
  );
}
