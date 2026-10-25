import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, ChevronRight, CircleOff, Pin, Settings, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface SetupOption {
  id: string;
  label: string;
  description?: string | null;
  count?: number;
  pinned?: boolean;
  meta?: string;
  unassigned?: boolean;
}

interface EmployeeSetupSelectProps {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  options: SetupOption[];
  tone: 'violet' | 'teal' | 'amber';
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
    button: 'border-violet-300/25 bg-gradient-to-r from-violet-300/[0.09] to-indigo-300/[0.03] text-violet-100 hover:border-violet-300/50 hover:from-violet-300/15 focus-visible:ring-violet-300/40',
    active: '!border-violet-300/60 ring-2 ring-violet-300/10',
    icon: 'border-violet-300/20 bg-violet-300/10 text-violet-200',
    surface: 'border-violet-300/25',
    header: 'border-violet-300/15 bg-gradient-to-r from-violet-300/[0.08] to-transparent text-violet-100',
    option: 'hover:border-violet-300/25 hover:bg-violet-300/[0.08] focus-visible:ring-violet-300/60',
    selected: 'border-violet-300/40 bg-gradient-to-r from-violet-300/15 to-indigo-300/5 text-violet-50',
    accent: 'text-violet-200',
    scrollbar: '#7c7095 #1b1d26',
  },
  teal: {
    button: 'border-teal-200/25 bg-gradient-to-r from-teal-200/[0.08] to-sky-300/[0.03] text-teal-50 hover:border-teal-200/50 hover:from-teal-200/[0.14] focus-visible:ring-teal-200/40',
    active: '!border-teal-200/60 ring-2 ring-teal-200/10',
    icon: 'border-teal-200/20 bg-teal-200/10 text-teal-200',
    surface: 'border-teal-200/25',
    header: 'border-teal-200/15 bg-gradient-to-r from-teal-200/[0.08] to-transparent text-teal-50',
    option: 'hover:border-teal-200/25 hover:bg-teal-200/[0.08] focus-visible:ring-teal-200/60',
    selected: 'border-teal-200/40 bg-gradient-to-r from-teal-200/15 to-sky-300/5 text-teal-50',
    accent: 'text-teal-200',
    scrollbar: '#5c837e #1b2226',
  },
  amber: {
    button: 'border-amber-200/25 bg-gradient-to-r from-amber-200/[0.09] to-rose-300/[0.03] text-amber-50 hover:border-amber-200/50 hover:from-amber-200/15 focus-visible:ring-amber-200/40',
    active: '!border-amber-200/60 ring-2 ring-amber-200/10',
    icon: 'border-amber-200/20 bg-amber-200/10 text-amber-200',
    surface: 'border-amber-200/25',
    header: 'border-amber-200/15 bg-gradient-to-r from-amber-200/[0.08] to-transparent text-amber-50',
    option: 'hover:border-amber-200/25 hover:bg-amber-200/[0.08] focus-visible:ring-amber-200/60',
    selected: 'border-amber-200/40 bg-gradient-to-r from-amber-200/15 to-rose-300/5 text-amber-50',
    accent: 'text-amber-200',
    scrollbar: '#958364 #24211b',
  },
};

