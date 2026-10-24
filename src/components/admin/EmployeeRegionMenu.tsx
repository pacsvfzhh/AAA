import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCircle, ChevronDown, Loader2, MapPin, Pencil, Pin, PinOff, Plus, Settings, Trash2, X } from 'lucide-react';

export const UNASSIGNED_REGION_FILTER = '__unassigned__';
const REGION_NAME_MAX_LENGTH = 30;

export interface EmployeeRegion {
  id: string;
  name: string;
  admin_id: string;
  is_pinned: boolean;
}

const sortRegions = (regions: EmployeeRegion[], counts: Map<string, number>) => (
  [...regions].sort((a, b) => {
    if (Boolean(a.is_pinned) !== Boolean(b.is_pinned)) return a.is_pinned ? -1 : 1;
    if (a.is_pinned) return 0;
    return (counts.get(b.id) || 0) - (counts.get(a.id) || 0);
  })
);

export interface EmployeeRegionActions {
  create: (name: string) => Promise<{ region: EmployeeRegion; created: boolean }>;
  rename: (regionId: string, name: string) => Promise<EmployeeRegion>;
  setPinned: (regionId: string, pinned: boolean) => Promise<EmployeeRegion>;
  remove: (regionId: string, replacementId: string | null) => Promise<void>;
}

interface RegionMenuOption {
  id: string;
  name: string;
  count?: number;
  muted?: boolean;
  pinned?: boolean;
}

interface MenuPosition {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

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
  46 + Math.min(210, 12 + Math.max(1, optionCount) * 30) + (hasFooter ? 34 : 0)
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

// Portals still bubble React events to the dialog/form that rendered them; keep them from reaching it.
const stopReactBubbling = (event: SyntheticEvent) => event.stopPropagation();
const portalEventGuards = {
  onClick: stopReactBubbling,
  onMouseDown: stopReactBubbling,
  onPointerDown: stopReactBubbling,
  onPointerUp: stopReactBubbling,
  onKeyDown: stopReactBubbling,
};

interface EmployeeRegionMenuProps {
  subtitle: string;
  options: RegionMenuOption[];
  selectedId: string;
  listRole: 'menu' | 'listbox';
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onClose: () => void;
  footer?: ReactNode;
}

function EmployeeRegionMenu({
  subtitle,
  options,
  selectedId,
  listRole,
  onSelect,
  onOpenSettings,
  onClose,
  footer,
}: EmployeeRegionMenuProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Captured on window so Escape only closes this menu and never the dialog behind it.
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, []);

