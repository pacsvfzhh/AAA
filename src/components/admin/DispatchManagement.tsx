import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  CheckCircle,
  ChevronDown,
  Edit2,
  FolderPlus,
  Layers,
  PackageSearch,
  Plus,
  PowerOff,
  Clock3,
  AlertTriangle,
  RefreshCw,
  Save,
  Search,
  Settings,
  Tag,
  Trash2,
  Upload,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { getAdminFinancialSessionToken, getStoredAuth } from '../../lib/auth';
import { formatSupabaseError, supabase } from '../../lib/supabase';
import { useCurrencyUnit } from '../../lib/useCurrencyUnit';

const PAGE_SIZE = 25;
const IMPORT_BATCH_SIZE = 250;
const inputClass =
  'w-full min-w-0 rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500';
const secondaryButton =
  'rounded-lg border border-slate-600 bg-slate-700/60 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50';
const primaryButton =
  'rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50';
const poolInputClass =
  'mt-1.5 w-full min-w-0 rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm font-medium text-slate-900 placeholder-slate-400 shadow-sm outline-none transition-colors focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50';

interface DispatchGroup {
  id: string;
  group_name: string;
  description: string | null;
  pool_selection_mode: 'base' | 'random' | 'weighted';
  session_timeout_minutes: number;
  submit_wait_min_seconds: number;
  submit_wait_max_seconds: number;
  commission_rate: number;
  grab_success_rate: number;
  dispatch_success_rate: number;
  withdrawal_amount_threshold: number;
  withdrawal_orders_threshold: number;
  withdrawal_condition_mode: 'OR' | 'AND' | 'amount_only' | 'days_only';
  is_default: boolean;
  is_active: boolean;
  archived_at: string | null;
  member_count: number;
  order_count: number;
}

const withdrawalModeLabels: Record<DispatchGroup['withdrawal_condition_mode'], string> = {
  OR: '餘額或訂單數任一達標',
  AND: '餘額與訂單數均須達標',
  amount_only: '僅檢查餘額是否達標',
  days_only: '僅檢查訂單數是否達標',
};

const poolSelectionOptions = [
  {
    value: 'base',
    label: '固定基本池',
    description: '僅從基本池派單',
    activeClass: 'border-blue-200 bg-blue-600 text-white ring-2 ring-blue-200 ring-offset-2 ring-offset-slate-900 shadow-lg shadow-blue-950/60',
    inactiveClass: 'border-slate-700/60 bg-slate-950/30 text-blue-200/60 hover:border-blue-400/40 hover:bg-blue-500/10',
  },
  {
    value: 'random',
    label: '隨機選擇訂單池',
    description: '可派單池等機率抽取',
    activeClass: 'border-violet-200 bg-violet-600 text-white ring-2 ring-violet-200 ring-offset-2 ring-offset-slate-900 shadow-lg shadow-violet-950/60',
    inactiveClass: 'border-slate-700/60 bg-slate-950/30 text-violet-200/60 hover:border-violet-400/40 hover:bg-violet-500/10',
  },
  {
    value: 'weighted',
    label: '按訂單池設定概率',
    description: '依各池百分比抽取',
    activeClass: 'border-amber-200 bg-amber-600 text-white ring-2 ring-amber-200 ring-offset-2 ring-offset-slate-900 shadow-lg shadow-amber-950/60',
    inactiveClass: 'border-slate-700/60 bg-slate-950/30 text-amber-200/60 hover:border-amber-400/40 hover:bg-amber-500/10',
  },
] as const;

const withdrawalModeOptions = ['OR', 'AND', 'amount_only', 'days_only'] as const;
function WithdrawalConditionPicker({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: DispatchGroup['withdrawal_condition_mode'];
  disabled: boolean;
  onChange: (value: DispatchGroup['withdrawal_condition_mode']) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{
    bottom: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const isOpen = menuPosition !== null;
  const positionMenu = useCallback(() => {
    const rect = triggerRef.current!.getBoundingClientRect();
    const width = Math.min(rect.width, window.innerWidth - 24);
    setMenuPosition({
      bottom: window.innerHeight - rect.top,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      width,
      maxHeight: Math.max(40, Math.min(184, rect.top - 12)),
    });
  }, []);

  useEffect(() => {
    if (isOpen) menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) {
        setMenuPosition(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuPosition(null);
        triggerRef.current?.focus();
      }
    };
    const closeOnFocusOutside = (event: FocusEvent) => {
      if (!triggerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) {
        setMenuPosition(null);
      }
    };
    const reposition = () => positionMenu();
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('focusin', closeOnFocusOutside);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('focusin', closeOnFocusOutside);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [isOpen, positionMenu]);

  return (
    <div className="space-y-2">
      <span id={`${id}-label`} className="block text-sm font-medium text-amber-100">提款條件組合</span>
      <p id={`${id}-hint`} className="text-xs text-amber-200/80">點擊下方按鈕向上展開選單，再次點擊可收起。</p>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-labelledby={`${id}-label ${id}`}
        aria-describedby={`${id}-hint`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={menuPosition ? `${id}-menu` : undefined}
        disabled={disabled}
        onClick={() => menuPosition ? setMenuPosition(null) : positionMenu()}
        className={`group flex h-11 w-full max-w-[420px] items-center gap-2.5 border border-amber-500/70 bg-slate-800 px-3 text-left text-amber-50 shadow-[0_8px_20px_rgba(15,23,42,0.3)] transition-colors hover:border-amber-300 hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-55 ${isOpen ? 'rounded-b-xl border-t-0' : 'rounded-xl'}`}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-400/20 text-amber-300"><CheckCircle className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{withdrawalModeLabels[value]}</span>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-400 text-slate-900 group-hover:bg-amber-300">
          <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {menuPosition && createPortal(
        <div
          ref={menuRef}
          id={`${id}-menu`}
          role="listbox"
          aria-labelledby={`${id}-label`}
          className="fixed z-[10010] overflow-y-auto rounded-t-xl border border-b-0 border-amber-500/70 bg-slate-900 p-1.5 text-amber-50 shadow-[0_-12px_28px_rgba(15,23,42,0.32)]"
          style={menuPosition}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
            const index = options.indexOf(document.activeElement as HTMLButtonElement);
            options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length]?.focus();
          }}
        >
          {withdrawalModeOptions.map((mode) => (
            <button
              key={mode}
              type="button"
              role="option"
              aria-selected={value === mode}
              className={`mb-0.5 flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors last:mb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${value === mode ? 'bg-amber-400 text-slate-950' : 'text-amber-50 hover:bg-slate-700 hover:text-amber-200'}`}
              onClick={() => {
                onChange(mode);
                setMenuPosition(null);
                triggerRef.current?.focus();
              }}
            >
              <span className="min-w-0 flex-1 text-sm font-medium">{withdrawalModeLabels[mode]}</span>
              {value === mode && <CheckCircle className="h-4 w-4 shrink-0 text-slate-900" />}
            </button>
          ))}
        </div>, document.body,
      )}
    </div>
  );
}

