import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, ChevronRight, Pin, Settings, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface SetupOption {
  id: string;
  label: string;
  description?: string | null;
  count?: number;
  pinned?: boolean;
  meta?: string;
}

interface EmployeeSetupSelectProps {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  options: SetupOption[];
  tone: 'violet' | 'cyan' | 'emerald';
  icon: LucideIcon;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  onOpenSettings?: () => void;
  emptyMessage?: string;
}

const tones = {
  violet: {
    button: 'border-violet-300/25 bg-violet-950/40 text-violet-100 hover:border-violet-300/60 hover:bg-violet-900/45 focus-visible:ring-violet-300/50',
    active: '!border-violet-300/70 !bg-violet-900/65 ring-2 ring-violet-400/20',
    icon: 'border-violet-300/25 bg-violet-400/15 text-violet-200',
    surface: 'border-violet-300/30 bg-[linear-gradient(145deg,#201331,#0e0b1c)]',
    header: 'border-violet-300/15 bg-violet-400/10 text-violet-100',
    option: 'hover:border-violet-300/35 hover:bg-violet-400/10 focus-visible:ring-violet-300/60',
    selected: 'border-violet-300/55 bg-gradient-to-r from-violet-600/35 to-fuchsia-500/10 text-violet-50',
    accent: 'text-violet-300',
  },
  cyan: {
    button: 'border-cyan-300/25 bg-cyan-950/35 text-cyan-100 hover:border-cyan-300/60 hover:bg-cyan-900/40 focus-visible:ring-cyan-300/50',
    active: '!border-cyan-300/70 !bg-cyan-900/60 ring-2 ring-cyan-400/20',
    icon: 'border-cyan-300/25 bg-cyan-400/15 text-cyan-200',
    surface: 'border-cyan-300/30 bg-[linear-gradient(145deg,#0e2838,#08141e)]',
    header: 'border-cyan-300/15 bg-cyan-400/10 text-cyan-100',
    option: 'hover:border-cyan-300/35 hover:bg-cyan-400/10 focus-visible:ring-cyan-300/60',
    selected: 'border-cyan-300/55 bg-gradient-to-r from-cyan-600/35 to-blue-500/10 text-cyan-50',
    accent: 'text-cyan-300',
  },
  emerald: {
    button: 'border-emerald-300/25 bg-emerald-950/35 text-emerald-100 hover:border-emerald-300/60 hover:bg-emerald-900/40 focus-visible:ring-emerald-300/50',
    active: '!border-emerald-300/70 !bg-emerald-900/60 ring-2 ring-emerald-400/20',
    icon: 'border-emerald-300/25 bg-emerald-400/15 text-emerald-200',
    surface: 'border-emerald-300/30 bg-[linear-gradient(145deg,#102c29,#081815)]',
    header: 'border-emerald-300/15 bg-emerald-400/10 text-emerald-100',
    option: 'hover:border-emerald-300/35 hover:bg-emerald-400/10 focus-visible:ring-emerald-300/60',
    selected: 'border-emerald-300/55 bg-gradient-to-r from-emerald-600/35 to-teal-500/10 text-emerald-50',
    accent: 'text-emerald-300',
  },
};

function menuPosition(rect: DOMRect, optionCount: number) {
  const padding = 12;
  const gap = 12;
  const availableRight = window.innerWidth - rect.right - padding - gap;
  const height = Math.min(414, 66 + Math.max(1, optionCount) * 60, window.innerHeight - padding * 2);
  if (availableRight >= 230) {
    const top = Math.max(padding, Math.min(rect.top - 44, window.innerHeight - height - padding));
    return { left: rect.right + gap, top, width: Math.min(340, availableRight), maxHeight: height, side: 'right', transformOrigin: `left ${rect.top + rect.height / 2 - top}px` };
  }
  const width = Math.min(340, window.innerWidth - padding * 2);
  const below = window.innerHeight - rect.bottom - padding - 8;
  const above = rect.top - padding - 8;
  const openBelow = below >= height || below >= above;
  const maxHeight = Math.min(height, Math.max(below, above));
  return {
    left: Math.max(padding, Math.min(rect.left, window.innerWidth - width - padding)),
    top: openBelow ? rect.bottom + 8 : Math.max(padding, rect.top - maxHeight - 8),
    width, maxHeight, side: openBelow ? 'bottom' : 'top', transformOrigin: openBelow ? 'top right' : 'bottom right',
  };
}

const stopPortalEvent = (event: SyntheticEvent) => event.stopPropagation();

