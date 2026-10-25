import { useId, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Loader2, LogOut, MessageCircle, Wrench, X } from 'lucide-react';
import { useLanguage } from '../lib/i18n/context';

interface EmployeeMaintenanceDialogProps {
  onClose: () => void;
  sessionEnded?: boolean;
  busy?: boolean;
}

export default function EmployeeMaintenanceDialog({ onClose, sessionEnded = false, busy = false }: EmployeeMaintenanceDialogProps) {
  const { t, dateLocale } = useLanguage();
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
      className="fixed inset-0 z-[10050] flex items-center justify-center overflow-hidden bg-[#0b1730]/[0.56] backdrop-blur-[8px]"
      onPointerDown={event => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        dialogRef.current?.focus({ preventScroll: true });
      }}
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
          max-width: 520px !important;
          max-height: 100% !important;
          padding: 0 !important;
        }
      `}</style>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-message ${id}-contact`}
        lang={dateLocale}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="employee-maintenance-dialog relative isolate max-h-full w-full max-w-[520px] overflow-y-auto overscroll-contain rounded-[24px] border border-slate-200/90 bg-white text-slate-700 shadow-[0_24px_80px_-20px_rgba(15,32,55,0.35),0_4px_16px_-6px_rgba(15,32,55,0.12)] outline-none"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[160px] rounded-t-[24px] bg-gradient-to-b from-slate-50 to-transparent" />
        <div className="relative px-[24px] py-[28px] sm:px-[40px] sm:py-[36px]">
          {!sessionEnded && <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t.login.maintenanceClose}
            className="absolute right-[12px] top-[12px] flex h-[44px] w-[44px] !min-h-[44px] items-center justify-center rounded-full !p-0 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-60"
          >
            <X aria-hidden="true" className="h-[18px] w-[18px]" />
          </button>}

          <div>
            <div aria-hidden="true" className="flex h-[56px] w-[56px] items-center justify-center rounded-[18px] border border-blue-100 bg-gradient-to-br from-white to-blue-50 text-[#244e78] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_3px_10px_-5px_rgba(36,78,120,0.18)]">
              <Wrench className="h-[26px] w-[26px]" strokeWidth={1.6} />
            </div>
            <h2 id={`${id}-title`} className="mt-[24px] break-words text-[24px] font-semibold leading-[1.35] tracking-[-0.5px] text-[#172b4d] sm:text-[26px]">
              {t.login.maintenanceTitle}
            </h2>
            <p id={`${id}-message`} className="mt-[14px] break-words text-[15px] leading-[27px] text-slate-600 [hyphens:auto]">
              {sessionEnded ? t.login.maintenanceSessionMessage : t.login.maintenanceMessage}
            </p>
          </div>

          <div className="mt-[24px] flex items-start gap-[10px] border-t border-slate-200/80 pt-[20px]">
            <MessageCircle aria-hidden="true" className="mt-[2px] h-[18px] w-[18px] shrink-0 text-[#52769c]" strokeWidth={1.75} />
            <p id={`${id}-contact`} className="min-w-0 break-words text-[13px] leading-[22px] text-slate-500 [hyphens:auto]">
              {t.login.maintenanceContact}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="mt-[26px] flex w-full !min-h-[48px] items-center justify-center gap-[10px] rounded-[12px] border border-[#173e67] bg-[#173e67] !px-[16px] !py-[13px] !text-[15px] font-semibold leading-[22px] text-white shadow-[0_4px_12px_-4px_rgba(23,62,103,0.24)] transition-colors hover:border-[#214f7c] hover:bg-[#214f7c] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? <Loader2 aria-hidden="true" className="h-[18px] w-[18px] shrink-0 animate-spin motion-reduce:animate-none" /> : sessionEnded ? <LogOut aria-hidden="true" className="h-[18px] w-[18px] shrink-0" /> : <ArrowLeft aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />}
            <span>{busy ? t.common.loading : sessionEnded ? t.login.maintenanceSessionAction : t.login.maintenanceAction}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
