import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, X } from 'lucide-react';
import DispatchShip from './DispatchShip';

export interface DispatchVeilConnect {
  state: 'connecting' | 'connected' | 'failed';
  steps: [string, string, string];
  connectedLabel: string;
  failedLabel: string;
}

interface DispatchVeilProps {
  phase: 'in' | 'out';
  label: string;
  connect?: DispatchVeilConnect;
}

// From the veil mounting: the first step lands as the stage fades in (index.css); OrderDispatch decides when
// "connected" may show, which is never before the server has confirmed the session.
const CONNECT_STEP_AT_MS = [380, 1550, 2750];
const CONNECT_PROGRESS = [0.3, 0.6, 0.9];
// Veil fade-in, stage entrance and sweep are all done by then (index.css).
const CONNECT_INTRO_MS = 1500;

// segments must be a multiple of 4 so the -50% loop lands on a whole wave period.
const waveCurve = (baseline: number, crest: number, segments: number) => {
  const step = 400 / segments;
  let d = `M0 ${baseline} Q${step / 2} ${crest} ${step} ${baseline}`;
  for (let x = step * 2; x <= 400; x += step) d += ` T${x} ${baseline}`;
  return d;
};

const WAVE_LAYERS = [
  { key: 'back', baseline: 16, crest: 3, top: '#bae6fd', bottom: '#7dd3fc', topOpacity: 0.55, bottomOpacity: 0.05 },
  { key: 'mid', baseline: 22, crest: 10, top: '#7dd3fc', bottom: '#38bdf8', topOpacity: 0.5, bottomOpacity: 0.06 },
  { key: 'front', baseline: 28, crest: 15, top: '#38bdf8', bottom: '#2563eb', topOpacity: 0.55, bottomOpacity: 0.08 },
] as const;

interface DispatchWavesProps {
  className?: string;
  wavelengths?: [number, number, number];
  speeds?: [number, number, number];
  intensity?: number;
}

