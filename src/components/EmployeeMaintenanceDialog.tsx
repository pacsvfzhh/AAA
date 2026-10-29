import { useId, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Loader2, LogOut, MessageCircle, Wrench } from 'lucide-react';
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
      className="employee-maintenance-overlay fixed inset-0 z-[10050] flex items-center justify-center overflow-hidden bg-[#071727]/[0.65] backdrop-blur-[8px] [--maintenance-gutter:16px] xs:[--maintenance-gutter:20px] md:[--maintenance-gutter:24px] low:![--maintenance-gutter:12px]"
      onPointerDown={event => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        dialogRef.current?.focus({ preventScroll: true });
      }}
      style={{
        paddingTop: 'max(var(--maintenance-gutter), env(safe-area-inset-top))',
        paddingRight: 'max(var(--maintenance-gutter), env(safe-area-inset-right))',
        paddingBottom: 'max(var(--maintenance-gutter), env(safe-area-inset-bottom))',
        paddingLeft: 'max(var(--maintenance-gutter), env(safe-area-inset-left))',
      }}
    >
      {/* Override legacy modal sizing without affecting other dialogs. */}
      <style>{`
        .employee-maintenance-overlay {
          height: 100%;
          height: 100dvh;
        }
        div.employee-maintenance-dialog[role="dialog"][aria-modal="true"] {
          width: 100% !important;
          max-width: var(--maintenance-dialog-width) !important;
          max-height: 100% !important;
          overflow: hidden !important;
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
        style={{ fontFamily: '"Microsoft YaHei", "微软雅黑", system-ui, sans-serif' }}
        className="employee-maintenance-dialog relative isolate flex max-h-full w-full flex-col overflow-hidden rounded-[18px] border border-white/80 bg-[#f8fafc] text-slate-700 shadow-[0_24px_72px_-24px_rgba(2,25,43,0.5)] outline-none [--maintenance-dialog-width:340px] md:rounded-[20px] md:[--maintenance-dialog-width:400px] lg:[--maintenance-dialog-width:440px]"
      >
        <div className="relative flex shrink-0 items-center gap-[8px] border-b border-[#0d5961] bg-gradient-to-r from-[#123d50] via-[#0f6570] to-[#0f766e] px-[18px] py-[15px] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] xs:gap-[10px] xs:px-[20px] md:gap-[12px] md:px-[24px] md:py-[17px] low:!py-[12px]">
          <div aria-hidden="true" className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[10px] border border-white/20 bg-white/10 text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] md:h-[34px] md:w-[34px] md:rounded-[11px]">
            <Wrench className="h-[17px] w-[17px] md:h-[18px] md:w-[18px]" strokeWidth={1.6} />
          </div>
          <h2 id={`${id}-title`} className="min-w-0 whitespace-nowrap !text-[15px] font-semibold leading-[1.4] text-white xs:!text-[16px] md:!text-[18px]">
            {t.login.maintenanceTitle}
          </h2>
        </div>
        <div
          tabIndex={0}
          className="relative min-h-0 overflow-y-auto overscroll-contain px-[18px] pt-[18px] outline-none [scrollbar-width:thin] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan-700/60 xs:px-[20px] md:px-[24px] md:pt-[22px] low:!pt-[14px]"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          <p id={`${id}-message`} className="break-words text-left text-[13px] leading-[22px] tracking-normal text-slate-600 [text-wrap:pretty] [word-spacing:normal] md:text-[14px] md:leading-[24px]">
            {sessionEnded ? t.login.maintenanceSessionMessage : t.login.maintenanceMessage}{' '}
            {sessionEnded ? t.login.maintenanceSessionNextStep : t.login.maintenanceNextStep}
          </p>

          <div className="mt-[18px] flex items-start gap-[9px] border-t border-slate-200/80 pt-[14px] md:mt-[20px] low:!mt-[14px] low:!pt-[12px]">
            <MessageCircle aria-hidden="true" className="mt-[2px] h-[16px] w-[16px] shrink-0 text-cyan-700" strokeWidth={1.75} />
            <p id={`${id}-contact`} className="min-w-0 break-words text-[12px] font-bold leading-[20px] text-[#0f6878]">
              {t.login.maintenanceContact}
            </p>
          </div>
        </div>

        <div className="relative shrink-0 px-[18px] pb-[20px] pt-[18px] xs:px-[20px] md:px-[24px] md:pb-[22px] md:pt-[20px] low:!pb-[14px] low:!pt-[14px]">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex w-full !min-h-[44px] items-center justify-center gap-[8px] rounded-[12px] bg-gradient-to-r from-[#12364f] to-[#0f6878] !px-[14px] !py-[10px] !text-[14px] font-semibold leading-[22px] text-white shadow-[0_6px_16px_-10px_rgba(15,104,120,0.45)] transition-colors hover:from-[#16445e] hover:to-[#137c86] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? <Loader2 aria-hidden="true" className="h-[18px] w-[18px] shrink-0 animate-spin motion-reduce:animate-none" /> : sessionEnded ? <LogOut aria-hidden="true" className="h-[18px] w-[18px] shrink-0" /> : <ArrowLeft aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />}
            <span className="min-w-0 break-words">{busy ? t.common.loading : sessionEnded ? t.login.maintenanceSessionAction : t.login.maintenanceAction}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
