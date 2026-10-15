import { useId } from 'react';

// Both the dispatch and orders tabs stay mounted; a shared gradient id would resolve to the hidden tab's copy and drop the hull.
export default function OrderPanelShip({ className = 'order-panel-ship' }: { className?: string }) {
  const hullId = `order-ship-hull-${useId().replace(/:/g, '')}`;
  return (
    <svg className={className} viewBox="0 0 240 80" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={hullId} x1="0" y1="50" x2="240" y2="76" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1b4b84" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <path d="M214 30v18" stroke="#1b4b84" strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" />
      <path d="M31 9h10v14H31z" fill="#1b4b84" fillOpacity="0.7" />
      <path d="M31 9h10v3H31z" fill="#38bdf8" fillOpacity="0.8" />
      <path d="M20 23h34v27H20z" fill="#e0f2fe" />
      <path d="M17 23h40v4H17z" fill="#1b4b84" fillOpacity="0.75" />
      <path d="M24 31h5v4h-5zM32 31h5v4h-5zM40 31h5v4h-5zM48 31h3v4h-3zM24 39h5v4h-5zM32 39h5v4h-5zM40 39h5v4h-5z" fill="#2563eb" fillOpacity="0.7" />
      <g strokeWidth="1" stroke="#ffffff" strokeOpacity="0.85">
        <path d="M60 36h22v14H60z" fill="#1b4b84" fillOpacity="0.8" />
        <path d="M82 36h22v14H82z" fill="#38bdf8" fillOpacity="0.85" />
        <path d="M104 36h22v14h-22z" fill="#2563eb" fillOpacity="0.8" />
        <path d="M126 36h22v14h-22z" fill="#7dd3fc" fillOpacity="0.9" />
        <path d="M148 36h22v14h-22z" fill="#1b4b84" fillOpacity="0.8" />
        <path d="M170 36h22v14h-22z" fill="#38bdf8" fillOpacity="0.85" />
        <path d="M71 24h22v12H71z" fill="#7dd3fc" fillOpacity="0.9" />
        <path d="M93 24h22v12H93z" fill="#1b4b84" fillOpacity="0.75" />
        <path d="M115 24h22v12h-22z" fill="#38bdf8" fillOpacity="0.85" />
        <path d="M137 24h22v12h-22z" fill="#2563eb" fillOpacity="0.8" />
        <path d="M159 24h22v12h-22z" fill="#7dd3fc" fillOpacity="0.9" />
      </g>
      <path d="M8 50h224l-18 24c-2 3-5 4-9 4H27c-5 0-8-2-10-5L8 50z" fill={`url(#${hullId})`} />
      <path d="M11 56h217l-3 4H14z" fill="#ffffff" fillOpacity="0.35" />
    </svg>
  );
}
