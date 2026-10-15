import type { CSSProperties } from 'react';

type Bird = { x: number; y: number; size: number; tone: 0 | 1 | 2; flap: number; delay: number };

type Flight = {
  top: string;
  drift: number;
  delay: number;
  reverse?: boolean;
  orbit: number;
  orbitDur: number;
  orbitReverse?: boolean;
  depth: [number, number];
  depthDur: number;
  desktopOnly?: boolean;
  birds: Bird[];
};

const FLIGHTS: Flight[] = [
  {
    top: '11%', drift: 88, delay: -14, orbit: 12, orbitDur: 22, depth: [0.85, 1.12], depthDur: 20,
    birds: [
      { x: 0, y: 0, size: 26, tone: 0, flap: 4.2, delay: 0 },
      { x: -30, y: 14, size: 22, tone: 0, flap: 4.4, delay: -0.3 },
      { x: -24, y: -12, size: 21, tone: 1, flap: 3.9, delay: -0.7 },
      { x: -58, y: 26, size: 18, tone: 1, flap: 4.7, delay: -1.1 },
      { x: -52, y: -20, size: 17, tone: 1, flap: 4.2, delay: -0.5 },
    ],
  },
  {
    top: '24%', drift: 62, delay: -33, orbit: 38, orbitDur: 18, depth: [0.9, 1.4], depthDur: 16,
    birds: [{ x: 0, y: 0, size: 36, tone: 0, flap: 5.7, delay: 0 }],
  },
  {
    top: '7%', drift: 104, delay: -60, reverse: true, orbit: 18, orbitDur: 26, orbitReverse: true, depth: [0.8, 1.05], depthDur: 16,
    birds: [
      { x: 0, y: 0, size: 24, tone: 1, flap: 4.9, delay: 0 },
      { x: 30, y: 10, size: 20, tone: 1, flap: 5.2, delay: -0.6 },
    ],
  },
  {
    top: '33%', drift: 120, delay: -24, reverse: true, orbit: 8, orbitDur: 20, depth: [0.75, 0.95], depthDur: 22,
    birds: [
      { x: 0, y: 0, size: 14, tone: 2, flap: 3.6, delay: 0 },
      { x: 18, y: 8, size: 12, tone: 2, flap: 3.9, delay: -0.4 },
      { x: 20, y: -7, size: 12, tone: 2, flap: 3.4, delay: -0.8 },
    ],
  },
  {
    top: '40%', drift: 50, delay: -8, orbit: 28, orbitDur: 14, depth: [0.7, 1.2], depthDur: 13,
    birds: [{ x: 0, y: 0, size: 20, tone: 1, flap: 4.7, delay: -0.2 }],
  },
  {
    top: '17%', drift: 70, delay: -52, reverse: true, orbit: 30, orbitDur: 17, orbitReverse: true, depth: [0.85, 1.3], depthDur: 12,
    desktopOnly: true,
    birds: [{ x: 0, y: 0, size: 28, tone: 0, flap: 6.2, delay: -0.9 }],
  },
  {
    top: '28%', drift: 96, delay: -78, orbit: 14, orbitDur: 24, depth: [0.8, 1.05], depthDur: 21,
    desktopOnly: true,
    birds: [
      { x: 0, y: 0, size: 19, tone: 1, flap: 4.2, delay: 0 },
      { x: -24, y: 10, size: 16, tone: 2, flap: 4.4, delay: -0.5 },
      { x: -22, y: -9, size: 16, tone: 2, flap: 3.9, delay: -1 },
      { x: -46, y: 3, size: 14, tone: 2, flap: 4.7, delay: -0.3 },
    ],
  },
];

export default function DispatchGulls() {
  return (
    <div className="dispatch-gulls pointer-events-none absolute inset-0 z-[2] overflow-hidden" aria-hidden="true">
      {FLIGHTS.map((f, i) => (
        <span
          key={i}
          className={`dispatch-gull-track${f.desktopOnly ? ' dispatch-gull-desktop' : ''}`}
          style={{
            top: f.top,
            animationDuration: `${f.drift}s`,
            animationDelay: `${f.delay}s`,
            animationDirection: f.reverse ? 'reverse' : 'normal',
          }}
        >
          <span
            className="dispatch-gull-orbit"
            style={{
              '--gull-orbit': `${f.orbit}px`,
              animationDuration: `${f.orbitDur}s`,
              animationDirection: f.orbitReverse ? 'reverse' : 'normal',
            } as CSSProperties}
          >
            <span
              className="dispatch-gull-depth"
              style={{
                '--gull-near': f.depth[1],
                '--gull-far': f.depth[0],
                animationDuration: `${f.depthDur}s`,
                animationDelay: `${f.delay / 3}s`,
              } as CSSProperties}
            >
              {f.birds.map((b, j) => {
                const wingTiming = { animationDuration: `${b.flap}s`, animationDelay: `${b.delay}s` };
                return (
                <span
                  key={j}
                  className={`dispatch-gull dispatch-gull-tone-${b.tone}`}
                  style={{
                    '--gull-x': b.x,
                    '--gull-y': b.y,
                    '--gull-size': b.size,
                    animationDelay: `${b.delay * 3}s`,
                  } as CSSProperties}
                >
                  {/* Wings are their own <svg> boxes: rotating an HTML box runs on the compositor, while rotating
                      paths inside one SVG forces a style/layout/paint pass on the main thread every frame. */}
                  <svg viewBox="0 0 48 22" className="dispatch-gull-wing dispatch-gull-wing-l" style={wingTiming} fill="currentColor">
                    <path d="M24 11.5C18 3.5 9 2.5 1 7.5C9 6 16 8 22.4 14L24 15.5Z" />
                  </svg>
                  <svg viewBox="0 0 48 22" className="dispatch-gull-wing dispatch-gull-wing-r" style={wingTiming} fill="currentColor">
                    <path d="M24 11.5C30 3.5 39 2.5 47 7.5C39 6 32 8 25.6 14L24 15.5Z" />
                  </svg>
                  <svg viewBox="0 0 48 22" className="dispatch-gull-svg" fill="currentColor">
                    <ellipse cx="24" cy="13.6" rx="2.1" ry="2.6" />
                  </svg>
                </span>
                );
              })}
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}