export default function EmployeeSetupSelect({
  id, label, placeholder, value, options, tone, icon: Icon, onChange, required = false,
  disabled = false, invalid = false, onOpenSettings, emptyMessage = '目前沒有可選項目',
}: EmployeeSetupSelectProps) {
  const listId = useId();
  const detailsId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRect = useRef<DOMRect | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<ReturnType<typeof menuPosition> | null>(null);
  const [details, setDetails] = useState<{ option: SetupOption; left: number; top: number; width: number } | null>(null);
  const selected = options.find(option => option.id === value);
  const detailsOpen = Boolean(details);
  const theme = tones[tone];

  const close = useCallback((restoreFocus = false) => {
    setPosition(null);
    setDetails(null);
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  useLayoutEffect(() => {
    if (!position) return;
    const option = menuRef.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')
      || menuRef.current?.querySelector<HTMLButtonElement>('[role="option"]')
      || menuRef.current?.querySelector<HTMLButtonElement>('button');
    option?.focus({ preventScroll: true });
  }, [position]);

  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      if (!buttonRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) close();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const viewport = (event: Event) => {
      if (event.type === 'scroll') {
        const target = event.target;
        if (target instanceof Element && target.closest('[role="tooltip"]')) return;
        if (menuRef.current?.contains(target as Node)) { setDetails(null); return; }
        const rect = buttonRef.current?.getBoundingClientRect();
        const anchor = anchorRect.current;
        // Scroll events queued before opening do not move the menu's anchor.
        if (rect && anchor && Math.abs(rect.top - anchor.top) < 1 && Math.abs(rect.left - anchor.left) < 1) return;
      }
      close();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', viewport);
    window.addEventListener('scroll', viewport, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', viewport);
      window.removeEventListener('scroll', viewport, true);
    };
  }, [position, close]);

  useEffect(() => {
    if (position || !detailsOpen) return;
    const dismiss = (event: Event) => {
      if (event.type === 'scroll' && event.target instanceof Element && event.target.closest('[role="tooltip"]')) return;
      setDetails(null);
    };
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [position, detailsOpen]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  const toggle = () => {
    if (position) return close();
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      anchorRect.current = rect;
      setPosition(menuPosition(rect, options.length));
    }
  };
  const showDetails = (target: HTMLButtonElement, option: SetupOption) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const text = target.querySelector<HTMLElement>('[data-option-label]');
    if (!option.description || !text || text.scrollWidth <= text.clientWidth) return setDetails(null);
    const rect = target.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    const beside = rect.left >= width + 24;
    setDetails({ option, width, left: beside ? rect.left - width - 12 : Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: Math.max(12, Math.min(beside ? rect.top : rect.bottom + 6, window.innerHeight - 232)) });
  };
  const hideDetails = () => {
    hideTimer.current = setTimeout(() => setDetails(null), 120);
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      const focusable = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
      const boundary = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
      if (document.activeElement === boundary) { event.preventDefault(); close(true); }
      return;
    }
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || []);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % buttons.length
        : event.key === 'ArrowUp' ? (current - 1 + buttons.length) % buttons.length : -1;
    if (next < 0 || !buttons.length) return;
    event.preventDefault();
    buttons[next].focus();
  };

  return (
    <>
      <button
        ref={buttonRef} id={id} type="button" aria-label={label} aria-haspopup="listbox"
        aria-expanded={Boolean(position)} aria-controls={position ? listId : undefined}
        aria-required={required || undefined} aria-invalid={invalid || undefined} disabled={disabled}
        aria-describedby={details && !position ? detailsId : undefined}
        onMouseEnter={event => { if (selected && !position) showDetails(event.currentTarget, selected); }} onMouseLeave={hideDetails}
        onFocus={event => { if (selected && !position) showDetails(event.currentTarget, selected); }} onBlur={() => setDetails(null)}
        onClick={toggle}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!position) toggle(); }
        }}
        className={`group flex min-h-[58px] w-full items-center gap-3 rounded-xl border p-2.5 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-45 ${theme.button} ${position ? theme.active : ''} ${invalid ? '!border-rose-400' : ''}`}
      >
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${theme.icon}`}><Icon className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1">
          <span data-option-label className={`block truncate text-xs font-bold ${selected ? '' : 'opacity-65'}`}>{selected ? <>{selected.label}{selected.description ? <span className="ml-1 font-normal opacity-65">（{selected.description}）</span> : null}</> : placeholder}</span>
          <span className="mt-1 block text-[9px] font-medium tracking-wide opacity-45">{selected?.meta || (selected ? '已選擇 · 點擊更換' : '點擊選擇')}</span>
        </span>
        <ChevronRight className={`h-4 w-4 shrink-0 transition-transform duration-200 ${position ? 'translate-x-0.5' : 'opacity-55 group-hover:translate-x-0.5 group-hover:opacity-100'}`} />
      </button>
      {position && createPortal(
        <div ref={menuRef} className="fixed z-[10050]" data-side={position.side} style={{ left: position.left, top: position.top, width: position.width }} onPointerDown={stopPortalEvent} onPointerUp={stopPortalEvent} onMouseDown={stopPortalEvent} onClick={stopPortalEvent} onKeyDown={event => { event.stopPropagation(); navigate(event); }}>
          <div data-tone={tone} className={`employee-setup-menu flex flex-col overflow-hidden rounded-2xl border shadow-[0_24px_70px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.03)] ${theme.surface}`} style={{ maxHeight: position.maxHeight, transformOrigin: position.transformOrigin }}>
            <div className={`flex shrink-0 items-center gap-2 border-b px-3.5 py-3 ${theme.header}`}>
              <Icon className="h-4 w-4" /><span className="flex-1 text-xs font-bold">{label}</span><span className="text-[10px] opacity-50">{options.length} 個選項</span>
              {onOpenSettings && <button type="button" aria-label="地區設定" title="編輯或新增地區" onClick={() => { close(); onOpenSettings(); }} className="rounded-md border border-current/20 bg-white/5 p-1.5 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"><Settings className="h-3.5 w-3.5" /></button>}
              <button type="button" aria-label={`關閉${label}選單`} onClick={() => close(true)} className="rounded-md p-1 text-current opacity-60 transition-colors hover:bg-white/10 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"><X className="h-3.5 w-3.5" /></button>
            </div>
            <div id={listId} role="listbox" aria-label={label} className="employee-region-scrollbar min-h-0 space-y-1.5 overflow-y-auto overscroll-contain p-2" style={{ scrollbarColor: tone === 'cyan' ? '#3f9eae #102633' : tone === 'emerald' ? '#439b80 #102a23' : undefined }}>
              {options.map(option => (
                <button key={option.id} type="button" role="option" aria-selected={value === option.id} aria-describedby={details?.option.id === option.id ? detailsId : undefined}
                  onClick={() => { onChange(option.id); close(true); }} onMouseEnter={event => showDetails(event.currentTarget, option)} onMouseLeave={hideDetails} onFocus={event => showDetails(event.currentTarget, option)} onBlur={() => setDetails(null)}
                  className={`group/option flex min-h-[52px] w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ${value === option.id ? theme.selected : `border-white/[0.045] bg-white/[0.025] text-slate-200 ${theme.option}`}`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${theme.icon}`}>{option.pinned ? <Pin className="h-3 w-3" /> : <Icon className="h-3 w-3" />}</span>
                  <span className="min-w-0 flex-1"><span data-option-label className="block truncate text-xs font-semibold">{option.label}{option.description ? <span className="ml-1 font-normal text-slate-400">（{option.description}）</span> : null}</span>{option.meta && <span className={`mt-1 block text-[9px] ${theme.accent}`}>{option.meta}</span>}</span>
                  {option.count !== undefined && <span className={`shrink-0 text-[10px] tabular-nums ${theme.accent}`}>{option.count} 人</span>}
                  {value === option.id ? <Check className={`h-4 w-4 shrink-0 ${theme.accent}`} /> : <ArrowRight className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/option:opacity-50" />}
                </button>
              ))}
              {options.length === 0 && <p className="px-3 py-6 text-center text-xs leading-5 text-slate-400">{emptyMessage}</p>}
            </div>
          </div>
        </div>, document.body,
      )}
      {details && createPortal(<div id={detailsId} role="tooltip" onPointerDown={stopPortalEvent} onPointerUp={stopPortalEvent} onMouseDown={stopPortalEvent} onClick={stopPortalEvent} onMouseEnter={() => { if (hideTimer.current) clearTimeout(hideTimer.current); }} onMouseLeave={hideDetails} className={`employee-setup-details fixed z-[10060] rounded-xl border p-3.5 shadow-[0_18px_50px_rgba(0,0,0,0.65)] ${theme.surface}`} style={{ left: details.left, top: details.top, width: details.width }}><p className={`mb-2 break-words text-xs font-bold ${theme.accent}`}>{details.option.label}</p><p className="employee-region-scrollbar max-h-[156px] overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-200">{details.option.description}</p></div>, document.body)}
    </>
  );
}
