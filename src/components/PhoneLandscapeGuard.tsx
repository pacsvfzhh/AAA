import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlarmClock, BellRing, Smartphone } from 'lucide-react';
import { useLanguage } from '../lib/i18n/context';

export interface PhoneLandscapeNotice {
  message: string;
  tone: 'order' | 'urgent';
}

// Phones only: touch is the primary input and the screen's short side is under 600 CSS px (tablets start at 600).
function isPhone() {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && Math.min(window.screen.width, window.screen.height) < 600;
}

// Uses the device orientation rather than the viewport shape: an on-screen keyboard can make a portrait viewport wider than tall.
function isLandscape() {
  const type = window.screen.orientation?.type;
  if (type) return type.startsWith('landscape');
  const legacyAngle = (window as Window & { orientation?: number }).orientation;
  if (typeof legacyAngle === 'number') return Math.abs(legacyAngle) === 90;
  return window.matchMedia?.('(orientation: landscape)').matches ?? false;
}

function usePhoneLandscape() {
  const [blocked, setBlocked] = useState(() => isPhone() && isLandscape());

  useEffect(() => {
    let timer = 0;
    const update = () => setBlocked(isPhone() && isLandscape());
    // iOS may report the new orientation slightly after the event fires.
    const handleChange = () => {
      update();
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 350);
    };
    const orientation = window.screen.orientation;
    orientation?.addEventListener?.('change', handleChange);
    window.addEventListener('orientationchange', handleChange);
    window.addEventListener('resize', handleChange);
    return () => {
      window.clearTimeout(timer);
      orientation?.removeEventListener?.('change', handleChange);
      window.removeEventListener('orientationchange', handleChange);
      window.removeEventListener('resize', handleChange);
    };
  }, []);

  return blocked;
}

// Covers the page while a phone is held sideways; the page underneath keeps running and resumes as it was.
export default function PhoneLandscapeGuard({ notice }: { notice?: PhoneLandscapeNotice | null }) {
  const blocked = usePhoneLandscape();
  const { t } = useLanguage();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!blocked) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
  }, [blocked]);

  // On very short screens or with enlarged system text, drop the explanation so the title and order notice stay visible.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const guard = card?.closest<HTMLElement>('.phone-landscape-guard');
    if (!blocked || !card || !guard) return;
    const fit = () => {
      const style = getComputedStyle(guard);
      const room = guard.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      card.removeAttribute('data-compact');
      if (card.offsetHeight > room) card.setAttribute('data-compact', '');
    };
    fit();
    void document.fonts?.ready.then(fit);
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [blocked, notice?.message, t]);

  if (!blocked) return null;

  const NoticeIcon = notice?.tone === 'urgent' ? AlarmClock : BellRing;

  return createPortal(
    <div className="phone-landscape-guard">
      <div className="plg-blocks" aria-hidden="true">
        <span className="plg-block plg-block--1" />
        <span className="plg-block plg-block--2" />
        <span className="plg-block plg-block--3" />
        <span className="plg-block plg-block--4" />
      </div>
      <div className="plg-stage">
        <span className="plg-accent plg-accent--a" aria-hidden="true" />
        <span className="plg-accent plg-accent--b" aria-hidden="true" />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="phone-landscape-title"
          aria-describedby="phone-landscape-message"
          className="plg-card"
          ref={cardRef}
        >
          <span className="plg-tile" aria-hidden="true">
            <Smartphone className="plg-phone" strokeWidth={1.9} />
          </span>
          <div className="plg-copy">
            <h2 id="phone-landscape-title" className="plg-title">{t.orientation.title}</h2>
            <p id="phone-landscape-message" className="plg-message">{t.orientation.message}</p>
            {notice && (
              <p role="status" className={`plg-notice plg-notice--${notice.tone}`}>
                <NoticeIcon aria-hidden="true" className="plg-notice-icon" strokeWidth={2.2} />
                <span>{notice.message}</span>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
