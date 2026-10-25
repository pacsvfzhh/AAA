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
      className="fixed inset-0 z-[10050] flex items-center justify-center overflow-hidden bg-[#071727]/[0.65] backdrop-blur-[8px]"
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
        className="employee-maintenance-dialog relative isolate max-h-full w-full max-w-[520px] overflow-y-auto overscroll-contain rounded-[28px] border border-white/80 bg-[#f8fafc] text-slate-700 shadow-[0_32px_100px_-24px_rgba(2,25,43,0.6)] outline-none"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[240px] rounded-t-[28px] bg-gradient-to-b from-cyan-50 via-sky-50/40 to-transparent" />
        <div className="relative px-[24px] pb-[26px] pt-[18px] sm:px-[32px] sm:pb-[32px] sm:pt-[22px]">
          <div className="flex min-h-[44px] items-center justify-between gap-[12px]">
            <span className="inline-flex min-w-0 items-center gap-[8px] rounded-full border border-amber-200/70 bg-amber-50 px-[12px] py-[6px] text-[12px] font-semibold leading-[18px] text-amber-800">
              <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 rounded-full bg-amber-500" />
              <span className="break-words">{t.login.maintenanceStatus}</span>
            </span>
            {!sessionEnded && <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label={t.login.maintenanceClose}
              className="-mr-[10px] flex h-[44px] w-[44px] !min-h-[44px] shrink-0 items-center justify-center rounded-full !p-0 text-slate-500 transition-colors hover:bg-slate-200/60 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:opacity-60"
            >
              <X aria-hidden="true" className="h-[20px] w-[20px]" />
            </button>}
          </div>

          <div className="mt-[18px] text-center">
            <div aria-hidden="true" className="mx-auto flex h-[80px] w-[80px] items-center justify-center rounded-[26px] border border-cyan-100/80 bg-white/80 shadow-[0_8px_28px_-14px_rgba(14,116,144,0.3)]">
              <span className="flex h-[60px] w-[60px] items-center justify-center rounded-[20px] bg-gradient-to-br from-[#153349] to-[#137c86] text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
                <Wrench className="h-[29px] w-[29px]" strokeWidth={1.6} />
              </span>
            </div>
            <h2 id={`${id}-title`} className="mt-[22px] break-words text-[24px] font-bold leading-[1.4] tracking-[-0.4px] text-[#123047] sm:text-[26px]">
              {t.login.maintenanceTitle}
            </h2>
            <p id={`${id}-message`} className="mt-[14px] break-words text-[15px] leading-[26px] text-slate-600 [hyphens:auto]">
              {sessionEnded ? t.login.maintenanceSessionMessage : t.login.maintenanceMessage}
            </p>
          </div>

          <div className="mt-[24px] flex items-start gap-[12px] rounded-[18px] border border-slate-200/80 bg-white/90 p-[16px]">
            <span aria-hidden="true" className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px] bg-cyan-50 text-cyan-800">
              <MessageCircle className="h-[18px] w-[18px]" strokeWidth={1.75} />
            </span>
            <p id={`${id}-contact`} className="min-w-0 self-center break-words text-[13px] leading-[22px] text-slate-600 [hyphens:auto]">
              {t.login.maintenanceContact}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="mt-[24px] flex w-full !min-h-[48px] items-center justify-center gap-[10px] rounded-[14px] bg-gradient-to-r from-[#12364f] to-[#0f6878] !px-[16px] !py-[13px] !text-[15px] font-semibold leading-[22px] text-white shadow-[0_8px_20px_-12px_rgba(15,104,120,0.55)] transition-colors hover:from-[#16445e] hover:to-[#137c86] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:cursor-wait disabled:opacity-60"
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
