import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, ChevronDown, Loader2, MapPin, Plus, Search, X } from 'lucide-react';

export const UNASSIGNED_REGION_FILTER = '__unassigned__';
const REGION_NAME_MAX_LENGTH = 30;

export interface EmployeeRegion {
  id: string;
  name: string;
}

export interface CreateRegionResult {
  region: EmployeeRegion;
  created: boolean;
}

interface RegionMenuOption {
  id: string;
  name: string;
  count?: number;
  muted?: boolean;
}

interface MenuPosition {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

// Opening upwards anchors the bottom edge, so typing or the add form never pushes the menu off the button.
const getAnchoredMenuPosition = (rect: DOMRect, estimatedHeight: number): MenuPosition => {
  const padding = 8;
  const gap = 6;
  const width = Math.min(rect.width, window.innerWidth - padding * 2);
  const left = Math.min(Math.max(padding, rect.left), window.innerWidth - width - padding);
  const spaceBelow = window.innerHeight - rect.bottom - padding - gap;
  const spaceAbove = rect.top - padding - gap;
  if (spaceBelow >= estimatedHeight || spaceBelow >= spaceAbove) {
    return { left, width, top: rect.bottom + gap, maxHeight: spaceBelow };
  }
  return { left, width, bottom: window.innerHeight - rect.top + gap, maxHeight: spaceAbove };
};

const estimateMenuHeight = (optionCount: number, hasFooter: boolean) => (
  46 + 41 + Math.min(210, 12 + Math.max(1, optionCount) * 30) + 41 + (hasFooter ? 34 : 0)
);

function useCloseOnOutsideOrViewportChange(
  open: boolean,
  insideRefs: Array<RefObject<HTMLElement>>,
  menuRef: RefObject<HTMLElement>,
  close: () => void,
) {
  const refsRef = useRef(insideRefs);
  refsRef.current = insideRefs;
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      const target = event.target as Node;
      if (refsRef.current.some(ref => ref.current?.contains(target))) return;
      closeRef.current();
    };
    const closeOnViewportChange = (event: Event) => {
      if (event.type === 'scroll' && menuRef.current?.contains(event.target as Node)) return;
      closeRef.current();
    };
    document.addEventListener('mousedown', closeOnOutsidePress);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [open, menuRef]);
}

interface EmployeeRegionMenuProps {
  subtitle: string;
  regionCount: number;
  options: RegionMenuOption[];
  selectedId: string;
  listRole: 'menu' | 'listbox';
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<CreateRegionResult>;
  onClose: () => void;
  selectCreated: boolean;
  footer?: ReactNode;
}