function menuPosition(rect: DOMRect, optionCount: number) {
  const padding = 12;
  const gap = 10;
  const availableRight = window.innerWidth - rect.right - padding - gap;
  const height = Math.min(326, 58 + Math.max(1, optionCount) * 42, window.innerHeight - padding * 2);
  if (availableRight >= 230) {
    const top = Math.max(padding, Math.min(rect.top - 44, window.innerHeight - height - padding));
    return { left: rect.right + gap, top, width: Math.min(296, availableRight), maxHeight: height, side: 'right', transformOrigin: `left ${rect.top + rect.height / 2 - top}px` };
  }
  const width = Math.min(296, window.innerWidth - padding * 2);
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
  const unassigned = selected?.unassigned === true;
  const SelectedIcon = unassigned ? CircleOff : Icon;
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
        data-unassigned={unassigned || undefined}
        data-setup-tone={tone}
        data-configured={Boolean(selected && !unassigned)}
        className={`group flex min-h-[54px] w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left shadow-[0_2px_8px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.025)] transition-all duration-200 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-45 ${unassigned ? 'border-dashed border-stone-500/60 bg-black/15 text-stone-300 hover:border-stone-400 hover:bg-white/[0.03] focus-visible:ring-stone-400/40' : theme.button} ${position ? unassigned ? '!border-stone-400 ring-2 ring-stone-400/10' : theme.active : ''} ${invalid ? '!border-rose-400' : ''}`}
      >
        <span className={`employee-setup-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${unassigned ? 'border-stone-500/25 bg-white/[0.03] text-stone-400' : theme.icon}`}><SelectedIcon className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1">
          <span data-option-label className={`block truncate text-xs font-bold ${selected ? '' : 'opacity-65'}`}>{selected ? <>{selected.label}{selected.description ? <span className="ml-1 font-normal opacity-65">（{selected.description}）</span> : null}</> : placeholder}</span>
          <span className="mt-0.5 block truncate text-[10px] font-medium opacity-70">{unassigned ? '不建立自動通知 · 可稍後設定' : selected?.meta || (selected ? '已選擇 · 點擊更換' : '點擊選擇')}</span>
        </span>
        {selected && !unassigned && <span className="employee-setup-selection-badge shrink-0 items-center gap-1 rounded-md border px-1.5 py-1 text-[9px] font-semibold"><Check className="h-3 w-3" />已選擇</span>}
        {unassigned && <span className="shrink-0 rounded-md border border-stone-500/25 bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-semibold text-stone-400">未套用</span>}
        <ChevronRight className={`h-4 w-4 shrink-0 transition-transform duration-200 ${position ? 'translate-x-0.5' : 'opacity-55 group-hover:translate-x-0.5 group-hover:opacity-100'}`} />
      </button>
      {position && createPortal(
        <div ref={menuRef} className="fixed z-[10050]" data-side={position.side} style={{ left: position.left, top: position.top, width: position.width }} onPointerDown={stopPortalEvent} onPointerUp={stopPortalEvent} onMouseDown={stopPortalEvent} onClick={stopPortalEvent} onKeyDown={event => { event.stopPropagation(); navigate(event); }}>
          <div data-tone={tone} className={`employee-setup-menu flex flex-col overflow-hidden rounded-xl border shadow-[0_18px_48px_rgba(2,6,23,0.28),0_2px_8px_rgba(2,6,23,0.12)] ${theme.surface}`} style={{ maxHeight: position.maxHeight, transformOrigin: position.transformOrigin }}>
            <div className={`flex shrink-0 items-center gap-2 border-b px-3 py-2 ${theme.header}`}>
              <Icon className="h-4 w-4" /><span className="flex-1 text-xs font-bold">{label}</span><span className="text-[10px] opacity-50">{options.length} 個選項</span>
              {onOpenSettings && <button type="button" aria-label="地區設定" title="編輯或新增地區" onClick={() => { close(); onOpenSettings(); }} className="rounded-md border border-transparent bg-white/5 p-1.5 text-violet-200 transition-colors hover:border-violet-300/20 hover:bg-violet-300/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300/60"><Settings className="h-3.5 w-3.5" /></button>}
              <button type="button" aria-label={`關閉${label}選單`} onClick={() => close(true)} className="rounded-md p-1 text-current opacity-60 transition-colors hover:bg-white/10 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"><X className="h-3.5 w-3.5" /></button>
            </div>
            <div id={listId} role="listbox" aria-label={label} className="employee-setup-scrollbar min-h-0 space-y-1 overflow-y-auto overscroll-contain p-1.5" style={{ scrollbarColor: theme.scrollbar }}>
              {options.map(option => (
                <button key={option.id} type="button" role="option" aria-selected={value === option.id} aria-describedby={details?.option.id === option.id ? detailsId : undefined}
                  onClick={() => { onChange(option.id); close(true); }} onMouseEnter={event => showDetails(event.currentTarget, option)} onMouseLeave={hideDetails} onFocus={event => showDetails(event.currentTarget, option)} onBlur={() => setDetails(null)}
                  data-unassigned={option.unassigned || undefined}
                  className={`group/option flex min-h-[38px] w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ${option.unassigned ? `!mb-2 border-dashed text-stone-300 hover:bg-white/5 focus-visible:ring-stone-400 ${value === option.id ? 'border-stone-400/60 bg-white/5' : 'border-stone-500/40 bg-black/10'}` : value === option.id ? theme.selected : `border-white/[0.04] bg-white/[0.025] text-stone-200 ${theme.option}`}`}
                >
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${option.unassigned ? 'border-stone-500/25 bg-white/[0.03] text-stone-400' : theme.icon}`}>{option.unassigned ? <CircleOff className="h-3 w-3" /> : option.pinned ? <Pin className="h-3 w-3" /> : <Icon className="h-3 w-3" />}</span>
                  <span className="min-w-0 flex-1"><span data-option-label className="block truncate text-[11px] font-semibold">{option.label}{option.description ? <span className="ml-1 font-normal text-stone-400">（{option.description}）</span> : null}</span></span>
                  {option.meta && <span className={`shrink-0 rounded border px-1 py-0.5 text-[9px] ${option.unassigned ? 'border-stone-500/25 bg-white/[0.03] text-stone-400' : `border-white/10 bg-white/5 ${theme.accent}`}`}>{option.meta}</span>}
                  {option.count !== undefined && <span className={`shrink-0 text-[10px] tabular-nums ${theme.accent}`}>{option.count} 人</span>}
                  {value === option.id ? <Check className={`h-3.5 w-3.5 shrink-0 ${option.unassigned ? 'text-stone-400' : theme.accent}`} /> : <ArrowRight className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/option:opacity-50" />}
                </button>
              ))}
              {options.length === 0 && <p className="px-3 py-6 text-center text-xs leading-5 text-slate-400">{emptyMessage}</p>}
            </div>
          </div>
        </div>, document.body,
      )}
      {details && createPortal(<div id={detailsId} role="tooltip" onPointerDown={stopPortalEvent} onPointerUp={stopPortalEvent} onMouseDown={stopPortalEvent} onClick={stopPortalEvent} onMouseEnter={() => { if (hideTimer.current) clearTimeout(hideTimer.current); }} onMouseLeave={hideDetails} className={`employee-setup-details fixed z-[10060] rounded-xl border p-3.5 shadow-[0_18px_50px_rgba(0,0,0,0.65)] ${theme.surface}`} style={{ left: details.left, top: details.top, width: details.width }}><p className={`mb-2 break-words text-xs font-bold ${theme.accent}`}>{details.option.label}</p><p className="employee-setup-scrollbar max-h-[156px] overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-stone-200" style={{ scrollbarColor: theme.scrollbar }}>{details.option.description}</p></div>, document.body)}
    </>
  );
}
