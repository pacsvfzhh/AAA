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
          max-width: 540px !important;
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
        className="employee-maintenance-dialog relative isolate max-h-full w-full max-w-[540px] overflow-y-auto overscroll-contain rounded-[24px] border border-white/70 bg-[#f8fbff] text-slate-700 shadow-[0_32px_100px_-24px_rgba(3,20,44,0.65),0_8px_28px_-12px_rgba(3,20,44,0.3)] outline-none"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        <div className="relative isolate overflow-hidden bg-gradient-to-br from-[#0b1d38] via-[#153d68] to-[#146779] px-[24px] pb-[30px] pt-[30px] sm:px-[36px] sm:pb-[32px] sm:pt-[34px]">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10" style={{ backgroundImage: 'radial-gradient(ellipse at 95% 0%, rgba(89, 217, 233, 0.2), transparent 60%), linear-gradient(120deg, transparent 40%, rgba(147, 221, 244, 0.04) 40.2%, transparent 40.5%)' }} />
          <div aria-hidden="true" className="pointer-events-none absolute -right-[72px] -top-[112px] -z-10 h-[320px] w-[320px] rounded-full border border-cyan-100/[0.12] shadow-[0_0_0_32px_rgba(207,250,254,0.035),0_0_0_64px_rgba(207,250,254,0.025)]" />
          <div aria-hidden="true" className="pointer-events-none absolute bottom-[28px] right-[38px] -z-10 h-[5px] w-[5px] rounded-full bg-cyan-100/50 shadow-[0_0_14px_rgba(165,243,252,0.6)]" />
          {!sessionEnded && <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t.login.maintenanceClose}
            className="absolute right-[10px] top-[10px] flex h-[44px] w-[44px] !min-h-[44px] items-center justify-center rounded-full !p-0 text-blue-100/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-200 disabled:opacity-60"
          >
            <X aria-hidden="true" className="h-[18px] w-[18px]" />
          </button>}

          <div aria-hidden="true" className="flex h-[62px] w-[62px] items-center justify-center rounded-[20px] border border-cyan-100/25 bg-gradient-to-br from-white/[0.16] to-cyan-200/5 shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_8px_24px_-12px_rgba(0,0,0,0.4)]">
            <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[14px] bg-gradient-to-br from-cyan-100/[0.16] to-sky-100/5 text-cyan-50">
              <Wrench className="h-[27px] w-[27px]" strokeWidth={1.6} />
            </span>
          </div>
          <h2 id={`${id}-title`} className="mt-[20px] break-words text-[24px] font-semibold leading-[1.35] tracking-[-0.4px] text-white sm:text-[27px]">
            {t.login.maintenanceTitle}
          </h2>
          <div aria-hidden="true" className="mt-[18px] h-[3px] w-[42px] rounded-full bg-gradient-to-r from-cyan-200 to-sky-300/30" />
        </div>

        <div aria-hidden="true" className="h-px bg-gradient-to-r from-cyan-300/60 via-sky-200 to-white" />

        <div className="bg-gradient-to-b from-white to-[#f3f8fd] px-[24px] pb-[28px] pt-[26px] sm:px-[36px] sm:pb-[32px] sm:pt-[28px]">
          <p id={`${id}-message`} className="break-words text-[15px] leading-[27px] text-slate-600 [hyphens:auto]">
            {sessionEnded ? t.login.maintenanceSessionMessage : t.login.maintenanceMessage}
          </p>

          <div className="relative mt-[22px] flex items-start gap-[12px] overflow-hidden rounded-[16px] border border-sky-100 bg-gradient-to-br from-[#edf5fc] to-white p-[16px] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
            <div aria-hidden="true" className="absolute inset-y-[16px] left-0 w-[3px] rounded-r-full bg-gradient-to-b from-sky-400 to-cyan-500/40" />
            <span aria-hidden="true" className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px] border border-sky-100 bg-white/90 text-[#286080] shadow-[0_2px_6px_-3px_rgba(15,76,110,0.2)]">
              <MessageCircle className="h-[18px] w-[18px]" strokeWidth={1.75} />
            </span>
            <p id={`${id}-contact`} className="min-w-0 self-center break-words text-[13px] leading-[23px] text-slate-600 [hyphens:auto]">
              {t.login.maintenanceContact}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="relative mt-[24px] flex w-full !min-h-[50px] items-center justify-center gap-[10px] overflow-hidden rounded-[13px] border border-[#184e76]/30 bg-gradient-to-r from-[#153b63] via-[#1b557d] to-[#176879] !px-[16px] !py-[13px] !text-[15px] font-semibold leading-[22px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_8px_18px_-8px_rgba(21,75,111,0.45)] transition-[filter] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-wait disabled:opacity-60"
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