function EmployeeRegionMenu({
  subtitle,
  regionCount,
  options,
  selectedId,
  listRole,
  onSelect,
  onCreate,
  onClose,
  selectCreated,
  footer,
}: EmployeeRegionMenuProps) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<{ id: string; message: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const addingRef = useRef(adding);
  addingRef.current = adding;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const keyword = query.trim().toLowerCase();
  const visibleOptions = keyword
    ? options.filter(option => option.name.toLowerCase().includes(keyword))
    : options;

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (adding) nameRef.current?.focus({ preventScroll: true });
  }, [adding]);

  // Captured on window so Escape only steps back inside this menu and never closes the dialog behind it.
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (addingRef.current) {
        setAdding(false);
        setError(null);
        searchRef.current?.focus({ preventScroll: true });
        return;
      }
      onCloseRef.current();
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, []);

  useEffect(() => {
    if (!recent) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-region-option="${CSS.escape(recent.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
    const timer = window.setTimeout(() => setRecent(null), 2500);
    return () => window.clearTimeout(timer);
  }, [recent]);

  const startAdding = () => {
    setNewName(query.trim().slice(0, REGION_NAME_MAX_LENGTH));
    setError(null);
    setAdding(true);
  };

  const cancelAdding = () => {
    setAdding(false);
    setError(null);
    searchRef.current?.focus({ preventScroll: true });
  };

  const submitNewRegion = async () => {
    const name = newName.trim();
    if (!name || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { region, created } = await onCreate(name);
      if (selectCreated) {
        onSelect(region.id);
        return;
      }
      setAdding(false);
      setNewName('');
      setQuery('');
      setRecent({ id: region.id, message: created ? `已新增「${region.name}」` : `「${region.name}」已存在` });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '新增地區失敗，請稍後再試。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-h-full flex-col overflow-hidden rounded-[14px] border border-violet-300/30 bg-[linear-gradient(145deg,rgba(22,14,42,0.98),rgba(9,8,24,0.99))] shadow-[0_18px_50px_rgba(2,8,23,0.72),0_0_0_1px_rgba(167,139,250,0.08)] backdrop-blur-xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-violet-400/15 bg-[linear-gradient(90deg,rgba(124,58,237,0.2),rgba(76,29,149,0.08))] px-2.5 py-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-violet-300/20 bg-violet-400/10 shadow-inner shadow-violet-200/5">
          <MapPin className="h-3.5 w-3.5 text-violet-300" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-bold leading-none tracking-wide text-violet-100">所在地區</p>
          <p className="mt-1 truncate text-[9px] leading-none text-violet-300/60">{subtitle}</p>
        </div>
        <span className="shrink-0 text-[9px] font-semibold tabular-nums text-violet-300/65">{regionCount} 個</span>
      </div>

      <div className="shrink-0 border-b border-violet-400/10 p-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-violet-300/70" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (visibleOptions[0]) onSelect(visibleOptions[0].id);
            }}
            placeholder="搜尋地區……"
            aria-label="搜尋地區"
            autoComplete="off"
            className="h-7 w-full rounded-md border border-violet-400/20 bg-slate-950/60 pl-6 pr-6 text-[11px] font-medium text-violet-50 outline-none transition-colors placeholder:text-slate-500 focus:border-violet-300/60 focus:bg-slate-950/85"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                searchRef.current?.focus({ preventScroll: true });
              }}
              aria-label="清除地區搜尋"
              className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-violet-300/70 transition-colors hover:bg-violet-400/15 hover:text-violet-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div
        ref={listRef}
        role={listRole}
        aria-label="所在地區"
        className="employee-date-menu-scrollbar max-h-[210px] min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1.5 pr-1"
      >
        {visibleOptions.length > 0 ? visibleOptions.map(option => {
          const isSelected = option.id === selectedId;
          const isRecent = recent?.id === option.id;
          return (
            <button
              key={option.id || 'none'}
              type="button"
              data-region-option={option.id}
              role={listRole === 'menu' ? 'menuitemradio' : 'option'}
              aria-checked={listRole === 'menu' ? isSelected : undefined}
              aria-selected={listRole === 'listbox' ? isSelected : undefined}
              title={option.name}
              onClick={() => onSelect(option.id)}
              className={`group relative flex h-7 w-full items-center gap-2 overflow-hidden rounded-md border px-2 text-[10px] font-semibold transition-all duration-150 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50 ${
                isSelected
                  ? 'border-violet-300/55 bg-gradient-to-r from-violet-600/85 via-purple-600/75 to-fuchsia-600/60 text-white shadow-[0_4px_14px_rgba(139,92,246,0.22)]'
                  : isRecent
                    ? 'border-emerald-300/50 bg-emerald-500/15 text-emerald-50'
                    : option.muted
                      ? 'border-transparent bg-white/[0.02] text-slate-400 hover:border-violet-400/25 hover:bg-violet-400/10 hover:text-violet-50'
                      : 'border-transparent bg-white/[0.025] text-slate-300 hover:border-violet-400/25 hover:bg-violet-400/10 hover:text-violet-50'
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all ${
                isSelected
                  ? 'bg-white shadow-[0_0_7px_rgba(255,255,255,0.8)]'
                  : option.muted ? 'bg-slate-500 group-hover:bg-violet-300' : 'bg-violet-400/70 group-hover:bg-violet-300'
              }`} />
              <span className="min-w-0 flex-1 truncate text-left">{option.name}</span>
              {option.count !== undefined && (
                <span className={`shrink-0 text-right text-[9px] font-bold tabular-nums ${isSelected ? 'text-white' : 'text-violet-300/75 group-hover:text-violet-200'}`}>
                  {option.count} 人
                </span>
              )}
              {isSelected && <CheckCircle className="h-3 w-3 shrink-0 text-violet-100" />}
            </button>
          );
        }) : (
          <p className="px-2 py-4 text-center text-[10px] leading-4 text-slate-500">
            {options.length > 0 ? '找不到符合的地區' : '尚未建立地區'}
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-violet-400/15 p-1.5">
        {adding ? (
          <div className="space-y-1.5">
            <input
              ref={nameRef}
              type="text"
              value={newName}
              maxLength={REGION_NAME_MAX_LENGTH}
              onChange={event => {
                setNewName(event.target.value);
                setError(null);
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                void submitNewRegion();
              }}
              disabled={saving}
              placeholder="輸入地區名稱"
              aria-label="新地區名稱"
              autoComplete="off"
              className="h-7 w-full rounded-md border border-violet-300/45 bg-slate-950/80 px-2 text-[11px] font-semibold text-violet-50 outline-none transition-colors placeholder:text-slate-500 focus:border-violet-200/80 disabled:opacity-60"
            />
            {error && <p role="alert" className="px-0.5 text-[10px] leading-4 text-rose-300">{error}</p>}
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={cancelAdding}
                disabled={saving}
                className="inline-flex h-7 flex-1 items-center justify-center rounded-md border border-slate-600/80 bg-slate-800/80 text-[11px] font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300/60 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitNewRegion()}
                disabled={saving || !newName.trim()}
                className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-violet-300/60 bg-violet-600 text-[11px] font-bold text-white transition-colors hover:bg-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200/70 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                新增
              </button>
            </div>
          </div>
        ) : (
          <>
            {recent && (
              <p role="status" className="mb-1.5 truncate px-0.5 text-center text-[10px] font-semibold text-emerald-300">{recent.message}</p>
            )}
            <button
              type="button"
              onClick={startAdding}
              className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-violet-400/50 bg-violet-500/10 text-[11px] font-bold text-violet-100 transition-colors hover:border-violet-300/80 hover:bg-violet-500/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60"
            >
              <Plus className="h-3.5 w-3.5" />
              新增地區
            </button>
          </>
        )}
      </div>

      {footer}
    </div>
  );
}

