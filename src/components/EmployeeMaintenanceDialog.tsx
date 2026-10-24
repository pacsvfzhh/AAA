import { useId, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Globe, PauseCircle, Shield, Wrench, X } from 'lucide-react';
import { useLanguage } from '../lib/i18n/context';
import { LANGUAGES } from '../lib/i18n/types';

interface EmployeeMaintenanceDialogProps {
  onClose: () => void;
  sessionEnded?: boolean;
  busy?: boolean;
}

export default function EmployeeMaintenanceDialog({ onClose, sessionEnded = false, busy = false }: EmployeeMaintenanceDialogProps) {
  const { t, language, setLanguage, dateLocale } = useLanguage();
  const dialogRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById('root');
    const previousInert = root?.getAttribute('inert');
    const { body, documentElement } = document;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const previousBodyStyles = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      overflow: body.style.overflow,
    };
    const previousHtmlOverflow = documentElement.style.overflow;

    // The portal stays interactive while the login page is unavailable to pointer and keyboard input.
    root?.setAttribute('inert', '');
    Object.assign(body.style, {
      position: 'fixed',
      top: `-${scrollY}px`,
      left: `-${scrollX}px`,
      right: '0',
      overflow: 'hidden',
    });
    documentElement.style.overflow = 'hidden';
    dialog.focus({ preventScroll: true });

    const keepFocusInside = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        dialog.focus({ preventScroll: true });
      }
    };
    document.addEventListener('focusin', keepFocusInside);

    return () => {
      document.removeEventListener('focusin', keepFocusInside);
      if (previousInert == null) root?.removeAttribute('inert');
      else root?.setAttribute('inert', previousInert);
      Object.assign(body.style, previousBodyStyles);
      documentElement.style.overflow = previousHtmlOverflow;
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (!sessionEnded && !busy) onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )).filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];

    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10050] flex items-center justify-center overflow-hidden bg-slate-950/55 backdrop-blur-[6px]"
      style={{
        paddingTop: 'max(16px, env(safe-area-inset-top))',
        paddingRight: 'max(16px, env(safe-area-inset-right))',
        paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
        paddingLeft: 'max(16px, env(safe-area-inset-left))',
      }}
    >
      {/* Override the legacy global phone-modal sizing without changing other dialogs. */}
      <style>{`
        div.employee-maintenance-dialog[role="dialog"][aria-modal="true"] {
          width: 100% !important;
          max-width: 540px !important;
          max-height: 100% !important;
          padding: 0 !important;
        }
      `}</style>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-message ${id}-contact`}
        lang={dateLocale}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="employee-maintenance-dialog relative max-h-full w-full max-w-[540px] overflow-y-auto overscroll-contain rounded-[24px] border border-white/70 bg-slate-50 text-slate-700 shadow-[0_28px_90px_-20px_rgba(15,23,42,0.55)] outline-none"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-950 via-blue-950 to-blue-800 px-[24px] pb-[26px] pt-[18px] sm:px-[32px]">
          <div aria-hidden="true" className="pointer-events-none absolute -right-[48px] -top-[72px] h-[240px] w-[240px] rounded-full border border-cyan-200/10 bg-cyan-300/5" />
          <div aria-hidden="true" className="pointer-events-none absolute -bottom-[80px] right-[20px] h-[180px] w-[180px] rounded-full border border-cyan-200/10" />
          <div className="relative flex items-start justify-between gap-[12px]">
            <span className="mt-[6px] inline-flex min-w-0 items-center gap-[8px] rounded-[12px] border border-cyan-200/25 bg-cyan-300/10 px-[10px] py-[6px] text-[12px] font-semibold leading-[18px] text-cyan-100">
              <PauseCircle aria-hidden="true" className="h-[15px] w-[15px] shrink-0" />
              <span>{t.login.maintenanceStatus}</span>
            </span>
            {!sessionEnded && <button
              type="button"
              onClick={onClose}
              aria-label={t.login.maintenanceClose}
              className="-mr-[10px] flex h-[44px] w-[44px] !min-h-[44px] shrink-0 items-center justify-center rounded-[12px] !p-0 text-blue-100 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200"
            >
              <X aria-hidden="true" className="h-[20px] w-[20px]" />
            </button>}
          </div>
          <div className="relative mt-[22px] flex items-start gap-[14px]">
            <span aria-hidden="true" className="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-[16px] border border-cyan-200/25 bg-gradient-to-br from-cyan-300/20 to-blue-400/10 text-cyan-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]">
              <Wrench className="h-[24px] w-[24px]" strokeWidth={1.75} />
            </span>
            <h2 id={`${id}-title`} className="min-w-0 self-center break-words text-[24px] font-bold leading-[1.3] tracking-[-0.4px] text-white sm:text-[26px]">
              {t.login.maintenanceTitle}
            </h2>
          </div>
        </div>

        <div className="h-[3px] bg-gradient-to-r from-cyan-400 via-sky-300 to-blue-100" aria-hidden="true" />

        <div className="px-[24px] pb-[26px] pt-[24px] sm:px-[32px]">
          <p id={`${id}-message`} className="break-words text-[15px] leading-[26px] text-slate-600">
            {sessionEnded ? t.login.maintenanceSessionMessage : t.login.maintenanceMessage}
          </p>
          <div className="mt-[18px] flex items-start gap-[12px] rounded-[16px] border border-sky-100 bg-gradient-to-br from-blue-50 to-white p-[16px]">
            <Shield aria-hidden="true" className="mt-[3px] h-[20px] w-[20px] shrink-0 text-sky-700" strokeWidth={1.75} />
            <p id={`${id}-contact`} className="min-w-0 break-words text-[14px] leading-[24px] text-slate-600">
              {t.login.maintenanceContact}
            </p>
          </div>

          <div className="mt-[24px] border-t border-slate-200/80 pt-[20px]">
            <label htmlFor={`${id}-language`} className="mb-[8px] flex items-center gap-[7px] text-[12px] font-semibold leading-[18px] text-slate-500">
              <Globe aria-hidden="true" className="h-[14px] w-[14px]" />
              {t.login.maintenanceLanguage}
            </label>
            <select
              id={`${id}-language`}
              value={language}
              disabled={busy}
              onChange={event => {
                const selected = LANGUAGES.find(option => option.code === event.target.value);
                if (selected) setLanguage(selected.code);
              }}
              className="block w-full !min-h-[44px] rounded-[12px] border border-slate-300 bg-white px-[12px] py-[10px] !text-[16px] leading-[22px] text-slate-800 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
              style={{ appearance: 'auto', WebkitAppearance: 'menulist', colorScheme: 'light' }}
            >
              {LANGUAGES.map(option => (
                <option key={option.code} value={option.code} lang={option.code} className="bg-white text-slate-900">
                  {option.nativeName}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="mt-[16px] disabled:opacity-60 flex w-full !min-h-[44px] items-center justify-center gap-[10px] rounded-[12px] bg-gradient-to-r from-blue-700 to-blue-600 !px-[16px] !py-[12px] !text-[15px] font-semibold leading-[22px] text-white shadow-[0_8px_18px_-10px_rgba(37,99,235,0.6)] transition-colors hover:from-blue-800 hover:to-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              <ArrowLeft aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
              <span>{busy ? t.common.loading : sessionEnded ? t.login.maintenanceSessionAction : t.login.maintenanceAction}</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