// Wave counts are derived from the rendered width so each crest keeps the same pixel shape on every screen.
export function DispatchWaves({ className = '', wavelengths = [460, 230, 460], speeds = [51, 66, 84], intensity = 1 }: DispatchWavesProps) {
  const uid = useId().replace(/:/g, '');
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      if (el.offsetWidth > 0) setWidth(el.offsetWidth);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`dispatch-veil-sea ${className}`} aria-hidden="true">
      {width > 0 && WAVE_LAYERS.map((layer, i) => {
        // One wave period spans 4W/segments px; segments must stay a multiple of 4 for a seamless -50% loop.
        const segments = Math.max(4, Math.round(width / wavelengths[i]) * 4);
        const curve = waveCurve(layer.baseline, layer.crest, segments);
        const gradientId = `${uid}-wave-${layer.key}`;
        return (
          <svg
            key={layer.key}
            className={`dispatch-veil-wave dispatch-veil-wave-${layer.key}`}
            viewBox="0 0 400 40"
            preserveAspectRatio="none"
            style={{ animationDuration: `${(width / speeds[i]).toFixed(2)}s` }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={layer.top} stopOpacity={Math.min(1, layer.topOpacity * intensity)} />
                <stop offset="1" stopColor={layer.bottom} stopOpacity={Math.min(1, layer.bottomOpacity * intensity)} />
              </linearGradient>
            </defs>
            <path d={`${curve} V40 H0Z`} fill={`url(#${gradientId})`} />
            {layer.key === 'front' && (
              <path d={curve} fill="none" stroke="#ffffff" strokeOpacity="0.7" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
        );
      })}
    </div>
  );
}

function useConnectStep(state: DispatchVeilConnect['state'] | undefined) {
  const [mountedAt] = useState(() => Date.now());
  const [step, setStep] = useState(-1);

  useEffect(() => {
    if (state !== 'connecting') return;
    const timers = CONNECT_STEP_AT_MS.map((at, i) =>
      setTimeout(() => setStep(previous => Math.max(previous, i)), Math.max(0, mountedAt + at - Date.now())));
    return () => timers.forEach(clearTimeout);
  }, [state, mountedAt]);

  return step;
}

export default function DispatchVeil({ phase, label, connect }: DispatchVeilProps) {
  const step = useConnectStep(connect?.state);
  const veilRef = useRef<HTMLDivElement>(null);
  const [stageHeight, setStageHeight] = useState<number | null>(null);
  const connectMode = !!connect;

  const [introDone, setIntroDone] = useState(false);

  // Tablet/desktop panels grow from standby to waiting height under the veil; pin the stage so the ship doesn't drift.
  useLayoutEffect(() => {
    if (connectMode && veilRef.current) setStageHeight(veilRef.current.clientHeight);
  }, [connectMode]);

  // CSS animations restart when the tab is shown again; after the intro, hold the end state instead of replaying it.
  useEffect(() => {
    if (!connectMode) return;
    const timer = setTimeout(() => setIntroDone(true), CONNECT_INTRO_MS);
    return () => clearTimeout(timer);
  }, [connectMode]);
  const state = connect?.state;
  const settled = state === 'connected' || state === 'failed';
  const progress = state === 'connected' ? 1 : step < 0 ? 0.04 : CONNECT_PROGRESS[step];
  const activeLine = state === 'connected' ? 3 : state === 'failed' ? 4 : Math.max(step, 0);

  const veilClass = [
    'dispatch-veil',
    phase === 'in' ? 'dispatch-veil-in' : 'dispatch-veil-out',
    connect ? 'dispatch-veil-connect' : '',
    settled ? 'is-settled' : '',
    state === 'connected' ? 'is-connected' : '',
    introDone && phase === 'in' ? 'is-steady' : '',
  ].filter(Boolean).join(' ');

  return (
    <div ref={veilRef} className={veilClass} aria-hidden="true">
      <span className="dispatch-veil-blob dispatch-veil-blob-1" />
      <span className="dispatch-veil-blob dispatch-veil-blob-2" />
      <span className="dispatch-veil-blob dispatch-veil-blob-3" />
      <span className="dispatch-veil-sweep" />

      <div className="dispatch-veil-stage" style={stageHeight ? { bottom: 'auto', height: stageHeight } : undefined}>
        {connect ? (
          <div className="dispatch-veil-hull">
            <span className="dispatch-veil-radar"><span /><span /><span /></span>
            <span className="dispatch-veil-radar-done" />
            <DispatchShip idPrefix="dispatch-veil" className="dispatch-veil-ship" />
          </div>
        ) : (
          <DispatchShip idPrefix="dispatch-veil" className="dispatch-veil-ship" />
        )}
        <DispatchWaves />
        <div className="dispatch-veil-caption">
          <span className="dispatch-veil-label">{label}</span>
          <span className="dispatch-veil-track">
            {connect ? (
              <span
                className={`dispatch-veil-fill ${state === 'connected' ? 'is-connected' : state === 'failed' ? 'is-failed' : ''}`}
                data-step={step}
                style={{ '--veil-progress': progress } as CSSProperties}
              />
            ) : (
              <span className="dispatch-veil-bar" />
            )}
          </span>
          {connect && (
            // All lines share one grid cell, so the stage keeps its height (and position) as the text changes.
            <span className="dispatch-veil-status">
              {[...connect.steps, connect.connectedLabel, connect.failedLabel].map((text, i) => (
                <span
                  key={i}
                  className={`dispatch-veil-status-line ${i === activeLine ? 'is-active' : i < activeLine ? 'is-past' : ''} ${i === 3 ? 'is-connected' : i === 4 ? 'is-failed' : ''}`}
                >
                  {i < 3 ? (
                    <span className="dispatch-veil-status-dot" />
                  ) : (
                    <span className="dispatch-veil-status-icon">
                      {i === 3 ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : <X className="h-2.5 w-2.5" strokeWidth={3.5} />}
                    </span>
                  )}
                  <span>{i < 3 ? `${text}…` : text}</span>
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