interface EmployeeRegionFilterProps {
  regions: EmployeeRegion[];
  counts: Map<string, number>;
  unassignedCount: number;
  selectedId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => Promise<CreateRegionResult>;
}

export function EmployeeRegionFilter({
  regions,
  counts,
  unassignedCount,
  selectedId,
  open,
  onOpenChange,
  onSelect,
  onCreate,
}: EmployeeRegionFilterProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const options: RegionMenuOption[] = [
    ...regions.map(region => ({ id: region.id, name: region.name, count: counts.get(region.id) || 0 })),
    ...(unassignedCount > 0 || selectedId === UNASSIGNED_REGION_FILTER
      ? [{ id: UNASSIGNED_REGION_FILTER, name: '未設定地區', count: unassignedCount, muted: true }]
      : []),
  ];
  const selectedLabel = selectedId
    ? options.find(option => option.id === selectedId)?.name || null
    : null;
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useCloseOnOutsideOrViewportChange(open, [groupRef, menuRef], menuRef, close);

  const toggle = () => {
    if (open) {
      onOpenChange(false);
      return;
    }
    const rect = groupRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(getAnchoredMenuPosition(rect, estimateMenuHeight(options.length, Boolean(selectedLabel))));
    onOpenChange(true);
  };

  const selectAndClose = (id: string | null) => {
    onSelect(id);
    onOpenChange(false);
  };

  return (
    <div className="ml-2 inline-flex items-center">
      <div
        ref={groupRef}
        className={`inline-flex h-8 w-[160px] shrink-0 overflow-hidden rounded-lg border shadow-sm transition-all ${
          selectedLabel
            ? 'border-violet-300/90 bg-violet-800 shadow-violet-950/40'
            : open
              ? 'border-violet-400/80 bg-violet-950 shadow-violet-950/30'
              : 'border-violet-700/70 bg-slate-900 hover:border-violet-500/80 hover:bg-violet-950'
        }`}
      >
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          title={selectedLabel || '按地區篩選員工'}
          className={`flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-2.5 text-[11px] font-semibold transition-all active:scale-[0.98] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/70 ${
            selectedLabel
              ? 'bg-violet-700 text-white hover:bg-violet-600'
              : open
                ? 'bg-violet-950 text-violet-100'
                : 'text-violet-200 hover:bg-violet-950 hover:text-violet-100'
          }`}
        >
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{selectedLabel || '地區'}</span>
          <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {selectedLabel && (
          <button
            type="button"
            onClick={() => selectAndClose(null)}
            aria-label="清除地區篩選"
            title="清除地區篩選"
            className="inline-flex h-full w-8 shrink-0 items-center justify-center border-l border-rose-200/30 bg-rose-600 text-white transition-colors hover:bg-rose-500 active:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200/80"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && position && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] flex flex-col"
          style={{ left: position.left, width: position.width, top: position.top, bottom: position.bottom, maxHeight: position.maxHeight }}
        >
          <EmployeeRegionMenu
            subtitle="按地區篩選員工"
            regionCount={regions.length}
            options={options}
            selectedId={selectedId || ''}
            listRole="menu"
            onSelect={id => selectAndClose(id === selectedId ? null : id)}
            onCreate={onCreate}
            onClose={close}
            selectCreated={false}
            footer={selectedLabel ? (
              <div className="flex h-[34px] shrink-0 items-stretch border-t border-rose-400/25 bg-[linear-gradient(90deg,rgba(76,5,25,0.4),rgba(30,10,30,0.3))]">
                <div className="flex min-w-0 flex-1 flex-col justify-center px-2 py-1">
                  <p className="text-[7px] font-bold uppercase leading-none tracking-[0.12em] text-rose-300/65">目前篩選</p>
                  <p className="mt-1 truncate text-[9px] font-semibold leading-none text-rose-100/90" title={selectedLabel}>{selectedLabel}</p>
                </div>
                <button
                  type="button"
                  onClick={() => selectAndClose(null)}
                  className="inline-flex min-w-[60px] shrink-0 items-center justify-center gap-1 border-l border-rose-300/35 bg-rose-600 px-2 text-[11px] font-bold text-white shadow-[-5px_0_16px_rgba(190,18,60,0.18)] transition-colors hover:bg-rose-500 active:bg-rose-700 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60"
                >
                  <X className="h-3.5 w-3.5" />
                  清除
                </button>
              </div>
            ) : undefined}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

interface EmployeeRegionPickerProps {
  id: string;
  regions: EmployeeRegion[];
  counts: Map<string, number>;
  value: string;
  onChange: (regionId: string) => void;
  onCreate: (name: string) => Promise<CreateRegionResult>;
  disabled?: boolean;
  className: string;
}

export function EmployeeRegionPicker({
  id,
  regions,
  counts,
  value,
  onChange,
  onCreate,
  disabled = false,
  className,
}: EmployeeRegionPickerProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const selected = regions.find(region => region.id === value) || null;
  const options: RegionMenuOption[] = [
    { id: '', name: '不指定地區', muted: true },
    ...regions.map(region => ({ id: region.id, name: region.name, count: counts.get(region.id) || 0 })),
  ];
  const close = useCallback(() => setPosition(null), []);

  useCloseOnOutsideOrViewportChange(Boolean(position), [buttonRef, menuRef], menuRef, close);

  useEffect(() => {
    if (disabled) setPosition(null);
  }, [disabled]);

  const toggle = () => {
    if (position) {
      close();
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition(getAnchoredMenuPosition(rect, estimateMenuHeight(options.length, false)));
  };

  return (
    <>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={Boolean(position)}
        onClick={toggle}
        disabled={disabled}
        className={className}
      >
        <MapPin className={`h-4 w-4 shrink-0 ${selected ? 'text-violet-600' : 'text-slate-400'}`} />
        <span className={`min-w-0 flex-1 truncate text-left ${selected ? 'font-semibold text-slate-900' : 'text-slate-400'}`}>
          {selected?.name || '請選擇地區'}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${position ? 'rotate-180' : ''}`} />
      </button>
      {position && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[10050] flex flex-col"
          style={{ left: position.left, width: position.width, top: position.top, bottom: position.bottom, maxHeight: position.maxHeight }}
          onClick={event => event.stopPropagation()}
        >
          <EmployeeRegionMenu
            subtitle="選擇員工所在地區"
            regionCount={regions.length}
            options={options}
            selectedId={value}
            listRole="listbox"
            onSelect={regionId => {
              onChange(regionId);
              close();
              buttonRef.current?.focus({ preventScroll: true });
            }}
            onCreate={onCreate}
            onClose={() => {
              close();
              buttonRef.current?.focus({ preventScroll: true });
            }}
            selectCreated
          />
        </div>,
        document.body,
      )}
    </>
  );
}