  return (
    <div className="flex max-h-full flex-col overflow-hidden rounded-[14px] border border-violet-300/30 bg-[linear-gradient(145deg,rgba(22,14,42,0.98),rgba(9,8,24,0.99))] shadow-[0_18px_50px_rgba(2,8,23,0.72),0_0_0_1px_rgba(167,139,250,0.08)] backdrop-blur-xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-violet-400/15 bg-[linear-gradient(90deg,rgba(124,58,237,0.2),rgba(76,29,149,0.08))] py-2 pl-2.5 pr-1.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-violet-300/20 bg-violet-400/10 shadow-inner shadow-violet-200/5">
          <MapPin className="h-3.5 w-3.5 text-violet-300" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-bold leading-none tracking-wide text-violet-100">所在地區</p>
          <p className="mt-1 truncate text-[9px] leading-none text-violet-300/60">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="地區設定"
          title="編輯或新增地區"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-violet-300/25 bg-violet-400/10 text-violet-200 transition-colors hover:border-violet-200/60 hover:bg-violet-400/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/70"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        role={listRole}
        aria-label="所在地區"
        className="employee-region-scrollbar max-h-[210px] min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1.5 pr-1"
      >
        {options.length > 0 ? options.map(option => {
          const isSelected = option.id === selectedId;
          return (
            <button
              key={option.id}
              type="button"
              role={listRole === 'menu' ? 'menuitemradio' : 'option'}
              aria-checked={listRole === 'menu' ? isSelected : undefined}
              aria-selected={listRole === 'listbox' ? isSelected : undefined}
              title={option.name}
              onClick={() => onSelect(option.id)}
              className={`group relative flex h-7 w-full items-center gap-2 overflow-hidden rounded-md border px-2 text-[10px] font-semibold transition-all duration-150 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/50 ${
                isSelected
                  ? 'border-violet-300/55 bg-gradient-to-r from-violet-600/85 via-purple-600/75 to-fuchsia-600/60 text-white shadow-[0_4px_14px_rgba(139,92,246,0.22)]'
                  : option.muted
                    ? 'border-transparent bg-white/[0.02] text-slate-400 hover:border-violet-400/25 hover:bg-violet-400/10 hover:text-violet-50'
                    : 'border-transparent bg-white/[0.025] text-slate-300 hover:border-violet-400/25 hover:bg-violet-400/10 hover:text-violet-50'
              }`}
            >
              {option.pinned ? (
                <Pin aria-label="已置頂" className="h-3 w-3 shrink-0 text-violet-200" />
              ) : (
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all ${
                  isSelected
                    ? 'bg-white shadow-[0_0_7px_rgba(255,255,255,0.8)]'
                    : option.muted ? 'bg-slate-500 group-hover:bg-violet-300' : 'bg-violet-400/70 group-hover:bg-violet-300'
                }`} />
              )}
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
            尚未建立地區<br />請點右上角齒輪新增
          </p>
        )}
      </div>

      {footer}
    </div>
  );
}

interface EmployeeRegionSettingsDialogProps {
  groupLabel: string;
  regions: EmployeeRegion[];
  counts: Map<string, number>;
  actions: EmployeeRegionActions;
  onClose: () => void;
  onCreated?: (region: EmployeeRegion) => void;
}

function EmployeeRegionSettingsDialog({
  groupLabel,
  regions,
  counts,
  actions,
  onClose,
  onCreated,
}: EmployeeRegionSettingsDialogProps) {
  const titleId = useId();
  const sortedRegions = useMemo(() => sortRegions(regions, counts), [regions, counts]);
  const [newName, setNewName] = useState('');
  const [pending, setPending] = useState<{ action: 'create' | 'rename' | 'pin' | 'delete'; regionId?: string } | null>(null);
  const busy = pending !== null;
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; replacementId: string } | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef({ busy, editing, deleting, onClose });
  stateRef.current = { busy, editing, deleting, onClose };

  useEffect(() => {
    addRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (editing) editRef.current?.focus({ preventScroll: true });
    // Focus only when an edit starts, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const timer = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Escape steps back one level (edit/delete → list → closed) and never reaches the panel behind; Tab stays inside.
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
        ) || []);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        const inside = Boolean(active && dialogRef.current?.contains(active));
        if (!inside || (event.shiftKey ? active === first : active === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      const state = stateRef.current;
      if (state.busy) return;
      if (state.editing || state.deleting) {
        setEditing(null);
        setDeleting(null);
        setRowError(null);
        return;
      }
      state.onClose();
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, []);

  const submitNewRegion = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setPending({ action: 'create' });
    setNotice(null);
    try {
      const { region, created } = await actions.create(name);
      setNewName('');
      setNotice(created
        ? { tone: 'success', text: `已新增「${region.name}」` }
        : { tone: 'error', text: `「${region.name}」已存在` });
      if (created) onCreated?.(region);
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error, '新增地區失敗，請稍後再試。') });
    } finally {
      setPending(null);
      addRef.current?.focus({ preventScroll: true });
    }
  };

  const submitRename = async () => {
    if (!editing || busy) return;
    const name = editing.name.trim();
    const current = regions.find(region => region.id === editing.id);
    if (!name) {
      setRowError('地區名稱不能空白。');
      return;
    }
    if (current && current.name === name) {
      setEditing(null);
      setRowError(null);
      return;
    }
    setPending({ action: 'rename', regionId: editing.id });
    setRowError(null);
    try {
      const region = await actions.rename(editing.id, name);
      setEditing(null);
      setNotice({ tone: 'success', text: `已改名為「${region.name}」` });
    } catch (error) {
      setRowError(errorMessage(error, '修改地區失敗，請稍後再試。'));
    } finally {
      setPending(null);
    }
  };

  const submitPinned = async (region: EmployeeRegion) => {
    if (busy) return;
    setPending({ action: 'pin', regionId: region.id });
    setNotice(null);
    try {
      const updated = await actions.setPinned(region.id, !region.is_pinned);
      setNotice({ tone: 'success', text: `已${updated.is_pinned ? '置頂' : '取消置頂'}「${updated.name}」` });
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error, '設定地區置頂失敗，請稍後再試。') });
    } finally {
      setPending(null);
    }
  };

  const submitDelete = async () => {
    if (!deleting || busy) return;
    const region = regions.find(item => item.id === deleting.id);
    const assigned = counts.get(deleting.id) || 0;
    if (assigned > 0 && !deleting.replacementId) {
      setRowError('請先選擇要改到的地區。');
      return;
    }
    setPending({ action: 'delete', regionId: deleting.id });
    setRowError(null);
    try {
      await actions.remove(deleting.id, assigned > 0 ? deleting.replacementId : null);
      setDeleting(null);
      setNotice({ tone: 'success', text: `已刪除「${region?.name || '地區'}」` });
    } catch (error) {
      setRowError(errorMessage(error, '刪除地區失敗，請稍後再試。'));
    } finally {
      setPending(null);
    }
  };

  const iconButton = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-wait';

  return createPortal(
    <div
      className="fixed inset-0 z-[10100] flex items-center justify-center bg-slate-950/65 p-3 backdrop-blur-[2px]"
      {...portalEventGuards}
      onMouseDown={event => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(560px,calc(100vh-24px))] w-full max-w-[400px] flex-col overflow-hidden rounded-2xl border border-violet-300/30 bg-[linear-gradient(145deg,rgba(22,14,42,0.99),rgba(9,8,24,1))] shadow-[0_24px_70px_rgba(2,8,23,0.8),0_0_0_1px_rgba(167,139,250,0.08)]"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-violet-400/15 bg-[linear-gradient(90deg,rgba(124,58,237,0.22),rgba(76,29,149,0.08))] px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-violet-300/25 bg-violet-400/10">
            <Settings className="h-4 w-4 text-violet-200" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="text-sm font-bold text-violet-50">地區設定</h3>
            <p className="mt-0.5 truncate text-[11px] text-violet-300/70">{groupLabel} 群組 · {regions.length} 個地區</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="關閉地區設定"
            className={`${iconButton} border-violet-300/20 bg-slate-950/40 text-violet-200 hover:border-violet-200/50 hover:bg-violet-400/15 hover:text-white focus-visible:ring-violet-300/60`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="shrink-0 border-b border-violet-400/10 p-3">
          <div className="flex gap-2">
            <input
              ref={addRef}
              type="text"
              value={newName}
              maxLength={REGION_NAME_MAX_LENGTH}
              onChange={event => {
                setNewName(event.target.value);
                if (notice?.tone === 'error') setNotice(null);
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                void submitNewRegion();
              }}
              readOnly={pending?.action === 'create'}
              placeholder="輸入新地區名稱"
              aria-label="新地區名稱"
              autoComplete="off"
              className="h-9 min-w-0 flex-1 rounded-lg border border-violet-400/30 bg-slate-950/70 px-3 text-xs font-semibold text-violet-50 outline-none transition-colors placeholder:text-slate-500 focus:border-violet-200/70 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => void submitNewRegion()}
              disabled={busy || !newName.trim()}
              className={`inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-lg border border-violet-300/60 bg-violet-600 px-3.5 text-xs font-bold text-white transition-colors hover:bg-violet-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200/70 disabled:cursor-not-allowed ${!newName.trim() ? 'opacity-50' : ''}`}
              aria-busy={pending?.action === 'create'}
            >
              {pending?.action === 'create' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              新增
            </button>
          </div>
          <p
            role={!busy && notice?.tone === 'error' ? 'alert' : 'status'}
            className={`mt-1.5 min-h-[16px] text-[11px] leading-4 ${busy ? 'text-violet-300' : notice?.tone === 'error' ? 'text-rose-300' : 'text-emerald-300'}`}
          >
            {busy ? '正在儲存……' : notice?.text}
          </p>
        </div>

        <div className="employee-region-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain p-3">
          {regions.length === 0 && (
            <p className="py-6 text-center text-xs text-slate-500">此群組尚未建立地區</p>
          )}
          {sortedRegions.map(region => {
            const count = counts.get(region.id) || 0;
            const isEditing = editing?.id === region.id;
            const isDeleting = deleting?.id === region.id;
            const otherRegions = isDeleting ? regions.filter(item => item.id !== region.id) : [];
            const rowLocked = busy || (Boolean(editing || deleting) && !isEditing && !isDeleting);
            return (
              <div
                key={region.id}
                className={`rounded-lg border transition-colors ${
                  isDeleting
                    ? 'border-rose-400/40 bg-rose-500/[0.07]'
                    : isEditing
                      ? 'border-violet-300/45 bg-violet-500/10'
                      : 'border-violet-400/10 bg-white/[0.025]'
                }`}
              >
                <div className="flex h-10 items-center gap-2 px-2.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400/70" />
                  {isEditing ? (
                    <input
                      ref={editRef}
                      type="text"
                      value={editing.name}
                      maxLength={REGION_NAME_MAX_LENGTH}
                      onChange={event => {
                        setEditing({ id: region.id, name: event.target.value });
                        setRowError(null);
                      }}
                      onKeyDown={event => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        void submitRename();
                      }}
                      disabled={busy}
                      aria-label={`修改「${region.name}」的名稱`}
                      autoComplete="off"
                      className="h-7 min-w-0 flex-1 rounded-md border border-violet-300/50 bg-slate-950/80 px-2 text-xs font-semibold text-violet-50 outline-none focus:border-violet-200/80 disabled:opacity-60"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-200" title={region.name}>{region.name}</span>
                  )}
                  {!isEditing && (
                    <span className="shrink-0 text-[10px] font-bold tabular-nums text-violet-300/75">{count} 人</span>
                  )}
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void submitRename()}
                        disabled={busy || !editing.name.trim()}
                        aria-label="儲存名稱"
                        title="儲存"
                        className={`${iconButton} border-violet-300/60 bg-violet-600 text-white hover:bg-violet-500 focus-visible:ring-violet-200/70`}
                      >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(null);
                          setRowError(null);
                        }}
                        disabled={busy}
                        aria-label="取消修改"
                        title="取消"
                        className={`${iconButton} border-slate-600/80 bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white focus-visible:ring-slate-300/60`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void submitPinned(region)}
                        disabled={rowLocked || isDeleting}
                        aria-label={`${region.is_pinned ? '取消置頂' : '置頂'}「${region.name}」`}
                        aria-pressed={Boolean(region.is_pinned)}
                        aria-busy={pending?.action === 'pin' && pending.regionId === region.id}
                        title={region.is_pinned ? '取消置頂' : '置頂地區'}
                        className={`${iconButton} ${region.is_pinned
                          ? 'border-violet-300/60 bg-violet-500/25 text-violet-100 hover:bg-violet-500/40'
                          : 'border-violet-300/20 bg-violet-400/10 text-violet-300/60 hover:border-violet-200/50 hover:bg-violet-400/20 hover:text-violet-100'
                        } focus-visible:ring-violet-300/60`}
                      >
                        {pending?.action === 'pin' && pending.regionId === region.id
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : region.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDeleting(null);
                          setRowError(null);
                          setEditing({ id: region.id, name: region.name });
                        }}
                        disabled={rowLocked || isDeleting}
                        aria-label={`修改「${region.name}」`}
                        title="修改名稱"
                        className={`${iconButton} border-violet-300/20 bg-violet-400/10 text-violet-200 hover:border-violet-200/50 hover:bg-violet-400/20 hover:text-white focus-visible:ring-violet-300/60`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(null);
                          setRowError(null);
                          setDeleting(isDeleting ? null : { id: region.id, replacementId: '' });
                        }}
                        disabled={rowLocked}
                        aria-label={`刪除「${region.name}」`}
                        aria-expanded={isDeleting}
                        title="刪除地區"
                        className={`${iconButton} border-rose-400/25 bg-rose-500/10 text-rose-300 hover:border-rose-300/60 hover:bg-rose-500/20 hover:text-rose-100 focus-visible:ring-rose-300/60`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>

                {isEditing && rowError && (
                  <p role="alert" className="px-2.5 pb-2 text-[11px] leading-4 text-rose-300">{rowError}</p>
                )}

                {isDeleting && (
                  <div className="space-y-2 border-t border-rose-400/20 px-2.5 py-2.5">
                    {count === 0 ? (
                      <p className="text-[11px] leading-4 text-rose-100/90">確定刪除「{region.name}」？此操作無法復原。</p>
                    ) : otherRegions.length === 0 ? (
                      <p className="text-[11px] leading-4 text-rose-100/90">
                        「{region.name}」還有 {count} 名員工。請先新增其他地區，才能把他們改過去再刪除。
                      </p>
                    ) : (
                      <label className="block text-[11px] leading-4 text-rose-100/90">
                        「{region.name}」還有 {count} 名員工，刪除前請選擇要把他們改到的地區：
                        <select
                          value={deleting.replacementId}
                          onChange={event => {
                            setDeleting({ id: region.id, replacementId: event.target.value });
                            setRowError(null);
                          }}
                          disabled={busy}
                          className="mt-1.5 h-8 w-full rounded-md border border-rose-300/30 bg-slate-950/80 px-2 text-xs font-semibold text-slate-100 outline-none focus:border-rose-200/70 disabled:opacity-60"
                        >
                          <option value="">請選擇地區</option>
                          {otherRegions.map(item => (
                            <option key={item.id} value={item.id}>{item.name}（{counts.get(item.id) || 0} 人）</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {rowError && <p role="alert" className="text-[11px] leading-4 text-rose-300">{rowError}</p>}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setDeleting(null);
                          setRowError(null);
                        }}
                        disabled={busy}
                        className="inline-flex h-7 items-center justify-center rounded-md border border-slate-600/80 bg-slate-800/80 px-3 text-[11px] font-semibold text-slate-300 transition-colors hover:bg-slate-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300/60 disabled:opacity-50"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={() => void submitDelete()}
                        disabled={busy || (count > 0 && (!deleting.replacementId || otherRegions.length === 0))}
                        className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-rose-300/50 bg-rose-600 px-3 text-[11px] font-bold text-white transition-colors hover:bg-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200/70 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        {count > 0 ? '改到新地區並刪除' : '刪除'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface EmployeeRegionFilterProps {
  groupLabel: string;
  regions: EmployeeRegion[];
  counts: Map<string, number>;
  unassignedCount: number;
  selectedId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string | null) => void;
  actions: EmployeeRegionActions;
}

export function EmployeeRegionFilter({
  groupLabel,
  regions,
  counts,
  unassignedCount,
  selectedId,
  open,
  onOpenChange,
  onSelect,
  actions,
}: EmployeeRegionFilterProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const options: RegionMenuOption[] = [
    ...sortRegions(regions, counts).map(region => ({ id: region.id, name: region.name, count: counts.get(region.id) || 0, pinned: region.is_pinned })),
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
          ref={buttonRef}
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
            subtitle={`${regions.length} 個地區`}
            options={options}
            selectedId={selectedId || ''}
            listRole="menu"
            onSelect={id => selectAndClose(id === selectedId ? null : id)}
            onOpenSettings={() => {
              onOpenChange(false);
              setSettingsOpen(true);
            }}
            onClose={close}
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
      {settingsOpen && (
        <EmployeeRegionSettingsDialog
          groupLabel={groupLabel}
          regions={regions}
          counts={counts}
          actions={actions}
          onClose={() => {
            setSettingsOpen(false);
            buttonRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}

interface EmployeeRegionPickerProps {
  id: string;
  groupLabel: string;
  regions: EmployeeRegion[];
  counts: Map<string, number>;
  value: string;
  onChange: (regionId: string) => void;
  actions: EmployeeRegionActions;
  disabled?: boolean;
  invalid?: boolean;
  className: string;
}

export function EmployeeRegionPicker({
  id,
  groupLabel,
  regions,
  counts,
  value,
  onChange,
  actions,
  disabled = false,
  invalid = false,
  className,
}: EmployeeRegionPickerProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const selected = regions.find(region => region.id === value) || null;
  const options: RegionMenuOption[] = sortRegions(regions, counts).map(region => ({
    id: region.id,
    name: region.name,
    count: counts.get(region.id) || 0,
    pinned: region.is_pinned,
  }));
  const close = useCallback(() => setPosition(null), []);
  const valueRef = useRef(value);
  valueRef.current = value;

  useCloseOnOutsideOrViewportChange(Boolean(position), [buttonRef, menuRef], menuRef, close);

  useEffect(() => {
    if (!disabled) return;
    setPosition(null);
    setSettingsOpen(false);
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
        aria-required="true"
        aria-invalid={invalid || undefined}
        onClick={toggle}
        disabled={disabled}
        className={`${className} ${invalid && !selected ? '!border-rose-400 ring-2 ring-rose-400/25' : ''}`}
      >
        <MapPin className={`h-4 w-4 shrink-0 ${selected ? 'text-violet-600' : invalid ? 'text-rose-500' : 'text-slate-400'}`} />
        <span className={`min-w-0 flex-1 truncate text-left ${selected ? 'font-semibold text-slate-900' : invalid ? 'text-rose-500' : 'text-slate-400'}`}>
          {selected?.name || '請選擇地區'}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${position ? 'rotate-180' : ''}`} />
      </button>
      {position && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[10050] flex flex-col"
          style={{ left: position.left, width: position.width, top: position.top, bottom: position.bottom, maxHeight: position.maxHeight }}
          {...portalEventGuards}
        >
          <EmployeeRegionMenu
            subtitle={`必填 · ${regions.length} 個地區`}
            options={options}
            selectedId={value}
            listRole="listbox"
            onSelect={regionId => {
              onChange(regionId);
              close();
              buttonRef.current?.focus({ preventScroll: true });
            }}
            onOpenSettings={() => {
              close();
              setSettingsOpen(true);
            }}
            onClose={() => {
              close();
              buttonRef.current?.focus({ preventScroll: true });
            }}
          />
        </div>,
        document.body,
      )}
      {settingsOpen && (
        <EmployeeRegionSettingsDialog
          groupLabel={groupLabel}
          regions={regions}
          counts={counts}
          actions={actions}
          onCreated={region => {
            if (!valueRef.current) onChange(region.id);
          }}
          onClose={() => {
            setSettingsOpen(false);
            buttonRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}