function MemberFilterPicker({
  id,
  label,
  caption,
  value,
  options,
  tone,
  onChange,
}: {
  id: string;
  label: string;
  caption: string;
  value: string;
  options: { value: string; label: string }[];
  tone: 'emerald' | 'blue' | 'violet';
  onChange: (value: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const isOpen = menuPosition !== null;
  const selectedLabel = options.find((option) => option.value === value)?.label ?? label;
  const iconClass = tone === 'emerald' ? 'bg-emerald-400/15 text-emerald-200' : tone === 'blue' ? 'bg-sky-400/15 text-sky-200' : 'bg-violet-400/15 text-violet-200';
  const activeClass = tone === 'emerald' ? 'border-emerald-400 bg-emerald-400/20 text-emerald-50' : tone === 'blue' ? 'border-sky-400 bg-sky-400/20 text-sky-50' : 'border-violet-400 bg-violet-400/20 text-violet-50';
  const hoverClass = tone === 'emerald' ? 'hover:bg-emerald-400/10' : tone === 'blue' ? 'hover:bg-sky-400/10' : 'hover:bg-violet-400/10';
  const borderClass = tone === 'emerald' ? 'border-emerald-300/40' : tone === 'blue' ? 'border-sky-300/40' : 'border-violet-300/40';
  const accentClass = tone === 'emerald' ? 'text-emerald-300' : tone === 'blue' ? 'text-sky-300' : 'text-violet-300';
  const headerClass = tone === 'emerald' ? 'border-emerald-400/20 bg-emerald-400/5' : tone === 'blue' ? 'border-sky-400/20 bg-sky-400/5' : 'border-violet-400/20 bg-violet-400/5';
  const focusClass = tone === 'emerald' ? 'focus-visible:ring-emerald-300' : tone === 'blue' ? 'focus-visible:ring-sky-300' : 'focus-visible:ring-violet-300';

  const positionMenu = useCallback(() => {
    const rect = triggerRef.current!.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 224), window.innerWidth - 24);
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const opensUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(264, Math.max(80, opensUp ? spaceAbove - 6 : spaceBelow - 6));
    setMenuPosition({
      top: opensUp ? undefined : rect.bottom + 6,
      bottom: opensUp ? window.innerHeight - rect.top + 6 : undefined,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      width,
      maxHeight,
    });
  }, []);

  useEffect(() => {
    if (isOpen) menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setMenuPosition(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuPosition(null);
        triggerRef.current?.focus();
      }
    };
    const closeOnFocusOutside = (event: FocusEvent) => {
      if (!triggerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setMenuPosition(null);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('focusin', closeOnFocusOutside);
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('focusin', closeOnFocusOutside);
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
    };
  }, [isOpen, positionMenu]);

  return (
    <div className="min-w-[136px] flex-1 sm:w-44 sm:flex-none">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${label}：${selectedLabel}`}
        aria-haspopup="listbox"
        aria-expanded={!!menuPosition}
        aria-controls={menuPosition ? `${id}-menu` : undefined}
        onClick={() => menuPosition ? setMenuPosition(null) : positionMenu()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!menuPosition) positionMenu();
          }
        }}
        className={`group flex h-10 w-full min-w-0 items-center gap-2 rounded-xl border bg-slate-900/85 px-2 text-left shadow-[0_6px_16px_rgba(2,6,23,0.18)] transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${borderClass} ${menuPosition ? 'ring-1 ring-white/30' : ''}`}
      >
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${iconClass}`}>
          {tone === 'emerald' ? <Layers className="h-4 w-4" /> : tone === 'blue' ? <Users className="h-4 w-4" /> : <Tag className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1" title={selectedLabel}>
          <span className="block text-[10px] leading-3 text-slate-400">{caption}</span>
          <span className="block truncate text-xs font-semibold leading-4 text-white">{selectedLabel}</span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-300 transition-transform group-hover:text-white ${menuPosition ? 'rotate-180' : ''}`} />
      </button>
      {menuPosition && createPortal(
        <div
          ref={menuRef}
          id={`${id}-menu`}
          role="listbox"
          aria-label={label}
          data-tone={tone}
          className={`dispatch-members-scroll fixed z-[10010] overflow-y-auto overscroll-contain rounded-xl border bg-gradient-to-b from-slate-800 to-slate-900 p-1 text-slate-100 shadow-[0_20px_48px_rgba(2,6,23,0.65)] ring-1 ring-white/10 ${borderClass}`}
          style={menuPosition}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
            items[nextIndex]?.focus();
          }}
        >
          <p className={`mb-1 rounded-md border-b px-2.5 py-1.5 text-[11px] font-semibold tracking-wide ${headerClass} ${accentClass}`}>{label}</p>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={value === option.value}
              className={`mb-0.5 flex min-h-8 w-full items-center gap-2 rounded-md border-l-2 px-2.5 py-1 text-left text-[13px] leading-4 transition-colors last:mb-0 focus-visible:outline-none focus-visible:ring-2 ${focusClass} ${value === option.value ? activeClass : `border-transparent text-slate-200 hover:text-white ${hoverClass}`}`}
              onClick={() => {
                onChange(option.value);
                setMenuPosition(null);
                triggerRef.current?.focus();
              }}
            >
              <span className="min-w-0 flex-1 break-words font-medium">{option.label}</span>
              {value === option.value && <CheckCircle className={`h-3.5 w-3.5 shrink-0 ${accentClass}`} />}
            </button>
          ))}
        </div>, document.body,
      )}
    </div>
  );
}

interface DispatchPool {
  id: string;
  group_id: string;
  pool_name: string;
  is_base: boolean;
  is_active: boolean;
  dispatch_interval_min: number;
  dispatch_interval_max: number;
  dispatch_order_mode: 'random' | 'sequential';
  trigger_probability: number;
  archived_at: string | null;
  order_count: number;
}

interface DispatchOrder {
  id: string;
  pool_id: string;
  order_content: string;
  is_active: boolean;
  created_at: string;
  archived_at: string | null;
}

interface Employee {
  id: string;
  username: string;
  employee_id: string;
  created_by: string | null;
  group_id: string | null;
  remarks: string | null;
  tags: string[] | null;
}

type GroupDraft = Pick<
  DispatchGroup,
  'group_name' | 'pool_selection_mode' | 'is_active'
> & {
  description: string;
  session_timeout_minutes: string;
  submit_wait_min_seconds: string;
  submit_wait_max_seconds: string;
  commission_rate: string;
  grab_success_rate: string;
  dispatch_success_rate: string;
  withdrawal_amount_threshold: string;
  withdrawal_orders_threshold: string;
  withdrawal_condition_mode: DispatchGroup['withdrawal_condition_mode'];
};
type PoolDraft = Pick<
  DispatchPool,
  'pool_name' | 'is_active' | 'dispatch_order_mode'
> & {
  dispatch_interval_min: string;
  dispatch_interval_max: string;
};

type OrderAction = 'edit' | 'toggle' | 'delete_permanent' | 'delete_all_permanent';

const emptyGroupDraft: GroupDraft = {
  group_name: '',
  description: '',
  pool_selection_mode: 'base',
  is_active: true,
  session_timeout_minutes: '10',
  submit_wait_min_seconds: '5',
  submit_wait_max_seconds: '20',
  commission_rate: '0.001',
  grab_success_rate: '100',
  dispatch_success_rate: '100',
  withdrawal_amount_threshold: '100',
  withdrawal_orders_threshold: '1000',
  withdrawal_condition_mode: 'OR',
};
const emptyPoolDraft: PoolDraft = {
  pool_name: '',
  is_active: true,
  dispatch_interval_min: '30',
  dispatch_interval_max: '120',
  dispatch_order_mode: 'random',
};

function groupDisplayName(group: DispatchGroup): string {
  return group.is_default && group.group_name === 'Default Group'
    ? '預設分組'
    : group.group_name;
}

function poolDisplayName(pool: DispatchPool): string {
  return pool.is_base && pool.pool_name === 'Base' ? '基本池' : pool.pool_name;
}

function groupDisplayDescription(group: DispatchGroup): string {
  return group.is_default && group.description === '默认分组 - 未分配到其他组的员工使用此组'
    ? '預設分組－未分配至其他分組的員工使用此組'
    : group.description || '暫無說明';
}

function poolToDraft(pool: DispatchPool): PoolDraft {
  return {
    pool_name: poolDisplayName(pool),
    is_active: pool.is_active,
    dispatch_interval_min: String(pool.dispatch_interval_min),
    dispatch_interval_max: String(pool.dispatch_interval_max),
    dispatch_order_mode: pool.dispatch_order_mode,
  };
}

export default function DispatchManagement() {
  const auth = getStoredAuth();
  const admin = auth?.userType === 'admin' ? auth.user : null;
  const isSuperAdmin = admin?.role === 'super_admin';
  const currencyUnit = useCurrencyUnit(admin?.id);
  const [groups, setGroups] = useState<DispatchGroup[]>([]);
  const [pools, setPools] = useState<DispatchPool[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [adminNames, setAdminNames] = useState<
    { id: string; username: string }[]
  >([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);
  const [memberPanelOpen, setMemberPanelOpen] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const employeeSearchRef = useRef<HTMLInputElement>(null);
  const [employeeAdminFilter, setEmployeeAdminFilter] = useState('all');
  const [employeeTagFilter, setEmployeeTagFilter] = useState('all');
  const [selectedCurrentMembers, setSelectedCurrentMembers] = useState<
    string[]
  >([]);
  const [selectedOtherMembers, setSelectedOtherMembers] = useState<string[]>(
    [],
  );
  const [orders, setOrders] = useState<DispatchOrder[]>([]);
  const [ordersPoolId, setOrdersPoolId] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('');
  const [orderFilter, setOrderFilter] = useState<'all' | 'active' | 'inactive'>(
    'all',
  );
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [pendingPage, setPendingPage] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [groupSaveStatus, setGroupSaveStatus] = useState<{ type: 'success' | 'error' } | null>(null);
  const [groupForm, setGroupForm] = useState<'create' | null>(null);
  const [groupDraft, setGroupDraft] = useState<GroupDraft>(emptyGroupDraft);
  const [pendingGroupActive, setPendingGroupActive] = useState<boolean | null>(null);
  const [poolForm, setPoolForm] = useState<'create' | 'edit' | null>(null);
  const [poolDraft, setPoolDraft] = useState<PoolDraft>(emptyPoolDraft);
  const [poolToggleTarget, setPoolToggleTarget] = useState<DispatchPool | null>(null);
  const [probabilityDraft, setProbabilityDraft] = useState<Record<string, string>>({});
  const [archiveTarget, setArchiveTarget] = useState<{
    type: 'group' | 'pool';
    id: string;
    name: string;
  } | null>(null);
  const [memberMove, setMemberMove] = useState<{
    ids: string[];
    targetGroupId: string;
    destination: string;
  } | null>(null);
  const [memberMoveProgress, setMemberMoveProgress] = useState<{ completed: number; total: number } | null>(null);
  const [targetOrderAvailability, setTargetOrderAvailability] = useState<'loading' | 'available' | 'empty' | 'error'>('loading');
  const memberMoveInFlightRef = useRef(false);
  const [bulkInput, setBulkInput] = useState('');
  const parsedImportOrders = useMemo(() => bulkInput
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .filter(Boolean), [bulkInput]);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [deleteOrder, setDeleteOrder] = useState<DispatchOrder | null>(null);
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');
  const ordersRequestRef = useRef(0);
  const manualPageRequestRef = useRef(false);
  const workspaceRequestRef = useRef(0);

  const selectedGroup =
    groups.find((group) => group.id === selectedGroupId) ?? null;
  const groupDraftChanged = !!selectedGroup && (
    groupDraft.group_name.trim() !== groupDisplayName(selectedGroup) ||
    groupDraft.description !== (selectedGroup.description ? groupDisplayDescription(selectedGroup) : '') ||
    groupDraft.is_active !== selectedGroup.is_active ||
    groupDraft.pool_selection_mode !== selectedGroup.pool_selection_mode ||
    groupDraft.session_timeout_minutes !== String(selectedGroup.session_timeout_minutes) ||
    groupDraft.submit_wait_min_seconds !== String(selectedGroup.submit_wait_min_seconds) ||
    groupDraft.submit_wait_max_seconds !== String(selectedGroup.submit_wait_max_seconds) ||
    Number(groupDraft.commission_rate) !== selectedGroup.commission_rate ||
    groupDraft.grab_success_rate !== String(selectedGroup.grab_success_rate) ||
    groupDraft.dispatch_success_rate !== String(selectedGroup.dispatch_success_rate) ||
    Number(groupDraft.withdrawal_amount_threshold) !== selectedGroup.withdrawal_amount_threshold ||
    groupDraft.withdrawal_orders_threshold !== String(selectedGroup.withdrawal_orders_threshold) ||
    groupDraft.withdrawal_condition_mode !== selectedGroup.withdrawal_condition_mode
  );
  const groupPools = pools.filter((pool) => pool.group_id === selectedGroupId);
  const editableProbabilityPools = groupPools.filter((pool) => !pool.archived_at);
  const probabilityTotal = editableProbabilityPools.reduce(
    (total, pool) => total + (Number(probabilityDraft[pool.id]) || 0), 0,
  );
  const probabilityDraftChanged = editableProbabilityPools.some(
    (pool) => probabilityDraft[pool.id]?.trim() === '' ||
      Number(probabilityDraft[pool.id]) !== pool.trigger_probability,
  );
  const probabilityDraftValid = editableProbabilityPools.length > 0 &&
    editableProbabilityPools.every((pool) =>
      /^\d{1,3}$/.test(probabilityDraft[pool.id]?.trim() ?? '') &&
      Number(probabilityDraft[pool.id]) <= 100,
    ) && probabilityTotal === 100;
  const groupSettingsChanged = groupDraftChanged ||
    (groupDraft.pool_selection_mode === 'weighted' && probabilityDraftChanged);
  const displayGroupById = (id: string | null) => {
    const group = groups.find((item) => item.id === id);
    return group ? groupDisplayName(group) : '尚未指派分組';
  };
  const selectedPool = groupPools.find((pool) => pool.id === selectedPoolId) ?? null;
  const defaultGroup = groups.find(
    (group) => group.is_default && group.is_active && !group.archived_at,
  );
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const modalOpen = Boolean(
    groupForm ||
      groupSettingsOpen ||
      memberPanelOpen ||
      ordersOpen ||
      poolForm ||
      poolToggleTarget ||
      archiveTarget ||
      memberMove ||
      deleteOrder ||
      showDeleteAll,
  );

  const notify = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
  };

  const groupSaveFailed = (message: string) => {
    setGroupSaveStatus({ type: 'error' });
    notify('error', message);
  };

  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => setNotification(null), 5000);
    return () => clearTimeout(timer);
  }, [notification]);

  useEffect(() => {
    if (!groupSaveStatus) return;
    const timer = setTimeout(() => setGroupSaveStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [groupSaveStatus]);

  useEffect(() => {
    if (!memberMove) return;
    let active = true;
    setTargetOrderAvailability('loading');
    const targetGroup = groups.find((group) => group.id === memberMove.targetGroupId);
    const eligiblePools = pools.filter((pool) =>
      pool.group_id === memberMove.targetGroupId && pool.is_active && !pool.archived_at &&
      (targetGroup?.pool_selection_mode !== 'base' || pool.is_base) &&
      (targetGroup?.pool_selection_mode !== 'weighted' || pool.trigger_probability > 0),
    );
    if (!eligiblePools.length) {
      setTargetOrderAvailability('empty');
      return;
    }
    void supabase.from('dispatch_group_orders')
      .select('id', { count: 'exact', head: true })
      .in('pool_id', eligiblePools.map((pool) => pool.id))
      .eq('is_active', true)
      .is('archived_at', null)
      .then(({ count, error }) => {
        if (active) setTargetOrderAvailability(error ? 'error' : count ? 'available' : 'empty');
      });
    return () => { active = false; };
  }, [memberMove, groups, pools]);

  const loadWorkspace = async () => {
    const requestId = ++workspaceRequestRef.current;
    try {
      if (!admin || (admin.role !== 'super_admin' && admin.role !== 'secondary_admin')) {
        throw new Error('管理員登入已失效。');
      }
      const [groupResult, poolResult, adminResult] = await Promise.all([
        supabase
          .from('dispatch_groups')
          .select('*')
          .order('is_default', { ascending: false })
          .order('created_at'),
        supabase
          .from('dispatch_order_pools')
          .select('*')
          .order('is_base', { ascending: false })
          .order('created_at'),
        isSuperAdmin
          ? supabase.from('admins').select('id, username').neq('role', 'emergency_admin').order('username')
          : Promise.resolve(null),
      ]);
      if (groupResult.error) throw groupResult.error;
      if (poolResult.error) throw poolResult.error;
      if (adminResult?.error) throw adminResult.error;

      const groupRows = groupResult.data as unknown as DispatchGroup[];
      const poolRows = poolResult.data as unknown as DispatchPool[];
      const employeeRows: Employee[] = [];
      // Page employees and their memberships to avoid Supabase's default 1,000-row limit.
      for (let offset = 0; ; offset += 500) {
        let query = supabase
          .from('users')
          .select('id, username, employee_id, created_by, remarks, tags')
          .order('username')
          .order('id')
          .range(offset, offset + 499);
        if (!isSuperAdmin) query = query.eq('created_by', admin.id);
        const { data: users, error } = await query;
        if (error) throw error;
        if (!users?.length) break;
        const memberMap = new Map<string, string>();
        for (let index = 0; index < users.length; index += 100) {
          const { data: memberships, error: memberError } = await supabase
            .from('dispatch_group_members')
            .select('user_id, group_id')
            .in(
              'user_id',
              users.slice(index, index + 100).map((user) => user.id),
            );
          if (memberError) throw memberError;
          for (const member of memberships ?? [])
            memberMap.set(member.user_id, member.group_id);
        }
        employeeRows.push(
          ...users.map((employee) => ({
            id: employee.id,
            username: employee.username,
            employee_id: employee.employee_id,
            created_by: employee.created_by,
            group_id: memberMap.get(employee.id) ?? null,
            remarks: employee.remarks,
            tags: employee.tags,
          })),
        );
        if (users.length < 500) break;
      }
      const counts = await Promise.all(
        poolRows.map(async (pool) => {
          const result = await supabase
            .from('dispatch_group_orders')
            .select('id', { count: 'exact', head: true })
            .eq('pool_id', pool.id)
            .is('archived_at', null);
          if (result.error) throw result.error;
          return result.count ?? 0;
        }),
      );
      const countedPools = poolRows.map((pool, index) => ({
        ...pool,
        order_count: counts[index],
      }));
      const countedGroups = groupRows.map((group) => ({
        ...group,
        member_count: employeeRows.filter(
          (employee) => employee.group_id === group.id,
        ).length,
        order_count: countedPools
          .filter((pool) => pool.group_id === group.id)
          .reduce((sum, pool) => sum + pool.order_count, 0),
      }));
      if (requestId !== workspaceRequestRef.current) return true;
      setGroups(countedGroups);
      setPools(countedPools);
      setEmployees(employeeRows);
      const availableEmployeeIds = new Set(employeeRows.map((employee) => employee.id));
      setSelectedCurrentMembers((current) => current.filter((id) => availableEmployeeIds.has(id)));
      setSelectedOtherMembers((current) => current.filter((id) => availableEmployeeIds.has(id)));
      setAdminNames(
        isSuperAdmin
          ? (adminResult?.data ?? [])
          : admin
            ? [{ id: admin.id, username: admin.username }]
            : [],
      );
      setSelectedGroupId((current) =>
        current && countedGroups.some((group) => group.id === current)
          ? current
          : (countedGroups.find(
              (group) => group.is_default && !group.archived_at,
            )?.id ??
            countedGroups[0]?.id ??
            null),
      );
      return true;
    } catch (error) {
      if (requestId !== workspaceRequestRef.current) return true;
      notify(
        'error',
        '載入訂單指派工作區失敗：' + formatSupabaseError(error),
      );
      return false;
    } finally {
      if (requestId === workspaceRequestRef.current) setWorkspaceLoading(false);
    }
  };

  const loadOrders = async (
    poolId: string,
    requestedPage = 1,
    status = orderFilter,
    manualPageChange = false,
  ) => {
    if (!manualPageChange && manualPageRequestRef.current) return false;
    const requestId = ++ordersRequestRef.current;
    if (manualPageChange) {
      manualPageRequestRef.current = true;
      setPendingPage(requestedPage);
    }
    if (manualPageChange || ordersPoolId !== poolId || requestedPage !== page) {
      setOrdersLoading(true);
    }
    try {
      const from = (requestedPage - 1) * PAGE_SIZE;
      let query = supabase
        .from('dispatch_group_orders')
        .select('*', { count: 'exact' })
        .eq('pool_id', poolId)
        .is('archived_at', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (status !== 'all') query = query.eq('is_active', status === 'active');
      const { data, error, count } = await query;
      if (error) throw error;
      if (requestId !== ordersRequestRef.current) return false;
      const total = count ?? 0;
      if (requestedPage > 1 && from >= total) {
        return await loadOrders(
          poolId,
          Math.max(1, Math.ceil(total / PAGE_SIZE)),
          status,
          manualPageChange,
        );
      }
      setOrders(data as unknown as DispatchOrder[]);
      setOrdersPoolId(poolId);
      setTotalCount(total);
      setPage(requestedPage);
      return true;
    } catch (error) {
      if (requestId !== ordersRequestRef.current) return false;
      if (!manualPageChange) {
        setOrders([]);
        setOrdersPoolId(poolId);
        setTotalCount(0);
      }
      notify('error', '載入訂單失敗：' + formatSupabaseError(error));
      return false;
    } finally {
      if (requestId === ordersRequestRef.current) {
        setOrdersLoading(false);
        if (manualPageChange) {
          manualPageRequestRef.current = false;
          setPendingPage(null);
        }
      }
    }
  };

  const refreshWorkspace = async () => {
    setRefreshing(true);
    try {
      const [workspaceLoaded, ordersLoaded] = await Promise.all([
        loadWorkspace(),
        ordersOpen && selectedPool
          ? loadOrders(selectedPool.id, page, orderFilter)
          : Promise.resolve(true),
      ]);
      if (workspaceLoaded && ordersLoaded)
        notify('success', '訂單指派資料已刷新。');
    } finally {
      setRefreshing(false);
    }
  };

  const loadWorkspaceRef = useRef(loadWorkspace);
  const loadOrdersRef = useRef(loadOrders);
  const orderViewRef = useRef({
    poolId: ordersOpen ? (selectedPool?.id ?? null) : null,
    page,
    status: orderFilter,
  });
  loadWorkspaceRef.current = loadWorkspace;
  loadOrdersRef.current = loadOrders;
  orderViewRef.current = {
    poolId: ordersOpen ? (selectedPool?.id ?? null) : null,
    page,
    status: orderFilter,
  };

  useEffect(() => {
    void loadWorkspaceRef.current();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (memberMoveInFlightRef.current) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (memberMoveInFlightRef.current) return;
        void loadWorkspaceRef.current();
        const { poolId, page: currentPage, status } = orderViewRef.current;
        if (poolId) void loadOrdersRef.current(poolId, currentPage, status);
      }, 600);
    };
    const channel = supabase.channel('dispatch-management-changes');
    for (const table of [
      'dispatch_groups',
      'dispatch_order_pools',
      'dispatch_group_orders',
      'dispatch_group_members',
      'users',
    ]) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        refresh,
      );
    }
    channel.subscribe();
    return () => {
      clearTimeout(refreshTimer);
      void supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    manualPageRequestRef.current = false;
    setPendingPage(null);
    if (ordersOpen && selectedPool?.id) {
      void loadOrdersRef.current(selectedPool.id, 1, orderFilter);
    } else {
      ++ordersRequestRef.current;
      setOrders([]);
      setOrdersPoolId(null);
      setTotalCount(0);
      setPage(1);
      setOrdersLoading(false);
    }
  }, [ordersOpen, selectedPool?.id, orderFilter]);

  useEffect(() => {
    if (!modalOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [modalOpen]);

  const switchGroup = (groupId: string) => {
    setSelectedGroupId(groupId);
    setSelectedPoolId(null);
    setPendingGroupActive(null);
    setGroupSettingsOpen(false);
    setMemberPanelOpen(false);
    setOrdersOpen(false);
    setPoolToggleTarget(null);
    setEditingId(null);
    setShowBulkImport(false);
    setBulkInput('');
    setSelectedCurrentMembers([]);
    setSelectedOtherMembers([]);
    setEmployeeTagFilter('all');
    setEmployeeAdminFilter('all');
  };

  const openGroupSettings = (group: DispatchGroup) => {
    switchGroup(group.id);
    setNotification(null);
    setGroupSaveStatus(null);
    setProbabilityDraft(Object.fromEntries(
      pools.filter((pool) => pool.group_id === group.id && !pool.archived_at)
        .map((pool) => [pool.id, String(pool.trigger_probability)]),
    ));
    setGroupDraft({
      group_name: groupDisplayName(group),
      description: group.description ? groupDisplayDescription(group) : '',
      is_active: group.is_active,
      pool_selection_mode: group.pool_selection_mode,
      session_timeout_minutes: String(group.session_timeout_minutes),
      submit_wait_min_seconds: String(group.submit_wait_min_seconds),
      submit_wait_max_seconds: String(group.submit_wait_max_seconds),
      commission_rate: String(group.commission_rate),
      grab_success_rate: String(group.grab_success_rate),
      dispatch_success_rate: String(group.dispatch_success_rate),
      withdrawal_amount_threshold: String(group.withdrawal_amount_threshold),
      withdrawal_orders_threshold: String(group.withdrawal_orders_threshold),
      withdrawal_condition_mode: group.withdrawal_condition_mode,
    });
    setGroupSettingsOpen(true);
  };

  const openOrders = (poolId: string) => {
    setSelectedPoolId(poolId);
    setOrdersPoolId(null);
    setTotalCount(0);
    setPageInput('');
    setOrderFilter('all');
    setEditingId(null);
    setShowBulkImport(false);
    setBulkInput('');
    setOrdersOpen(true);
  };

  const saveGroup = async (form: 'create' | 'edit' = 'create') => {
    if (!isSuperAdmin) return;
    setNotification(null);
    setGroupSaveStatus(null);
    if (form === 'edit' && !selectedGroup)
      return groupSaveFailed('目前未選取分組，請重新整理後再試。');
    if (!groupDraft.group_name.trim())
      return groupSaveFailed('請填寫分組名稱。');
    if (form === 'edit' && groupDraft.pool_selection_mode === 'weighted' && !probabilityDraftValid)
      return groupSaveFailed('請為每個未封存訂單池填寫 0–100% 的整數概率，合計須為 100%。');
    const timeout = Number(groupDraft.session_timeout_minutes);
    const waitMin = Number(groupDraft.submit_wait_min_seconds);
    const waitMax = Number(groupDraft.submit_wait_max_seconds);
    const commissionRate = Number(groupDraft.commission_rate);
    const grabSuccessRate = Number(groupDraft.grab_success_rate);
    const successRate = Number(groupDraft.dispatch_success_rate);
    const withdrawalAmount = Number(groupDraft.withdrawal_amount_threshold);
    const withdrawalOrders = Number(groupDraft.withdrawal_orders_threshold);
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(groupDraft.withdrawal_amount_threshold.trim()) ||
        !Number.isFinite(withdrawalAmount) || withdrawalAmount > 999999999999.99 ||
        !/^\d{1,7}$/.test(groupDraft.withdrawal_orders_threshold.trim()) ||
        !Number.isInteger(withdrawalOrders) || withdrawalOrders < 1 || withdrawalOrders > 1000000) {
      return groupSaveFailed('提款門檻須為 0–999999999999.99，訂單數須為 1–1000000。');
    }
    if (!groupDraft.commission_rate.trim() || !Number.isFinite(commissionRate) || commissionRate < 0.00001 || commissionRate > 1 || !/^\d+(\.\d{1,8})?$/.test(groupDraft.commission_rate.trim()) ||
        !groupDraft.grab_success_rate.trim() || !Number.isInteger(grabSuccessRate) || grabSuccessRate < 0 || grabSuccessRate > 100 ||
        !groupDraft.dispatch_success_rate.trim() || !Number.isInteger(successRate) || successRate < 0 || successRate > 100) {
      return groupSaveFailed('佣金率須為 0.00001–1（最多 8 位小數），搶單與提交後成功率各須為 0–100% 的整數。');
    }
    if (!groupDraft.session_timeout_minutes.trim() || !Number.isInteger(timeout) || timeout < 1 || timeout > 60 ||
        !groupDraft.submit_wait_min_seconds.trim() || !Number.isInteger(waitMin) || waitMin < 3 || waitMin > 120 ||
        !groupDraft.submit_wait_max_seconds.trim() || !Number.isInteger(waitMax) || waitMax < waitMin || waitMax > 300) {
      return groupSaveFailed('逾時須為 1–60 分鐘；提交等待最短 3–120 秒、最長 3–300 秒，且最短不得大於最長。');
    }
    setBusy(true);
    let probabilitiesSaved = false;
    try {
      if (form === 'edit' && selectedGroup && groupDraft.pool_selection_mode === 'weighted' && probabilityDraftChanged) {
        const { error: probabilityError } = await supabase.rpc('admin_set_dispatch_pool_probabilities', {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_group_id: selectedGroup.id,
          p_probabilities: editableProbabilityPools.map((pool) => ({
            pool_id: pool.id,
            probability: Number(probabilityDraft[pool.id]),
          })),
        });
        if (probabilityError) throw probabilityError;
        probabilitiesSaved = true;
      }
      if (form === 'edit' && !groupDraftChanged) {
        setGroupSaveStatus({ type: 'success' });
        notify('success', '訂單池觸發概率已儲存。');
        await loadWorkspace();
        return;
      }
      const { data, error } = await supabase.rpc(
        'admin_save_dispatch_group',
        {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_group_id: form === 'edit' ? (selectedGroup?.id ?? null) : null,
          p_changes: {
            group_name:
              form === 'edit' && selectedGroup &&
              groupDraft.group_name.trim() === groupDisplayName(selectedGroup)
                ? selectedGroup.group_name
                : groupDraft.group_name.trim(),
            description:
              form === 'edit' && selectedGroup &&
              groupDraft.description === (selectedGroup.description ? groupDisplayDescription(selectedGroup) : '')
                ? selectedGroup.description
                : groupDraft.description,
            pool_selection_mode: groupDraft.pool_selection_mode,
            session_timeout_minutes: timeout,
            submit_wait_min_seconds: waitMin,
            submit_wait_max_seconds: waitMax,
            commission_rate: commissionRate,
            grab_success_rate: grabSuccessRate,
            dispatch_success_rate: successRate,
            withdrawal_amount_threshold: withdrawalAmount,
            withdrawal_orders_threshold: withdrawalOrders,
            withdrawal_condition_mode: groupDraft.withdrawal_condition_mode,
            is_active: groupDraft.is_active,
          },
        },
      );
      if (error) throw error;
      if (!data?.group?.id) throw new Error('儲存分組後未收到分組資料。');
      const savedGroup = data.group as unknown as DispatchGroup;
      setGroups((current) => {
        const existing = current.find((group) => group.id === savedGroup.id);
        return existing
          ? current.map((group) => group.id === savedGroup.id ? { ...group, ...savedGroup } : group)
          : [...current, { ...savedGroup, member_count: 0, order_count: 0 }];
      });
      if (form === 'create') setGroupForm(null);
      setSelectedGroupId(savedGroup.id);
      if (form === 'create') setSelectedPoolId(null);
      setGroupSaveStatus({ type: 'success' });
      notify(
        'success',
        form === 'create'
          ? '已建立分組及專屬基本池。'
          : '分組設定已儲存成功。',
      );
      await loadWorkspace();
    } catch (error) {
      const message = formatSupabaseError(error);
      groupSaveFailed(
        probabilitiesSaved
          ? '觸發概率已儲存，但分組設定失敗：' + message
          : message.includes('Invalid dispatch group changes.')
            ? '儲存失敗：目前資料庫尚未支援分組時間、收益及提款設定；資料未變更，需先完成資料庫遷移。'
            : '儲存分組失敗：' + message,
      );
      if (probabilitiesSaved) await loadWorkspace();
    } finally {
      setBusy(false);
    }
  };

  const savePool = async () => {
    if (!isSuperAdmin || !selectedGroup || !poolForm) return;
    if (selectedGroup.archived_at || (poolForm === 'edit' && !selectedPool))
      return notify(
        'error',
        '所選分組或訂單池已無法使用，請重新整理後再試。',
      );
    const min = Number(poolDraft.dispatch_interval_min);
    const max = Number(poolDraft.dispatch_interval_max);
    if (!poolDraft.pool_name.trim())
      return notify('error', '請填寫訂單池名稱。');
    if (
      !Number.isInteger(min) ||
      min < 1 ||
      min > 3000 ||
      !Number.isInteger(max) ||
      max < min ||
      max > 3000
    ) {
      return notify(
        'error',
        '派單間隔須為 1–3000 秒，且最短不得大於最長。',
      );
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('admin_save_dispatch_pool', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_group_id: selectedGroup.id,
        p_pool_id: poolForm === 'edit' ? (selectedPool?.id ?? null) : null,
        p_changes: {
          pool_name:
            poolForm === 'edit' && selectedPool &&
            poolDraft.pool_name.trim() === poolDisplayName(selectedPool)
              ? selectedPool.pool_name
              : poolDraft.pool_name.trim(),
          is_active: poolDraft.is_active,
          dispatch_interval_min: min,
          dispatch_interval_max: max,
          dispatch_order_mode: poolDraft.dispatch_order_mode,
        },
      });
      if (error) throw error;
      if (!data?.pool?.id) throw new Error('儲存訂單池後未收到訂單池資料。');
      setPoolForm(null);
      setSelectedPoolId(data.pool.id);
      if (await loadWorkspace())
        notify(
          'success',
          poolForm === 'create' ? '訂單池已建立。' : '訂單池設定已儲存。',
        );
    } catch (error) {
      notify('error', '儲存訂單池失敗：' + formatSupabaseError(error));
    } finally {
      setBusy(false);
    }
  };

  const changeArchive = async (
    type: 'group' | 'pool',
    id: string,
    archive: boolean,
  ) => {
    if (!isSuperAdmin) return;
    const targetPool = type === 'pool' ? pools.find((pool) => pool.id === id) : null;
    if (type === 'pool' && !targetPool) return notify('error', '找不到訂單池。');
    setBusy(true);
    try {
      const { error } =
        type === 'group'
          ? await supabase.rpc('admin_save_dispatch_group', {
              p_admin_session_token: getAdminFinancialSessionToken(),
              p_group_id: id,
              p_changes: {
                archived_at: archive ? new Date().toISOString() : null,
              },
            })
          : await supabase.rpc('admin_save_dispatch_pool', {
              p_admin_session_token: getAdminFinancialSessionToken(),
              p_group_id: targetPool!.group_id,
              p_pool_id: id,
              p_changes: {
                archived_at: archive ? new Date().toISOString() : null,
              },
            });
      if (error) throw error;
      setArchiveTarget(null);
      if (await loadWorkspace())
        notify(
          'success',
          `${type === 'group' ? '分組' : '訂單池'}已${archive ? '封存' : '還原'}。`,
        );
    } catch (error) {
      notify(
        'error',
        '更新封存狀態失敗：' + formatSupabaseError(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const togglePool = async (pool: DispatchPool) => {
    if (
      !isSuperAdmin ||
      !selectedGroup ||
      selectedGroup.archived_at ||
      pool.archived_at
    )
      return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('admin_save_dispatch_pool', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_group_id: selectedGroup.id,
        p_pool_id: pool.id,
        p_changes: { is_active: !pool.is_active },
      });
      if (error) throw error;
      setPoolToggleTarget(null);
      if (await loadWorkspace())
        notify('success', `訂單池已${pool.is_active ? '停用' : '啟用'}。`);
    } catch (error) {
      notify(
        'error',
        '變更訂單池狀態失敗：' + formatSupabaseError(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const assignMembers = async () => {
    if (!memberMove || busy) return;
    const { ids, targetGroupId, destination } = memberMove;
    if (!admin || (!isSuperAdmin && (
      admin.role !== 'secondary_admin' || ids.some((id) =>
        !employees.some((employee) => employee.id === id && employee.created_by === admin.id)
      )
    ))) {
      return notify('error', '只能移動自己名下的員工；請刷新列表後重試。');
    }
    if (
      !groups.some(
        (group) =>
          group.id === targetGroupId && group.is_active && !group.archived_at,
      )
    ) {
      return notify('error', '目標分組未啟用。');
    }
    const movedIds = new Set(ids);
    const originalGroups = new Map(employees.filter((employee) => movedIds.has(employee.id)).map((employee) => [employee.id, employee.group_id]));
    const groupChanges = new Map<string, number>();
    for (const id of ids) {
      const previousGroupId = originalGroups.get(id);
      if (previousGroupId === targetGroupId) continue;
      if (previousGroupId) groupChanges.set(previousGroupId, (groupChanges.get(previousGroupId) ?? 0) - 1);
      groupChanges.set(targetGroupId, (groupChanges.get(targetGroupId) ?? 0) + 1);
    }
    memberMoveInFlightRef.current = true;
    ++workspaceRequestRef.current;
    setBusy(true);
    setMemberMove(null);
    setMemberMoveProgress({ completed: 0, total: ids.length });
    setEmployees((current) => current.map((employee) => movedIds.has(employee.id) ? { ...employee, group_id: targetGroupId } : employee));
    setGroups((current) => current.map((group) => ({ ...group, member_count: group.member_count + (groupChanges.get(group.id) ?? 0) })));
    const succeeded = new Set<string>();
    let firstError: string | null = null;
    try {
      const token = getAdminFinancialSessionToken();
      let nextIndex = 0;
      await Promise.all(Array.from({ length: Math.min(5, ids.length) }, async () => {
        while (nextIndex < ids.length) {
          const id = ids[nextIndex++];
          try {
            const { data, error } = await supabase.rpc('admin_assign_dispatch_group_member', {
              p_admin_session_token: token,
              p_user_id: id,
              p_group_id: targetGroupId,
            });
            if (error) throw error;
            const member = (data as { member?: { user_id: string; group_id: string } } | null)?.member;
            if (member?.user_id !== id || member.group_id !== targetGroupId)
              throw new Error('指派後未收到正確的員工歸屬資料。');
            succeeded.add(id);
          } catch (error) {
            firstError ??= formatSupabaseError(error);
          } finally {
            setMemberMoveProgress((current) => current && { ...current, completed: current.completed + 1 });
          }
        }
      }));
    } catch (error) {
      firstError ??= formatSupabaseError(error);
    } finally {
      const failedIds = ids.filter((id) => !succeeded.has(id));
      const failedSet = new Set(failedIds);
      const rollbackCounts = new Map<string, number>();
      for (const id of failedIds) {
        const previousGroupId = originalGroups.get(id);
        if (previousGroupId === targetGroupId) continue;
        if (previousGroupId) rollbackCounts.set(previousGroupId, (rollbackCounts.get(previousGroupId) ?? 0) + 1);
        rollbackCounts.set(targetGroupId, (rollbackCounts.get(targetGroupId) ?? 0) - 1);
      }
      setEmployees((current) => current.map((employee) => failedSet.has(employee.id) ? { ...employee, group_id: originalGroups.get(employee.id) ?? null } : employee));
      setGroups((current) => current.map((group) => ({ ...group, member_count: group.member_count + (rollbackCounts.get(group.id) ?? 0) })));
      setSelectedCurrentMembers((current) => current.filter((id) => !succeeded.has(id)));
      setSelectedOtherMembers((current) => current.filter((id) => !succeeded.has(id)));
      if (failedIds.length) {
        notify('error', `已將 ${succeeded.size} / ${ids.length} 位員工移至「${destination}」；其餘未移動：${firstError ?? '請重試。'}`);
      } else {
        notify('success', `已將 ${succeeded.size} 位員工移至「${destination}」。`);
      }
      void loadWorkspace();
      memberMoveInFlightRef.current = false;
      setMemberMoveProgress(null);
      setBusy(false);
    }
  };

  const manageOrder = async (
    action: OrderAction,
    orderId?: string,
    content?: string,
  ) => {
    if (!isSuperAdmin) return;
    if (!selectedPool || selectedPool.archived_at || selectedGroup?.archived_at)
      return notify(
        'error',
        '所選訂單池已無法管理訂單。',
      );
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc(
        'admin_manage_dispatch_orders',
        {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_pool_id: selectedPool.id,
          p_action: action,
          p_order_id: orderId ?? null,
          p_content: content ?? null,
        },
      );
      if (error) throw error;
      const result = data as { affected?: number } | null;
      if (typeof result?.affected !== 'number')
        throw new Error('訂單操作未傳回結果。');
      setEditingId(null);
      setDeleteOrder(null);
      setShowDeleteAll(false);
      setDeleteConfirmInput('');
      const [refreshed, ordersRefreshed] = await Promise.all([
        loadWorkspace(),
        loadOrders(selectedPool.id, page),
      ]);
      if (refreshed && ordersRefreshed)
        notify(
          'success',
          action === 'delete_all_permanent'
            ? `已永久刪除「${poolDisplayName(selectedPool)}」中的 ${result.affected} 筆訂單。`
            : `訂單已${action === 'delete_permanent' ? '永久刪除' : action === 'toggle' ? '更新狀態' : '儲存'}。`,
        );
    } catch (error) {
      await Promise.all([loadWorkspace(), loadOrders(selectedPool.id, page)]);
      const message = formatSupabaseError(error);
      notify('error',
        (action === 'delete_permanent' || action === 'delete_all_permanent') &&
        message.includes('Invalid dispatch order action or pool.')
          ? '目前資料庫尚未支援永久刪除，訂單未變更；請先完成資料庫更新。'
          : '訂單操作失敗：' + message,
      );
    } finally {
      setBusy(false);
    }
  };

  const importOrders = async () => {
    const target = selectedPool;
    if (!isSuperAdmin || !target || target.archived_at || selectedGroup?.archived_at)
      return notify('error', '目前訂單池已無法匯入訂單。');
    const contents = parsedImportOrders;
    if (!contents.length)
      return notify(
        'error',
        '請輸入至少一筆訂單，並以空白行分隔。',
      );
    setBusy(true);
    setImportProgress({ current: 0, total: contents.length });
    let imported = 0;
    let importError: string | null = null;
    try {
      const token = getAdminFinancialSessionToken();
      for (let index = 0; index < contents.length; index += IMPORT_BATCH_SIZE) {
        const batch = contents.slice(index, index + IMPORT_BATCH_SIZE);
        const { data, error } = await supabase.rpc(
          'admin_manage_dispatch_orders',
          {
            p_admin_session_token: token,
            p_pool_id: target.id,
            p_action: 'import',
            p_contents: batch,
          },
        );
        if (error) throw error;
        if ((data as { affected?: number } | null)?.affected !== batch.length) {
          throw new Error(
            '匯入筆數與提交筆數不符，請重新整理核對後再試。',
          );
        }
        imported += batch.length;
        setImportProgress({ current: imported, total: contents.length });
      }
    } catch (error) {
      // The failed response may still have committed its batch; retain it for verification.
      setBulkInput(contents.slice(imported).join('\n\n'));
      importError = `已確認匯入 ${imported} / ${contents.length} 筆訂單；其餘內容已保留。部分結果可能尚未確認，請先刷新核對後再重試，避免重複。${formatSupabaseError(error)}`;
    } finally {
      const [workspaceLoaded, ordersLoaded] = await Promise.all([
        loadWorkspace(),
        loadOrders(target.id, 1),
      ]);
      if (importError) {
        notify('error', importError);
      } else {
        setBulkInput('');
        setShowBulkImport(false);
        notify('success', workspaceLoaded && ordersLoaded
          ? `已將 ${imported} 筆訂單匯入「${poolDisplayName(target)}」。`
          : `已將 ${imported} 筆訂單匯入「${poolDisplayName(target)}」，但重新載入資料失敗；請按「刷新」確認。`);
      }
      setImportProgress(null);
      setBusy(false);
    }
  };

  const visibleEmployees = employees.filter(
    (employee) =>
      (isSuperAdmin || (admin?.role === 'secondary_admin' && employee.created_by === admin.id)) &&
      (employee.username.toLowerCase().includes(employeeSearch.toLowerCase()) ||
        employee.employee_id.toLowerCase().includes(employeeSearch.toLowerCase())) &&
      (employeeAdminFilter === 'all' ||
        employee.created_by === employeeAdminFilter) &&
      (employeeTagFilter === 'all' ||
        employee.tags?.includes(employeeTagFilter)),
  );
  const currentMembers = visibleEmployees.filter(
    (employee) => employee.group_id === selectedGroupId,
  );
  const otherMembers = visibleEmployees.filter(
    (employee) => employee.group_id !== selectedGroupId,
  );
  const tags = [
    ...new Set(employees.flatMap((employee) => employee.tags ?? [])),
  ].sort();
  const canManageOrders =
    isSuperAdmin &&
    !!selectedPool &&
    !selectedPool.archived_at &&
    !selectedGroup?.archived_at;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-slate-950/30 text-slate-100">
      {notification && createPortal(
        <div
          role={notification.type === 'error' ? 'alert' : 'status'}
          className={`fixed left-4 right-4 top-4 z-[10020] flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl sm:left-auto sm:w-full sm:max-w-md ${notification.type === 'error' ? 'border-rose-400/70 bg-rose-950 text-rose-50' : 'border-emerald-400/70 bg-emerald-950 text-emerald-50'}`}
        >
          {notification.type === 'error' ? (
            <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
          ) : (
            <CheckCircle className="mt-0.5 h-5 w-5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 break-words">{notification.message}</span>
          <button
            type="button"
            onClick={() => setNotification(null)}
            aria-label="關閉通知"
            className="shrink-0 rounded p-0.5 hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>, document.body,
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-cyan-800/60 bg-gradient-to-r from-blue-950/70 via-slate-900/70 to-cyan-950/40 px-3 py-1.5 sm:px-4 lg:px-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white sm:text-base">
            訂單指派工作區
          </h2>
          {!isSuperAdmin && (
            <p className="text-xs text-slate-400">
              分組設定與訂單僅供檢視；您可以將自己工作區的員工指派至已啟用的分組。
            </p>
          )}
        </div>
        <button
          type="button"
          className="inline-flex h-8 w-32 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-blue-600 px-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
          disabled={workspaceLoading || refreshing || busy}
          aria-busy={refreshing}
          onClick={() => void refreshWorkspace()}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          <span aria-live="polite">{refreshing ? '刷新中…' : '刷新'}</span>
        </button>
      </div>

      <div className="relative grid min-h-0 min-w-0 w-full flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] lg:before:pointer-events-none lg:before:absolute lg:before:inset-y-0 lg:before:left-[279px] lg:before:z-10 lg:before:w-[2px] lg:before:bg-gradient-to-b lg:before:from-blue-400/80 lg:before:via-cyan-500/60 lg:before:to-cyan-800/30">
        <>
            <section className="min-w-0 border-b-2 border-cyan-700/65 bg-gradient-to-b from-blue-950/65 via-slate-900/40 to-slate-950/20 px-3 py-4 sm:px-4 lg:border-b-0">
              <div className="mb-4 flex min-w-0 items-center justify-between gap-2">
                <h3 className="flex min-w-0 items-center gap-2 font-semibold text-blue-100">
                  <Layers className="h-4 w-4 text-blue-400" />
                  分組 <span className="rounded-full bg-blue-400/15 px-2 py-0.5 text-xs text-blue-200">{groups.length}</span>
                </h3>
                {isSuperAdmin && (
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy}
                    onClick={() => {
                      setGroupDraft({
                        ...emptyGroupDraft,
                        commission_rate: String(defaultGroup?.commission_rate ?? 0.001),
                        grab_success_rate: String(defaultGroup?.grab_success_rate ?? 100),
                        dispatch_success_rate: String(defaultGroup?.dispatch_success_rate ?? 100),
                        withdrawal_amount_threshold: String(defaultGroup?.withdrawal_amount_threshold ?? 100),
                        withdrawal_orders_threshold: String(defaultGroup?.withdrawal_orders_threshold ?? 1000),
                        withdrawal_condition_mode: defaultGroup?.withdrawal_condition_mode ?? 'OR',
                      });
                      setGroupForm('create');
                    }}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />新增分組
                  </button>
                )}
              </div>
              <div className="max-h-[min(70vh,780px)] space-y-2.5 overflow-y-auto pr-1">
                {groups.map((group) => (
                  <article
                    key={group.id}
                    className={`relative min-w-0 overflow-hidden rounded-lg border px-2.5 py-2 transition-colors ${selectedGroupId === group.id ? 'border-cyan-300 bg-gradient-to-br from-blue-900/90 via-indigo-950/95 to-cyan-900/85 shadow-[0_0_16px_rgba(34,211,238,0.2)] ring-1 ring-cyan-300/70 before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-cyan-300' : 'border-slate-700 bg-slate-950/70 hover:border-slate-500 hover:bg-slate-800/80'}`}
                  >
                    <button
                      type="button"
                      className="w-full min-w-0 text-left focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                      aria-pressed={selectedGroupId === group.id}
                      onClick={() => switchGroup(group.id)}
                    >
                      <span className="flex min-w-0 items-start justify-between gap-1.5">
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 flex-wrap items-center gap-1">
                            <span className={`min-w-0 break-words text-sm font-semibold leading-5 ${selectedGroupId === group.id ? 'text-white' : 'text-slate-200'}`}>{groupDisplayName(group)}</span>
                            {group.is_default && <span className="shrink-0 rounded bg-amber-400/20 px-1 text-[10px] leading-4 text-amber-100">預設</span>}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] leading-4 text-slate-300" title={groupDisplayDescription(group)}>{groupDisplayDescription(group)}</span>
                        </span>
                        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] leading-5 ${group.archived_at ? 'bg-rose-500/20 text-rose-100' : group.is_active ? 'bg-emerald-500/20 text-emerald-100' : 'bg-rose-500/20 text-rose-200'}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${group.archived_at ? 'bg-rose-400' : group.is_active ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                          {group.archived_at ? '已封存' : group.is_active ? '已啟用' : '未啟用'}
                        </span>
                      </span>
                      <span className="mt-1.5 block text-[11px] leading-4 text-slate-200">
                        {group.member_count} 位成員 · {group.order_count} 筆訂單
                      </span>
                      <span className={`mt-1 block text-[11px] font-medium leading-4 ${selectedGroupId === group.id ? 'text-cyan-50' : 'text-slate-300'}`}>
                        選池 · {group.pool_selection_mode === 'base' ? '固定基本池' : group.pool_selection_mode === 'weighted' ? '按池設定概率' : '隨機可派單池'}
                      </span>
                      <span className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1 border-t border-white/15 pt-1.5 text-[11px] leading-4">
                        <span className="min-w-0 truncate text-cyan-200">提交 <strong className="font-semibold text-white">{group.submit_wait_min_seconds == null || group.submit_wait_max_seconds == null ? '—' : `${group.submit_wait_min_seconds}–${group.submit_wait_max_seconds} 秒`}</strong></span>
                        <span className="min-w-0 truncate text-emerald-200">佣金 <strong className="font-semibold text-white">{group.commission_rate == null ? '—' : `${Number((group.commission_rate * 100).toFixed(6))}%`}</strong></span>
                        <span className="min-w-0 text-emerald-200">搶單 <strong className="font-semibold text-white">{`${group.grab_success_rate}%`}</strong></span>
                        <span className="min-w-0 text-teal-200">提交後 <strong className="font-semibold text-white">{group.dispatch_success_rate == null ? '—' : `${group.dispatch_success_rate}%`}</strong></span>
                        <span className="col-span-2 grid grid-cols-[minmax(0,1.35fr)_minmax(0,0.85fr)] gap-x-2">
                          <span className="min-w-0 break-words text-amber-200" title={`提款要求：${group.withdrawal_amount_threshold ?? '—'} ${currencyUnit}`}>
                            提款要求 <strong className="font-semibold text-white">{group.withdrawal_amount_threshold == null ? '—' : `${group.withdrawal_amount_threshold.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currencyUnit}`}</strong>
                          </span>
                          <span className="min-w-0 break-words text-amber-200">訂單要求 <strong className="font-semibold text-white">{group.withdrawal_orders_threshold ?? '—'}</strong></span>
                        </span>
                        <span className="col-span-2 text-amber-200">提款條件 <strong className="font-semibold text-white">{withdrawalModeLabels[group.withdrawal_condition_mode] ?? '—'}</strong></span>
                      </span>
                    </button>
                    <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-white/15 pt-2">
                      <button type="button" className="inline-flex min-w-0 items-center justify-center gap-1 rounded-md border border-cyan-400/45 bg-cyan-500/20 px-1 py-1 text-[11px] font-medium text-cyan-50 hover:bg-cyan-500/30" onClick={() => openGroupSettings(group)}><Settings className="h-3 w-3 shrink-0" />分組設定</button>
                      <button type="button" className="inline-flex min-w-0 items-center justify-center gap-1 rounded-md border border-emerald-400/45 bg-emerald-500/20 px-1 py-1 text-[11px] font-medium text-emerald-50 hover:bg-emerald-500/30" onClick={() => { switchGroup(group.id); setMemberPanelOpen(true); }}><Users className="h-3 w-3 shrink-0" />成員管理</button>
                    </div>
                  </article>
                ))}
                {!groups.length && (
                  <div className="flex min-h-44 flex-col items-center justify-center gap-2 px-3 py-8 text-center">
                    <Layers className="h-8 w-8 text-blue-300/60" />
                    <p className="text-sm font-medium text-blue-100">
                      {workspaceLoading ? '正在載入分組…' : '尚未建立分組'}
                    </p>
                    {!workspaceLoading && <p className="text-xs text-slate-400">新增分組後即可在此管理訂單池。</p>}
                  </div>
                )}
              </div>
            </section>

            {groupSettingsOpen && selectedGroup && createPortal(
              <div className="fixed inset-0 z-[9990] flex flex-col items-center overflow-y-auto bg-slate-950/80 p-2 backdrop-blur-sm sm:p-4">
                <div role="dialog" aria-modal="true" aria-label="分組設定" className="my-auto w-full max-w-7xl shrink-0 overflow-hidden rounded-2xl border border-indigo-300/30 bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950 shadow-[0_32px_90px_rgba(2,6,23,0.65)]">
                  <div className="flex flex-wrap items-center gap-3 border-b border-indigo-300/20 bg-gradient-to-r from-indigo-900 via-blue-900 to-slate-900 px-4 py-3 sm:px-6">
                    <div className="flex min-w-[150px] flex-1 items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/30 bg-white/10 text-cyan-200"><Settings className="h-5 w-5" /></div>
                      <div className="min-w-0">
                        <h3 className="text-lg font-semibold text-white">分組設定</h3>
                        <p className="truncate text-xs text-blue-100/75">{groupDisplayName(selectedGroup)} · 調整派單與員工規則</p>
                      </div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
                      <button
                        type="button"
                        role="switch"
                        aria-label="啟用分組"
                        aria-checked={groupDraft.is_active}
                        disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                        onClick={() => setPendingGroupActive(!groupDraft.is_active)}
                        className={`inline-flex min-h-10 items-center gap-2.5 rounded-xl border px-3 py-1.5 text-sm font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-60 ${groupDraft.is_active ? 'border-emerald-300/60 bg-emerald-500/25 text-emerald-50 shadow-emerald-950/40 hover:bg-emerald-500/35' : 'border-rose-300/60 bg-rose-500/25 text-rose-50 shadow-rose-950/40 hover:bg-rose-500/35'}`}
                      >
                        <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${groupDraft.is_active ? 'bg-emerald-400' : 'bg-rose-500'}`} aria-hidden="true">
                          <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform ${groupDraft.is_active ? 'translate-x-5' : ''}`} />
                        </span>
                        <span>{groupDraft.is_active ? '已啟用' : '未啟用'}</span>
                        {groupDraft.is_active !== selectedGroup.is_active && <span className="text-xs text-white/80">· 待儲存</span>}
                      </button>
                      <button type="button" onClick={() => setGroupSettingsOpen(false)} disabled={busy} aria-label="關閉分組設定" className="shrink-0 rounded-lg border border-white/10 bg-white/10 p-2 text-blue-100 transition-colors hover:bg-white/20 disabled:opacity-50"><X className="h-5 w-5" /></button>
                    </div>
                  </div>
                  <div className="dispatch-group-settings-fields px-4 py-4 sm:px-6">
                    <div className="grid gap-5 lg:grid-cols-2 lg:gap-6">
                      <div className="min-w-0 space-y-4">
                        <section className="min-w-0 space-y-2">
                          <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-400/20 text-xs font-bold text-sky-200">01</span><h4 className="font-semibold text-sky-100">基本資料</h4></div>
                          <div className="space-y-2">
                    <label className="block text-sm font-medium text-slate-200">
                      分組名稱
                      <input
                        className={`${inputClass} mt-1 sm:ml-3 sm:max-w-40`}
                                value={groupDraft.group_name ?? ''}
                        disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                        onChange={(event) => setGroupDraft({ ...groupDraft, group_name: event.target.value })}
                      />
                    </label>
                    <label className="block text-sm font-medium text-slate-200">
                      說明
                      <textarea
                        className={`${inputClass} mt-1 min-h-14 resize-y`}
                        value={groupDraft.description ?? ''}
                        disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                        onChange={(event) => setGroupDraft({ ...groupDraft, description: event.target.value })}
                      />
                    </label>
                  </div>
                        </section>
                        <section className="min-w-0 space-y-2 border-t border-slate-700/70 pt-3">
                          <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-400/20 text-xs font-bold text-violet-200">02</span><h4 className="font-semibold text-violet-100">訂單池設定</h4></div>
                    <p className="text-sm font-medium text-violet-100">訂單池選擇模式</p>
                    <div role="group" aria-label="訂單池選擇模式" className="grid grid-cols-3 gap-2">
                      {poolSelectionOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={groupDraft.pool_selection_mode === option.value}
                          disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                          onClick={() => setGroupDraft({ ...groupDraft, pool_selection_mode: option.value })}
                          className={`min-w-0 rounded-xl border px-2 py-2.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50 ${groupDraft.pool_selection_mode === option.value ? option.activeClass : option.inactiveClass}`}
                        >
                          <span className="flex items-start justify-between gap-1 text-xs font-semibold sm:text-sm">
                            {option.label}
                            {groupDraft.pool_selection_mode === option.value && <CheckCircle className="h-4 w-4 shrink-0" />}
                          </span>
                          <span className="mt-1 hidden text-xs opacity-85 sm:block">{option.description}</span>
                        </button>
                      ))}
                    </div>
                    {groupDraft.pool_selection_mode === 'weighted' && (
                      <div className="space-y-3 border-t border-amber-400/25 pt-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h5 className="text-sm font-semibold text-amber-100">各訂單池觸發概率</h5>
                          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${probabilityDraftValid ? 'bg-emerald-500/20 text-emerald-200' : 'bg-rose-500/20 text-rose-200'}`}>
                            合計 {probabilityTotal}% / 100%
                          </span>
                        </div>
                        <p className="text-xs leading-relaxed text-amber-100/80">所有未封存訂單池合計須為 100%。停用、無可派訂單或 0% 的池不參與抽選，其餘可用池按比例重新分配。</p>
                        <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
                          {editableProbabilityPools.map((pool) => (
                            <label key={pool.id} className="min-w-0 text-sm font-medium text-slate-200">
                              <span className="mb-1 block truncate font-semibold" title={poolDisplayName(pool)}>
                                {poolDisplayName(pool)}{!pool.is_active ? '（已停用）' : ''}
                              </span>
                              <span className="flex items-center gap-2">
                                <input
                                  type="number"
                                  min="0"
                                  max="100"
                                  step="1"
                                  value={probabilityDraft[pool.id] ?? ''}
                                  disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                                  onChange={(event) => setProbabilityDraft((current) => ({ ...current, [pool.id]: event.target.value }))}
                                  className={inputClass}
                                  aria-label={`${poolDisplayName(pool)}觸發概率（%）`}
                                />
                                <span className="shrink-0 text-sm font-semibold text-amber-200">%</span>
                              </span>
                            </label>
                          ))}
                        </div>
                        {!editableProbabilityPools.length && <p className="text-xs text-amber-200">此分組目前沒有可設定的訂單池。</p>}
                        {probabilityDraftChanged && <p className="text-xs text-amber-200">調整後按「儲存分組設定」，即可一併儲存各池概率。</p>}
                      </div>
                    )}
                        </section>
                      </div>
                      <div className="min-w-0 space-y-4 lg:border-l lg:border-indigo-300/20 lg:pl-6">
                        <section className="min-w-0 space-y-2">
                          <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-400/20 text-xs font-bold text-cyan-200">03</span><h4 className="font-semibold text-cyan-100">工作與提交時間</h4></div>
                          <div className="grid min-w-0 gap-3 sm:grid-cols-2 sm:gap-5">
                            <div className="min-w-0">
                              <label className="block text-sm font-medium text-slate-200">
                                <span className="block leading-5">工作會話逾時（分鐘）</span>
                                <input type="number" min="1" max="60" className={`${inputClass} mt-1 block sm:max-w-40`}
                                  value={groupDraft.session_timeout_minutes ?? ''}
                                  disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                                  onChange={(event) => setGroupDraft({ ...groupDraft, session_timeout_minutes: event.target.value })} />
                              </label>
                              <p className="mt-1 text-xs leading-relaxed text-cyan-100">接單後尚未提交的期限；已派訂單保留原設定。</p>
                            </div>
                            <div className="min-w-0" role="group" aria-labelledby="dispatch-submit-wait-label">
                              <p id="dispatch-submit-wait-label" className="text-sm font-medium leading-5 text-slate-200">提交等待時間（秒）</p>
                              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
                                <label className="inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium text-slate-200">
                                  最短
                                  <input type="number" min="3" max="120" className={`${inputClass} !w-20 !px-2`}
                                    value={groupDraft.submit_wait_min_seconds ?? ''}
                                    disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                                    onChange={(event) => setGroupDraft({ ...groupDraft, submit_wait_min_seconds: event.target.value })} />
                                </label>
                                <label className="inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium text-slate-200">
                                  最長
                                  <input type="number" min="3" max="300" className={`${inputClass} !w-20 !px-2`}
                                    value={groupDraft.submit_wait_max_seconds ?? ''}
                                    disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                                    onChange={(event) => setGroupDraft({ ...groupDraft, submit_wait_max_seconds: event.target.value })} />
                                </label>
                              </div>
                              <p className="mt-1 text-xs leading-relaxed text-cyan-100">僅影響提交頁動畫，不延長接單或處理期限。</p>
                            </div>
                          </div>
                        </section>
                        <section className="min-w-0 space-y-2 border-t border-slate-700/70 pt-3">
                          <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-400/20 text-xs font-bold text-emerald-200">04</span><h4 className="font-semibold text-emerald-100">訂單收益與成功率</h4></div>
                          <div className="grid min-w-0 gap-y-3 sm:grid-cols-3 sm:gap-x-5">
                            <label className="min-w-0 text-sm font-medium text-slate-200">
                              <span className="block leading-5">佣金率</span>
                              <input type="number" min="0.00001" max="1" step="0.00000001" className={`${inputClass} mt-1 sm:max-w-40`}
                                value={groupDraft.commission_rate ?? ''}
                                disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                                onChange={(event) => setGroupDraft({ ...groupDraft, commission_rate: event.target.value })} />
                              <span className="mt-1 block text-xs font-normal leading-4 text-emerald-300 sm:max-w-40">小數比例：0.00008 = 0.008%；成功訂單計佣。</span>
                            </label>
                            <label className="min-w-0 text-sm font-medium text-slate-200">
                              <span className="block leading-5">搶單成功率（%）</span>
                              <input type="number" min="0" max="100" step="1" className={`${inputClass} mt-1 sm:max-w-40`}
                                value={groupDraft.grab_success_rate ?? ''}
                                disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                                onChange={(event) => setGroupDraft({ ...groupDraft, grab_success_rate: event.target.value })} />
                              <span className="mt-1 block text-xs font-normal leading-4 text-emerald-300 sm:max-w-40">僅影響接單；新派單保存機率。</span>
                            </label>
                            <label className="min-w-0 text-sm font-medium text-slate-200">
                              <span className="block leading-5">提交後訂單成功率（%）</span>
                              <input type="number" min="0" max="100" step="1" className={`${inputClass} mt-1 sm:max-w-40`}
                                value={groupDraft.dispatch_success_rate ?? ''}
                                disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                                onChange={(event) => setGroupDraft({ ...groupDraft, dispatch_success_rate: event.target.value })} />
                              <span className="mt-1 block text-xs font-normal leading-4 text-teal-300 sm:max-w-40">僅影響訂單結果；提交時保存機率。</span>
                            </label>
                          </div>
                        </section>
                        <section className="min-w-0 space-y-2 border-t border-slate-700/70 pt-3">
                    <div className="flex flex-wrap items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-400/20 text-xs font-bold text-amber-200">05</span><h4 className="font-semibold text-amber-100">提款資格</h4><span className="ml-auto rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-100">{selectedGroup.member_count} 位員工</span></div>
                    <p className="text-xs leading-relaxed text-slate-300">依目前所屬分組判斷；員工人數由分組成員自動統計。</p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="min-w-0 text-sm font-medium text-slate-200">
                        最低提款餘額
                        <input type="number" min="0" max="999999999999.99" step="0.01" className={`${inputClass} mt-1 sm:ml-3 sm:max-w-40`}
                                value={groupDraft.withdrawal_amount_threshold ?? ''}
                          disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                          onChange={(event) => setGroupDraft({ ...groupDraft, withdrawal_amount_threshold: event.target.value })} />
                        <span className="mt-1 block text-xs font-normal leading-relaxed text-amber-200/90">按員工目前餘額是否達到此金額判斷。</span>
                      </label>
                      <label className="min-w-0 text-sm font-medium text-slate-200">
                        最低訂單數
                        <input type="number" min="1" max="1000000" step="1" className={`${inputClass} mt-1 sm:ml-3 sm:max-w-40`}
                                value={groupDraft.withdrawal_orders_threshold ?? ''}
                          disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                          onChange={(event) => setGroupDraft({ ...groupDraft, withdrawal_orders_threshold: event.target.value })} />
                        <span className="mt-1 block text-xs font-normal leading-relaxed text-amber-200/90">按所有狀態的訂單筆數計算。</span>
                      </label>
                    </div>
                    <WithdrawalConditionPicker
                      id="edit-withdrawal-condition"
                      value={groupDraft.withdrawal_condition_mode}
                      disabled={!isSuperAdmin || !!selectedGroup.archived_at || busy}
                      onChange={(mode) => setGroupDraft((current) => ({ ...current, withdrawal_condition_mode: mode }))}
                    />
                        </section>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-indigo-300/20 bg-slate-950/50 px-4 py-2.5 sm:px-6">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span
                      className={`rounded-full px-2 py-1 ${selectedGroup.archived_at ? 'bg-rose-500/20 text-rose-300' : selectedGroup.is_active ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-200'}`}
                    >
                      {!selectedGroup.is_active && !selectedGroup.archived_at && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-rose-400 align-middle" />}
                      {selectedGroup.archived_at
                        ? '已封存'
                        : selectedGroup.is_active
                          ? '目前已啟用'
                          : '目前未啟用'}
                    </span>
                    {isSuperAdmin &&
                      (selectedGroup.archived_at ? (
                        <button
                          className={secondaryButton}
                          disabled={busy}
                          onClick={() =>
                            void changeArchive('group', selectedGroup.id, false)
                          }
                        >
                          還原分組
                        </button>
                      ) : (
                        !selectedGroup.is_default && (
                          <button
                            className="text-rose-400 hover:text-rose-300 disabled:opacity-50"
                            disabled={busy}
                            onClick={() =>
                              setArchiveTarget({
                                type: 'group',
                                id: selectedGroup.id,
                                name: groupDisplayName(selectedGroup),
                              })
                            }
                          >
                            封存分組
                          </button>
                        )
                      ))}
                    </div>
                    {isSuperAdmin && (
                      <button
                        className={`inline-flex min-h-10 items-center justify-center rounded-xl px-5 py-2 text-sm font-semibold text-white shadow-lg transition-colors disabled:cursor-not-allowed ${!busy && groupSaveStatus?.type === 'success' ? 'bg-emerald-600 shadow-emerald-950/30' : !busy && groupSaveStatus?.type === 'error' ? 'bg-rose-600 shadow-rose-950/30' : 'bg-blue-600 shadow-blue-900/30 hover:bg-blue-500 disabled:opacity-50'}`}
                        disabled={busy || !!selectedGroup.archived_at || !groupSettingsChanged}
                        onClick={() => void saveGroup('edit')}
                      >
                        {busy ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : groupSaveStatus?.type === 'success' ? <CheckCircle className="mr-2 h-4 w-4" /> : groupSaveStatus?.type === 'error' ? <XCircle className="mr-2 h-4 w-4" /> : <Save className="mr-2 h-4 w-4" />}
                        <span aria-live="polite">{busy ? '儲存中…' : groupSaveStatus?.type === 'success' ? '儲存成功' : groupSaveStatus?.type === 'error' ? '儲存失敗' : '儲存分組設定'}</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>, document.body,
            )}

            {pendingGroupActive !== null && ((groupSettingsOpen && selectedGroup) || groupForm) && createPortal(
              <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm">
                <div role="dialog" aria-modal="true" aria-labelledby="group-active-confirm-title" aria-describedby="group-active-confirm-note" className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-600/70 bg-slate-900 text-slate-100 shadow-[0_28px_80px_rgba(2,6,23,0.7)]">
                  <div className={`h-1 ${pendingGroupActive ? 'bg-gradient-to-r from-emerald-400 to-teal-500' : 'bg-gradient-to-r from-rose-400 to-orange-500'}`} />
                  <div className="p-5 sm:p-6">
                    <div className="flex items-start gap-3">
                      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${pendingGroupActive ? 'border-emerald-400/40 bg-emerald-400/15 text-emerald-300' : 'border-rose-400/40 bg-rose-400/15 text-rose-300'}`}>
                        {pendingGroupActive ? <CheckCircle className="h-6 w-6" /> : <XCircle className="h-6 w-6" />}
                      </div>
                      <div className="min-w-0">
                        <h3 id="group-active-confirm-title" className="text-lg font-semibold text-white">確認{pendingGroupActive ? '啟用' : '停用'}分組</h3>
                        <p className="mt-1 break-words text-sm text-slate-300">{groupForm ? '新分組' : selectedGroup ? groupDisplayName(selectedGroup) : ''}</p>
                      </div>
                    </div>
                    <div className="mt-5 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-3 sm:px-4">
                      <div className="min-w-0">
                        <p className="text-xs text-slate-400">目前選擇</p>
                        <p className="mt-1 text-sm font-semibold text-slate-100">{groupDraft.is_active ? '已啟用' : '未啟用'}</p>
                      </div>
                      <span aria-hidden="true" className="text-lg text-slate-400">→</span>
                      <div className="min-w-0 text-right">
                        <p className="text-xs text-slate-400">確認後</p>
                        <p className={`mt-1 text-sm font-semibold ${pendingGroupActive ? 'text-emerald-300' : 'text-rose-300'}`}>{pendingGroupActive ? '已啟用' : '未啟用'}</p>
                      </div>
                    </div>
                    <p id="group-active-confirm-note" className="mt-4 border-l-2 border-blue-400 pl-3 text-sm leading-relaxed text-blue-100">確認後只會更新此表單，按「{groupForm ? '儲存分組' : '儲存分組設定'}」才正式生效。</p>
                    <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                      <button type="button" className="min-h-10 rounded-lg border border-slate-600 bg-slate-800 px-5 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300" onClick={() => setPendingGroupActive(null)}>取消</button>
                      <button
                        type="button"
                        className={`min-h-10 rounded-lg px-5 py-2 text-sm font-semibold text-white shadow-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${pendingGroupActive ? 'bg-emerald-600 shadow-emerald-950/40 hover:bg-emerald-500' : 'bg-rose-600 shadow-rose-950/40 hover:bg-rose-500'}`}
                        onClick={() => {
                          setGroupDraft((current) => ({ ...current, is_active: pendingGroupActive }));
                          setPendingGroupActive(null);
                        }}
                      >
                        確認{pendingGroupActive ? '啟用' : '停用'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>, document.body,
            )}

          {selectedGroup && (
            <>
              {memberPanelOpen && createPortal(
                <div className="fixed inset-0 z-[9990] flex items-center justify-center bg-slate-950/85 p-2 backdrop-blur-sm sm:p-4">
                  <div role="dialog" aria-modal="true" aria-labelledby="dispatch-members-title" className="flex h-[min(820px,calc(100dvh-16px))] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-emerald-300/30 bg-slate-900 text-slate-100 shadow-[0_32px_90px_rgba(2,6,23,0.75)] sm:h-[min(820px,calc(100dvh-32px))]">
                    <div className="h-1 shrink-0 bg-gradient-to-r from-emerald-400 via-teal-400 to-cyan-400" />
                    <header className="shrink-0 border-b border-emerald-300/20 bg-gradient-to-r from-emerald-950 via-teal-950 to-slate-900 px-4 py-4 sm:px-6 sm:py-5">
                      <div className="flex items-start gap-3">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-300/30 bg-emerald-400/15 text-emerald-200 shadow-[0_0_24px_rgba(52,211,153,0.12)]">
                          <Users className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-semibold tracking-[0.16em] text-emerald-300">ORDER GROUP / MEMBERS</p>
                          <h3 id="dispatch-members-title" className="mt-1 break-words text-lg font-semibold leading-snug text-white sm:text-xl">{groupDisplayName(selectedGroup)} <span className="text-emerald-300">· 分組成員</span></h3>
                          <p className="mt-1 text-xs leading-relaxed text-emerald-50/70">選取員工後，可將其移入此分組或移回已啟用的預設分組。</p>
                          {memberMoveProgress && <p role="status" className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-cyan-200"><RefreshCw className="h-3 w-3 animate-spin" />正在確認分組變更 {memberMoveProgress.completed}/{memberMoveProgress.total}，未成功的員工會回到原分組。</p>}
                        </div>
                        <button type="button" onClick={() => setMemberPanelOpen(false)} disabled={busy} aria-label="關閉成員管理" className="shrink-0 rounded-xl border border-white/10 bg-white/5 p-2 text-slate-200 transition-colors hover:border-white/25 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:opacity-50"><X className="h-5 w-5" /></button>
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <div className="relative min-w-[180px] flex-1">
                          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-emerald-700" />
                          <input
                            ref={employeeSearchRef}
                            className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-10 pr-10 text-sm font-medium text-slate-900 shadow-sm placeholder-slate-500 outline-none transition-colors focus:border-emerald-400 focus:bg-white focus:ring-2 focus:ring-emerald-400/35"
                            placeholder="搜尋員工名稱或員工 ID"
                            aria-label="搜尋員工名稱或員工 ID"
                            value={employeeSearch}
                            onChange={(event) => setEmployeeSearch(event.target.value)}
                          />
                          {employeeSearch && (
                            <button
                              type="button"
                              aria-label="清除員工搜尋"
                              title="清除搜尋"
                              className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md bg-slate-200 text-slate-600 transition-colors hover:bg-emerald-100 hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                              onClick={() => {
                                setEmployeeSearch('');
                                employeeSearchRef.current?.focus();
                              }}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                        <MemberFilterPicker
                          id="member-group-filter"
                          label="切換分組"
                          caption="分組"
                          value={selectedGroup.id}
                          options={groups.map((group) => ({ value: group.id, label: groupDisplayName(group) }))}
                          tone="emerald"
                          onChange={(groupId) => {
                            switchGroup(groupId);
                            setMemberPanelOpen(true);
                          }}
                        />
                        {isSuperAdmin && (
                          <MemberFilterPicker
                            id="member-admin-filter"
                            label="篩選管理員"
                            caption="管理員"
                            value={employeeAdminFilter}
                            options={[{ value: 'all', label: '所有管理員' }, ...adminNames.map((owner) => ({ value: owner.id, label: owner.username }))]}
                            tone="blue"
                            onChange={(adminId) => {
                              setEmployeeAdminFilter(adminId);
                              setSelectedCurrentMembers([]);
                              setSelectedOtherMembers([]);
                            }}
                          />
                        )}
                        {tags.length > 0 && (
                          <MemberFilterPicker
                            id="member-tag-filter"
                            label="篩選標籤"
                            caption="標籤"
                            value={employeeTagFilter}
                            options={[{ value: 'all', label: '所有標籤' }, ...tags.map((tag) => ({ value: tag, label: tag }))]}
                            tone="violet"
                            onChange={(tag) => {
                              setEmployeeTagFilter(tag);
                              setSelectedCurrentMembers([]);
                              setSelectedOtherMembers([]);
                            }}
                          />
                        )}
                        <span className="shrink-0 text-xs font-medium text-emerald-100/75">共 {visibleEmployees.length} 人</span>
                      </div>
                    </header>
                    <div className="dispatch-members-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain bg-slate-900 md:overflow-hidden">
                      <div className="grid min-h-full min-w-0 grid-cols-1 md:h-full md:min-h-0 md:grid-cols-2">
                        <section className="flex min-w-0 flex-col md:min-h-0">
                          <div className="flex shrink-0 items-center gap-3 border-b-2 border-emerald-400/70 bg-gradient-to-r from-emerald-900 via-teal-900 to-emerald-950 px-4 py-3 shadow-[0_5px_14px_rgba(2,44,34,0.35)] sm:px-5">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-300/30 bg-emerald-300/15 text-emerald-200"><Users className="h-5 w-5" /></span>
                            <div className="min-w-0 flex-1">
                              <h4 className="text-sm font-semibold text-white">目前分組</h4>
                              <p className="text-xs text-emerald-100/80">已指派至此分組的員工</p>
                            </div>
                            <span className="rounded-full border border-emerald-300/40 bg-emerald-300/20 px-2.5 py-1 text-xs font-semibold text-emerald-50">{currentMembers.length} 人</span>
                          </div>
                          <div className="dispatch-members-scroll min-h-32 max-h-72 flex-1 overflow-y-auto overscroll-contain bg-slate-950/30 md:min-h-0 md:max-h-none">
                            <div className="divide-y divide-slate-700/60">
                              {currentMembers.map((employee, index) => (
                                <label key={employee.id} className={`flex min-w-0 cursor-pointer items-start gap-2 px-4 py-2 transition-colors focus-within:ring-2 focus-within:ring-inset focus-within:ring-emerald-300/70 sm:px-5 ${selectedCurrentMembers.includes(employee.id) ? 'bg-emerald-400/15' : 'hover:bg-slate-800/70'}`}>
                                  <span aria-hidden="true" className={`mt-0.5 flex h-6 min-w-7 shrink-0 items-center justify-center rounded-md border px-1 text-[11px] font-semibold tabular-nums ${selectedCurrentMembers.includes(employee.id) ? 'border-emerald-400/60 bg-emerald-400/20 text-emerald-100' : 'border-slate-600 bg-slate-800 text-slate-300'}`}>{index + 1}</span>
                                  <input
                                    type="checkbox"
                                    className="mt-1 h-4 w-4 shrink-0 accent-emerald-400"
                                    checked={selectedCurrentMembers.includes(employee.id)}
                                    onChange={() => setSelectedCurrentMembers((current) => current.includes(employee.id) ? current.filter((id) => id !== employee.id) : [...current, employee.id])}
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                      <span className="break-words text-sm font-semibold text-white">{employee.username}</span>
                                      <span className="break-all text-xs text-emerald-200/80">員工 ID：{employee.employee_id}</span>
                                    </span>
                                    {employee.remarks && <span className="mt-0.5 block break-words text-xs text-slate-400">備註：{employee.remarks}</span>}
                                  </span>
                                  <span aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0">
                                    {selectedCurrentMembers.includes(employee.id) && <CheckCircle className="h-5 w-5 fill-emerald-400 text-emerald-950" />}
                                  </span>
                                </label>
                              ))}
                              {!currentMembers.length && <p className="px-4 py-10 text-center text-sm text-slate-400">沒有符合條件的成員</p>}
                            </div>
                          </div>
                          <div className={`shrink-0 border-t px-4 py-3 sm:px-5 ${selectedGroup.is_default ? 'border-emerald-400/60 bg-gradient-to-r from-emerald-950 via-teal-950 to-slate-900' : 'border-emerald-400/20 bg-slate-900'}`}>
                            {!selectedGroup.is_default ? (
                              <button
                                type="button"
                                className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-100 transition-colors hover:bg-emerald-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-45"
                                disabled={!selectedCurrentMembers.length || !defaultGroup || busy}
                                title={!defaultGroup ? '沒有可用的已啟用預設分組' : undefined}
                                onClick={() => defaultGroup && setMemberMove({ ids: selectedCurrentMembers, targetGroupId: defaultGroup.id, destination: groupDisplayName(defaultGroup) })}
                              >
                                移至預設分組（{selectedCurrentMembers.length}）<span aria-hidden="true">→</span>
                              </button>
                            ) : (
                              <div role="status" className="flex min-h-10 items-center gap-3 border-l-[3px] border-emerald-400 pl-3">
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-300/40 bg-emerald-400/20 text-emerald-200">
                                  <CheckCircle className="h-4 w-4" />
                                </span>
                                <div className="min-w-0">
                                  <p className="text-sm font-semibold text-emerald-50">已是預設分組</p>
                                  <p className="text-xs text-emerald-100/75">此處成員無需再移回預設分組</p>
                                </div>
                              </div>
                            )}
                            {!defaultGroup && !selectedGroup.is_default && <p className="mt-2 text-xs text-amber-200">若要移出成員，預設分組必須處於啟用狀態。</p>}
                          </div>
                        </section>
                        <section className="flex min-w-0 flex-col border-t border-cyan-400/30 md:min-h-0 md:border-l md:border-t-0">
                          <div className="flex shrink-0 items-center gap-3 border-b-2 border-sky-400/70 bg-gradient-to-r from-sky-900 via-blue-900 to-slate-900 px-4 py-3 shadow-[0_5px_14px_rgba(8,47,73,0.4)] sm:px-5">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-sky-300/30 bg-sky-300/15 text-sky-200"><Users className="h-5 w-5" /></span>
                            <div className="min-w-0 flex-1">
                              <h4 className="text-sm font-semibold text-white">其他分組／未指派</h4>
                              <p className="text-xs text-sky-100/80">選取後移入目前分組</p>
                            </div>
                            <span className="rounded-full border border-sky-300/40 bg-sky-300/20 px-2.5 py-1 text-xs font-semibold text-sky-50">{otherMembers.length} 人</span>
                          </div>
                          <div className="dispatch-members-scroll min-h-32 max-h-72 flex-1 overflow-y-auto overscroll-contain bg-slate-950/30 md:min-h-0 md:max-h-none">
                            <div className="divide-y divide-slate-700/60">
                              {otherMembers.map((employee, index) => (
                                <label key={employee.id} className={`flex min-w-0 cursor-pointer items-start gap-2 px-4 py-2 transition-colors focus-within:ring-2 focus-within:ring-inset focus-within:ring-cyan-300/70 sm:px-5 ${selectedOtherMembers.includes(employee.id) ? 'bg-cyan-400/15' : 'hover:bg-slate-800/70'}`}>
                                  <span aria-hidden="true" className={`mt-0.5 flex h-6 min-w-7 shrink-0 items-center justify-center rounded-md border px-1 text-[11px] font-semibold tabular-nums ${selectedOtherMembers.includes(employee.id) ? 'border-cyan-400/60 bg-cyan-400/20 text-cyan-100' : 'border-slate-600 bg-slate-800 text-slate-300'}`}>{index + 1}</span>
                                  <input
                                    type="checkbox"
                                    className="mt-1 h-4 w-4 shrink-0 accent-cyan-400"
                                    checked={selectedOtherMembers.includes(employee.id)}
                                    onChange={() => setSelectedOtherMembers((current) => current.includes(employee.id) ? current.filter((id) => id !== employee.id) : [...current, employee.id])}
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                      <span className="break-words text-sm font-semibold text-white">{employee.username}</span>
                                      <span className="break-all text-xs text-cyan-200/80">員工 ID：{employee.employee_id}</span>
                                    </span>
                                    <span className="mt-0.5 block break-words text-xs text-cyan-200/80">所屬分組：{displayGroupById(employee.group_id)}</span>
                                    {employee.remarks && <span className="mt-0.5 block break-words text-xs text-slate-400">備註：{employee.remarks}</span>}
                                  </span>
                                  <span aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0">
                                    {selectedOtherMembers.includes(employee.id) && <CheckCircle className="h-5 w-5 fill-cyan-400 text-cyan-950" />}
                                  </span>
                                </label>
                              ))}
                              {!otherMembers.length && <p className="px-4 py-10 text-center text-sm text-slate-400">沒有符合條件的員工</p>}
                            </div>
                          </div>
                          <div className="shrink-0 border-t border-cyan-400/20 bg-slate-900 px-4 py-3 sm:px-5">
                            <button
                              type="button"
                              className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-950/30 transition-colors hover:from-cyan-500 hover:to-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-45"
                              disabled={!selectedOtherMembers.length || !selectedGroup.is_active || !!selectedGroup.archived_at || busy}
                              onClick={() => setMemberMove({ ids: selectedOtherMembers, targetGroupId: selectedGroup.id, destination: groupDisplayName(selectedGroup) })}
                            >
                              移至此分組（{selectedOtherMembers.length}）<span aria-hidden="true">→</span>
                            </button>
                          </div>
                        </section>
                      </div>
                    </div>
                  </div>
                </div>, document.body,
              )}

              <section className="min-h-[320px] min-w-0 bg-gradient-to-br from-cyan-950/25 via-slate-900/10 to-slate-950/15 px-3 py-4 sm:px-4 lg:px-6">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-cyan-300">{groupDisplayName(selectedGroup)}</p>
                    <h3 className="mt-1 flex items-center gap-2 text-lg font-semibold text-white">
                      <Layers className="h-5 w-5 text-cyan-300" />
                      訂單池 <span className="rounded-full bg-cyan-400/15 px-2 py-0.5 text-xs font-medium text-cyan-200">{groupPools.length} 個</span>
                    </h3>
                    <p className="mt-1 text-xs text-slate-400">
                      各池觸發概率請至「分組設定」選擇「按訂單池設定概率」後調整；派單間隔與池內選單模式仍由各池管理。
                    </p>
                  </div>
                  {isSuperAdmin && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={primaryButton}
                        disabled={busy || !!selectedGroup.archived_at}
                        onClick={() => {
                          setPoolDraft({ ...emptyPoolDraft });
                          setPoolForm('create');
                        }}
                      >
                        <Plus className="mr-1 inline h-4 w-4" />
                        新增訂單池
                      </button>
                    </div>
                  )}
                </div>
                <div className="min-w-0 overflow-hidden rounded-xl border border-cyan-300/20 bg-slate-950/45 shadow-[0_16px_40px_rgba(2,6,23,0.2)]">
                  <div className="hidden border-b border-cyan-300/20 bg-gradient-to-r from-blue-900/70 via-cyan-900/45 to-slate-900/80 px-4 py-2.5 text-[11px] font-semibold tracking-wide text-cyan-100/80 xl:grid xl:grid-cols-[minmax(170px,1fr)_minmax(265px,1.15fr)_minmax(320px,auto)] xl:gap-5">
                    <span>訂單池 / 訂單數</span>
                    <span>派單設定</span>
                    <span className="text-right">操作</span>
                  </div>
                  <div className="divide-y divide-cyan-300/15">
                    {groupPools.map((pool, index) => (
                      <div
                        key={pool.id}
                        className={`relative min-w-0 transition-colors ${pool.archived_at ? 'bg-gradient-to-r from-rose-950/30 via-slate-900/50 to-slate-950/40' : pool.is_base ? 'bg-gradient-to-r from-amber-950/35 via-blue-950/30 to-cyan-950/20 hover:from-amber-900/40 hover:via-blue-900/35' : 'bg-gradient-to-r from-blue-950/35 via-slate-900/35 to-cyan-950/15 hover:from-blue-900/40 hover:via-cyan-900/25'}`}
                      >
                        <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 bg-gradient-to-b ${pool.archived_at ? 'from-rose-400 via-rose-600 to-transparent' : pool.is_base ? 'from-amber-300 via-amber-500 to-transparent' : 'from-cyan-300 via-blue-500 to-transparent'}`} />
                        <div className="grid min-w-0 items-center gap-x-5 gap-y-3 px-3 py-3 pl-4 sm:px-4 sm:pl-5 xl:grid-cols-[minmax(170px,1fr)_minmax(265px,1.15fr)_minmax(320px,auto)]">
                          <div className="flex min-w-0 items-start gap-3">
                            <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-[11px] font-semibold tabular-nums ${pool.is_base ? 'border-amber-300/35 bg-amber-400/15 text-amber-100' : 'border-cyan-300/25 bg-cyan-400/10 text-cyan-100'}`}>{String(index + 1).padStart(2, '0')}</span>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <h4 className="min-w-0 break-words text-sm font-semibold text-white">{poolDisplayName(pool)}</h4>
                                {pool.is_base && <span className="rounded-md border border-amber-400/30 bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-100">基本池</span>}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                                <span className="font-medium tabular-nums text-slate-300">{pool.order_count} 筆訂單</span>
                                <span aria-hidden="true" className="text-slate-600">·</span>
                                <span className={`inline-flex items-center gap-1.5 font-medium ${pool.archived_at ? 'text-rose-300' : pool.is_active ? 'text-emerald-300' : 'text-amber-300'}`}>
                                  <span className={`h-1.5 w-1.5 rounded-full ${pool.archived_at ? 'bg-rose-400' : pool.is_active ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                                  {pool.archived_at ? '已封存' : pool.is_active ? '已啟用' : '已停用'}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="grid min-w-0 grid-cols-3 gap-2 text-xs sm:gap-3">
                            <div className="min-w-0"><span className="block whitespace-nowrap text-[11px] text-cyan-200/70">派單間隔</span><strong className="mt-0.5 block whitespace-nowrap text-xs font-semibold tabular-nums text-slate-100 sm:text-sm">{pool.dispatch_interval_min}–{pool.dispatch_interval_max} 秒</strong></div>
                            <div className="min-w-0 border-l border-cyan-300/15 pl-2 sm:pl-3"><span className="block whitespace-nowrap text-[11px] text-cyan-200/70">池內選單</span><strong className="mt-0.5 block whitespace-nowrap text-xs font-semibold text-slate-100 sm:text-sm">{pool.dispatch_order_mode === 'random' ? '隨機選單' : '依序選單'}</strong></div>
                            <div className="min-w-0 border-l border-amber-300/15 pl-2 sm:pl-3"><span className="block whitespace-nowrap text-[11px] text-amber-200/80">觸發概率</span><strong className="mt-0.5 block text-xs font-semibold tabular-nums text-amber-100 sm:text-sm">{pool.trigger_probability}%</strong></div>
                          </div>
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5 xl:justify-end">
                            <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:from-cyan-500 hover:to-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300" onClick={() => openOrders(pool.id)}><PackageSearch className="h-3.5 w-3.5" />查看訂單</button>
                            {isSuperAdmin && !selectedGroup.archived_at && (
                              !pool.archived_at ? (
                                <>
                                  <button
                                    type="button"
                                    className="inline-flex items-center gap-1 rounded-lg border border-blue-400/30 bg-blue-500/10 px-2.5 py-1.5 text-xs font-medium text-blue-100 transition-colors hover:bg-blue-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:opacity-50"
                                    disabled={busy}
                                    onClick={() => {
                                      setSelectedPoolId(pool.id);
                                      setPoolDraft(poolToDraft(pool));
                                      setPoolForm('edit');
                                    }}
                                  >
                                    <Edit2 className="h-3.5 w-3.5" />編輯設定
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50"
                                    disabled={busy}
                                    onClick={() => pool.is_active ? setPoolToggleTarget(pool) : void togglePool(pool)}
                                  >
                                    {pool.is_active ? '停用' : '啟用'}
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="rounded-lg border border-blue-400/30 bg-blue-500/10 px-2.5 py-1.5 text-xs font-medium text-blue-100 transition-colors hover:bg-blue-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:opacity-50"
                                  disabled={busy}
                                  onClick={() => void changeArchive('pool', pool.id, false)}
                                >
                                  還原
                                </button>
                              )
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {!groupPools.length && (
                    <div className="flex min-h-64 flex-col items-center justify-center gap-3 px-4 py-12 text-center">
                      <Layers className="h-10 w-10 text-cyan-300/60" />
                      <p className="text-base font-semibold text-cyan-100">此分組尚無訂單池</p>
                      <p className="max-w-sm text-sm text-slate-400">訂單池建立後會在這裡顯示設定與訂單入口。</p>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
          {!selectedGroup && (
            <section className="flex min-h-[320px] min-w-0 flex-col items-center justify-center gap-3 bg-gradient-to-br from-cyan-950/25 via-slate-900/10 to-slate-950/15 px-6 py-12 text-center">
              <Layers className="h-10 w-10 text-cyan-300/60" />
              <h3 className="text-base font-semibold text-cyan-100">{workspaceLoading ? '正在載入訂單池…' : '請選擇分組'}</h3>
              <p className="max-w-sm text-sm text-slate-400">{workspaceLoading ? '正在讀取分組及訂單池資料。' : groups.length ? '選擇左側分組，即可檢視所屬訂單池。' : '建立分組後，訂單池會顯示於此。'}</p>
            </section>
          )}
        </>

        {ordersOpen && selectedPool && createPortal(
          <div className="fixed inset-0 z-[9990] flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm">
            <aside
              role="dialog"
              aria-modal="true"
              aria-labelledby="pool-orders-title"
              className="flex h-[min(900px,calc(100dvh-24px))] min-h-0 w-full max-w-[1360px] flex-col overflow-hidden rounded-2xl border border-cyan-300/30 bg-slate-900 text-slate-100 shadow-[0_32px_90px_rgba(2,6,23,0.7)]"
            >
          <div className="h-1 shrink-0 bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-500" />
          <div className="relative shrink-0 border-b border-cyan-300/15 bg-gradient-to-r from-blue-950 via-slate-900 to-cyan-950 py-4 pl-4 pr-14 sm:pl-6 sm:pr-16 xl:pr-6">
            <div className="flex flex-wrap items-center gap-3 xl:flex-nowrap">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-300/30 bg-cyan-400/10 text-cyan-200">{showBulkImport ? <Upload className="h-5 w-5" /> : <PackageSearch className="h-5 w-5" />}</span>
              <div className="min-w-[180px] flex-1">
                <p className="text-[11px] font-semibold tracking-widest text-cyan-300">{selectedGroup ? groupDisplayName(selectedGroup) : '訂單分組'} · 訂單池</p>
                <h3 id="pool-orders-title" className="mt-1 break-words text-xl font-semibold text-white">{showBulkImport ? '匯入訂單' : <>{poolDisplayName(selectedPool)} <span className="text-slate-300">/ 訂單管理</span></>}</h3>
                <p className="mt-1 text-xs text-slate-300">{showBulkImport ? '選擇匯入目標訂單池並貼上訂單內容。' : '檢視及管理此池的訂單內容與狀態。'}</p>
              </div>
              {!showBulkImport && <span className={`hidden shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold sm:block ${selectedPool.archived_at ? 'border-rose-400/30 bg-rose-400/10 text-rose-200' : selectedPool.is_active ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-amber-400/30 bg-amber-400/10 text-amber-200'}`}>{selectedPool.archived_at ? '已封存' : selectedPool.is_active ? '已啟用' : '已停用'}</span>}
              {showBulkImport ? (
                <button type="button" onClick={() => setShowBulkImport(false)} disabled={busy}
                  className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-400/10 px-3 text-xs font-semibold text-cyan-100 transition-colors hover:bg-cyan-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50 xl:ml-auto"><ArrowLeft className="h-4 w-4" />返回訂單列表</button>
              ) : <div className="flex flex-wrap items-center gap-2 xl:ml-auto xl:flex-nowrap">
                <span className="whitespace-nowrap rounded-lg border border-cyan-300/25 bg-cyan-400/10 px-3 py-2 text-xs font-semibold tabular-nums text-cyan-100">
                  {ordersLoading ? '正在載入訂單…' : totalCount ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, totalCount)} / 共 ${totalCount} 筆` : '目前沒有訂單'} · 第 {pendingPage ?? page} / {totalPages} 頁
                </span>
                <div role="group" className="flex items-center gap-1.5" aria-label="訂單分頁">
                  <button type="button" disabled={page <= 1 || ordersLoading} onClick={() => void loadOrders(selectedPool.id, page - 1, orderFilter, true)}
                    className="min-h-9 rounded-lg border border-cyan-300/30 bg-cyan-400/10 px-3 text-xs font-semibold text-cyan-100 transition-colors hover:bg-cyan-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">上一頁</button>
                  <button type="button" disabled={page >= totalPages || ordersLoading} onClick={() => void loadOrders(selectedPool.id, page + 1, orderFilter, true)}
                    className="min-h-9 rounded-lg border border-cyan-300/30 bg-cyan-400/10 px-3 text-xs font-semibold text-cyan-100 transition-colors hover:bg-cyan-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">下一頁</button>
                </div>
                <form className="flex items-center gap-1.5 rounded-lg border border-blue-300/25 bg-blue-400/10 p-1" onSubmit={(event) => {
                  event.preventDefault();
                  const targetPage = Number(pageInput);
                  if (!Number.isInteger(targetPage) || targetPage < 1 || targetPage > totalPages) {
                    notify('error', `請輸入 1 至 ${totalPages} 之間的頁碼。`);
                    return;
                  }
                  setPageInput('');
                  void loadOrders(selectedPool.id, targetPage, orderFilter, true);
                }}>
                  <label htmlFor="order-page" className="shrink-0 pl-2 text-xs font-semibold text-blue-100">跳至頁碼</label>
                  <input id="order-page" type="number" min={1} max={totalPages} value={pageInput} onChange={(event) => setPageInput(event.target.value)}
                    className="h-9 w-16 rounded-md border border-blue-300/40 bg-slate-50 px-2 text-center text-sm font-semibold tabular-nums text-slate-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-300/50" />
                  <button type="submit" disabled={ordersLoading || !pageInput || totalPages <= 1}
                    className="h-9 rounded-md bg-blue-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-40">跳轉</button>
                </form>
              </div>}
              <button type="button" onClick={() => { setOrdersOpen(false); setShowBulkImport(false); setEditingId(null); }} disabled={busy} aria-label={showBulkImport ? '關閉匯入訂單' : '關閉訂單管理'} className="absolute right-4 top-4 rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50 sm:right-6 xl:static xl:ml-4 xl:self-center"><X className="h-4 w-4" /></button>
            </div>
          </div>
          {showBulkImport && isSuperAdmin ? (
            <>
              <div className="min-h-0 flex-1 overflow-hidden bg-gradient-to-br from-blue-950/45 via-slate-900 to-slate-950 p-2 sm:p-3">
                <div className="grid h-full min-h-0 grid-rows-[minmax(0,55%)_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(205px,240px)_minmax(0,1fr)] lg:grid-rows-1 lg:gap-3">
                  <div className="dispatch-orders-scroll min-h-0 min-w-0 overflow-y-auto border-b border-cyan-300/20 px-2 pb-3 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-3">
                    <p className="text-xs font-semibold tracking-widest text-cyan-300">批量匯入</p>
                    <h4 className="mt-2 text-lg font-semibold text-white">新增訂單至訂單池</h4>
                    <p className="mt-2 text-sm leading-relaxed text-slate-300">每筆訂單以空白行分隔；超過 250 筆時會自動分批送出。</p>
                    <div className="mt-5 border-t border-cyan-300/15 pt-5">
                      <p className="text-sm font-semibold text-cyan-100">匯入目標訂單池</p>
                      <div className="mt-3 min-w-0 rounded-xl border border-cyan-300/55 bg-gradient-to-br from-cyan-900/85 via-blue-950/85 to-slate-950 px-4 py-4 shadow-lg shadow-cyan-950/30">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-cyan-300/35 bg-cyan-400/20 text-cyan-100"><Layers className="h-5 w-5" /></span>
                          <div className="min-w-0">
                            <p className="text-[11px] font-medium text-cyan-200">目前開啟的訂單池</p>
                            <p className="mt-0.5 break-words text-base font-bold text-white">{poolDisplayName(selectedPool)}</p>
                          </div>
                        </div>
                        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-cyan-200/20 pt-3">
                          <span className="text-xs font-medium text-cyan-100/85">目前已有訂單數量</span>
                          <strong className="text-xl font-bold tabular-nums text-cyan-100">{selectedPool.order_count.toLocaleString('zh-TW')} <span className="text-xs font-medium">筆</span></strong>
                        </div>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-cyan-100/80">訂單只會匯入此池，不會影響其他訂單池。</p>
                    </div>
                  </div>
                  <div className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
                    <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 lg:flex-nowrap">
                      <label className="shrink-0 text-sm font-semibold text-cyan-100" htmlFor="bulk-orders">訂單內容</label>
                      <p id="bulk-orders-help" className="text-xs text-slate-400">貼上多筆訂單，使用一個空白行區分每筆內容。</p>
                      <span className="ml-auto shrink-0 whitespace-nowrap rounded-lg border border-cyan-300/35 bg-cyan-400/10 px-2.5 py-1 text-xs font-medium text-cyan-100" aria-live="polite">待匯入 <strong className="font-bold tabular-nums text-white">{parsedImportOrders.length.toLocaleString('zh-TW')}</strong> 筆訂單</span>
                    </div>
                    <textarea id="bulk-orders" aria-describedby="bulk-orders-help" className={`${poolInputClass} dispatch-orders-scroll !mt-0 h-full min-h-0 w-full resize-none font-mono leading-relaxed`}
                      placeholder={'第一筆訂單\n\n第二筆訂單'} value={bulkInput} disabled={busy}
                      onChange={(event) => setBulkInput(event.target.value)} />
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-cyan-300/15 bg-slate-900 px-4 py-3 sm:px-6">
                {importProgress && (
                  <div className="mr-auto min-w-[180px] flex-1 text-xs text-blue-200 sm:max-w-xs" role="status">
                    <div className="flex items-center justify-between gap-2">
                      <span>資料庫已確認 {importProgress.current.toLocaleString('zh-TW')} / {importProgress.total.toLocaleString('zh-TW')} 筆</span>
                      <strong className="tabular-nums text-white">{Math.round((importProgress.current / importProgress.total) * 100)}%</strong>
                    </div>
                    <div role="progressbar" aria-label="訂單匯入進度" aria-valuemin={0} aria-valuemax={importProgress.total} aria-valuenow={importProgress.current} className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-700">
                      <div className="h-full rounded-full bg-blue-400 transition-[width]" style={{ width: `${Math.round((importProgress.current / importProgress.total) * 100)}%` }} />
                    </div>
                  </div>
                )}
                <button type="button" className={secondaryButton} disabled={busy} onClick={() => setShowBulkImport(false)}>返回列表</button>
                <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:from-cyan-500 hover:to-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy || !bulkInput.trim() || !canManageOrders} onClick={() => void importOrders()}>
                  {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{busy ? '匯入中…' : '開始匯入訂單'}
                </button>
              </div>
            </>
          ) : (
            <>
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-cyan-300/15 bg-slate-900/95 px-4 py-3 sm:px-6">
            <div role="group" aria-label="依狀態篩選訂單" className="flex min-w-0 flex-wrap gap-1 rounded-xl border border-slate-700 bg-slate-950/70 p-1">
              {([
                { value: 'all', label: '全部訂單' },
                { value: 'active', label: '已啟用' },
                { value: 'inactive', label: '未啟用' },
              ] as const).map((option) => (
                <button type="button" key={option.value} aria-pressed={orderFilter === option.value} onClick={() => setOrderFilter(option.value)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${orderFilter === option.value ? 'bg-cyan-500/20 text-cyan-100 shadow-sm ring-1 ring-cyan-400/30' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>{option.label}</button>
              ))}
            </div>
            {isSuperAdmin && (
              <div className="flex flex-wrap gap-2 sm:ml-auto">
                <button type="button" disabled={!canManageOrders || busy || ordersLoading} onClick={() => setShowBulkImport(true)}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:from-cyan-500 hover:to-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"><Upload className="h-3.5 w-3.5" />匯入訂單</button>
                <button type="button" disabled={!canManageOrders || busy || ordersLoading} onClick={() => { setDeleteConfirmInput(''); setShowDeleteAll(true); }}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />全部刪除</button>
              </div>
            )}
          </div>
          <div aria-busy={ordersLoading} className="dispatch-orders-scroll min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-950/70">
            <div className={`sticky top-0 z-10 hidden items-center gap-x-4 border-b border-cyan-300/20 bg-gradient-to-r from-blue-900/90 via-cyan-950/90 to-slate-900/95 px-6 py-2.5 text-[11px] font-semibold tracking-wide text-cyan-100 lg:grid ${canManageOrders ? 'lg:grid-cols-[56px_minmax(0,1fr)_110px_170px_198px]' : 'lg:grid-cols-[56px_minmax(0,1fr)_110px_170px]'}`}>
              <span>序號</span><span>訂單內容</span><span>狀態</span><span>建立時間</span>{canManageOrders && <span className="text-right">操作</span>}
            </div>
            {ordersLoading && !orders.length && (
              <p className="py-8 text-center text-sm text-cyan-200" role="status">正在載入訂單…</p>
            )}
            {!selectedPool ? (
              <p className="py-12 text-center text-sm text-slate-400">
                請選擇訂單池以檢視訂單。
              </p>
            ) : ordersPoolId !== selectedPool.id ? null : !orders.length && !ordersLoading ? (
              <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-4 py-10 text-center"><PackageSearch className="h-9 w-9 text-cyan-300/60" /><p className="text-sm font-medium text-slate-300">
                此訂單池沒有
                {orderFilter === 'all'
                  ? ''
                  : orderFilter === 'active'
                    ? '已啟用的'
                    : '未啟用的'}
                訂單。
              </p></div>
            ) : (
              orders.map((order, index) => (
                <div key={order.id} className={`grid min-w-0 grid-cols-[40px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 border-b border-cyan-300/10 px-4 py-2.5 transition-opacity even:bg-slate-800/30 hover:bg-cyan-400/5 sm:px-6 lg:items-center lg:gap-x-4 ${ordersLoading ? 'pointer-events-none opacity-45' : ''} ${canManageOrders ? 'lg:grid-cols-[56px_minmax(0,1fr)_110px_170px_198px]' : 'lg:grid-cols-[56px_minmax(0,1fr)_110px_170px]'}`}>
                  <span className="font-mono text-xs font-semibold tabular-nums text-cyan-300/80">{String((page - 1) * PAGE_SIZE + index + 1).padStart(2, '0')}</span>
                  <div className="col-span-2 min-w-0 lg:col-span-1">
                    {editingId === order.id ? (
                      <>
                        <textarea className={`${poolInputClass} dispatch-orders-scroll !mt-0 min-h-28 resize-y font-mono`} value={editContent} onChange={(event) => setEditContent(event.target.value)} aria-label="編輯訂單內容" />
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button type="button" className={primaryButton} disabled={busy || ordersLoading || !editContent.trim()} onClick={() => void manageOrder('edit', order.id, editContent.trim())}><Save className="mr-1 inline h-3 w-3" />儲存</button>
                          <button type="button" className={secondaryButton} disabled={busy || ordersLoading} onClick={() => setEditingId(null)}>取消</button>
                        </div>
                      </>
                    ) : (
                      <p className="dispatch-orders-scroll max-h-20 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-slate-100">{order.order_content}</p>
                    )}
                  </div>
                  <span className={`col-start-2 w-fit rounded-full border px-2.5 py-1 text-xs font-medium lg:col-auto ${order.is_active ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-amber-400/30 bg-amber-400/10 text-amber-200'}`}>{order.is_active ? '已啟用' : '未啟用'}</span>
                  <time dateTime={order.created_at} className="col-start-3 min-w-0 text-right text-[11px] tabular-nums text-slate-400 lg:col-auto lg:text-left lg:text-xs">{new Date(order.created_at).toLocaleString('zh-TW')}</time>
                  {canManageOrders && editingId !== order.id && (
                    <div className="col-span-2 col-start-2 flex flex-wrap items-center gap-1.5 lg:col-auto lg:justify-end">
                      <button type="button" className="inline-flex min-h-8 items-center rounded-md border border-blue-400/30 bg-blue-400/10 px-2.5 text-xs font-medium text-blue-200 hover:bg-blue-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:opacity-50" disabled={busy || ordersLoading} onClick={() => { setEditingId(order.id); setEditContent(order.order_content); }}><Edit2 className="mr-1 h-3 w-3" />編輯</button>
                      <button type="button" className="min-h-8 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 text-xs font-medium text-amber-200 hover:bg-amber-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50" disabled={busy || ordersLoading} onClick={() => void manageOrder('toggle', order.id)}>{order.is_active ? '停用' : '啟用'}</button>
                      <button type="button" className="inline-flex min-h-8 items-center rounded-md border border-rose-400/30 bg-rose-400/10 px-2.5 text-xs font-medium text-rose-200 hover:bg-rose-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:opacity-50" disabled={busy || ordersLoading} onClick={() => setDeleteOrder(order)}><Trash2 className="mr-1 h-3 w-3" />刪除</button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
            </>
          )}
            </aside>
          </div>, document.body,
        )}
      </div>

      {groupForm && createPortal(
        <div className="fixed inset-0 z-[9990] flex flex-col items-center overflow-y-auto bg-slate-950/80 p-2 backdrop-blur-sm sm:p-4">
          <div role="dialog" aria-modal="true" aria-label="建立分組" className="my-auto w-full max-w-7xl shrink-0 overflow-hidden rounded-2xl border border-indigo-300/30 bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950 shadow-[0_32px_90px_rgba(2,6,23,0.65)]">
            <div className="flex flex-wrap items-center gap-3 border-b border-indigo-300/20 bg-gradient-to-r from-indigo-900 via-blue-900 to-slate-900 px-4 py-3 sm:px-6">
              <div className="flex min-w-[150px] flex-1 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/30 bg-white/10 text-cyan-200"><FolderPlus className="h-5 w-5" /></div>
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-white">建立訂單分組</h3>
                  <p className="text-xs text-blue-100/75">設定派單與員工規則，建立後自動新增基本池</p>
                </div>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
                <button type="button" role="switch" aria-label="啟用新分組" aria-checked={groupDraft.is_active}
                  disabled={busy} onClick={() => setPendingGroupActive(!groupDraft.is_active)}
                  className={`inline-flex min-h-10 items-center gap-2.5 rounded-xl border px-3 py-1.5 text-sm font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-60 ${groupDraft.is_active ? 'border-emerald-300/60 bg-emerald-500/25 text-emerald-50 shadow-emerald-950/40 hover:bg-emerald-500/35' : 'border-rose-300/60 bg-rose-500/25 text-rose-50 shadow-rose-950/40 hover:bg-rose-500/35'}`}>
                  <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${groupDraft.is_active ? 'bg-emerald-400' : 'bg-rose-500'}`} aria-hidden="true">
                    <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform ${groupDraft.is_active ? 'translate-x-5' : ''}`} />
                  </span>
                  <span>{groupDraft.is_active ? '已啟用' : '未啟用'}</span>
                </button>
                <button type="button" onClick={() => setGroupForm(null)} disabled={busy} aria-label="關閉新增分組" className="shrink-0 rounded-lg border border-white/10 bg-white/10 p-2 text-blue-100 transition-colors hover:bg-white/20 disabled:opacity-50"><X className="h-5 w-5" /></button>
              </div>
            </div>
            <div className="dispatch-group-settings-fields px-4 py-4 sm:px-6">
              <div className="grid gap-5 lg:grid-cols-2 lg:gap-6">
                <div className="min-w-0 space-y-4">
                  <section className="min-w-0 space-y-2">
                    <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-400/20 text-xs font-bold text-sky-200">01</span><h4 className="font-semibold text-sky-100">基本資料</h4></div>
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-slate-200">
                        分組名稱 *
                        <input className={`${inputClass} mt-1 sm:ml-3 sm:max-w-40`} value={groupDraft.group_name ?? ''} disabled={busy}
                          onChange={(event) => setGroupDraft({ ...groupDraft, group_name: event.target.value })} />
                      </label>
                      <label className="block text-sm font-medium text-slate-200">
                        說明
                        <textarea className={`${inputClass} mt-1 min-h-14 resize-y`} value={groupDraft.description ?? ''} disabled={busy}
                          onChange={(event) => setGroupDraft({ ...groupDraft, description: event.target.value })} />
                      </label>
                    </div>
                  </section>
                  <section className="min-w-0 space-y-2 border-t border-slate-700/70 pt-3">
                    <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-400/20 text-xs font-bold text-violet-200">02</span><h4 className="font-semibold text-violet-100">訂單池設定</h4></div>
                    <p className="text-sm font-medium text-violet-100">訂單池選擇模式</p>
                  <div role="group" aria-label="訂單池選擇模式" className="grid grid-cols-3 gap-2">
                    {poolSelectionOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={groupDraft.pool_selection_mode === option.value}
                        disabled={busy}
                        onClick={() => setGroupDraft({ ...groupDraft, pool_selection_mode: option.value })}
                        className={`min-w-0 rounded-xl border px-2 py-2.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50 ${groupDraft.pool_selection_mode === option.value ? option.activeClass : option.inactiveClass}`}
                      >
                        <span className="flex items-start justify-between gap-1 text-xs font-semibold sm:text-sm">
                          {option.label}
                          {groupDraft.pool_selection_mode === option.value && <CheckCircle className="h-4 w-4 shrink-0" />}
                        </span>
                        <span className="mt-1 hidden text-xs opacity-85 sm:block">{option.description}</span>
                      </button>
                    ))}
                  </div>
                  {groupDraft.pool_selection_mode === 'weighted' && (
                    <p className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
                      建立分組後會自動新增基本池，初始概率為 100%；新增其他池後，可在「分組設定」調整各池概率。
                    </p>
                  )}
                  </section>
                </div>
                <div className="min-w-0 space-y-4 lg:border-l lg:border-indigo-300/20 lg:pl-6">
                  <section className="min-w-0 space-y-2">
                    <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-400/20 text-xs font-bold text-cyan-200">03</span><h4 className="font-semibold text-cyan-100">工作與提交時間</h4></div>
                    <div className="grid min-w-0 gap-3 sm:grid-cols-2 sm:gap-5">
                      <div className="min-w-0">
                        <label className="block text-sm font-medium text-slate-200">
                          <span className="block leading-5">工作會話逾時（分鐘）</span>
                          <input type="number" min="1" max="60" className={`${inputClass} mt-1 block sm:max-w-40`}
                            value={groupDraft.session_timeout_minutes ?? ''} disabled={busy}
                            onChange={(event) => setGroupDraft({ ...groupDraft, session_timeout_minutes: event.target.value })} />
                        </label>
                        <p className="mt-1 text-xs leading-relaxed text-cyan-100">接單後尚未提交的期限；已派訂單保留原設定。</p>
                      </div>
                      <div className="min-w-0" role="group" aria-labelledby="create-dispatch-submit-wait-label">
                        <p id="create-dispatch-submit-wait-label" className="text-sm font-medium leading-5 text-slate-200">提交等待時間（秒）</p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
                          <label className="inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium text-slate-200">
                            最短
                            <input type="number" min="3" max="120" className={`${inputClass} !w-20 !px-2`}
                              value={groupDraft.submit_wait_min_seconds ?? ''} disabled={busy}
                              onChange={(event) => setGroupDraft({ ...groupDraft, submit_wait_min_seconds: event.target.value })} />
                          </label>
                          <label className="inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium text-slate-200">
                            最長
                            <input type="number" min="3" max="300" className={`${inputClass} !w-20 !px-2`}
                              value={groupDraft.submit_wait_max_seconds ?? ''} disabled={busy}
                              onChange={(event) => setGroupDraft({ ...groupDraft, submit_wait_max_seconds: event.target.value })} />
                          </label>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-cyan-100">僅影響提交頁動畫，不延長接單或處理期限。</p>
                      </div>
                    </div>
                  </section>
                  <section className="min-w-0 space-y-2 border-t border-slate-700/70 pt-3">
                    <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-400/20 text-xs font-bold text-emerald-200">04</span><h4 className="font-semibold text-emerald-100">訂單收益與成功率</h4></div>
                    <div className="grid min-w-0 gap-y-3 sm:grid-cols-3 sm:gap-x-5">
                      <label className="min-w-0 text-sm font-medium text-slate-200">
                        <span className="block leading-5">佣金率</span>
                        <input type="number" min="0.00001" max="1" step="0.00000001" className={`${inputClass} mt-1 sm:max-w-40`}
                          value={groupDraft.commission_rate ?? ''} disabled={busy}
                          onChange={(event) => setGroupDraft({ ...groupDraft, commission_rate: event.target.value })} />
                        <span className="mt-1 block text-xs font-normal leading-4 text-emerald-300 sm:max-w-40">小數比例：0.00008 = 0.008%；成功訂單計佣。</span>
                      </label>
                      <label className="min-w-0 text-sm font-medium text-slate-200">
                        <span className="block leading-5">搶單成功率（%）</span>
                        <input type="number" min="0" max="100" step="1" className={`${inputClass} mt-1 sm:max-w-40`}
                          value={groupDraft.grab_success_rate ?? ''} disabled={busy}
                          onChange={(event) => setGroupDraft({ ...groupDraft, grab_success_rate: event.target.value })} />
                        <span className="mt-1 block text-xs font-normal leading-4 text-emerald-300 sm:max-w-40">僅影響接單；新派單保存機率。</span>
                      </label>
                      <label className="min-w-0 text-sm font-medium text-slate-200">
                        <span className="block leading-5">提交後訂單成功率（%）</span>
                        <input type="number" min="0" max="100" step="1" className={`${inputClass} mt-1 sm:max-w-40`}
                          value={groupDraft.dispatch_success_rate ?? ''} disabled={busy}
                          onChange={(event) => setGroupDraft({ ...groupDraft, dispatch_success_rate: event.target.value })} />
                        <span className="mt-1 block text-xs font-normal leading-4 text-teal-300 sm:max-w-40">僅影響訂單結果；提交時保存機率。</span>
                      </label>
                    </div>
                  </section>
                  <section className="min-w-0 space-y-2 border-t border-slate-700/70 pt-3">
                    <div className="flex flex-wrap items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-400/20 text-xs font-bold text-amber-200">05</span><h4 className="font-semibold text-amber-100">提款資格</h4><span className="ml-auto rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-100">建立後統計成員</span></div>
                    <p className="text-xs leading-relaxed text-slate-300">依所屬分組判斷；員工人數由分組成員自動統計。</p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="min-w-0 text-sm font-medium text-slate-200">
                        最低提款餘額
                        <input type="number" min="0" max="999999999999.99" step="0.01" className={`${inputClass} mt-1 sm:ml-3 sm:max-w-40`}
                          value={groupDraft.withdrawal_amount_threshold ?? ''} disabled={busy}
                          onChange={(event) => setGroupDraft({ ...groupDraft, withdrawal_amount_threshold: event.target.value })} />
                        <span className="mt-1 block text-xs font-normal leading-relaxed text-amber-200/90">按員工目前餘額是否達到此金額判斷。</span>
                      </label>
                      <label className="min-w-0 text-sm font-medium text-slate-200">
                        最低訂單數
                        <input type="number" min="1" max="1000000" step="1" className={`${inputClass} mt-1 sm:ml-3 sm:max-w-40`}
                          value={groupDraft.withdrawal_orders_threshold ?? ''} disabled={busy}
                          onChange={(event) => setGroupDraft({ ...groupDraft, withdrawal_orders_threshold: event.target.value })} />
                        <span className="mt-1 block text-xs font-normal leading-relaxed text-amber-200/90">按所有狀態的訂單筆數計算。</span>
                      </label>
                    </div>
                    <WithdrawalConditionPicker id="create-withdrawal-condition" value={groupDraft.withdrawal_condition_mode}
                      disabled={busy} onChange={(mode) => setGroupDraft((current) => ({ ...current, withdrawal_condition_mode: mode }))} />
                  </section>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-indigo-300/20 bg-slate-950/50 px-4 py-2.5 sm:px-6">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                <span className={`rounded-full px-2 py-1 ${groupDraft.is_active ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-200'}`}>{groupDraft.is_active ? '建立時啟用' : '建立時未啟用'}</span>
                <span>基本池會在建立後自動新增。</span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={() => setGroupForm(null)} disabled={busy} className={`${secondaryButton} min-h-10`}>取消</button>
                <button type="button" disabled={busy || !groupDraft.group_name.trim()} onClick={() => void saveGroup()}
                  className="inline-flex min-h-10 items-center justify-center rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-900/30 transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">
                  {busy ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  {busy ? '儲存中…' : '儲存分組'}
                </button>
              </div>
            </div>
          </div>
        </div>, document.body,
      )}

      {poolForm && selectedGroup && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/85 p-3 backdrop-blur-sm sm:p-5">
          <div role="dialog" aria-modal="true" aria-labelledby="pool-form-title" className="flex max-h-[calc(100dvh-24px)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-cyan-300/25 bg-slate-900 text-slate-100 shadow-[0_32px_90px_rgba(2,6,23,0.7)] sm:max-h-[calc(100dvh-40px)]">
            <div className="h-1 shrink-0 bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-500" />
            <div className="flex shrink-0 items-start gap-3 border-b border-cyan-300/15 bg-gradient-to-r from-blue-950 via-slate-900 to-cyan-950 px-4 py-4 sm:px-6 sm:py-5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-300/30 bg-cyan-400/10 text-cyan-200">{poolForm === 'create' ? <Plus className="h-5 w-5" /> : <Settings className="h-5 w-5" />}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold tracking-widest text-cyan-300">{groupDisplayName(selectedGroup)} · 訂單池管理</p>
                <h3 id="pool-form-title" className="mt-1 break-words text-xl font-semibold text-white">{poolForm === 'create' ? '建立訂單池' : `編輯「${selectedPool ? poolDisplayName(selectedPool) : ''}」`}</h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-300">設定池內派單節奏與訂單選擇方式。</p>
              </div>
              <button type="button" disabled={busy} onClick={() => setPoolForm(null)} aria-label="關閉訂單池設定" className="shrink-0 rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 transition-colors hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"><X className="h-4 w-4" /></button>
            </div>
            <div className="min-h-0 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
              <section>
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-cyan-100"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-cyan-400/15 text-xs text-cyan-300">01</span>基本資料</div>
                <label className="block text-sm font-medium text-slate-200">訂單池名稱 <span className="text-cyan-300">*</span>
                  <input className={poolInputClass} value={poolDraft.pool_name} disabled={busy} placeholder="輸入訂單池名稱" onChange={(event) => setPoolDraft({ ...poolDraft, pool_name: event.target.value })} />
                </label>
              </section>
              <section className="border-t border-slate-700/80 pt-5">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-blue-100"><span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-400/15 text-xs text-blue-300">02</span>派單規則</div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="min-w-0 text-sm font-medium text-slate-200">最短派單間隔 <span className="text-slate-400">/ 秒</span>
                    <input type="number" min="1" max="3000" className={poolInputClass} value={poolDraft.dispatch_interval_min} disabled={busy} onChange={(event) => setPoolDraft({ ...poolDraft, dispatch_interval_min: event.target.value })} />
                  </label>
                  <label className="min-w-0 text-sm font-medium text-slate-200">最長派單間隔 <span className="text-slate-400">/ 秒</span>
                    <input type="number" min="1" max="3000" className={poolInputClass} value={poolDraft.dispatch_interval_max} disabled={busy} onChange={(event) => setPoolDraft({ ...poolDraft, dispatch_interval_max: event.target.value })} />
                  </label>
                </div>
                <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-blue-200/80"><Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />間隔範圍為 1–3000 秒，最短不得大於最長。</p>
                <div className="mt-4">
                  <p id="pool-order-mode-label" className="text-sm font-medium text-slate-200">池內選單模式</p>
                  <div role="group" aria-labelledby="pool-order-mode-label" className="mt-2 grid grid-cols-2 gap-2">
                    {([
                      {
                        value: 'random', label: '隨機選單', description: '從池內訂單隨機抽取',
                        selectedClass: 'border-violet-200 bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white ring-2 ring-violet-300/70 shadow-lg shadow-violet-950/40',
                        unselectedClass: 'border-violet-400/30 bg-violet-400/5 text-violet-200/70 hover:border-violet-400/70 hover:bg-violet-400/10',
                        focusClass: 'focus-visible:ring-violet-300',
                      },
                      {
                        value: 'sequential', label: '依序選單', description: '按訂單排列順序選取',
                        selectedClass: 'border-amber-200 bg-gradient-to-br from-amber-400 to-orange-500 text-slate-950 ring-2 ring-amber-300/80 shadow-lg shadow-amber-950/40',
                        unselectedClass: 'border-amber-400/30 bg-amber-400/5 text-amber-200/70 hover:border-amber-400/70 hover:bg-amber-400/10',
                        focusClass: 'focus-visible:ring-amber-300',
                      },
                    ] as const).map((mode) => (
                      <button key={mode.value} type="button" aria-pressed={poolDraft.dispatch_order_mode === mode.value} disabled={busy} onClick={() => setPoolDraft({ ...poolDraft, dispatch_order_mode: mode.value })}
                        className={`min-w-0 rounded-xl border px-3 py-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50 ${mode.focusClass} ${poolDraft.dispatch_order_mode === mode.value ? mode.selectedClass : mode.unselectedClass}`}>
                        <span className="flex items-center justify-between gap-1 text-sm font-semibold">{mode.label}{poolDraft.dispatch_order_mode === mode.value && <CheckCircle className="h-5 w-5 shrink-0" />}</span>
                        <span className="mt-1 block text-xs opacity-85">{mode.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </section>
              <section className="border-t border-slate-700/80 pt-5">
                <button type="button" role="switch" aria-checked={poolDraft.is_active} disabled={busy} onClick={() => setPoolDraft({ ...poolDraft, is_active: !poolDraft.is_active })}
                  className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50 ${poolDraft.is_active ? 'border-emerald-400/30 bg-emerald-400/10 hover:bg-emerald-400/15' : 'border-amber-400/30 bg-amber-400/10 hover:bg-amber-400/15'}`}>
                  <span className={`relative h-6 w-11 shrink-0 rounded-full ${poolDraft.is_active ? 'bg-emerald-500' : 'bg-slate-600'}`} aria-hidden="true"><span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${poolDraft.is_active ? 'translate-x-5' : ''}`} /></span>
                  <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-white">{poolDraft.is_active ? '啟用訂單池' : '停用訂單池'}</span><span className="mt-0.5 block text-xs text-slate-300">{poolDraft.is_active ? '儲存後可依分組規則參與派單' : '儲存後不再參與新的派單'}</span></span>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${poolDraft.is_active ? 'bg-emerald-400/20 text-emerald-200' : 'bg-amber-400/20 text-amber-200'}`}>{poolDraft.is_active ? '已啟用' : '已停用'}</span>
                </button>
              </section>
            </div>
            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-cyan-300/15 bg-slate-950/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-6">
              <button type="button" disabled={busy} onClick={() => setPoolForm(null)} className="min-h-10 rounded-xl border border-slate-600 bg-slate-800 px-5 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-50">取消</button>
              <button type="button" disabled={busy || !poolDraft.pool_name.trim()} onClick={() => void savePool()}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-950/40 transition-colors hover:from-cyan-500 hover:to-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50">
                {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {busy ? '儲存中…' : poolForm === 'create' ? '建立訂單池' : '儲存變更'}
              </button>
            </div>
          </div>
        </div>, document.body,
      )}

      {poolToggleTarget && createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/85 p-3 backdrop-blur-sm sm:p-5">
          <div role="alertdialog" aria-modal="true" aria-labelledby="pool-stop-title" aria-describedby="pool-stop-description" className="max-h-[calc(100dvh-24px)] w-full max-w-md overflow-y-auto rounded-2xl border border-amber-400/30 bg-slate-900 text-slate-100 shadow-[0_32px_90px_rgba(2,6,23,0.7)]">
            <div className="h-1 bg-gradient-to-r from-amber-300 via-orange-500 to-rose-500" />
            <div className="flex items-start gap-3 bg-gradient-to-r from-amber-950/70 to-slate-900 px-5 py-5 sm:px-6">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-400/15 text-amber-200"><PowerOff className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1"><p className="text-xs font-semibold tracking-widest text-amber-300">訂單池狀態變更</p><h3 id="pool-stop-title" className="mt-1 text-xl font-semibold text-white">停用訂單池？</h3></div>
              <button type="button" disabled={busy} onClick={() => setPoolToggleTarget(null)} aria-label="關閉停用確認" className="shrink-0 rounded-lg p-2 text-slate-300 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-4 px-5 pb-5 sm:px-6">
              <div className="rounded-xl border border-slate-700 bg-slate-950/50 px-4 py-3"><p className="text-xs text-slate-400">即將停用</p><p className="mt-1 break-words text-base font-semibold text-white">{poolDisplayName(poolToggleTarget)}</p><p className="mt-1 text-xs text-slate-400">{selectedGroup ? groupDisplayName(selectedGroup) : '訂單分組'} · {poolToggleTarget.order_count} 筆訂單</p></div>
              <p id="pool-stop-description" className="flex items-start gap-2 text-sm leading-relaxed text-amber-100"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />停用後，此池不再參與新的派單；池內訂單與既有派單紀錄會保留，之後可重新啟用。</p>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-amber-400/15 bg-slate-950/60 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              <button type="button" disabled={busy} onClick={() => setPoolToggleTarget(null)} className="min-h-10 rounded-xl border border-slate-600 bg-slate-800 px-5 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-50">取消</button>
              <button type="button" disabled={busy} onClick={() => void togglePool(poolToggleTarget)} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 px-5 py-2 text-sm font-semibold text-slate-950 shadow-lg shadow-orange-950/30 hover:from-amber-400 hover:to-orange-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50">{busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <PowerOff className="h-4 w-4" />}{busy ? '處理中…' : '確認停用'}</button>
            </div>
          </div>
        </div>, document.body,
      )}

      {archiveTarget &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="確認封存"
              className="w-full max-w-md rounded-xl border border-rose-500 bg-slate-800 p-5"
            >
              <h3 className="mb-2 text-lg font-semibold">
                確定封存{archiveTarget.type === 'group' ? '分組' : '訂單池'}？
              </h3>
              <p className="break-words text-sm text-slate-300">
                確定封存「{archiveTarget.name}」？封存後將無法使用，但既有訂單與派單紀錄會保留。
                {archiveTarget.type === 'group' &&
                  ' 此分組的員工將停止接收訂單，直到重新指派分組或還原此分組。'}
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  className={secondaryButton}
                  disabled={busy}
                  onClick={() => setArchiveTarget(null)}
                >
                  取消
                </button>
                <button
                  className="rounded-lg bg-rose-600 px-3 py-2 text-sm text-white disabled:opacity-50"
                  disabled={busy}
                  onClick={() =>
                    void changeArchive(
                      archiveTarget.type,
                      archiveTarget.id,
                      true,
                    )
                  }
                >
                  封存
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {memberMove &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="member-move-title"
              aria-describedby="member-move-note"
              className="dispatch-members-scroll max-h-[calc(100dvh-32px)] w-full max-w-lg overflow-y-auto rounded-2xl border border-emerald-300/30 bg-slate-900 text-slate-100 shadow-[0_32px_80px_rgba(2,6,23,0.75)]"
            >
              <div className="h-1 bg-gradient-to-r from-emerald-400 via-teal-400 to-cyan-400" />
              <div className="border-b border-emerald-400/20 bg-gradient-to-r from-emerald-950 via-teal-950 to-slate-900 px-5 py-5 sm:px-6">
                <div className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-400/35 bg-emerald-400/15 text-emerald-200 shadow-[0_0_22px_rgba(52,211,153,0.12)]">
                    <Users className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold tracking-wide text-emerald-300">分組成員調整</p>
                    <h3 id="member-move-title" className="mt-1 text-xl font-semibold text-white">確認移動員工</h3>
                    <p className="mt-1 text-sm text-emerald-100/75">請確認移動人數與目標分組。</p>
                  </div>
                  <button type="button" aria-label="關閉確認視窗" disabled={busy} onClick={() => setMemberMove(null)} className="shrink-0 rounded-lg p-1.5 text-emerald-100/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:opacity-50"><X className="h-5 w-5" /></button>
                </div>
              </div>
              <div className="px-5 py-5 sm:px-6">
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-400/25 bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 px-4 py-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-lg font-bold text-emerald-200">{memberMove.ids.length}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-slate-400">即將移動的員工</p>
                    <p className="mt-0.5 text-sm font-semibold text-white">{memberMove.ids.length} 位員工</p>
                  </div>
                  <span aria-hidden="true" className="text-xl font-semibold text-emerald-300">→</span>
                  <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
                    <p className="text-xs text-slate-400">目標分組</p>
                    <p className="mt-0.5 break-words text-sm font-semibold text-emerald-200">{memberMove.destination}</p>
                  </div>
                </div>
                <p id="member-move-note" className="mt-4 border-l-2 border-cyan-400 bg-cyan-400/5 px-3 py-2 text-sm leading-relaxed text-slate-300">移動後會取代員工原有的分組歸屬，不會留下未指派分組的員工。</p>
                {targetOrderAvailability === 'empty' && <p role="status" className="mt-3 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">目標分組目前沒有可派訂單。員工可移入，但新增可用訂單前不會收到新派單。</p>}
                {targetOrderAvailability === 'error' && <p role="status" className="mt-3 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">暫時無法確認目標分組是否有可派訂單；移動員工仍可繼續。</p>}
                {targetOrderAvailability === 'loading' && <p role="status" className="mt-3 text-xs text-slate-400">正在確認目標分組的可派訂單…</p>}
                <div className="mt-6 flex flex-col-reverse gap-2 border-t border-slate-700/70 pt-4 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    className="min-h-10 rounded-lg border border-slate-600 bg-slate-800 px-5 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-slate-400 hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy}
                    onClick={() => setMemberMove(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-950/40 transition-colors hover:from-emerald-500 hover:to-teal-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy}
                    aria-busy={busy}
                    onClick={() => void assignMembers()}
                  >
                    {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
                    {busy ? '移動中…' : '確認移動'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {deleteOrder && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/85 p-3 backdrop-blur-sm sm:p-5">
          <div role="alertdialog" aria-modal="true" aria-labelledby="delete-order-title" aria-describedby="delete-order-note"
            className="dispatch-orders-scroll max-h-[calc(100dvh-24px)] w-full max-w-lg overflow-y-auto rounded-2xl border border-rose-400/30 bg-slate-900 text-slate-100 shadow-[0_32px_90px_rgba(2,6,23,0.7)]">
            <div className="h-1 bg-gradient-to-r from-rose-400 via-red-500 to-orange-400" />
            <div className="flex items-start gap-3 border-b border-rose-400/20 bg-gradient-to-r from-rose-950/85 via-slate-900 to-slate-900 px-5 py-5 sm:px-6">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-rose-400/35 bg-rose-400/15 text-rose-200"><Trash2 className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold tracking-widest text-rose-300">訂單管理 · 單筆操作</p>
                <h3 id="delete-order-title" className="mt-1 text-xl font-semibold text-white">確定刪除訂單？</h3>
                <p className="mt-1 text-xs text-slate-300">請確認以下訂單內容再繼續。</p>
              </div>
              <button type="button" disabled={busy} onClick={() => setDeleteOrder(null)} aria-label="關閉刪除確認"
                className="shrink-0 rounded-lg p-2 text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:opacity-50"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-4 px-5 py-5 sm:px-6">
              <div className="rounded-xl border border-slate-700/80 bg-slate-950/65 p-4">
                <p className="mb-2 text-xs font-semibold text-rose-200">即將永久刪除的訂單</p>
                <p className="dispatch-orders-scroll max-h-36 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-slate-200">
                  {deleteOrder.order_content.slice(0, 200)}{deleteOrder.order_content.length > 200 ? '…' : ''}
                </p>
              </div>
              <p id="delete-order-note" className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-3 text-sm leading-relaxed text-amber-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />此訂單將從資料庫永久刪除，無法復原。既有派單紀錄保留，但不再連結此訂單。
              </p>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-rose-400/15 bg-slate-950/65 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              <button type="button" disabled={busy} onClick={() => setDeleteOrder(null)}
                className="min-h-10 rounded-xl border border-slate-600 bg-slate-800 px-5 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-50">取消</button>
              <button type="button" disabled={busy} onClick={() => void manageOrder('delete_permanent', deleteOrder.id)}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-rose-600 to-red-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-rose-950/40 transition-colors hover:from-rose-500 hover:to-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:opacity-50">
                {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}{busy ? '處理中…' : '確認刪除'}
              </button>
            </div>
          </div>
        </div>, document.body,
      )}

      {showDeleteAll &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/85 p-3 backdrop-blur-sm sm:p-5">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-all-title"
              aria-describedby="delete-all-note"
              className="dispatch-orders-scroll max-h-[calc(100dvh-24px)] w-full max-w-lg overflow-y-auto rounded-2xl border border-rose-400/30 bg-slate-900 text-slate-100 shadow-[0_32px_90px_rgba(2,6,23,0.7)]"
            >
              <div className="h-1 bg-gradient-to-r from-rose-400 via-red-500 to-orange-400" />
              <div className="flex items-start gap-3 border-b border-rose-400/20 bg-gradient-to-r from-rose-950/85 via-slate-900 to-slate-900 px-5 py-5 sm:px-6">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-rose-400/35 bg-rose-400/15 text-rose-200"><Trash2 className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold tracking-widest text-rose-300">訂單管理 · 批量操作</p>
                  <h3 id="delete-all-title" className="mt-1 text-xl font-semibold text-white">永久刪除此池全部訂單？</h3>
                  <p className="mt-1 text-xs text-slate-300">此操作僅影響目前選取的訂單池。</p>
                </div>
                <button type="button" disabled={busy} onClick={() => setShowDeleteAll(false)} aria-label="關閉全部刪除確認"
                  className="shrink-0 rounded-lg p-2 text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:opacity-50"><X className="h-4 w-4" /></button>
              </div>
              <div className="space-y-4 px-5 py-5 sm:px-6">
                <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-700/80 bg-slate-950/65 px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-400">刪除目標 · 訂單池</p>
                    <p className="mt-1 break-words text-base font-semibold text-white">{selectedPool ? poolDisplayName(selectedPool) : ''}</p>
                  </div>
                  <div className="shrink-0 border-l border-slate-700 pl-4 text-right">
                    <p className="text-xs font-medium text-slate-400">目前未封存</p>
                    <p className="mt-0.5 text-xl font-semibold tabular-nums text-rose-200">{selectedPool?.order_count ?? 0} <span className="text-xs font-medium">筆</span></p>
                  </div>
                </div>
                <div id="delete-all-note" className="flex items-start gap-2.5 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3.5 py-3 text-sm leading-relaxed text-amber-100">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <p><strong className="font-semibold text-amber-200">無法復原。</strong>此池所有訂單都會從資料庫永久刪除，包括先前封存及目前篩選隱藏的訂單。其他訂單池不受影響；既有派單紀錄保留，但會解除與被刪訂單的連結。</p>
                </div>
                <label htmlFor="delete-all-confirm" className="block text-sm font-medium text-slate-200">
                  輸入 <span className="font-semibold text-rose-300">全部刪除</span> 以確認
                </label>
                <input
                  id="delete-all-confirm"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-rose-400 focus:bg-white focus:ring-2 focus:ring-rose-400/25 disabled:opacity-50"
                  placeholder="請輸入：全部刪除"
                  value={deleteConfirmInput}
                  disabled={busy}
                  onChange={(event) => setDeleteConfirmInput(event.target.value)}
                />
              </div>
              <div className="flex flex-col-reverse gap-2 border-t border-rose-400/15 bg-slate-950/65 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
                <button type="button" disabled={busy} onClick={() => setShowDeleteAll(false)}
                  className="min-h-10 rounded-xl border border-slate-600 bg-slate-800 px-5 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-50">取消</button>
                <button type="button" disabled={busy || deleteConfirmInput !== '全部刪除'} onClick={() => void manageOrder('delete_all_permanent')}
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-rose-600 to-red-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-rose-950/40 transition-colors hover:from-rose-500 hover:to-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-not-allowed disabled:opacity-40">
                  {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}{busy ? '處理中…' : '永久刪除全部訂單'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
