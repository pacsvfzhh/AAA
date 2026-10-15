import { useId } from 'react';
import { NOTIFICATION_DETAIL_THEMES, type NotificationDetailTone } from './notificationDetailTheme';

export default function NotificationDetailBackground({ tone }: { tone: NotificationDetailTone }) {
  const { orbPrimary, orbSecondary } = NOTIFICATION_DETAIL_THEMES[tone];
  const dotsId = `nd-dots-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute -right-20 -top-20 h-[360px] w-[360px]" style={{ background: `radial-gradient(circle, rgba(${orbPrimary},0.16) 0%, transparent 62%)` }}></div>
      <div className="absolute -bottom-16 -left-16 h-[320px] w-[320px]" style={{ background: `radial-gradient(circle, rgba(${orbSecondary},0.14) 0%, transparent 62%)` }}></div>
      <svg className="absolute inset-0 h-full w-full opacity-[0.05]" xmlns="http://www.w3.org/2000/svg">
        <pattern id={dotsId} x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse">
          <circle cx="20" cy="20" r="1.2" fill={`rgb(${orbPrimary})`} />
        </pattern>
        <rect width="100%" height="100%" fill={`url(#${dotsId})`} />
      </svg>
      <svg className="absolute inset-0 h-full w-full opacity-[0.12]" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" viewBox="0 0 800 600">
        <path d="M-50 300 C100 200, 250 400, 400 280 S650 150, 850 320" stroke={`rgb(${orbPrimary})`} strokeWidth="1.5" fill="none" strokeDasharray="8 6" />
        <path d="M-30 450 C150 350, 300 500, 500 380 S700 250, 850 420" stroke={`rgb(${orbSecondary})`} strokeWidth="1" fill="none" strokeDasharray="6 8" />
        <circle cx="200" cy="350" r="4" stroke={`rgb(${orbPrimary})`} strokeWidth="0.8" fill={`rgba(${orbPrimary},0.1)`} />
        <circle cx="500" cy="300" r="4" stroke={`rgb(${orbPrimary})`} strokeWidth="0.8" fill={`rgba(${orbPrimary},0.1)`} />
        <circle cx="650" cy="220" r="3.5" stroke={`rgb(${orbSecondary})`} strokeWidth="0.7" fill={`rgba(${orbSecondary},0.1)`} />
      </svg>
      <div className="absolute left-0 right-0 top-[18%] h-px opacity-[0.12]" style={{ background: `linear-gradient(90deg, transparent 0%, rgb(${orbPrimary}) 20%, rgb(${orbPrimary}) 80%, transparent 100%)` }}></div>
      <div className="absolute left-0 right-0 top-[78%] h-px opacity-[0.1]" style={{ background: `linear-gradient(90deg, transparent 0%, rgb(${orbSecondary}) 30%, rgb(${orbSecondary}) 70%, transparent 100%)` }}></div>
    </div>
  );
}
