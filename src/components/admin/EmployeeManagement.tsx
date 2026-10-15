import { Fragment, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { UserPlus, Search, MoreVertical, CheckCircle, XCircle, Key, ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, ChevronLeft, ChevronRight, Trash2, Eye, EyeOff, RefreshCw, ArrowUpDown, ArrowUp, ArrowDown, Pin, Tag, X, Users, CalendarDays, Clock, Pencil, Bell, MessageCircle, DollarSign, Headphones, Globe, Loader2, Timer, Wallet, MapPin, Clock3, History, LogIn, LogOut } from 'lucide-react';
import { formatSupabaseError, isFinancialAdminSessionError, isSupabaseAbortError, isSupabaseTransientError, supabase } from '../../lib/supabase';
import { Employee, Admin, NotificationAutomationPlan, NotificationAutomationPlanAssignment } from '../../types';
import { createFinancialOperationId, getAdminFinancialSessionToken, logout } from '../../lib/auth';
import { mutateAuditedContent } from '../../lib/contentAudit';
import EmployeeDetailModal from './EmployeeDetailModal';
import LoginDeviceSummary from './LoginDeviceSummary';

interface OrderRealtimeData {
  user_id: string;
  status: string;
  commission_amount?: number | string | null;
  created_at?: string | null;
}

interface PendingWithdrawalRecord {
  id: string;
  amount: number;
  created_at: string;
}

interface WalletModalData {
  available: number;
  pending: number;
}

const getCreateEmployeeErrorMessage = (
  error: unknown,
  attemptedUsername: string,
  attemptedEmployeeId: string,
) => {
  const message = formatSupabaseError(error);
  const errorCode = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : message.match(/\b(23505)\b/)?.[1];
  const duplicateUsername = message.match(/Key \(username\)=\(([^)]+)\) already exists/i)?.[1]
    || attemptedUsername;
  const duplicateEmployeeId = message.match(/Key \(employee_id\)=\(([^)]+)\) already exists/i)?.[1]
    || attemptedEmployeeId;

  if (/users_username_key|Key \(username\)=/i.test(message)) {
    return `新增員工失敗：使用者名稱「${duplicateUsername}」已存在，請更換其他使用者名稱後再試。\n錯誤代碼：${errorCode || '23505'}（使用者名稱重複）`;
  }

  if (/users_employee_id_key|Key \(employee_id\)=/i.test(message)) {
    return `新增員工失敗：員工 ID「${duplicateEmployeeId}」已存在，請更換其他員工 ID 後再試。\n錯誤代碼：${errorCode || '23505'}（員工 ID 重複）`;
  }

  if (errorCode === '23505' || /duplicate key value violates unique constraint/i.test(message)) {
    return '新增員工失敗：輸入的帳號資料已存在，請更換使用者名稱或員工 ID 後再試。\n錯誤代碼：23505（資料重複）';
  }

  if (/A dispatch group must be selected\./i.test(message)) {
    return '新增員工失敗：請先選擇派單分組。';
  }

  if (/The selected dispatch group is not available\./i.test(message)) {
    return '新增員工失敗：所選派單分組已封存、停用或不存在，請重新開啟視窗選擇可用分組。';
  }

  if (/^(使用者名稱為必填|密碼至少需要 6 個字元|員工 ID 為必填|請先選擇派單分組|所選派單分組已不可用，請重新選擇|派單分組載入中，請稍候再試|無法載入派單分組，請關閉視窗後重試。)$/.test(message)) {
    return message;
  }

  return `新增員工失敗：系統暫時無法建立帳號，請稍後再試。${errorCode ? `\n錯誤代碼：${errorCode}` : ''}`;
};

const loadWalletModalData = async (userId: string): Promise<WalletModalData> => {
  const [walletResult, pendingWithdrawalsResult] = await Promise.all([
    supabase
      .from('wallets')
      .select('available_balance')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('withdrawals')
      .select('amount')
      .eq('user_id', userId)
      .eq('status', 'pending'),
  ]);

  if (walletResult.error) throw walletResult.error;
  if (pendingWithdrawalsResult.error) throw pendingWithdrawalsResult.error;

  return {
    available: Number(walletResult.data?.available_balance) || 0,
    pending: (pendingWithdrawalsResult.data || []).reduce(
      (total, withdrawal) => total + (Number(withdrawal.amount) || 0),
      0,
    ),
  };
};

interface EmployeeWithAdmin extends Employee {
  admin?: {
    id: string;
    username: string;
    role: string;
  };
  walletBalance?: number;
  verification?: {
    real_name: string | null;
    wallet_address: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  todayOrders: number;
  todayCompletedOrders: number;
  failedOrders: number;
  todayCommission: number;
  totalWorkMinutes: number;
  todayWorkMinutes: number;
  workDays: number;
  workStatus: 'online' | 'offline' | 'never_started';
  totalOrders: number;
  accountBalance: number;
  hasPendingWithdrawal: boolean;
  pendingWithdrawalAmount: number;
  pendingWithdrawalDate: string | null;
  pendingWithdrawals?: PendingWithdrawalRecord[];
  withdrawalDates?: string[];
  statsLoaded: boolean;
}

type SortField = 'totalOrders' | 'todayOrders' | 'todayCompletedOrders' | 'failedOrders' | 'walletBalance' | 'accountBalance' | 'todayCommission' | 'totalWorkMinutes' | 'todayWorkMinutes' | 'workDays' | 'created_at';
type SummaryFilter = 'today_working' | 'new_today' | 'currently_working';
type FinancialFilter = 'wallet' | 'today_commission';

const AUTO_REFRESH_INTERVAL_MS = 180000;
const AUTO_REFRESH_RETRY_MS = 5000;

function RefreshCountdown({ nextRefreshAt }: { nextRefreshAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const update = () => setNow(Date.now());
    const interval = globalThis.setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => {
      globalThis.clearInterval(interval);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return <>{Math.max(0, Math.ceil((nextRefreshAt - now) / 1000))}s</>;
}

const formatWithdrawalDate = (value: string) => {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getUTCDateKey = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getCalendarMonthKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

const formatCalendarDateLabel = (value: string) => value || '請選擇日期';

const isValidCalendarDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};

interface EmployeeGroup {
  admin: {
    id: string;
    username: string;
    role: string;
    is_pinned?: boolean;
  };
  employees: EmployeeWithAdmin[];
}

interface LoginIPRecord {
  id: string;
  action_type: 'login' | 'logout';
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  device_info: unknown | null;
}

interface EmployeeManagementProps {
  admin: Admin;
  isActive?: boolean;
  onQuickAction?: (action: 'message' | 'customerservice' | 'cccservice', employee: {
    id: string;
    username: string;
    employeeId: string;
    adminId: string;
    adminUsername?: string;
    isVerified: boolean;
    isActive: boolean;
    remarks: string;
    tags: string[];
  }) => void;
}

export default function EmployeeManagement({ admin, isActive = true, onQuickAction }: EmployeeManagementProps) {
  const [employeeGroups, setEmployeeGroups] = useState<EmployeeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedAdminFilter, setSelectedAdminFilter] = useState<string>('all');
  const [adminFilterOpen, setAdminFilterOpen] = useState(false);
  const [showCreateSecondaryAdmin, setShowCreateSecondaryAdmin] = useState(false);
  const [creatingSecondaryAdmin, setCreatingSecondaryAdmin] = useState(false);
  const [createSecondaryAdminError, setCreateSecondaryAdminError] = useState<string | null>(null);
  const [showSecondaryAdminPassword, setShowSecondaryAdminPassword] = useState(false);
  const [secondaryAdminForm, setSecondaryAdminForm] = useState({
    username: '',
    password: '',
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [dispatchGroups, setDispatchGroups] = useState<Array<{ id: string; group_name: string; is_default: boolean }>>([]);
  const [dispatchGroupsLoading, setDispatchGroupsLoading] = useState(false);
  const [dispatchGroupsError, setDispatchGroupsError] = useState<string | null>(null);
  const [automationPlans, setAutomationPlans] = useState<NotificationAutomationPlan[]>([]);
  const [automationAssignmentsByEmployee, setAutomationAssignmentsByEmployee] = useState<Map<string, NotificationAutomationPlanAssignment>>(new Map());
  const [editingEmployee, setEditingEmployee] = useState<EmployeeWithAdmin | null>(null);
  const [editingAutomationPlanId, setEditingAutomationPlanId] = useState('');
  const [editingAutomationPlanTouched, setEditingAutomationPlanTouched] = useState(false);
  const [editPlanMenuOpen, setEditPlanMenuOpen] = useState(false);
  const [editPlanMenuPosition, setEditPlanMenuPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const editPlanButtonRef = useRef<HTMLButtonElement>(null);
  const editPlanMenuRef = useRef<HTMLDivElement>(null);
  const editBackdropPressRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const editingEmployeeInitialRef = useRef<{ username: string; employeeId: string; remarks: string; planId: string } | null>(null);
  const [savingEmployeeEdit, setSavingEmployeeEdit] = useState(false);
  const [editEmployeeError, setEditEmployeeError] = useState<string | null>(null);
  const [editingRemarksOnly, setEditingRemarksOnly] = useState<EmployeeWithAdmin | null>(null);
  const [showPasswordReset, setShowPasswordReset] = useState<{id: string; username: string; employeeId: string} | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const expandedGroupsBeforeSearchRef = useRef<Set<string> | null>(null);
  const [deletingEmployee, setDeletingEmployee] = useState<EmployeeWithAdmin | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteFeedback, setDeleteFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [pinConfirmEmployee, setPinConfirmEmployee] = useState<{id: string; username: string; employeeId?: string; currentPinned: boolean} | null>(null);
  const [editingCreatedAt, setEditingCreatedAt] = useState<{id: string; username: string; employeeId: string; currentDate: string} | null>(null);
  const [newCreatedAt, setNewCreatedAt] = useState('');
  const [registrationDateInputError, setRegistrationDateInputError] = useState<string | null>(null);
  const [registrationCalendarOpen, setRegistrationCalendarOpen] = useState(false);
  const [registrationCalendarMonth, setRegistrationCalendarMonth] = useState(() => getCalendarMonthKey(new Date()));
  const [savingCreatedAt, setSavingCreatedAt] = useState(false);

  const closeRegistrationDateEditor = () => {
    setEditingCreatedAt(null);
    setRegistrationCalendarOpen(false);
    setRegistrationDateInputError(null);
  };
  const [viewingEmployee, setViewingEmployee] = useState<EmployeeWithAdmin | null>(null);
  const [selectedTagsByGroup, setSelectedTagsByGroup] = useState<Map<string, string[]>>(new Map());
  const [editingTags, setEditingTags] = useState<EmployeeWithAdmin | null>(null);
  const [newTag, setNewTag] = useState('');
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    employeeId: '',
    remarks: '',
    dispatchGroupId: '',
    automationPlanId: '',
  });
  const [selectedAdminForCreate, setSelectedAdminForCreate] = useState<string | null>(null);
  const [createPlanMenuOpen, setCreatePlanMenuOpen] = useState(false);
  const [createPlanMenuPosition, setCreatePlanMenuPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const createPlanButtonRef = useRef<HTMLButtonElement>(null);
  const createPlanMenuRef = useRef<HTMLDivElement>(null);
  const createBackdropPressRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const adminFilterRef = useRef<HTMLDivElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean;
    title: string;
    message: string;
    employeeUsername: string;
    employeeId: string;
    variant: 'verification' | 'status';
    nextStatus: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [notification, setNotification] = useState<{
    show: boolean;
    type: 'success' | 'error' | 'warning';
    title: string;
    message: string;
    category?: 'password' | 'profile';
    employee?: { username: string; employeeId: string };
    details?: Array<{ label: string; value: string }>;
  } | null>(null);

  // Sort state per group
  const [sortByGroup, setSortByGroup] = useState<Map<string, { sortBy: SortField | null; sortDirection: 'asc' | 'desc' }>>(new Map());
  // Active filter per group (is_active): 'all' | 'active' | 'inactive'
  const [activeFilterByGroup, setActiveFilterByGroup] = useState<Map<string, 'all' | 'active' | 'inactive'>>(new Map());
  // Work status filter per group (multi-select): Set of selected work statuses
  const [workStatusFilterByGroup, setWorkStatusFilterByGroup] = useState<Map<string, Set<'online' | 'offline' | 'never_started'>>>(new Map());
  // Inactive days filter per group: accounts created X days ago that never started work
  type InactiveDaysRange = '2-3' | '3-7' | '7-15' | '15+';
  const [inactiveDaysFilterByGroup, setInactiveDaysFilterByGroup] = useState<Map<string, InactiveDaysRange>>(new Map());
  const [inactiveDaysDropdownOpen, setInactiveDaysDropdownOpen] = useState<string | null>(null);
  const [withdrawalFilterByGroup, setWithdrawalFilterByGroup] = useState<Map<string, string>>(new Map());
  const [withdrawalDropdownOpen, setWithdrawalDropdownOpen] = useState<string | null>(null);
  const [withdrawalDropdownPos, setWithdrawalDropdownPos] = useState<{ top: number; left: number } | null>(null);
  // Summary filter per group
  const [summaryFilterByGroup, setSummaryFilterByGroup] = useState<Map<string, SummaryFilter>>(new Map());
  const [createdDateFilterByGroup, setCreatedDateFilterByGroup] = useState<Map<string, string>>(new Map());
  const [financialFilterByGroup, setFinancialFilterByGroup] = useState<Map<string, FinancialFilter>>(new Map());
  const [createdDateDropdownOpen, setCreatedDateDropdownOpen] = useState<string | null>(null);
  const [createdDateDropdownPos, setCreatedDateDropdownPos] = useState<{ top: number; left: number } | null>(null);
  // Action menu
  const [openActionMenu, setOpenActionMenu] = useState<string | null>(null);
  const [resetFeedbackAdminId, setResetFeedbackAdminId] = useState<string | null>(null);
  const [pinningAdminId, setPinningAdminId] = useState<string | null>(null);
  const [adminPinOverrides, setAdminPinOverrides] = useState<Map<string, boolean>>(new Map());
  const resetFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Refresh
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);

  const [nextRefreshAt, setNextRefreshAt] = useState(() => Date.now() + AUTO_REFRESH_INTERVAL_MS);

  // Login IP popup state
  const [loginIPEmployee, setLoginIPEmployee] = useState<{ id: string; username: string; employeeId?: string } | null>(null);
  const [loginIPRecords, setLoginIPRecords] = useState<LoginIPRecord[]>([]);
  const [loginIPLoading, setLoginIPLoading] = useState(false);
  const [loginIPActionFilter, setLoginIPActionFilter] = useState<'login' | 'logout' | null>(null);

  // Wallet adjustment popup state
  const [walletEmployee, setWalletEmployee] = useState<{ id: string; username: string; employeeId?: string } | null>(null);
  const [walletData, setWalletData] = useState<WalletModalData | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletDataVerified, setWalletDataVerified] = useState(false);
  const [walletAdjustData, setWalletAdjustData] = useState({ amount: '', remarks: '' });
  const [walletAdjusting, setWalletAdjusting] = useState(false);
  const [walletNotification, setWalletNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const walletAdjustmentOperationIdRef = useRef<string | null>(null);
  const walletAdjustingRef = useRef(false);
  const walletLoadRequestRef = useRef(0);

  const scrollLockRef = useRef(false);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const registrationCalendarRef = useRef<HTMLDivElement>(null);
  const createdDateOptionsRef = useRef<HTMLDivElement>(null);
  const createdDateSelectedOptionRef = useRef<HTMLButtonElement>(null);
  const employeeGroupsScrollRef = useRef<HTMLDivElement>(null);
  const employeeGroupsRef = useRef<EmployeeGroup[]>([]);
  employeeGroupsRef.current = employeeGroups;
  const isMountedRef = useRef(false);
  const initialLoadStartedRef = useRef(false);
  const loadInProgressRef = useRef(false);
  const pendingReloadRef = useRef(false);
  const pendingReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextAutoRefreshAtRef = useRef(Date.now() + AUTO_REFRESH_INTERVAL_MS);
  const guardedLoadEmployeesRef = useRef<((silent?: boolean) => Promise<boolean>) | null>(null);
  const realtimeChangeGenerationRef = useRef(0);
  const employeeScopeGenerationRef = useRef(0);
  const employeeScopeKeyRef = useRef(`${admin.id}:${admin.role}`);

  const resetAutoRefreshTimer = useCallback((delayMs = AUTO_REFRESH_INTERVAL_MS) => {
    if (!isMountedRef.current) return;
    if (autoRefreshTimerRef.current) clearTimeout(autoRefreshTimerRef.current);
    const nextRefreshAt = Date.now() + delayMs;
    nextAutoRefreshAtRef.current = nextRefreshAt;
    setNextRefreshAt(nextRefreshAt);
    autoRefreshTimerRef.current = setTimeout(() => {
      void guardedLoadEmployeesRef.current?.(true);
    }, delayMs);
  }, []);

  const schedulePendingReload = () => {
    if (!isMountedRef.current || pendingReloadTimerRef.current) return;
    pendingReloadTimerRef.current = setTimeout(() => {
      pendingReloadTimerRef.current = null;
      if (!pendingReloadRef.current) return;
      pendingReloadRef.current = false;
      void guardedLoadEmployeesRef.current?.(true);
    }, 750);
  };

  // Close action menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (openActionMenu && actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) {
        setOpenActionMenu(null);
      }
    };
    if (openActionMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openActionMenu]);

  useEffect(() => {
    if (!adminFilterOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (adminFilterRef.current && !adminFilterRef.current.contains(e.target as Node)) {
        setAdminFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [adminFilterOpen]);

  useEffect(() => {
    if (!withdrawalDropdownOpen) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('[data-withdrawal-dropdown]')) {
        setWithdrawalDropdownOpen(null);
        setWithdrawalDropdownPos(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWithdrawalDropdownOpen(null);
        setWithdrawalDropdownPos(null);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [withdrawalDropdownOpen]);

  useEffect(() => {
    if (!inactiveDaysDropdownOpen) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-inactive-days-dropdown]')) {
        setInactiveDaysDropdownOpen(null);
        setIdleDaysDropdownPos(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [inactiveDaysDropdownOpen]);

  useEffect(() => {
    if (!inactiveDaysDropdownOpen) return;
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setInactiveDaysDropdownOpen(null);
        setIdleDaysDropdownPos(null);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [inactiveDaysDropdownOpen]);

  useEffect(() => {
    if (!createdDateDropdownOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-created-date-dropdown]')) {
        setCreatedDateDropdownOpen(null);
        setCreatedDateDropdownPos(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCreatedDateDropdownOpen(null);
        setCreatedDateDropdownPos(null);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [createdDateDropdownOpen]);

  useLayoutEffect(() => {
    if (!createdDateDropdownOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const container = createdDateOptionsRef.current;
      const selectedOption = createdDateSelectedOptionRef.current;
      if (!container || !selectedOption) return;
      container.scrollTop = Math.max(
        0,
        selectedOption.offsetTop - (container.clientHeight - selectedOption.offsetHeight) / 2,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [createdDateDropdownOpen]);

  useEffect(() => {
    if (!registrationCalendarOpen) return;
    const closeCalendarOnOutsideClick = (event: MouseEvent) => {
      if (registrationCalendarRef.current && !registrationCalendarRef.current.contains(event.target as Node)) {
        setRegistrationCalendarOpen(false);
      }
    };
    document.addEventListener('mousedown', closeCalendarOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeCalendarOnOutsideClick);
  }, [registrationCalendarOpen]);

  useEffect(() => {
    const anyModalOpen = !!(showCreateForm || showCreateSecondaryAdmin || adminFilterOpen || editingEmployee || editingRemarksOnly || showPasswordReset || deletingEmployee || editingTags || editingCreatedAt || pinConfirmEmployee || notification?.show || confirmDialog?.show || loginIPEmployee || walletEmployee);
    if (anyModalOpen && !scrollLockRef.current) {
      scrollLockRef.current = true;
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
    } else if (!anyModalOpen && scrollLockRef.current) {
      scrollLockRef.current = false;
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    }
  }, [showCreateForm, showCreateSecondaryAdmin, adminFilterOpen, editingEmployee, editingRemarksOnly, showPasswordReset, deletingEmployee, editingTags, editingCreatedAt, pinConfirmEmployee, notification?.show, confirmDialog?.show, loginIPEmployee, walletEmployee]);

  useEffect(() => {
    const scopeKey = `${admin.id}:${admin.role}`;
    const scopeChanged = employeeScopeKeyRef.current !== scopeKey;
    employeeScopeKeyRef.current = scopeKey;
    employeeScopeGenerationRef.current += 1;

    if (scopeChanged) {
      realtimeChangeGenerationRef.current += 1;
      initialLoadStartedRef.current = false;
      employeeGroupsRef.current = [];
      setEmployeeGroups([]);
      setAutomationPlans([]);
      setAutomationAssignmentsByEmployee(new Map());
      setEditingAutomationPlanId('');
      setEditEmployeeError(null);
      setExpandedGroups(new Set());
      setLoadError(null);
      setLoading(true);
      setStatsLoading(false);
      setIsRefreshing(false);
    }

    if (!isActive) {
      isMountedRef.current = false;
      if (autoRefreshTimerRef.current) clearTimeout(autoRefreshTimerRef.current);
      autoRefreshTimerRef.current = null;
      if (pendingReloadTimerRef.current) clearTimeout(pendingReloadTimerRef.current);
      pendingReloadTimerRef.current = null;
      pendingReloadRef.current = false;
      return;
    }

    isMountedRef.current = true;
    let realtimeReloadTimer: ReturnType<typeof setTimeout> | null = null;
    let realtimeReloadWindowStartedAt: number | null = null;
    const scheduleRealtimeReload = (delay: number) => {
      if (!isMountedRef.current) return;
      const now = Date.now();
      realtimeReloadWindowStartedAt ??= now;
      if (realtimeReloadTimer) clearTimeout(realtimeReloadTimer);
      const elapsed = now - realtimeReloadWindowStartedAt;
      const wait = Math.max(0, Math.min(delay, 2000 - elapsed));
      realtimeReloadTimer = setTimeout(() => {
        realtimeReloadTimer = null;
        realtimeReloadWindowStartedAt = null;
        if (isMountedRef.current) void guardedLoadEmployeesRef.current?.(true);
      }, wait);
    };
    const markRealtimeChange = () => {
      realtimeChangeGenerationRef.current += 1;
    };
    const debouncedStructureReload = () => {
      markRealtimeChange();
      scheduleRealtimeReload(800);
    };
    const debouncedStatsReload = () => {
      markRealtimeChange();
      scheduleRealtimeReload(2000);
    };
    const updateEmployeeGroups = (updateEmployee: (employee: EmployeeWithAdmin) => EmployeeWithAdmin) => {
      setEmployeeGroups(prev => {
        let groupsChanged = false;
        const nextGroups = prev.map(group => {
          let employeesChanged = false;
          const employees = group.employees.map(employee => {
            const nextEmployee = updateEmployee(employee);
            if (nextEmployee === employee) return employee;
            employeesChanged = true;
            return nextEmployee;
          });
          if (!employeesChanged) return group;
          groupsChanged = true;
          return { ...group, employees };
        });
        return groupsChanged ? nextGroups : prev;
      });
    };
    const getPayloadUserId = (payload: { new: Record<string, unknown>; old: Record<string, unknown> }) => (
      String(payload.new.user_id || payload.old.user_id || '')
    );
    const isVisibleEmployeePayload = (payload: { new: Record<string, unknown>; old: Record<string, unknown> }) => {
      const userId = getPayloadUserId(payload);
      if (!userId) return false;
      return employeeGroupsRef.current.some(group => group.employees.some(employee => employee.id === userId));
    };
    const isTodayOrder = (dateString?: string | null) => {
      if (!dateString) return true;
      const now = new Date();
      const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const timestamp = new Date(dateString).getTime();
      return timestamp >= start && timestamp < start + 24 * 60 * 60 * 1000;
    };
    const hasRelevantEmployeeChange = (payload: {
      eventType: string;
      new: Record<string, unknown>;
      old: Record<string, unknown>;
    }) => {
      const employeeId = String(payload.new.id || payload.old.id || '');
      const currentEmployee = employeeGroupsRef.current
        .flatMap(group => group.employees)
        .find(employee => employee.id === employeeId);
      const nextCreatedBy = String(payload.new.created_by || payload.old.created_by || '');

      if (admin.role === 'secondary_admin' && !currentEmployee && nextCreatedBy !== admin.id) {
        return false;
      }
      if (payload.eventType === 'INSERT' || payload.eventType === 'DELETE') return true;
      if (!currentEmployee) return true;

      const relevantFields = ['username', 'employee_id', 'is_verified', 'is_active', 'remarks', 'tags', 'is_pinned', 'created_by', 'created_at'];
      return relevantFields.some(field =>
        field in payload.new && JSON.stringify(payload.new[field]) !== JSON.stringify((currentEmployee as unknown as Record<string, unknown>)[field])
      );
    };
    const realtimeRecoveryPending = new Set<string>();
    const handleRealtimeStatus = (channelKey: string, status: string) => {
      if (status === 'SUBSCRIBED') {
        if (!realtimeRecoveryPending.delete(channelKey) || !isMountedRef.current) return;
        void guardedLoadEmployeesRef.current?.(true);
        return;
      }

      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        realtimeRecoveryPending.add(channelKey);
        markRealtimeChange();
        scheduleRealtimeReload(1000);
      }
    };

    const adminsSubscription = supabase
      .channel('employee_mgmt_admins')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'admins',
        ...(admin.role === 'secondary_admin' ? { filter: `id=eq.${admin.id}` } : {}),
      }, (payload) => {
        if (admin.role === 'secondary_admin') {
          const changedAdminId = String(
            (payload.new as { id?: unknown }).id || (payload.old as { id?: unknown }).id || '',
          );
          if (changedAdminId !== admin.id) return;
        }
        debouncedStructureReload();
      })
      .subscribe((status) => handleRealtimeStatus('admins', status));

    const usersSubscription = supabase
      .channel('employee_mgmt_users')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'users',
        ...(admin.role === 'secondary_admin' ? { filter: `created_by=eq.${admin.id}` } : {}),
      }, (payload) => {
        if (hasRelevantEmployeeChange(payload)) debouncedStructureReload();
      })
      .subscribe((status) => handleRealtimeStatus('users', status));

    const verificationRequestsSubscription = supabase
      .channel('employee_mgmt_verification_requests')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'verification_requests' }, (payload) => {
        if (isVisibleEmployeePayload(payload)) debouncedStructureReload();
      })
      .subscribe((status) => handleRealtimeStatus('verification_requests', status));

    const presenceEventsSubscription = supabase
      .channel('employee_mgmt_presence_events')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'employee_presence_events',
        ...(admin.role === 'secondary_admin' ? { filter: `admin_id=eq.${admin.id}` } : {}),
      }, (payload) => {
        const userId = String((payload.new as { user_id?: unknown }).user_id || '');
        const workStatus = (payload.new as { status?: unknown }).status;
        markRealtimeChange();
        if (userId && (workStatus === 'online' || workStatus === 'offline')) {
          updateEmployeeGroups(employee => (
            employee.id === userId ? { ...employee, workStatus } : employee
          ));
        }
        scheduleRealtimeReload(800);
      })
      .subscribe((status) => handleRealtimeStatus('employee_presence_events', status));

    const withdrawalsSubscription = supabase
      .channel('employee_mgmt_withdrawals')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'withdrawal_events',
        ...(admin.role === 'secondary_admin' ? { filter: `admin_id=eq.${admin.id}` } : {}),
      }, () => {
        markRealtimeChange();
        scheduleRealtimeReload(500);
      })
      .subscribe((status) => handleRealtimeStatus('withdrawals', status));

    let commissionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let commissionRefreshWindowStartedAt: number | null = null;
    let commissionRefreshRunning = false;
    const pendingCommissionUserIds = new Set<string>();
    const scheduleCommissionRefresh = (userId: string) => {
      pendingCommissionUserIds.add(userId);
      if (commissionRefreshRunning) return;
      const now = Date.now();
      commissionRefreshWindowStartedAt ??= now;
      if (commissionRefreshTimer) clearTimeout(commissionRefreshTimer);
      const elapsed = now - commissionRefreshWindowStartedAt;
      const wait = Math.max(0, Math.min(700, 2000 - elapsed));
      commissionRefreshTimer = setTimeout(async () => {
        commissionRefreshTimer = null;
        commissionRefreshWindowStartedAt = null;
        const userIds = Array.from(pendingCommissionUserIds);
        pendingCommissionUserIds.clear();
        if (userIds.length === 0 || !isMountedRef.current) return;
        commissionRefreshRunning = true;
        const requestGeneration = realtimeChangeGenerationRef.current;

        try {
          const { data, error } = await supabase.rpc('get_today_commission_by_user', { user_ids: userIds });
          if (error) {
            if (isMountedRef.current) debouncedStatsReload();
            return;
          }

          const commissionMap = new Map<string, number>(userIds.map(userId => [userId, 0]));
          (data || []).forEach((row) => {
            commissionMap.set(row.user_id, Number(row.today_commission) || 0);
          });
          if (!isMountedRef.current) return;
          if (requestGeneration !== realtimeChangeGenerationRef.current) {
            debouncedStatsReload();
            return;
          }
          markRealtimeChange();
          updateEmployeeGroups(employee => (
            commissionMap.has(employee.id)
              ? { ...employee, todayCommission: commissionMap.get(employee.id) || 0 }
              : employee
          ));
        } catch {
          if (isMountedRef.current) debouncedStatsReload();
        } finally {
          commissionRefreshRunning = false;
          if (isMountedRef.current && pendingCommissionUserIds.size > 0) {
            const nextUserId = pendingCommissionUserIds.values().next().value;
            if (nextUserId) scheduleCommissionRefresh(nextUserId);
          }
        }
      }, wait);
    };

    const walletTransactionsSubscription = supabase
      .channel('employee_mgmt_wallet_transactions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wallet_transactions', filter: 'type=eq.commission' }, (payload) => {
        if (!isVisibleEmployeePayload(payload)) return;
        const currentRecord = (payload.eventType === 'DELETE' ? payload.old : payload.new) as Record<string, unknown>;
        const previousRecord = payload.old as Record<string, unknown>;
        if (currentRecord.type !== 'commission' && previousRecord.type !== 'commission') return;
        const userId = String(currentRecord.user_id || previousRecord.user_id || '');
        if (userId) scheduleCommissionRefresh(userId);
      })
      .subscribe((status) => handleRealtimeStatus('wallet_transactions', status));

    const walletsSubscription = supabase
      .channel('employee_mgmt_wallets')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wallets' }, (payload) => {
        if (!isVisibleEmployeePayload(payload)) return;
        if (payload.eventType !== 'DELETE' && payload.new && payload.new.user_id) {
          const userId = String(payload.new.user_id);
          const available = Number(payload.new.available_balance) || 0;
          const frozen = Number(payload.new.frozen_balance) || 0;
          markRealtimeChange();
          updateEmployeeGroups(employee => (
            employee.id === userId
              ? { ...employee, walletBalance: available + frozen, accountBalance: available }
              : employee
          ));
          return;
        }
        debouncedStatsReload();
      })
      .subscribe((status) => handleRealtimeStatus('wallets', status));

    const ordersSubscription = supabase
      .channel('employee_mgmt_orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        if (!isVisibleEmployeePayload(payload)) return;
        if (payload.eventType === 'UPDATE' && payload.new && payload.new.user_id) {
          const order = payload.new as unknown as OrderRealtimeData;
          const previousOrder = payload.old as unknown as Partial<OrderRealtimeData>;
          if (!previousOrder.status) {
            debouncedStatsReload();
            return;
          }
          const userId = order.user_id;
          const wasToday = isTodayOrder(previousOrder.created_at);
          const isToday = isTodayOrder(order.created_at);
          const commissionChanged = previousOrder.status !== order.status
            || Number(previousOrder.commission_amount || 0) !== Number(order.commission_amount || 0);
          if (commissionChanged && (wasToday || isToday)) scheduleCommissionRefresh(userId);
          markRealtimeChange();
          updateEmployeeGroups(emp => {
            if (emp.id !== userId) return emp;
            const wasSuccess = previousOrder.status === 'success';
            const isSuccess = order.status === 'success';
            const wasFailed = previousOrder.status === 'failure';
            const isFailed = order.status === 'failure';
            let todayCompletedDelta = 0;
            let failedDelta = 0;
            if (isToday && isSuccess && !wasSuccess) {
              todayCompletedDelta = 1;
            } else if (wasToday && !isSuccess && wasSuccess) {
              todayCompletedDelta = -1;
            }
            if (isToday && isFailed && !wasFailed) failedDelta = 1;
            else if (wasToday && !isFailed && wasFailed) failedDelta = -1;
            return {
              ...emp,
              todayCompletedOrders: Math.max(0, emp.todayCompletedOrders + todayCompletedDelta),
              failedOrders: Math.max(0, emp.failedOrders + failedDelta),
              todayCommission: emp.todayCommission,
            };
          });
          return;
        }
        if (payload.eventType === 'INSERT' && payload.new && payload.new.user_id) {
          const order = payload.new as unknown as OrderRealtimeData;
          const userId = order.user_id;
          const isToday = isTodayOrder(order.created_at);
          if (isToday && order.status === 'success') scheduleCommissionRefresh(userId);
          markRealtimeChange();
          updateEmployeeGroups(emp => {
            if (emp.id !== userId) return emp;
            return {
              ...emp,
              todayOrders: isToday ? emp.todayOrders + 1 : emp.todayOrders,
              totalOrders: emp.totalOrders + 1,
              todayCompletedOrders: isToday && order.status === 'success' ? emp.todayCompletedOrders + 1 : emp.todayCompletedOrders,
              failedOrders: isToday && order.status === 'failure' ? emp.failedOrders + 1 : emp.failedOrders,
              todayCommission: emp.todayCommission,
            };
          });
          return;
        }
        debouncedStatsReload();
      })
      .subscribe((status) => handleRealtimeStatus('orders', status));

    if (!initialLoadStartedRef.current) {
      initialLoadStartedRef.current = true;
      void guardedLoadEmployeesRef.current?.(false);
    } else {
      void guardedLoadEmployeesRef.current?.(true);
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() >= nextAutoRefreshAtRef.current && !loadInProgressRef.current) {
        void guardedLoadEmployeesRef.current?.(true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMountedRef.current = false;
      pendingReloadRef.current = false;
      if (realtimeReloadTimer) clearTimeout(realtimeReloadTimer);
      supabase.removeChannel(adminsSubscription);
      supabase.removeChannel(usersSubscription);
      supabase.removeChannel(verificationRequestsSubscription);
      supabase.removeChannel(presenceEventsSubscription);
      supabase.removeChannel(withdrawalsSubscription);
      supabase.removeChannel(walletsSubscription);
      supabase.removeChannel(walletTransactionsSubscription);
      supabase.removeChannel(ordersSubscription);
      if (commissionRefreshTimer) clearTimeout(commissionRefreshTimer);
      if (resetFeedbackTimeoutRef.current) clearTimeout(resetFeedbackTimeoutRef.current);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (autoRefreshTimerRef.current) clearTimeout(autoRefreshTimerRef.current);
      if (pendingReloadTimerRef.current) clearTimeout(pendingReloadTimerRef.current);
    };
  }, [admin.id, admin.role, isActive, resetAutoRefreshTimer]);

  const formatTime = useCallback((minutes: number): string => {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return `${hours}h ${mins}m`;
  }, []);

  const generatePassword = () => {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < 12; i++) {
      password += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    setFormData({ ...formData, password });
  };

  const openCreateEmployeeForm = (targetAdminId: string) => {
    setFormData(prev => ({ ...prev, dispatchGroupId: '', automationPlanId: '' }));
    setDispatchGroups([]);
    setDispatchGroupsError(null);
    setDispatchGroupsLoading(true);
    setCreateError(null);
    setCreatePlanMenuOpen(false);
    setCreatePlanMenuPosition(null);
    setSelectedAdminForCreate(targetAdminId);
    setShowCreateForm(true);
    setExpandedGroups(prev => new Set(prev).add(targetAdminId));
  };

  const closeCreateEmployeeForm = () => {
    setShowCreateForm(false);
    setCreateError(null);
    setCreatePlanMenuOpen(false);
    setCreatePlanMenuPosition(null);
    setFormData({ username: '', password: '', employeeId: '', remarks: '', dispatchGroupId: '', automationPlanId: '' });
    setSelectedAdminForCreate(null);
  };

  useEffect(() => {
    if (!showCreateForm) return;

    let cancelled = false;
    const loadDispatchGroups = async () => {
      try {
        const { data, error } = await supabase
          .from('dispatch_groups')
          .select('id, group_name, is_default')
          .eq('is_active', true)
          .is('archived_at', null)
          .order('is_default', { ascending: false })
          .order('group_name', { ascending: true });

        if (error) throw error;
        if (!cancelled) setDispatchGroups(data || []);
      } catch (error) {
        if (!cancelled) {
          console.error('Error loading dispatch groups:', formatSupabaseError(error));
          setDispatchGroupsError('無法載入派單分組，請關閉視窗後重試。');
        }
      } finally {
        if (!cancelled) setDispatchGroupsLoading(false);
      }
    };

    void loadDispatchGroups();
    return () => { cancelled = true; };
  }, [showCreateForm]);

  const toggleCreatePlanMenu = (optionCount: number) => {
    if (createPlanMenuOpen) {
      setCreatePlanMenuOpen(false);
      setCreatePlanMenuPosition(null);
      return;
    }

    const button = createPlanButtonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const viewportPadding = 12;
    const menuHeight = Math.min(280, 32 + optionCount * 34);
    const width = Math.min(rect.width, window.innerWidth - viewportPadding * 2);
    const left = Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - width - viewportPadding);
    const openAbove = window.innerHeight - rect.bottom < menuHeight + viewportPadding && rect.top > menuHeight;
    const top = openAbove
      ? Math.max(viewportPadding, rect.top - menuHeight - 8)
      : Math.max(viewportPadding, Math.min(rect.bottom + 8, window.innerHeight - menuHeight - viewportPadding));

    setCreatePlanMenuPosition({ top, left, width });
    setCreatePlanMenuOpen(true);
  };

  useEffect(() => {
    if (!showCreateForm) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (createPlanMenuOpen) {
        setCreatePlanMenuOpen(false);
        setCreatePlanMenuPosition(null);
      } else if (!creating) {
        closeCreateEmployeeForm();
      }
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [showCreateForm, createPlanMenuOpen, creating]);

  useEffect(() => {
    if (!createPlanMenuOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!createPlanButtonRef.current?.contains(target) && !createPlanMenuRef.current?.contains(target)) {
        setCreatePlanMenuOpen(false);
        setCreatePlanMenuPosition(null);
      }
    };
    const closeOnViewportChange = (event: Event) => {
      if (event.type === 'scroll' && createPlanMenuRef.current?.contains(event.target as Node)) return;
      setCreatePlanMenuOpen(false);
      setCreatePlanMenuPosition(null);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [createPlanMenuOpen]);

  const generateResetPassword = () => {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < 12; i++) {
      password += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    setNewPassword(password);
  };

  const guardedLoadEmployees = async (silent: boolean = true): Promise<boolean> => {
    if (loadInProgressRef.current) {
      pendingReloadRef.current = true;
      return false;
    }
    if (pendingReloadTimerRef.current) {
      clearTimeout(pendingReloadTimerRef.current);
      pendingReloadTimerRef.current = null;
    }
    pendingReloadRef.current = false;
    loadInProgressRef.current = true;
    try {
      const committed = await loadEmployees(silent);
      resetAutoRefreshTimer(committed ? AUTO_REFRESH_INTERVAL_MS : AUTO_REFRESH_RETRY_MS);
      return committed;
    } finally {
      loadInProgressRef.current = false;
      if (isMountedRef.current && pendingReloadRef.current) schedulePendingReload();
    }
  };
  guardedLoadEmployeesRef.current = guardedLoadEmployees;

  const loadEmployees = async (silent: boolean = false) => {
    const requestRealtimeGeneration = realtimeChangeGenerationRef.current;
    const requestScopeGeneration = employeeScopeGenerationRef.current;
    const hasExistingGroups = employeeGroupsRef.current.length > 0;
    const showInitialLoading = !silent && !hasExistingGroups;
    let committed = false;
    let superseded = false;

    if (showInitialLoading) {
      setLoadError(null);
      setLoading(true);
    } else {
      setIsRefreshing(true);
    }

    try {
      const sessionToken = getAdminFinancialSessionToken();
      const [employeeSnapshotResult, planAssignmentResult, withdrawalResult] = await Promise.all([
        supabase.rpc('get_employee_management_snapshot', {
          p_admin_session_token: sessionToken,
        }),
        supabase.rpc('get_notification_automation_plan_assignments', {
          p_admin_session_token: sessionToken,
        }),
        supabase.rpc('get_withdrawals_for_admin', {
          p_admin_session_token: sessionToken,
        }),
      ]);
      if (employeeSnapshotResult.error) throw employeeSnapshotResult.error;
      if (withdrawalResult.error) throw withdrawalResult.error;
      if (planAssignmentResult.error && isFinancialAdminSessionError(planAssignmentResult.error)) throw planAssignmentResult.error;

      const snapshot = employeeSnapshotResult.data;
      const planAssignmentSnapshot = planAssignmentResult.error ? null : planAssignmentResult.data as {
        plans?: NotificationAutomationPlan[];
        assignments?: NotificationAutomationPlanAssignment[];
      } | null;
      const hasValidPlanAssignmentSnapshot = Boolean(
        planAssignmentSnapshot
        && Array.isArray(planAssignmentSnapshot.plans)
        && Array.isArray(planAssignmentSnapshot.assignments)
      );
      if (!snapshot || !Array.isArray(snapshot.admins) || !Array.isArray(snapshot.employees)) {
        throw new Error('Employee management snapshot response was invalid.');
      }
      if (planAssignmentResult.error) {
        console.error('Error loading automation plan assignments:', formatSupabaseError(planAssignmentResult.error));
      }

      const adminMap = new Map(snapshot.admins.map(adminInfo => [adminInfo.id, adminInfo]));
      const withdrawalDatesByUser = new Map<string, Set<string>>();
      (withdrawalResult.data || []).forEach(withdrawal => {
        const dates = withdrawalDatesByUser.get(withdrawal.user_id) || new Set<string>();
        dates.add(formatWithdrawalDate(withdrawal.created_at));
        withdrawalDatesByUser.set(withdrawal.user_id, dates);
      });
      const baseGroups = new Map<string, EmployeeGroup>();
      snapshot.admins.forEach(adminInfo => {
        baseGroups.set(adminInfo.id, {
          admin: adminInfo,
          employees: [],
        });
      });

      snapshot.employees.forEach(employee => {
        const adminInfo = adminMap.get(employee.created_by);
        if (!adminInfo) return;

        const workStatus: EmployeeWithAdmin['workStatus'] = employee.workStatus === 'online'
          ? 'online'
          : employee.workStatus === 'offline'
            ? 'offline'
            : 'never_started';
        const pendingWithdrawals = (employee.pendingWithdrawals || []).map(withdrawal => ({
          id: withdrawal.id,
          amount: Number(withdrawal.amount) || 0,
          created_at: withdrawal.created_at,
        }));

        baseGroups.get(adminInfo.id)?.employees.push({
          ...employee,
          admin: adminInfo,
          walletBalance: Number(employee.walletBalance) || 0,
          verification: employee.verification || null,
          todayOrders: Number(employee.todayOrders) || 0,
          todayCompletedOrders: Number(employee.todayCompletedOrders) || 0,
          failedOrders: Number(employee.failedOrders) || 0,
          todayCommission: Number(employee.todayCommission) || 0,
          totalWorkMinutes: Number(employee.totalWorkMinutes) || 0,
          todayWorkMinutes: Number(employee.todayWorkMinutes) || 0,
          workDays: Number(employee.workDays) || 0,
          workStatus,
          totalOrders: Number(employee.totalOrders) || 0,
          accountBalance: Number(employee.accountBalance) || 0,
          hasPendingWithdrawal: Boolean(employee.hasPendingWithdrawal),
          pendingWithdrawalAmount: Number(employee.pendingWithdrawalAmount) || 0,
          pendingWithdrawalDate: employee.pendingWithdrawalDate || null,
          pendingWithdrawals,
          withdrawalDates: Array.from(withdrawalDatesByUser.get(employee.id) || []),
          statsLoaded: true,
        });
      });

      const groupsArray = Array.from(baseGroups.values()).sort((a, b) => {
        if (a.admin.role === 'super_admin' && b.admin.role !== 'super_admin') return -1;
        if (a.admin.role !== 'super_admin' && b.admin.role === 'super_admin') return 1;
        if (a.admin.role === 'secondary_admin' && b.admin.role === 'secondary_admin') {
          if (a.admin.is_pinned && !b.admin.is_pinned) return -1;
          if (!a.admin.is_pinned && b.admin.is_pinned) return 1;
        }
        return a.admin.username.localeCompare(b.admin.username);
      });

      const currentEmployeeCount = employeeGroupsRef.current.reduce((sum, group) => sum + group.employees.length, 0);
      const nextEmployeeCount = groupsArray.reduce((sum, group) => sum + group.employees.length, 0);
      const hasIncompleteSilentResult = silent
        && currentEmployeeCount > 0
        && nextEmployeeCount === 0
        && snapshot.employees.length > 0;
      if (hasIncompleteSilentResult || !isMountedRef.current) return false;
      if (requestScopeGeneration !== employeeScopeGenerationRef.current) {
        superseded = true;
        return false;
      }
      if (requestRealtimeGeneration !== realtimeChangeGenerationRef.current) {
        pendingReloadRef.current = true;
        superseded = true;
        return false;
      }

      const nextAssignmentsByEmployee = hasValidPlanAssignmentSnapshot
        ? new Map<string, NotificationAutomationPlanAssignment>(
            planAssignmentSnapshot!.assignments!.map(assignment => [assignment.user_id, assignment]),
          )
        : null;

      realtimeChangeGenerationRef.current += 1;
      setEmployeeGroups(groupsArray);
      if (hasValidPlanAssignmentSnapshot) {
        setAutomationPlans(planAssignmentSnapshot!.plans!);
        setAutomationAssignmentsByEmployee(nextAssignmentsByEmployee!);
      }
      setAdminPinOverrides(new Map());
      setLoadError(null);
      setLoading(false);
      setStatsLoading(false);
      committed = true;
      setExpandedGroups(prev => {
        if (prev.size === 0) return new Set(groupsArray.slice(0, 1).map(group => group.admin.id));
        return prev;
      });
    } catch (error) {
      if (isFinancialAdminSessionError(error)) {
        void logout(false);
        return false;
      }

      if (!isSupabaseAbortError(error)) {
        console.error('Error loading employees:', formatSupabaseError(error));
      }
      if (isMountedRef.current) {
        setLoadError(hasExistingGroups
          ? '無法更新員工資料，目前顯示上次載入的內容。'
          : '無法載入員工資料，請重試。');
      }
    } finally {
      if (isMountedRef.current) {
        // A superseded first load is always followed by a reload; showing "找不到員工" meanwhile would be wrong.
        if (!superseded || hasExistingGroups) setLoading(false);
        setStatsLoading(false);
        setIsRefreshing(false);
      }
    }
    return committed;
  };

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);

    try {
      if (!formData.username.trim()) throw new Error('使用者名稱為必填');
      if (formData.password.length < 6) throw new Error('密碼至少需要 6 個字元');
      if (!formData.employeeId.trim()) throw new Error('員工 ID 為必填');
      if (dispatchGroupsLoading || dispatchGroupsError) {
        throw new Error(dispatchGroupsError || '派單分組載入中，請稍候再試');
      }
      if (!formData.dispatchGroupId) throw new Error('請先選擇派單分組');
      if (!dispatchGroups.some(group => group.id === formData.dispatchGroupId)) {
        throw new Error('所選派單分組已不可用，請重新選擇');
      }

      const createdBy = admin.role === 'secondary_admin'
        ? admin.id
        : (selectedAdminForCreate || admin.id);

      const createArgs = {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_username: formData.username.trim(),
        p_password: formData.password,
        p_employee_id: formData.employeeId.trim(),
        p_created_by: createdBy,
        p_remarks: formData.remarks.trim(),
        p_automation_plan_id: formData.automationPlanId || null,
        p_dispatch_group_id: formData.dispatchGroupId,
      };
      const { data: result, error } = await supabase.rpc('admin_create_employee_account_with_automation_plan', createArgs);

      if (error) throw error;
      if (!result?.success) throw new Error(result?.error || '建立員工失敗');

      setFormData({ username: '', password: '', employeeId: '', remarks: '', dispatchGroupId: '', automationPlanId: '' });
      setShowCreateForm(false);
      setCreateError(null);
      setSelectedAdminForCreate(null);
      await guardedLoadEmployeesRef.current?.(false);
    } catch (error: unknown) {
      if (isFinancialAdminSessionError(error)) {
        void logout(false);
        return;
      }

      console.error('Error creating employee:', formatSupabaseError(error));
      setCreateError(getCreateEmployeeErrorMessage(
        error,
        formData.username.trim(),
        formData.employeeId.trim(),
      ));
    } finally {
      setCreating(false);
    }
  };

  const handleCreateSecondaryAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateSecondaryAdminError(null);
    setCreatingSecondaryAdmin(true);

    try {
      if (!secondaryAdminForm.username.trim()) throw new Error('使用者名稱為必填');
      if (secondaryAdminForm.password.length < 6) throw new Error('密碼至少需要 6 個字元');

      const { data: result, error } = await supabase.rpc('admin_create_secondary_account', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_username: secondaryAdminForm.username.trim(),
        p_password: secondaryAdminForm.password,
      });

      if (error) throw error;
      if (!result?.success) throw new Error(result?.error || '建立管理員失敗');

      setSecondaryAdminForm({ username: '', password: '' });
      setShowSecondaryAdminPassword(false);
      setShowCreateSecondaryAdmin(false);
      await guardedLoadEmployeesRef.current?.(false);
    } catch (error) {
      console.error('Error creating secondary admin:', formatSupabaseError(error));
      setCreateSecondaryAdminError(formatSupabaseError(error) || '建立次要管理員失敗。');
    } finally {
      setCreatingSecondaryAdmin(false);
    }
  };

  const toggleEmployeeStatus = useCallback(async (employeeId: string, currentStatus: boolean, employeeUsername: string, employeeDisplayId: string) => {
    const newStatus = !currentStatus;
    setConfirmDialog({
      show: true,
      title: `${newStatus ? '啟用' : '停用'}員工`,
      message: `確定要${newStatus ? '啟用' : '停用'}此員工帳戶嗎？`,
      employeeUsername,
      employeeId: employeeDisplayId,
      variant: 'status',
      nextStatus: newStatus,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          setEmployeeGroups(prev => prev.map(g => ({
            ...g,
            employees: g.employees.map(emp => emp.id === employeeId ? { ...emp, is_active: newStatus } : emp)
          })));
          const { error } = await supabase.rpc('admin_update_employee_account', {
            p_admin_session_token: getAdminFinancialSessionToken(),
            p_user_id: employeeId,
            p_updates: { is_active: newStatus },
          });
          if (error) {
            setEmployeeGroups(prev => prev.map(g => ({
              ...g,
              employees: g.employees.map(emp => emp.id === employeeId ? { ...emp, is_active: currentStatus } : emp)
            })));
            throw error;
          }
        } catch (error) {
          console.error('Error toggling employee status:', formatSupabaseError(error));
        }
      }
    });
  }, []);

  const toggleVerification = useCallback(async (employeeId: string, currentStatus: boolean, employeeUsername: string, employeeDisplayId: string) => {
    const newStatus = !currentStatus;
    setConfirmDialog({
      show: true,
      title: `${newStatus ? '驗證' : '取消驗證'}員工`,
      message: `確定要${newStatus ? '驗證' : '取消驗證'}此員工帳戶嗎？`,
      employeeUsername,
      employeeId: employeeDisplayId,
      variant: 'verification',
      nextStatus: newStatus,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          setEmployeeGroups(prev => prev.map(g => ({
            ...g,
            employees: g.employees.map(emp => emp.id === employeeId ? { ...emp, is_verified: newStatus } : emp)
          })));
          const { error } = await supabase.rpc('admin_set_employee_verification', {
            p_admin_session_token: getAdminFinancialSessionToken(),
            p_user_id: employeeId,
            p_is_verified: newStatus,
          });
          if (error) throw error;
        } catch (error) {
          setEmployeeGroups(prev => prev.map(g => ({
            ...g,
            employees: g.employees.map(emp => emp.id === employeeId ? { ...emp, is_verified: currentStatus } : emp)
          })));
          if (isFinancialAdminSessionError(error)) {
            void logout(false);
            return;
          }
          console.error('Error toggling verification:', formatSupabaseError(error));
          void guardedLoadEmployeesRef.current?.(true);
        }
      }
    });
  }, []);

  const handleResetPassword = async (employeeId: string) => {
    if (newPassword.length < 6) {
      setNotification({ show: true, type: 'warning', title: '輸入無效', message: '密碼至少需要 6 個字元' });
      return;
    }

    const passwordTarget = showPasswordReset ?? { username: '—', employeeId: '—' };
    setResettingPassword(true);
    try {
      const { data, error } = await supabase.rpc('admin_reset_employee_password', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_user_id: employeeId,
        p_new_password: newPassword,
      });
      if (error) throw error;
      if (!data) throw new Error('沒有資料列被更新。');
      setShowPasswordReset(null);
      setNewPassword('');
      setShowResetPassword(false);
      setNotification({
        show: true,
        type: 'success',
        category: 'password',
        title: '登入密碼已更新',
        message: '新密碼已安全儲存，舊密碼與既有員工會話已失效。',
        employee: passwordTarget,
        details: [
          { label: '登入密碼', value: '已更新（實際密碼不顯示）' },
          { label: '員工會話', value: '已撤銷，需使用新密碼重新登入' },
        ],
      });
    } catch (error: unknown) {
      if (isFinancialAdminSessionError(error)) {
        void logout(false);
        return;
      }

      setNotification({ show: true, type: 'error', title: '錯誤', message: formatSupabaseError(error) || '重設密碼失敗' });
    } finally {
      setResettingPassword(false);
    }
  };

  const toggleGroup = (adminId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(adminId)) next.delete(adminId);
      else next.add(adminId);
      return next;
    });
  };

  const setAllGroupsExpanded = (expanded: boolean) => {
    if (admin.role !== 'super_admin' || selectedAdminFilter !== 'all') return;
    setExpandedGroups(expanded ? new Set(employeeGroups.map(group => group.admin.id)) : new Set());
  };

  const handleUpdateEmployee = async (employeeId: string, updates: Partial<EmployeeWithAdmin>) => {
    const previousEmployee = employeeGroupsRef.current
      .flatMap(group => group.employees)
      .find(employee => employee.id === employeeId);

    try {
      setEmployeeGroups(prev => prev.map(g => ({
        ...g,
        employees: g.employees.map(emp => emp.id === employeeId ? { ...emp, ...updates } : emp)
      })));
      const allowedUpdates = Object.fromEntries(
        Object.entries(updates).filter(([key, value]) =>
          value !== undefined
          && ['username', 'employee_id', 'is_verified', 'is_active', 'remarks', 'tags', 'is_pinned', 'created_at'].includes(key)
        ),
      );
      const { error } = await supabase.rpc('admin_update_employee_account', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_user_id: employeeId,
        p_updates: allowedUpdates,
      });
      if (error) throw error;
      const updatedEmployee = {
        username: typeof updates.username === 'string' ? updates.username.trim() : previousEmployee?.username || '—',
        employeeId: typeof updates.employee_id === 'string' ? updates.employee_id.trim() : previousEmployee?.employee_id || '—',
      };
      const profileDetails = [
        { label: '使用者名稱', value: updatedEmployee.username },
        { label: '員工 ID', value: updatedEmployee.employeeId },
        { label: '備註', value: typeof updates.remarks === 'string' ? (updates.remarks.trim() || '（空白）') : undefined },
      ].filter((detail): detail is { label: string; value: string } => detail.value !== undefined);
      setEditingEmployee(null);
      setNotification({
        show: true,
        type: 'success',
        category: 'profile',
        title: '員工資料已儲存',
        message: '帳戶資料已成功更新，員工清單與管理檢視已同步最新內容。',
        employee: updatedEmployee,
        details: profileDetails,
      });
    } catch (error) {
      console.error('Error updating employee:', formatSupabaseError(error));
      if (previousEmployee) {
        setEmployeeGroups(prev => prev.map(group => ({
          ...group,
          employees: group.employees.map(employee => employee.id === employeeId ? previousEmployee : employee),
        })));
      }
      setNotification({ show: true, type: 'error', title: '錯誤', message: '更新員工資料失敗，已還原畫面內容' });
      void guardedLoadEmployeesRef.current?.(true);
    }
  };

  const openEmployeeEditor = useCallback((employee: EmployeeWithAdmin) => {
    const planId = automationAssignmentsByEmployee.get(employee.id)?.plan_id || '';
    editingEmployeeInitialRef.current = {
      username: employee.username,
      employeeId: employee.employee_id,
      remarks: employee.remarks || '',
      planId,
    };
    setEditingEmployee(employee);
    setEditingAutomationPlanId(planId);
    setEditingAutomationPlanTouched(false);
    setEditPlanMenuOpen(false);
    setEditPlanMenuPosition(null);
    setEditEmployeeError(null);
  }, [automationAssignmentsByEmployee]);

  const closeEmployeeEditor = () => {
    if (savingEmployeeEdit) return;
    const initial = editingEmployeeInitialRef.current;
    const dirty = Boolean(editingEmployee && initial && (
      editingEmployee.username !== initial.username
      || editingEmployee.employee_id !== initial.employeeId
      || (editingEmployee.remarks || '') !== initial.remarks
      || editingAutomationPlanId !== initial.planId
    ));
    if (dirty && !window.confirm('員工資料或自動化方案尚未儲存，確定要放棄變更嗎？')) return;
    setEditingEmployee(null);
    setEditingAutomationPlanId('');
    setEditingAutomationPlanTouched(false);
    setEditPlanMenuOpen(false);
    setEditPlanMenuPosition(null);
    editingEmployeeInitialRef.current = null;
    setEditEmployeeError(null);
  };

  const toggleEditPlanMenu = (optionCount: number) => {
    if (editPlanMenuOpen) {
      setEditPlanMenuOpen(false);
      setEditPlanMenuPosition(null);
      return;
    }

    const button = editPlanButtonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const viewportPadding = 12;
    const menuHeight = Math.min(280, 32 + optionCount * 34);
    const width = Math.min(rect.width, window.innerWidth - viewportPadding * 2);
    const left = Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - width - viewportPadding);
    const openAbove = window.innerHeight - rect.bottom < menuHeight + viewportPadding && rect.top > menuHeight;
    const top = openAbove
      ? Math.max(viewportPadding, rect.top - menuHeight - 8)
      : Math.max(viewportPadding, Math.min(rect.bottom + 8, window.innerHeight - menuHeight - viewportPadding));

    setEditPlanMenuPosition({ top, left, width });
    setEditPlanMenuOpen(true);
  };

  useEffect(() => {
    if (!editPlanMenuOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!editPlanButtonRef.current?.contains(target) && !editPlanMenuRef.current?.contains(target)) {
        setEditPlanMenuOpen(false);
        setEditPlanMenuPosition(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEditPlanMenuOpen(false);
        setEditPlanMenuPosition(null);
      }
    };
    const closeOnViewportChange = (event: Event) => {
      if (event.type === 'scroll' && editPlanMenuRef.current?.contains(event.target as Node)) return;
      setEditPlanMenuOpen(false);
      setEditPlanMenuPosition(null);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [editPlanMenuOpen]);

  const handleSaveEmployeeEdit = async () => {
    if (!editingEmployee || savingEmployeeEdit) return;

    const username = editingEmployee.username.trim();
    const employeeId = editingEmployee.employee_id.trim();
    if (!username || !employeeId) {
      setEditEmployeeError('使用者名稱與員工 ID 均為必填。');
      return;
    }

    const currentAssignment = automationAssignmentsByEmployee.get(editingEmployee.id);
    const initialPlanId = editingEmployeeInitialRef.current?.planId || null;
    const livePlanId = currentAssignment?.plan_id || null;
    const nextPlanId = editingAutomationPlanId || null;
    const assignmentChanged = editingAutomationPlanTouched && initialPlanId !== nextPlanId;
    if (editingAutomationPlanTouched && livePlanId !== initialPlanId && livePlanId !== nextPlanId) {
      setEditEmployeeError('此員工的自動化方案已被其他管理員更新，請關閉後重新開啟最新資料再修改。');
      return;
    }
    const activeOwnerPlans = automationPlans.filter(plan => (
      plan.status === 'active' && plan.owner_admin_id === editingEmployee.created_by
    ));
    const selectedPlan = nextPlanId
      ? activeOwnerPlans.find(plan => plan.id === nextPlanId)
      : null;
    let profileSaved = false;

    setSavingEmployeeEdit(true);
    setEditEmployeeError(null);

    try {
      const { error: profileError } = await supabase.rpc('admin_update_employee_account', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_user_id: editingEmployee.id,
        p_updates: {
          username,
          employee_id: employeeId,
          remarks: (editingEmployee.remarks || '').trim(),
        },
      });
      if (profileError) throw profileError;
      profileSaved = true;

      if (assignmentChanged) {
        const { data: assignmentResult, error: assignmentError } = await supabase.rpc('set_notification_automation_plan_for_employee', {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_user_id: editingEmployee.id,
          p_plan_id: nextPlanId,
        });
        if (assignmentError) throw assignmentError;
        if (!assignmentResult?.success) throw new Error('自動化方案更新未成功完成。');
      }

      const refreshed = await guardedLoadEmployeesRef.current?.(false);
      if (!refreshed) {
        setEditEmployeeError(assignmentChanged
          ? '員工帳戶資料與自動化方案已儲存，但目前無法重新載入伺服器資料。請保留此視窗並稍後重試。'
          : '員工帳戶資料已儲存，但目前無法重新載入伺服器資料。請保留此視窗並稍後重試。');
        return;
      }

      setEditingEmployee(null);
      setEditingAutomationPlanId('');
      setEditingAutomationPlanTouched(false);
      setEditPlanMenuOpen(false);
      setEditPlanMenuPosition(null);
      editingEmployeeInitialRef.current = null;
      setEditEmployeeError(null);
      setNotification({
        show: true,
        type: 'success',
        category: 'profile',
        title: '員工資料已儲存',
        message: assignmentChanged
          ? '帳戶資料與自動化方案已成功更新，並已從伺服器重新整理。'
          : '帳戶資料已成功更新，並已從伺服器重新整理。',
        employee: { username, employeeId },
        details: [
          { label: '使用者名稱', value: username },
          { label: '員工 ID', value: employeeId },
          { label: '備註', value: editingEmployee.remarks?.trim() || '（空白）' },
          ...(assignmentChanged ? [{
            label: '自動化方案',
            value: selectedPlan?.name || (nextPlanId ? currentAssignment?.plan_name || '已更新' : '不指定方案'),
          }] : []),
        ],
      });
    } catch (error) {
      if (isFinancialAdminSessionError(error)) {
        void logout(false);
        return;
      }

      console.error('Error saving employee and automation plan:', formatSupabaseError(error));
      setEditEmployeeError(profileSaved
        ? `員工帳戶資料已儲存，但自動化方案更新失敗：${formatSupabaseError(error) || '請重試。'}`
        : `員工帳戶資料儲存失敗，自動化方案尚未變更：${formatSupabaseError(error) || '請重試。'}`);
      await guardedLoadEmployeesRef.current?.(true);
    } finally {
      setSavingEmployeeEdit(false);
    }
  };

  useEffect(() => {
    if (!deleteFeedback) return;
    const timer = window.setTimeout(() => setDeleteFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [deleteFeedback]);

  const handleDeleteEmployee = async (employee: EmployeeWithAdmin) => {
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const { data: fastResult, error: fastError } = await supabase.rpc('archive_employee_without_media', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_user_id: employee.id,
      });
      if (fastError && !fastError.message.includes('Notification evidence changed; retry employee deletion.')) throw fastError;
      const result = fastError || fastResult?.requires_audit_service
        ? await mutateAuditedContent('employee_delete', [employee.id])
        : fastResult;
      if (!result?.success) throw new Error('無法刪除員工。');
      setEmployeeGroups(prev => prev.map(g => ({
        ...g,
        employees: g.employees.filter(emp => emp.id !== employee.id)
      })).filter(g => g.employees.length > 0 || g.admin.role === 'super_admin' || g.admin.role === 'secondary_admin'));
      setDeletingEmployee(null);
      setDeleteError(null);
      setDeleteFeedback({ type: 'success', message: `員工「${employee.username}」已刪除。` });
    } catch (error: unknown) {
      if (isFinancialAdminSessionError(error)) {
        void logout(false);
        return;
      }
      if (isSupabaseTransientError(error)) {
        const { data: snapshot, error: refreshError } = await supabase.rpc('get_employee_management_snapshot', {
          p_admin_session_token: getAdminFinancialSessionToken(),
        });
        if (!refreshError && snapshot && Array.isArray(snapshot.admins) && Array.isArray(snapshot.employees)
          && !snapshot.employees.some(item => item.id === employee.id)) {
          setDeletingEmployee(null);
          setDeleteFeedback({ type: 'success', message: `已核對員工「${employee.username}」不在員工列表中。` });
          void guardedLoadEmployeesRef.current?.(true);
          return;
        }
        setDeleteError('請求結果尚未確認，請刷新員工列表核對狀態後再操作。');
        setDeleteFeedback({ type: 'error', message: '刪除結果尚未確認，請刷新員工列表核對後再操作。' });
        void guardedLoadEmployeesRef.current?.(true);
      } else {
        setDeleteError('刪除員工未完成，請重新整理列表核對狀態後再試。');
        setDeleteFeedback({ type: 'error', message: '刪除員工未完成，請重新整理列表核對狀態後再試。' });
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSort = (adminId: string, field: SortField) => {
    const group = employeeGroups.find(item => item.admin.id === adminId);
    if (group?.employees.some(employee => !employee.statsLoaded)) return;

    setSortByGroup(prev => {
      const newMap = new Map(prev);
      const current = newMap.get(adminId);
      if (current?.sortBy === field) {
        if (current.sortDirection === 'desc') {
          newMap.set(adminId, { sortBy: field, sortDirection: 'asc' });
        } else {
          newMap.delete(adminId);
        }
      } else {
        newMap.set(adminId, { sortBy: field, sortDirection: 'desc' });
      }
      return newMap;
    });
  };

  const getSortIcon = (adminId: string, field: SortField) => {
    const s = sortByGroup.get(adminId);
    if (!s || s.sortBy !== field) return <ArrowUpDown className="h-3.5 w-3.5 text-white" />;
    if (s.sortDirection === 'desc') return <ArrowDown className="h-3.5 w-3.5 text-white" />;
    return <ArrowUp className="h-3.5 w-3.5 text-white" />;
  };

  const clearWithdrawalFilter = (adminId: string) => {
    setWithdrawalFilterByGroup(prev => {
      if (!prev.has(adminId)) return prev;
      const next = new Map(prev);
      next.delete(adminId);
      return next;
    });
  };

  const handleSearchTermChange = (nextTerm: string) => {
    const wasSearching = searchTerm.trim().length > 0;
    const isSearching = nextTerm.trim().length > 0;

    if (!wasSearching && isSearching) {
      expandedGroupsBeforeSearchRef.current = new Set(expandedGroups);
    } else if (wasSearching && !isSearching) {
      const previousExpandedGroups = expandedGroupsBeforeSearchRef.current;
      if (previousExpandedGroups) {
        setExpandedGroups(new Set(previousExpandedGroups));
      }
      expandedGroupsBeforeSearchRef.current = null;
    }

    setSearchTerm(nextTerm);
  };

  const clearOtherEmployeeFilters = (adminId: string) => {
    setSortByGroup(prev => {
      const next = new Map(prev);
      next.delete(adminId);
      return next;
    });
    setActiveFilterByGroup(prev => {
      const next = new Map(prev);
      next.delete(adminId);
      return next;
    });
    setWorkStatusFilterByGroup(prev => {
      const next = new Map(prev);
      next.delete(adminId);
      return next;
    });
    setInactiveDaysFilterByGroup(prev => {
      const next = new Map(prev);
      next.delete(adminId);
      return next;
    });
    setSummaryFilterByGroup(prev => {
      const next = new Map(prev);
      next.delete(adminId);
      return next;
    });
    setCreatedDateFilterByGroup(prev => {
      const next = new Map(prev);
      next.delete(adminId);
      return next;
    });
    setFinancialFilterByGroup(prev => {
      const next = new Map(prev);
      next.delete(adminId);
      return next;
    });
    setSelectedTagsByGroup(prev => {
      const next = new Map(prev);
      next.delete(adminId);
      return next;
    });
  };

  const resetEmployeeListFilters = (adminId: string) => {
    handleSearchTermChange('');
    setResetFeedbackAdminId(adminId);
    if (resetFeedbackTimeoutRef.current) clearTimeout(resetFeedbackTimeoutRef.current);
    resetFeedbackTimeoutRef.current = setTimeout(() => {
      setResetFeedbackAdminId(currentId => currentId === adminId ? null : currentId);
      resetFeedbackTimeoutRef.current = null;
    }, 900);
    clearOtherEmployeeFilters(adminId);
    clearWithdrawalFilter(adminId);
    setInactiveDaysDropdownOpen(null);
    setIdleDaysDropdownPos(null);
    setWithdrawalDropdownOpen(null);
    setWithdrawalDropdownPos(null);
    setCreatedDateDropdownOpen(null);
    setCreatedDateDropdownPos(null);
  };

  const handleActiveFilter = (adminId: string, filter: 'all' | 'active' | 'inactive') => {
    clearWithdrawalFilter(adminId);
    setActiveFilterByGroup(prev => {
      const newMap = new Map(prev);
      if (filter === 'all') newMap.delete(adminId);
      else newMap.set(adminId, filter);
      return newMap;
    });
  };

  const getActiveFilter = (adminId: string): 'all' | 'active' | 'inactive' => activeFilterByGroup.get(adminId) || 'all';

  const handleWorkStatusFilter = (adminId: string, status: 'online' | 'offline' | 'never_started') => {
    clearWithdrawalFilter(adminId);
    setWorkStatusFilterByGroup(prev => {
      const newMap = new Map(prev);
      const current = newMap.get(adminId) || new Set<'online' | 'offline' | 'never_started'>();
      const updated = new Set(current);
      if (updated.has(status)) updated.delete(status);
      else updated.add(status);
      if (updated.size === 0) newMap.delete(adminId);
      else newMap.set(adminId, updated);
      return newMap;
    });
  };

  const getWorkStatusFilter = (adminId: string): Set<'online' | 'offline' | 'never_started'> => workStatusFilterByGroup.get(adminId) || new Set();

  const handleSummaryFilter = (adminId: string, filter: SummaryFilter) => {
    clearWithdrawalFilter(adminId);
    setSummaryFilterByGroup(prev => {
      const next = new Map(prev);
      if (next.get(adminId) === filter) next.delete(adminId);
      else next.set(adminId, filter);
      return next;
    });
  };

  const getSummaryFilter = (adminId: string): SummaryFilter | null => summaryFilterByGroup.get(adminId) || null;

  const togglePin = async (employeeId: string, currentPinned: boolean) => {
    const newPinned = !currentPinned;
    setEmployeeGroups(prev => prev.map(g => ({
      ...g,
      employees: g.employees.map(emp => emp.id === employeeId ? { ...emp, is_pinned: newPinned } : emp)
    })));
    try {
      const { error } = await supabase.rpc('admin_update_employee_account', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_user_id: employeeId,
        p_updates: { is_pinned: newPinned },
      });
      if (error) throw error;
    } catch {
      setEmployeeGroups(prev => prev.map(g => ({
        ...g,
        employees: g.employees.map(emp => emp.id === employeeId ? { ...emp, is_pinned: currentPinned } : emp)
      })));
    }
  };

  const toggleAdminPin = async (adminId: string, currentPinned: boolean) => {
    if (pinningAdminId) return;

    const newPinned = !currentPinned;
    setPinningAdminId(adminId);
    setAdminPinOverrides(prev => {
      const next = new Map(prev);
      next.set(adminId, newPinned);
      return next;
    });

    try {
      const { error } = await supabase.rpc('admin_update_admin_account', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_target_admin_id: adminId,
        p_updates: { is_pinned: newPinned },
      });
      if (error) throw error;
    } catch {
      setAdminPinOverrides(prev => {
        const next = new Map(prev);
        next.delete(adminId);
        return next;
      });
    } finally {
      setPinningAdminId(null);
    }
  };

  const handleAddTag = async (employee: EmployeeWithAdmin) => {
    if (!newTag.trim()) return;
    const updatedTags = [...(employee.tags || []), newTag.trim()];
    const tagToAdd = newTag.trim();
    setEmployeeGroups(prev => prev.map(g => ({
      ...g,
      employees: g.employees.map(emp => emp.id === employee.id ? { ...emp, tags: updatedTags } : emp)
    })));
    if (editingTags && editingTags.id === employee.id) setEditingTags({ ...editingTags, tags: updatedTags });
    setNewTag('');
    try {
      const { error } = await supabase.rpc('admin_update_employee_account', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_user_id: employee.id,
        p_updates: { tags: updatedTags },
      });
      if (error) throw error;
    } catch {
      const originalTags = employee.tags || [];
      setEmployeeGroups(prev => prev.map(g => ({
        ...g,
        employees: g.employees.map(emp => emp.id === employee.id ? { ...emp, tags: originalTags } : emp)
      })));
      if (editingTags && editingTags.id === employee.id) setEditingTags({ ...editingTags, tags: originalTags });
      setNewTag(tagToAdd);
    }
  };

  const handleRemoveTag = async (employee: EmployeeWithAdmin, tagToRemove: string) => {
    const updatedTags = (employee.tags || []).filter(tag => tag !== tagToRemove);
    const originalTags = employee.tags || [];
    setEmployeeGroups(prev => prev.map(g => ({
      ...g,
      employees: g.employees.map(emp => emp.id === employee.id ? { ...emp, tags: updatedTags } : emp)
    })));
    if (editingTags && editingTags.id === employee.id) setEditingTags({ ...editingTags, tags: updatedTags });
    try {
      const { error } = await supabase.rpc('admin_update_employee_account', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_user_id: employee.id,
        p_updates: { tags: updatedTags },
      });
      if (error) throw error;
    } catch {
      setEmployeeGroups(prev => prev.map(g => ({
        ...g,
        employees: g.employees.map(emp => emp.id === employee.id ? { ...emp, tags: originalTags } : emp)
      })));
      if (editingTags && editingTags.id === employee.id) setEditingTags({ ...editingTags, tags: originalTags });
    }
  };

  const getGroupTags = (groupId: string) => {
    const group = employeeGroups.find(g => g.admin.id === groupId);
    if (!group) return [];
    const tagsSet = new Set<string>();
    group.employees.forEach(emp => (emp.tags || []).forEach(tag => tagsSet.add(tag)));
    return Array.from(tagsSet).sort();
  };

  const getSelectedTagsForGroup = (groupId: string): string[] => selectedTagsByGroup.get(groupId) || [];

  const setSelectedTagsForGroup = (groupId: string, tags: string[]) => {
    setSelectedTagsByGroup(prev => {
      const newMap = new Map(prev);
      if (tags.length === 0) newMap.delete(groupId);
      else newMap.set(groupId, tags);
      return newMap;
    });
  };

  const sortEmployees = useCallback((employees: EmployeeWithAdmin[], adminId: string) => {
    const sorted = [...employees];
    const groupSort = sortByGroup.get(adminId);
    sorted.sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;
      if (groupSort?.sortBy) {
        if (groupSort.sortBy === 'created_at') {
          const aVal = a.created_at ? new Date(a.created_at).getTime() : 0;
          const bVal = b.created_at ? new Date(b.created_at).getTime() : 0;
          return groupSort.sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        }
        const getSortValue = (employee: EmployeeWithAdmin) => {
          const values: Partial<Record<SortField, number>> = {
            totalOrders: employee.totalOrders,
            todayOrders: employee.todayOrders,
            todayCompletedOrders: employee.todayCompletedOrders,
            failedOrders: employee.failedOrders,
            walletBalance: employee.walletBalance,
            accountBalance: employee.accountBalance,
            todayCommission: employee.todayCommission,
            totalWorkMinutes: employee.totalWorkMinutes,
            todayWorkMinutes: employee.todayWorkMinutes,
            workDays: employee.workDays,
          };
          return values[groupSort.sortBy!] || 0;
        };
        const aVal = getSortValue(a);
        const bVal = getSortValue(b);
        return groupSort.sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }
      return 0;
    });
    return sorted;
  }, [sortByGroup]);

  const getFilteredEmployeesForGroup = useCallback((group: EmployeeGroup, ignoreFinancialFilter = false, ignoreInactiveDaysFilter = false) => {
    const selectedTags = selectedTagsByGroup.get(group.admin.id) || [];
    const activeFilter = activeFilterByGroup.get(group.admin.id) || 'all';
    const workStatusFilter = workStatusFilterByGroup.get(group.admin.id) || new Set<'online' | 'offline' | 'never_started'>();
    const summaryFilter = summaryFilterByGroup.get(group.admin.id) || null;
    const createdDateFilter = createdDateFilterByGroup.get(group.admin.id) || null;
    const financialFilter = ignoreFinancialFilter ? null : financialFilterByGroup.get(group.admin.id) || null;
    const inactiveDaysRange = ignoreInactiveDaysFilter ? null : inactiveDaysFilterByGroup.get(group.admin.id) || null;
    const searchLower = searchTerm.toLowerCase();
    const today = new Date();
    const now = Date.now();

    return sortEmployees(
      group.employees.filter((emp) => {
        const matchesSearch = !searchTerm ||
          emp.username.toLowerCase().includes(searchLower) ||
          emp.employee_id.toLowerCase().includes(searchLower) ||
          (emp.verification?.real_name && emp.verification.real_name.toLowerCase().includes(searchLower)) ||
          (emp.verification?.phone && emp.verification.phone.includes(searchTerm)) ||
          (emp.verification?.email && emp.verification.email.toLowerCase().includes(searchLower)) ||
          (emp.verification?.wallet_address && emp.verification.wallet_address.toLowerCase().includes(searchLower));

        const matchesTags = selectedTags.length === 0 ||
          selectedTags.some(tag => (emp.tags || []).includes(tag));

        const matchesActive =
          activeFilter === 'all' ? true :
          activeFilter === 'active' ? emp.is_active === true :
          emp.is_active === false;

        const matchesWorkStatus = workStatusFilter.size === 0 || workStatusFilter.has(emp.workStatus);
        const matchesSummary = !summaryFilter ||
          (summaryFilter === 'today_working' && emp.todayWorkMinutes > 0) ||
          (summaryFilter === 'new_today' && Boolean(emp.created_at) && new Date(emp.created_at).toDateString() === today.toDateString()) ||
          (summaryFilter === 'currently_working' && emp.workStatus === 'online');

        const matchesInactiveDays = !inactiveDaysRange || (() => {
          if (emp.workStatus !== 'never_started' || !emp.created_at) return false;
          const ageDays = (now - new Date(emp.created_at).getTime()) / (1000 * 60 * 60 * 24);
          switch (inactiveDaysRange) {
            case '2-3': return ageDays > 2 && ageDays <= 3;
            case '3-7': return ageDays > 3 && ageDays <= 7;
            case '7-15': return ageDays > 7 && ageDays <= 15;
            case '15+': return ageDays > 15;
            default: return true;
          }
        })();

        const withdrawalFilter = withdrawalFilterByGroup.get(group.admin.id);
        const matchesWithdrawal = !withdrawalFilter
          || (withdrawalFilter === 'today'
            ? emp.withdrawalDates?.includes(formatWithdrawalDate(today.toISOString()))
            : withdrawalFilter === 'all'
              ? emp.hasPendingWithdrawal
              : emp.pendingWithdrawals?.some(withdrawal => formatWithdrawalDate(withdrawal.created_at) === withdrawalFilter));
        const matchesCreatedDate = !createdDateFilter || getUTCDateKey(emp.created_at) === createdDateFilter;
        const matchesFinancial = !financialFilter
          || (financialFilter === 'wallet' && (emp.walletBalance || 0) > 0)
          || (financialFilter === 'today_commission' && emp.todayCommission > 0);

        return matchesSearch && matchesTags && matchesActive && matchesWorkStatus && matchesSummary && matchesInactiveDays && matchesWithdrawal && matchesCreatedDate && matchesFinancial;
      }),
      group.admin.id
    );
  }, [
    activeFilterByGroup,
    createdDateFilterByGroup,
    financialFilterByGroup,
    inactiveDaysFilterByGroup,
    withdrawalFilterByGroup,
    searchTerm,
    selectedTagsByGroup,
    sortEmployees,
    summaryFilterByGroup,
    workStatusFilterByGroup,
  ]);
  const filteredEmployeeGroups = useMemo(() => employeeGroups.map(group => ({
    ...group,
    employees: getFilteredEmployeesForGroup(group)
  })).filter(group => {
    if (admin.role === 'super_admin' && selectedAdminFilter !== 'all') {
      return group.admin.id === selectedAdminFilter;
    }
    return group.admin.role === 'secondary_admin' || group.admin.role === 'super_admin' || group.employees.length > 0;
  }), [
    employeeGroups,
    admin.role,
    selectedAdminFilter,
    getFilteredEmployeesForGroup,
  ]);

  const filteredGroups = useMemo(() => {
    if (adminPinOverrides.size === 0) return filteredEmployeeGroups;

    const groupsWithOverrides = filteredEmployeeGroups.map(group => {
      const override = adminPinOverrides.get(group.admin.id);
      return override === undefined || override === group.admin.is_pinned
        ? group
        : { ...group, admin: { ...group.admin, is_pinned: override } };
    });

    return [...groupsWithOverrides].sort((a, b) => {
      if (a.admin.role === 'super_admin' && b.admin.role !== 'super_admin') return -1;
      if (a.admin.role !== 'super_admin' && b.admin.role === 'super_admin') return 1;
      if (a.admin.role === 'secondary_admin' && b.admin.role === 'secondary_admin') {
        if (a.admin.is_pinned && !b.admin.is_pinned) return -1;
        if (!a.admin.is_pinned && b.admin.is_pinned) return 1;
      }
      return a.admin.username.localeCompare(b.admin.username);
    });
  }, [filteredEmployeeGroups, adminPinOverrides]);

  useEffect(() => {
    if (!searchTerm) return;
    const groupsWithMatches = filteredEmployeeGroups
      .filter(group => group.employees.length > 0)
      .map(group => group.admin.id);
    setExpandedGroups(prev => {
      if (prev.size === groupsWithMatches.length && groupsWithMatches.every(groupId => prev.has(groupId))) return prev;
      return new Set(groupsWithMatches);
    });
  }, [searchTerm, filteredEmployeeGroups]);

  const flatFilteredEmployees = admin.role === 'secondary_admin' && filteredGroups.length > 0
    ? filteredGroups[0].employees
    : [];

  const flatAdminId = admin.id;

  useLayoutEffect(() => {
    employeeGroupsScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [selectedAdminFilter]);

  const navigateGroupPanel = (direction: -1 | 1) => {
    if (admin.role !== 'super_admin' || selectedAdminFilter !== 'all') return;

    const container = employeeGroupsScrollRef.current;
    if (!container || filteredGroups.length === 0) return;

    const panelsById = new Map(
      Array.from(container.querySelectorAll<HTMLElement>('[data-admin-group-id]'))
        .map(panel => [panel.dataset.adminGroupId, panel] as const)
    );
    const panels = filteredGroups
      .map(group => panelsById.get(group.admin.id))
      .filter((panel): panel is HTMLElement => Boolean(panel));
    if (panels.length === 0) return;

    const containerRect = container.getBoundingClientRect();
    const panelTops = panels.map(panel =>
      panel.getBoundingClientRect().top - containerRect.top + container.scrollTop
    );
    const currentIndex = panelTops.reduce(
      (index, top, panelIndex) => top <= container.scrollTop + 32 ? panelIndex : index,
      0
    );
    const nextIndex = Math.max(0, Math.min(panels.length - 1, currentIndex + direction));

    container.scrollTo({ top: panelTops[nextIndex], behavior: 'smooth' });
  };

  // ===== Render helpers =====

  const renderEmployeeStat = useCallback((employee: EmployeeWithAdmin, value: ReactNode) => (
    employee.statsLoaded ? value : <span className="text-slate-500" title="統計資料載入中">—</span>
  ), []);

  const renderWorkStatusBadge = useCallback((status: 'online' | 'offline' | 'never_started') => {
    if (status === 'online') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-green-500/20 border border-green-500/50">
          <span className="w-1 h-1 rounded-full bg-green-400" />
          <span className="text-xs font-medium text-green-400">上線</span>
        </span>
      );
    }
    if (status === 'offline') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-red-500/20 border border-red-500/50">
          <span className="w-1 h-1 rounded-full bg-red-400" />
          <span className="text-xs font-medium text-red-400">離線</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-slate-500/20 border border-slate-500/50">
        <span className="w-1 h-1 rounded-full bg-slate-400" />
        <span className="text-xs font-medium text-slate-400">新人</span>
      </span>
    );
  }, []);

  const renderSummaryFilterButton = (
    adminId: string,
    filter: SummaryFilter,
    label: string,
    count: number,
  ) => {
    const isSelected = getSummaryFilter(adminId) === filter;
    const styles: Record<SummaryFilter, { active: string; inactive: string; dot: string }> = {
      today_working: {
        active: 'border-emerald-300 bg-emerald-500/85 text-white shadow-md shadow-emerald-950/50 ring-1 ring-emerald-300/35',
        inactive: 'border-emerald-500/50 bg-emerald-950/45 text-emerald-300 hover:border-emerald-300/75 hover:bg-emerald-900/70 hover:text-emerald-100',
        dot: 'bg-emerald-400',
      },
      new_today: {
        active: 'border-sky-300 bg-sky-500/85 text-white shadow-md shadow-sky-950/50 ring-1 ring-sky-300/35',
        inactive: 'border-sky-500/50 bg-sky-950/45 text-sky-300 hover:border-sky-300/75 hover:bg-sky-900/70 hover:text-sky-100',
        dot: 'bg-sky-400',
      },
      currently_working: {
        active: 'border-green-300 bg-green-500/85 text-white shadow-md shadow-green-950/50 ring-1 ring-green-300/35',
        inactive: 'border-green-500/50 bg-green-950/45 text-green-300 hover:border-green-300/75 hover:bg-green-900/70 hover:text-green-100',
        dot: 'bg-green-400',
      },
    };
    const style = styles[filter];

    return (
      <button
        type="button"
        onClick={() => handleSummaryFilter(adminId, filter)}
        aria-pressed={isSelected}
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold tabular-nums transition-all duration-150 ${
          isSelected ? style.active : style.inactive
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${isSelected ? 'bg-white' : style.dot}`} />
        {label}: {count}
      </button>
    );
  };

  const getFinancialFilterCounts = (adminId: string) => {
    const group = employeeGroups.find(item => item.admin.id === adminId);
    if (!group) return { wallet: 0, todayCommission: 0 };
    const employees = getFilteredEmployeesForGroup(group, true);
    return {
      wallet: employees.filter(employee => (employee.walletBalance || 0) > 0).length,
      todayCommission: employees.filter(employee => employee.todayCommission > 0).length,
    };
  };

  const getInactiveDaysFilterCounts = (adminId: string): Record<InactiveDaysRange, number> => {
    const counts: Record<InactiveDaysRange, number> = { '2-3': 0, '3-7': 0, '7-15': 0, '15+': 0 };
    const group = employeeGroups.find(item => item.admin.id === adminId);
    if (!group) return counts;

    const now = Date.now();
    getFilteredEmployeesForGroup(group, false, true).forEach(employee => {
      if (employee.workStatus !== 'never_started' || !employee.created_at) return;
      const ageDays = (now - new Date(employee.created_at).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > 2 && ageDays <= 3) counts['2-3'] += 1;
      else if (ageDays > 3 && ageDays <= 7) counts['3-7'] += 1;
      else if (ageDays > 7 && ageDays <= 15) counts['7-15'] += 1;
      else if (ageDays > 15) counts['15+'] += 1;
    });
    return counts;
  };

  const renderFinancialFilterButton = (
    adminId: string,
    filter: FinancialFilter,
    label: string,
    count: number,
  ) => {
    const isSelected = financialFilterByGroup.get(adminId) === filter;
    const isWallet = filter === 'wallet';

    return (
      <button
        type="button"
        onClick={() => {
          setFinancialFilterByGroup(prev => {
            const next = new Map(prev);
            if (isSelected) next.delete(adminId);
            else next.set(adminId, filter);
            return next;
          });
        }}
        aria-pressed={isSelected}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold transition-all duration-150 ${
          isSelected
            ? isWallet
              ? 'border-violet-200 bg-violet-600 text-white shadow-md shadow-violet-950/50 ring-1 ring-violet-300/35'
              : 'border-amber-200 bg-amber-500 text-amber-950 shadow-md shadow-amber-950/50 ring-1 ring-amber-300/40'
            : isWallet
              ? 'border-violet-600/70 bg-violet-950/45 text-violet-200 hover:border-violet-400/90 hover:bg-violet-900/70 hover:text-white'
              : 'border-amber-600/70 bg-amber-950/45 text-amber-200 hover:border-amber-400/90 hover:bg-amber-900/70 hover:text-amber-50'
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${isSelected ? isWallet ? 'bg-white' : 'bg-amber-950' : isWallet ? 'bg-violet-400' : 'bg-amber-400'}`} />
        <span className="whitespace-nowrap">{label}:</span>
        <span className="min-w-[12px] text-right font-bold tabular-nums">{count}</span>
      </button>
    );
  };

  const renderSortableHeader = (adminId: string, field: SortField, label: string, widthClass = '') => {
    const sortState = sortByGroup.get(adminId);
    const isActive = sortState?.sortBy === field;
    const activeStyles = !isActive
      ? 'text-white hover:bg-blue-500 hover:text-white'
      : sortState?.sortDirection === 'desc'
        ? 'bg-emerald-600 font-bold text-white'
        : 'bg-rose-600 font-bold text-white';

    return (
      <th className={`h-[40px] p-0 text-center text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap ${widthClass}`}>
        <button
          type="button"
          onClick={() => handleSort(adminId, field)}
          className={`flex h-full min-h-0 w-full flex-col items-center justify-center gap-0.5 rounded-none px-1 leading-none transition-all ${activeStyles}`}
        >
          <span>{label}</span>
          <span className="inline-flex h-3.5 items-center justify-center">{getSortIcon(adminId, field)}</span>
        </button>
      </th>
    );
  };

  const [idleDaysDropdownPos, setIdleDaysDropdownPos] = useState<{ top: number; left: number } | null>(null);

  const getCreatedDateOptions = (adminId: string) => {
    const groupEmployees = employeeGroups.find(group => group.admin.id === adminId)?.employees || [];
    const counts = new Map<string, number>();
    groupEmployees.forEach(employee => {
      const dateKey = getUTCDateKey(employee.created_at);
      if (dateKey) counts.set(dateKey, (counts.get(dateKey) || 0) + 1);
    });
    return Array.from(counts, ([date, count]) => ({ date, count }))
      .sort((a, b) => b.date.localeCompare(a.date));
  };

  const renderCreatedDatePortal = (adminId: string) => {
    if (createdDateDropdownOpen !== adminId || !createdDateDropdownPos) return null;
    const options = getCreatedDateOptions(adminId);
    const selectedDate = createdDateFilterByGroup.get(adminId);

    return createPortal(
      <div
        data-created-date-dropdown
        className="fixed z-[9999]"
        style={{ top: createdDateDropdownPos.top, left: createdDateDropdownPos.left }}
      >
        <div className="w-[208px] overflow-hidden rounded-[14px] border border-sky-300/30 bg-[linear-gradient(145deg,rgba(8,22,40,0.98),rgba(5,13,27,0.99))] shadow-[0_18px_50px_rgba(2,8,23,0.72),0_0_0_1px_rgba(56,189,248,0.08)] backdrop-blur-xl">
          <div className="flex items-center gap-2 border-b border-sky-400/15 bg-[linear-gradient(90deg,rgba(14,116,144,0.18),rgba(30,64,175,0.08))] px-2.5 py-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-sky-300/20 bg-sky-400/10 shadow-inner shadow-sky-200/5">
              <CalendarDays className="h-3.5 w-3.5 text-sky-300" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold leading-none tracking-wide text-sky-100">入职日期</p>
              <p className="mt-1 text-[9px] leading-none text-sky-300/60">按日期筛选员工</p>
            </div>
            <span className="text-[9px] font-semibold tabular-nums text-sky-300/65">{options.length} 天</span>
          </div>
          <div ref={createdDateOptionsRef} role="menu" aria-label="入职日期篩選" className="employee-date-menu-scrollbar max-h-[230px] space-y-0.5 overflow-y-auto overscroll-contain p-1.5 pr-1">
            {options.length > 0 ? options.map(({ date, count }) => {
              const isSelected = selectedDate === date;
              return (
                <button
                  key={date}
                  ref={isSelected ? createdDateSelectedOptionRef : undefined}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  onClick={() => {
                    setCreatedDateFilterByGroup(prev => {
                      const next = new Map(prev);
                      if (isSelected) next.delete(adminId);
                      else next.set(adminId, date);
                      return next;
                    });
                    setCreatedDateDropdownOpen(null);
                    setCreatedDateDropdownPos(null);
                  }}
                  className={`group relative flex h-7 w-full items-center gap-2 overflow-hidden rounded-md border px-2 text-[10px] font-semibold transition-all duration-150 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 ${
                    isSelected
                      ? 'border-sky-300/55 bg-gradient-to-r from-sky-600/85 via-cyan-600/75 to-blue-600/70 text-white shadow-[0_4px_14px_rgba(14,165,233,0.2)]'
                      : 'border-transparent bg-white/[0.025] text-slate-300 hover:border-sky-400/25 hover:bg-sky-400/10 hover:text-sky-50'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all ${isSelected ? 'bg-white shadow-[0_0_7px_rgba(255,255,255,0.8)]' : 'bg-sky-400/65 group-hover:bg-sky-300'}`} />
                  <span className="min-w-0 flex-1 text-left font-mono tabular-nums tracking-wide">{date}</span>
                  <span className={`min-w-[30px] text-right text-[9px] font-bold tabular-nums ${isSelected ? 'text-white' : 'text-sky-300/75 group-hover:text-sky-200'}`}>
                    {count} 人
                  </span>
                  {isSelected && <CheckCircle className="h-3 w-3 shrink-0 text-sky-100" />}
                </button>
              );
            }) : (
              <p className="px-2 py-5 text-center text-[10px] text-slate-500">暫無入职记录</p>
            )}
          </div>
          {selectedDate && (
            <div className="flex h-[34px] items-stretch border-t border-rose-400/25 bg-[linear-gradient(90deg,rgba(76,5,25,0.4),rgba(30,10,30,0.3))]">
              <div className="flex min-w-0 flex-1 flex-col justify-center px-2 py-1">
                <p className="text-[7px] font-bold uppercase leading-none tracking-[0.12em] text-rose-300/65">当前筛选</p>
                <p className="mt-1 truncate font-mono text-[9px] font-semibold leading-none tabular-nums text-rose-100/90">{selectedDate}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCreatedDateFilterByGroup(prev => {
                    const next = new Map(prev);
                    next.delete(adminId);
                    return next;
                  });
                  setCreatedDateDropdownOpen(null);
                  setCreatedDateDropdownPos(null);
                }}
                className="inline-flex min-w-[68px] shrink-0 items-center justify-center gap-1.5 border-l border-rose-300/35 bg-rose-600 px-3 text-[11px] font-bold text-white shadow-[-5px_0_16px_rgba(190,18,60,0.18)] transition-colors hover:bg-rose-500 active:bg-rose-700 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60"
              >
                <X className="h-3.5 w-3.5" />
                清除
              </button>
            </div>
          )}
        </div>
      </div>,
      document.body
    );
  };

  const handleCreatedDateClick = (adminId: string, event: React.MouseEvent<HTMLButtonElement>) => {
    if (createdDateDropdownOpen === adminId) {
      setCreatedDateDropdownOpen(null);
      setCreatedDateDropdownPos(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 208;
    const menuHeight = Math.min(316, 52 + getCreatedDateOptions(adminId).length * 30 + (createdDateFilterByGroup.has(adminId) ? 34 : 0));
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menuWidth - 8));
    const top = window.innerHeight - rect.bottom < menuHeight + 8
      ? Math.max(8, rect.top - menuHeight - 6)
      : rect.bottom + 6;
    setInactiveDaysDropdownOpen(null);
    setIdleDaysDropdownPos(null);
    setWithdrawalDropdownOpen(null);
    setWithdrawalDropdownPos(null);
    setCreatedDateDropdownPos({ top, left });
    setCreatedDateDropdownOpen(adminId);
  };

  const getWithdrawalDateOptions = (adminId: string) => {
    const groupEmployees = employeeGroups.find(group => group.admin.id === adminId)?.employees || [];
    const counts = new Map<string, Set<string>>();
    groupEmployees.forEach(employee => {
      employee.pendingWithdrawals?.forEach(withdrawal => {
        const date = formatWithdrawalDate(withdrawal.created_at);
        const users = counts.get(date) || new Set<string>();
        users.add(employee.id);
        counts.set(date, users);
      });
    });
    return Array.from(counts, ([date, users]) => ({ date, count: users.size }))
      .sort((left, right) => right.date.localeCompare(left.date));
  };

  const renderWithdrawalPortal = (adminId: string) => {
    if (withdrawalDropdownOpen !== adminId || !withdrawalDropdownPos) return null;
    const groupEmployees = employeeGroups.find(group => group.admin.id === adminId)?.employees || [];
    const selected = withdrawalFilterByGroup.get(adminId);
    const todayKey = formatWithdrawalDate(new Date().toISOString());
    const todayCount = groupEmployees.filter(employee => employee.withdrawalDates?.includes(todayKey)).length;
    const pendingCount = groupEmployees.filter(employee => employee.hasPendingWithdrawal).length;
    const options = getWithdrawalDateOptions(adminId);

    const select = (value: string) => {
      if (selected !== value) clearOtherEmployeeFilters(adminId);
      setWithdrawalFilterByGroup(prev => {
        const next = new Map(prev);
        if (selected === value) next.delete(adminId);
        else next.set(adminId, value);
        return next;
      });
      setWithdrawalDropdownOpen(null);
      setWithdrawalDropdownPos(null);
    };

    return createPortal(
      <div data-withdrawal-dropdown className="fixed z-[9999]" style={{ top: withdrawalDropdownPos.top, left: withdrawalDropdownPos.left }}>
        <div role="menu" aria-label="提现日期筛选" className="w-[180px] overflow-hidden rounded-xl border border-orange-400/60 bg-[#120e0d] shadow-[0_18px_36px_rgba(0,0,0,0.65)]">
          <div className="flex items-center gap-2 border-b border-orange-400/20 bg-orange-950/70 px-3 py-2">
            <Wallet className="h-4 w-4 text-orange-300" />
            <span className="flex-1 text-[11px] font-bold text-orange-100">提现日期筛选</span>
          </div>
          <div className="space-y-1 p-1.5">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={selected === 'today'}
              onClick={() => select('today')}
              className={`flex h-7 w-full items-center gap-2 rounded-lg border px-2 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ${selected === 'today' ? 'border-emerald-200 bg-emerald-600 text-white shadow-[0_3px_12px_rgba(5,150,105,0.4)]' : 'border-emerald-500/55 bg-emerald-950/65 text-emerald-100 hover:border-emerald-300/85 hover:bg-emerald-800/70 hover:text-white'}`}
            >
              <span className="min-w-0 flex-1 text-left">今天提现人数</span>
              <span className="tabular-nums">{todayCount} 人</span>
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={selected === 'all'}
              onClick={() => select('all')}
              className={`flex h-7 w-full items-center gap-2 rounded-lg border px-2 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${selected === 'all' ? 'border-violet-200 bg-violet-600 text-white shadow-[0_3px_12px_rgba(124,58,237,0.4)]' : 'border-violet-500/55 bg-violet-950/65 text-violet-100 hover:border-violet-300/85 hover:bg-violet-800/70 hover:text-white'}`}
            >
              <span className="min-w-0 flex-1 text-left">全部提现中</span>
              <span className="tabular-nums">{pendingCount} 人</span>
            </button>
          </div>
          <div className="employee-date-menu-scrollbar max-h-[210px] space-y-1 overflow-y-auto border-t border-orange-400/15 p-1.5">
            {options.length > 0 ? options.map(({ date, count }) => (
              <button
                key={date}
                type="button"
                role="menuitemradio"
                aria-checked={selected === date}
                onClick={() => select(date)}
                className={`flex h-7 w-full items-center gap-2 rounded-lg border px-2 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 ${selected === date ? 'border-orange-200 bg-orange-500 text-white shadow-[0_3px_12px_rgba(249,115,22,0.35)]' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-orange-400/75 hover:bg-orange-900/45 hover:text-orange-50'}`}
              >
                <span className="min-w-0 flex-1 text-left font-mono tabular-nums">{date}</span>
                <span className="tabular-nums">{count} 人</span>
              </button>
            )) : <p className="py-3 text-center text-[10px] text-slate-400">暂无提现中记录</p>}
          </div>
          {selected && (
            <div className="flex h-[34px] items-stretch border-t border-rose-400/25 bg-[linear-gradient(90deg,rgba(76,5,25,0.4),rgba(30,10,30,0.3))]">
              <div className="flex min-w-0 flex-1 flex-col justify-center px-2 py-1">
                <p className="text-[7px] font-bold uppercase leading-none tracking-[0.12em] text-rose-300/65">当前筛选</p>
                <p className="mt-1 truncate text-[9px] font-semibold leading-none text-rose-100/90" title={selected === 'today' ? '今天提现人数' : selected === 'all' ? '全部提现中' : selected}>
                  {selected === 'today' ? '今天提现人数' : selected === 'all' ? '全部提现中' : selected}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  clearWithdrawalFilter(adminId);
                  setWithdrawalDropdownOpen(null);
                  setWithdrawalDropdownPos(null);
                }}
                className="inline-flex min-w-[68px] shrink-0 items-center justify-center gap-1.5 border-l border-rose-300/35 bg-rose-600 px-3 text-[11px] font-bold text-white shadow-[-5px_0_16px_rgba(190,18,60,0.18)] transition-colors hover:bg-rose-500 active:bg-rose-700 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60"
              >
                <X className="h-3.5 w-3.5" />
                清除
              </button>
            </div>
          )}
        </div>
      </div>,
      document.body,
    );
  };

  const handleWithdrawalClick = (adminId: string, event: React.MouseEvent<HTMLButtonElement>) => {
    if (withdrawalDropdownOpen === adminId) {
      setWithdrawalDropdownOpen(null);
      setWithdrawalDropdownPos(null);
      return;
    }
    const rect = event.currentTarget.parentElement!.getBoundingClientRect();
    const menuWidth = 180;
    const optionCount = getWithdrawalDateOptions(adminId).length;
    const menuHeight = 105 + (optionCount ? Math.min(210, 9 + optionCount * 32) : 49) + (withdrawalFilterByGroup.has(adminId) ? 34 : 0);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menuWidth - 8));
    const top = window.innerHeight - rect.bottom < menuHeight + 8
      ? Math.max(8, rect.top - menuHeight - 6)
      : rect.bottom + 6;
    setInactiveDaysDropdownOpen(null);
    setIdleDaysDropdownPos(null);
    setCreatedDateDropdownOpen(null);
    setCreatedDateDropdownPos(null);
    setWithdrawalDropdownPos({ top, left });
    setWithdrawalDropdownOpen(adminId);
  };

  const renderIdleDaysPortal = (adminId: string) => {
    if (inactiveDaysDropdownOpen !== adminId || !idleDaysDropdownPos) return null;
    const items = [
      { key: '2-3' as InactiveDaysRange, label: '2～3 天', accent: 'bg-sky-400', badge: 'border-sky-400/35 bg-sky-500/10 text-sky-200' },
      { key: '3-7' as InactiveDaysRange, label: '3～7 天', accent: 'bg-emerald-400', badge: 'border-emerald-400/35 bg-emerald-500/10 text-emerald-200' },
      { key: '7-15' as InactiveDaysRange, label: '7～15 天', accent: 'bg-amber-400', badge: 'border-amber-400/35 bg-amber-500/10 text-amber-200' },
      { key: '15+' as InactiveDaysRange, label: '15 天以上', accent: 'bg-rose-400', badge: 'border-rose-400/35 bg-rose-500/10 text-rose-200' },
    ];
    const selectedRange = inactiveDaysFilterByGroup.get(adminId);
    const selectedRangeLabel = items.find(item => item.key === selectedRange)?.label;
    const rangeCounts = getInactiveDaysFilterCounts(adminId);
    return createPortal(
      <div
        data-inactive-days-dropdown
        className="fixed z-[9999]"
        style={{ top: idleDaysDropdownPos.top, left: idleDaysDropdownPos.left }}
      >
        <div className="w-[190px] overflow-hidden rounded-xl border border-[#4d8b5c] bg-[#07150b] shadow-2xl shadow-black/70 ring-1 ring-inset ring-emerald-200/10">
          <div role="menu" aria-label="停工天数篩選" className="space-y-1 bg-[#07150b] p-1.5">
            {items.map(({ key, label, accent, badge }, index) => {
              const isSelected = selectedRange === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  onClick={() => {
                    clearWithdrawalFilter(adminId);
                    setInactiveDaysFilterByGroup(prev => {
                      const newMap = new Map(prev);
                      if (isSelected) newMap.delete(adminId);
                      else newMap.set(adminId, key);
                      return newMap;
                    });
                    setInactiveDaysDropdownOpen(null);
                    setIdleDaysDropdownPos(null);
                  }}
                  className={`group relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-lg border px-2 text-left text-[11px] font-semibold transition-all duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 ${
                    isSelected
                      ? 'border-emerald-300/80 bg-gradient-to-r from-emerald-700 to-green-600 text-white shadow-md shadow-emerald-950/40'
                      : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <span className={`absolute bottom-1.5 left-0 top-1.5 w-1 rounded-r-full ${isSelected ? 'bg-emerald-100' : accent}`} />
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[10px] font-bold tabular-nums ${isSelected ? 'border-white/30 bg-white/15 text-white' : badge}`}>
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className={`min-w-[34px] text-right text-[10px] font-bold tabular-nums ${isSelected ? 'text-white' : 'text-emerald-200/80'}`}>
                    {rangeCounts[key]} 人
                  </span>
                  {isSelected ? (
                    <CheckCircle className="h-3.5 w-3.5 shrink-0 text-emerald-100" />
                  ) : (
                    <span className={`h-2 w-2 shrink-0 rounded-full border-2 border-[#07150b] ${accent}`} />
                  )}
                </button>
              );
            })}
          </div>
          {selectedRange && (
            <div className="flex h-[34px] items-stretch border-t border-rose-400/25 bg-[linear-gradient(90deg,rgba(76,5,25,0.4),rgba(30,10,30,0.3))]">
              <div className="flex min-w-0 flex-1 flex-col justify-center px-2 py-1">
                <p className="text-[7px] font-bold uppercase leading-none tracking-[0.12em] text-rose-300/65">当前筛选</p>
                <p className="mt-1 truncate text-[9px] font-semibold leading-none text-rose-100/90">{selectedRangeLabel}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setInactiveDaysFilterByGroup(prev => {
                    const newMap = new Map(prev);
                    newMap.delete(adminId);
                    return newMap;
                  });
                  setInactiveDaysDropdownOpen(null);
                  setIdleDaysDropdownPos(null);
                }}
                className="inline-flex min-w-[58px] shrink-0 items-center justify-center gap-1 border-l border-rose-300/35 bg-rose-600 px-2 text-[10px] font-bold text-white shadow-[-5px_0_16px_rgba(190,18,60,0.18)] transition-colors hover:bg-rose-500 active:bg-rose-700 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60"
              >
                <X className="h-3 w-3" />
                清除
              </button>
            </div>
          )}
        </div>
      </div>,
      document.body
    );
  };

  const handleIdleDaysClick = (adminId: string, e: React.MouseEvent<HTMLButtonElement>) => {
    if (inactiveDaysDropdownOpen === adminId) {
      setInactiveDaysDropdownOpen(null);
      setIdleDaysDropdownPos(null);
    } else {
      setCreatedDateDropdownOpen(null);
      setCreatedDateDropdownPos(null);
      setWithdrawalDropdownOpen(null);
      setWithdrawalDropdownPos(null);
      const rect = e.currentTarget.getBoundingClientRect();
      const menuWidth = 190;
      const menuHeight = 194;
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menuWidth - 8));
      const top = window.innerHeight - rect.bottom < menuHeight + 8
        ? Math.max(8, rect.top - menuHeight - 6)
        : rect.bottom + 6;
      setIdleDaysDropdownPos({ top, left });
      setInactiveDaysDropdownOpen(adminId);
    }
  };

  const renderStatusFilterButtons = (adminId: string) => {
    const groupEmployees = employeeGroups.find(group => group.admin.id === adminId)?.employees || [];
    if (groupEmployees.some(employee => !employee.statsLoaded)) {
      return <span className="px-2 text-[10px] font-medium text-slate-500">統計資料載入中……</span>;
    }

    const currentActive = getActiveFilter(adminId);
    const currentWorkStatus = getWorkStatusFilter(adminId);
    const hasIdleFilter = inactiveDaysFilterByGroup.has(adminId);
    const selectedWithdrawal = withdrawalFilterByGroup.get(adminId);
    const selectedCreatedDate = createdDateFilterByGroup.get(adminId);
    const pendingWithdrawalCount = groupEmployees.filter(employee => employee.hasPendingWithdrawal).length;

    const on = 'text-white font-semibold shadow-md border border-transparent';
    const dim = 'bg-slate-800/60 border border-slate-600/50 font-medium';

    return (
      <div className="flex gap-1 flex-wrap items-center">
        {/* Account status: ALL / Active / Off */}
        <button
          onClick={() => handleActiveFilter(adminId, 'all')}
          className={`px-2 py-0.5 rounded text-[11px] transition-all ${
            currentActive === 'all'
              ? `bg-blue-500 ${on}`
              : `${dim} text-slate-400 hover:text-blue-300 hover:border-blue-500/40`
          }`}
        >全部</button>
        <button
          onClick={() => handleActiveFilter(adminId, 'active')}
          className={`px-2 py-0.5 rounded text-[11px] transition-all flex items-center gap-1 ${
            currentActive === 'active'
              ? `bg-emerald-500 ${on}`
              : `${dim} text-slate-400 hover:text-emerald-300 hover:border-emerald-500/40`
          }`}
        >
          <span className={`w-1 h-1 rounded-full ${currentActive === 'active' ? 'bg-white' : 'bg-emerald-600'}`} />
          啟用
        </button>
        <button
          onClick={() => handleActiveFilter(adminId, 'inactive')}
          className={`px-2 py-0.5 rounded text-[11px] transition-all flex items-center gap-1 ${
            currentActive === 'inactive'
              ? `bg-red-500 ${on}`
              : `${dim} text-slate-400 hover:text-red-300 hover:border-red-500/40`
          }`}
        >
          <span className={`w-1 h-1 rounded-full ${currentActive === 'inactive' ? 'bg-white' : 'bg-red-600'}`} />
          停用
        </button>

        <div className="w-px h-4 bg-slate-600 shrink-0 mx-1" />

        {/* Work status: ALL / Online / Offline / Never Started */}
        <button
          onClick={() => {
            clearWithdrawalFilter(adminId);
            setWorkStatusFilterByGroup(prev => {
              const newMap = new Map(prev);
              newMap.delete(adminId);
              return newMap;
            });
          }}
          className={`px-2 py-0.5 rounded text-[11px] transition-all ${
            currentWorkStatus.size === 0
              ? `bg-blue-500 ${on}`
              : `${dim} text-slate-400 hover:text-blue-300 hover:border-blue-500/40`
          }`}
        >全部</button>
        <button
          onClick={() => handleWorkStatusFilter(adminId, 'online')}
          className={`px-2 py-0.5 rounded text-[11px] transition-all flex items-center gap-1 ${
            currentWorkStatus.has('online')
              ? `bg-green-500 ${on}`
              : `${dim} text-slate-400 hover:text-green-300 hover:border-green-500/40`
          }`}
        >
          <span className={`w-1 h-1 rounded-full ${currentWorkStatus.has('online') ? 'bg-white' : 'bg-green-600'}`} />
          上線
        </button>
        <button
          onClick={() => handleWorkStatusFilter(adminId, 'offline')}
          className={`px-2 py-0.5 rounded text-[11px] transition-all flex items-center gap-1 ${
            currentWorkStatus.has('offline')
              ? `bg-red-500 ${on}`
              : `${dim} text-slate-400 hover:text-red-300 hover:border-red-500/40`
          }`}
        >
          <span className={`w-1 h-1 rounded-full ${currentWorkStatus.has('offline') ? 'bg-white' : 'bg-red-600'}`} />
          離線
        </button>
        <button
          onClick={() => handleWorkStatusFilter(adminId, 'never_started')}
          className={`px-2 py-0.5 rounded text-[11px] transition-all flex items-center gap-1 ${
            currentWorkStatus.has('never_started')
              ? `bg-amber-500 ${on}`
              : `${dim} text-slate-400 hover:text-amber-300 hover:border-amber-500/40`
          }`}
        >
          <span className={`w-1 h-1 rounded-full ${currentWorkStatus.has('never_started') ? 'bg-white' : 'bg-amber-600'}`} />
          從未開始
        </button>

        <div className="w-px h-4 bg-slate-600 shrink-0 mx-1" />

        {/* Withdrawing */}
        <div data-withdrawal-dropdown className="ml-2 inline-flex items-center">
          <div className={`inline-flex h-8 w-[180px] shrink-0 overflow-hidden rounded-lg border shadow-md transition-all ${selectedWithdrawal ? 'border-orange-200 bg-orange-600 shadow-orange-950/50' : 'border-orange-500/70 bg-orange-950/55 shadow-orange-950/30 hover:border-orange-300/90 hover:bg-orange-900/75'}`}>
            <button
              type="button"
              onClick={event => handleWithdrawalClick(adminId, event)}
              aria-haspopup="menu"
              aria-expanded={withdrawalDropdownOpen === adminId}
              className="inline-flex h-full min-w-0 flex-1 items-center justify-center gap-1 px-1.5 text-[11px] font-semibold text-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
            >
              <Wallet className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate whitespace-nowrap text-center">{selectedWithdrawal === 'today' ? '今天提现人数' : selectedWithdrawal && selectedWithdrawal !== 'all' ? selectedWithdrawal : '提現中'}</span>
              <span className={`inline-flex h-5 min-w-6 shrink-0 items-center justify-center rounded-full border px-1.5 text-center text-[10px] font-extrabold tabular-nums leading-none shadow-[0_0_10px_rgba(251,146,60,0.45)] ${selectedWithdrawal ? 'border-white/80 bg-white text-orange-800' : 'border-orange-100 bg-orange-400 text-orange-950'}`}>
                {selectedWithdrawal === 'today'
                  ? groupEmployees.filter(employee => employee.withdrawalDates?.includes(formatWithdrawalDate(new Date().toISOString()))).length
                  : selectedWithdrawal && selectedWithdrawal !== 'all'
                    ? getWithdrawalDateOptions(adminId).find(option => option.date === selectedWithdrawal)?.count || 0
                    : pendingWithdrawalCount}
              </span>
              <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${withdrawalDropdownOpen === adminId ? 'rotate-180' : ''}`} />
            </button>
            {selectedWithdrawal && (
              <button
                type="button"
                onClick={() => {
                  clearWithdrawalFilter(adminId);
                  setWithdrawalDropdownOpen(null);
                  setWithdrawalDropdownPos(null);
                }}
                aria-label="清除提现筛选"
                className="inline-flex h-full w-8 shrink-0 items-center justify-center border-l border-blue-200/40 bg-blue-600 text-white hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        {renderWithdrawalPortal(adminId)}

        {/* Idle Days */}
        <div data-inactive-days-dropdown className="ml-2 inline-flex items-center">
          <div className={`inline-flex h-8 w-[180px] shrink-0 overflow-hidden rounded-lg border shadow-sm transition-all ${
            hasIdleFilter
              ? 'border-emerald-400/90 bg-emerald-900/90 shadow-emerald-950/40'
              : inactiveDaysDropdownOpen === adminId
                ? 'border-emerald-500/80 bg-emerald-950 shadow-emerald-950/30'
                : 'border-emerald-700/70 bg-slate-900 hover:border-emerald-500/80 hover:bg-emerald-950'
          }`}>
            <button
              type="button"
              onClick={(e) => handleIdleDaysClick(adminId, e)}
              aria-haspopup="menu"
              aria-expanded={inactiveDaysDropdownOpen === adminId}
              className={`flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-2.5 text-[11px] font-semibold transition-all active:scale-[0.98] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70 ${
                hasIdleFilter
                  ? 'bg-emerald-800 text-emerald-50 hover:bg-emerald-700'
                  : inactiveDaysDropdownOpen === adminId
                    ? 'bg-emerald-950 text-emerald-100'
                    : 'text-emerald-200 hover:bg-emerald-950 hover:text-emerald-100'
              }`}
            >
              <Timer className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {hasIdleFilter
                  ? (() => {
                      const r = inactiveDaysFilterByGroup.get(adminId);
                      return r === '2-3' ? '停工 2-3 天' : r === '3-7' ? '停工 3-7 天' : r === '7-15' ? '停工 7-15 天' : '停工 15 天以上';
                    })()
                  : '停工天数'
                }
              </span>
              <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${inactiveDaysDropdownOpen === adminId ? 'rotate-180' : ''}`} />
            </button>
            {hasIdleFilter && (
              <button
                type="button"
                onClick={() => {
                  setInactiveDaysFilterByGroup(prev => {
                    const next = new Map(prev);
                    next.delete(adminId);
                    return next;
                  });
                  setInactiveDaysDropdownOpen(null);
                  setIdleDaysDropdownPos(null);
                }}
                aria-label="清除停工天数篩選"
                title="清除停工天数篩選"
                className="inline-flex h-full w-8 shrink-0 items-center justify-center border-l border-rose-200/30 bg-rose-600 text-white transition-colors hover:bg-rose-500 active:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200/80"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        {renderIdleDaysPortal(adminId)}

        <div data-created-date-dropdown className="ml-2 inline-flex items-center">
          <div className={`inline-flex h-8 w-[178px] shrink-0 overflow-hidden rounded-lg border shadow-sm transition-all ${
            selectedCreatedDate
              ? 'border-sky-300/90 bg-sky-800 shadow-sky-950/40'
              : createdDateDropdownOpen === adminId
                ? 'border-sky-400/80 bg-sky-950 shadow-sky-950/30'
                : 'border-sky-700/70 bg-slate-900 hover:border-sky-500/80 hover:bg-sky-950'
          }`}>
            <button
              type="button"
              onClick={(event) => handleCreatedDateClick(adminId, event)}
              aria-haspopup="menu"
              aria-expanded={createdDateDropdownOpen === adminId}
              className={`flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-2.5 text-[11px] font-semibold transition-all active:scale-[0.98] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 ${
                selectedCreatedDate
                  ? 'bg-sky-700 text-white hover:bg-sky-600'
                  : createdDateDropdownOpen === adminId
                    ? 'bg-sky-950 text-sky-100'
                    : 'text-sky-200 hover:bg-sky-950 hover:text-sky-100'
              }`}
            >
              <CalendarDays className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate tabular-nums">{selectedCreatedDate || '入职日期'}</span>
              <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${createdDateDropdownOpen === adminId ? 'rotate-180' : ''}`} />
            </button>
            {selectedCreatedDate && (
              <button
                type="button"
                onClick={() => {
                  setCreatedDateFilterByGroup(prev => {
                    const next = new Map(prev);
                    next.delete(adminId);
                    return next;
                  });
                  setCreatedDateDropdownOpen(null);
                  setCreatedDateDropdownPos(null);
                }}
                aria-label="清除入职日期篩選"
                title="清除入职日期篩選"
                className="inline-flex h-full w-8 shrink-0 items-center justify-center border-l border-rose-200/30 bg-rose-600 text-white transition-colors hover:bg-rose-500 active:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200/80"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        {renderCreatedDatePortal(adminId)}

        <button
          type="button"
          onClick={() => resetEmployeeListFilters(adminId)}
          title="取消全部选中"
          aria-label="取消全部选中"
          className={`ml-3 inline-flex h-8 min-w-[142px] items-center justify-center gap-1.5 rounded-lg border border-blue-300/80 px-3.5 py-1 text-[11px] font-semibold text-white shadow-sm transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/70 ${
            resetFeedbackAdminId === adminId
              ? 'bg-emerald-600 shadow-emerald-950/40'
              : 'bg-blue-700 shadow-blue-950/30 hover:bg-blue-500 hover:text-white active:bg-blue-900'
          }`}
        >
          {resetFeedbackAdminId === adminId ? (
            <>
              <CheckCircle className="h-3.5 w-3.5" />
              <span>完成</span>
            </>
          ) : (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              <span>取消全部选中</span>
            </>
          )}
        </button>
      </div>
    );
  };

  const handleViewLoginIP = useCallback(async (employee: { id: string; username: string; employeeId?: string }) => {
    setLoginIPEmployee(employee);
    setLoginIPRecords([]);
    setLoginIPActionFilter(null);
    setLoginIPLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_employee_login_history_with_device_info', {
        p_admin_id: getAdminFinancialSessionToken(),
        p_user_id: employee.id,
        p_limit: 10000,
        p_offset: 0
      });
      if (error) throw error;
      setLoginIPRecords((data as LoginIPRecord[]) || []);
    } catch (err) {
      console.error('Error loading login IP history:', formatSupabaseError(err));
    } finally {
      setLoginIPLoading(false);
    }
  }, []);

  const renderLoginIPModal = () => {
    if (!loginIPEmployee) return null;
    const formatDateTime = (dateString: string) => {
      const d = new Date(dateString);
      const Y = d.getFullYear();
      const M = String(d.getMonth() + 1).padStart(2, '0');
      const D = String(d.getDate()).padStart(2, '0');
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      const s = String(d.getSeconds()).padStart(2, '0');
      return `${Y}-${M}-${D} ${h}:${m}:${s}`;
    };
    const loginRecordCount = loginIPRecords.filter(record => record.action_type === 'login').length;
    const logoutRecordCount = loginIPRecords.filter(record => record.action_type === 'logout').length;
    const displayedLoginIPRecords = loginIPActionFilter
      ? loginIPRecords.filter(record => record.action_type === loginIPActionFilter)
      : loginIPRecords;

    return createPortal(
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm" onClick={() => setLoginIPEmployee(null)}>
        <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-[26px] border border-cyan-200/25 bg-[#0b1724] shadow-[0_24px_90px_rgba(2,12,27,0.65)]" onClick={(e) => e.stopPropagation()}>
          <div className="relative shrink-0 overflow-hidden border-b border-white/10 px-5 py-3.5 pr-24 sm:px-6 sm:pr-24">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.16),transparent_34%),linear-gradient(115deg,rgba(15,23,42,0.96),rgba(10,31,46,0.88))]" />
            <div className="relative flex flex-wrap items-center gap-3">
              <div className="flex min-w-[240px] flex-1 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-400/10 shadow-[0_0_24px_rgba(34,211,238,0.12)]">
                  <Globe className="h-4 w-4 text-cyan-300" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase leading-4 tracking-[0.18em] text-cyan-300/90">安全活動</p>
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <h3 className="truncate text-lg font-bold leading-6 tracking-tight text-white">{loginIPEmployee.username}</h3>
                    {loginIPEmployee.employeeId && <span className="font-mono text-xs font-semibold tracking-wide text-cyan-300/90">ID: {loginIPEmployee.employeeId}</span>}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 rounded-2xl border border-white/10 bg-slate-950/55 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_10px_24px_rgba(2,12,27,0.28)] backdrop-blur-md">
                <button
                  type="button"
                  onClick={() => setLoginIPActionFilter(null)}
                  aria-pressed={loginIPActionFilter === null}
                  title="顯示全部紀錄"
                  className={`group inline-flex h-9 min-w-[84px] items-center justify-between gap-2 rounded-xl border px-2.5 outline-none transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-cyan-200/90 ${loginIPActionFilter === null ? 'border-white/70 bg-gradient-to-br from-white via-cyan-100 to-cyan-300 text-slate-950 shadow-[0_5px_14px_rgba(103,232,249,0.25)]' : 'border-transparent text-cyan-100/80 hover:border-cyan-300/25 hover:bg-cyan-300/10 hover:text-white'}`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-lg transition-colors ${loginIPActionFilter === null ? 'bg-slate-950/15' : 'bg-cyan-300/10 group-hover:bg-cyan-300/20'}`}>
                      <History className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-[10px] font-black tracking-wide">全部</span>
                  </span>
                  <span className={`min-w-[1.5rem] rounded-lg px-1 py-1 text-center text-[11px] font-black leading-none ${loginIPActionFilter === null ? 'bg-slate-950/15' : 'bg-cyan-300/10'}`}>
                    {loginIPLoading ? '—' : loginIPRecords.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setLoginIPActionFilter((current) => current === 'login' ? null : 'login')}
                  aria-pressed={loginIPActionFilter === 'login'}
                  title="篩選登入紀錄"
                  className={`group inline-flex h-9 min-w-[84px] items-center justify-between gap-2 rounded-xl border px-2.5 outline-none transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-emerald-200/90 ${loginIPActionFilter === 'login' ? 'border-emerald-100/80 bg-gradient-to-br from-emerald-200 via-emerald-300 to-teal-400 text-slate-950 shadow-[0_5px_14px_rgba(52,211,153,0.24)]' : 'border-transparent text-emerald-100/80 hover:border-emerald-300/25 hover:bg-emerald-300/10 hover:text-white'}`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-lg transition-colors ${loginIPActionFilter === 'login' ? 'bg-slate-950/15' : 'bg-emerald-300/10 group-hover:bg-emerald-300/20'}`}>
                      <LogIn className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-[10px] font-black tracking-wide">登入</span>
                  </span>
                  <span className={`min-w-[1.5rem] rounded-lg px-1 py-1 text-center text-[11px] font-black leading-none ${loginIPActionFilter === 'login' ? 'bg-slate-950/15' : 'bg-emerald-300/10'}`}>
                    {loginIPLoading ? '—' : loginRecordCount}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setLoginIPActionFilter((current) => current === 'logout' ? null : 'logout')}
                  aria-pressed={loginIPActionFilter === 'logout'}
                  title="篩選登出紀錄"
                  className={`group inline-flex h-9 min-w-[84px] items-center justify-between gap-2 rounded-xl border px-2.5 outline-none transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-rose-200/90 ${loginIPActionFilter === 'logout' ? 'border-rose-100/80 bg-gradient-to-br from-rose-200 via-rose-300 to-red-400 text-slate-950 shadow-[0_5px_14px_rgba(251,113,133,0.24)]' : 'border-transparent text-rose-100/80 hover:border-rose-300/25 hover:bg-rose-300/10 hover:text-white'}`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-lg transition-colors ${loginIPActionFilter === 'logout' ? 'bg-slate-950/15' : 'bg-rose-300/10 group-hover:bg-rose-300/20'}`}>
                      <LogOut className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-[10px] font-black tracking-wide">登出</span>
                  </span>
                  <span className={`min-w-[1.5rem] rounded-lg px-1 py-1 text-center text-[11px] font-black leading-none ${loginIPActionFilter === 'logout' ? 'bg-slate-950/15' : 'bg-rose-300/10'}`}>
                    {loginIPLoading ? '—' : logoutRecordCount}
                  </span>
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setLoginIPEmployee(null)}
              aria-label="關閉登入 IP 紀錄"
              className="absolute right-5 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg border border-rose-300/35 bg-rose-500/15 text-rose-200 transition-all hover:border-rose-200/80 hover:bg-rose-500/40 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="login-history-modal-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-[linear-gradient(180deg,#0d1b2a_0%,#0a1521_100%)]">
            {loginIPLoading ? (
              <div className="m-4 flex min-h-[260px] flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] sm:m-6">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-300/10">
                  <Loader2 className="h-6 w-6 animate-spin text-cyan-300" />
                </div>
                <p className="mt-3 text-sm font-semibold text-slate-300">正在載入安全活動</p>
                <p className="mt-1 text-xs text-slate-500">正在取得最新登入紀錄</p>
              </div>
            ) : displayedLoginIPRecords.length === 0 ? (
              <div className="m-4 flex min-h-[260px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.03] text-center sm:m-6">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-500/20 bg-slate-500/10">
                  <Globe className="h-6 w-6 text-slate-500" />
                </div>
                <p className="mt-3 text-sm font-semibold text-slate-300">{loginIPActionFilter ? `找不到${loginIPActionFilter === 'login' ? '登入' : '登出'}紀錄` : '找不到登入紀錄'}</p>
                <p className="mt-1 max-w-xs text-xs text-slate-500">新的登入與登出活動會顯示在這裡。</p>
              </div>
            ) : (
              <div className="w-full overflow-x-auto">
                <table className="min-w-[720px] w-full">
                  <thead className="bg-white/[0.025]">
                    <tr className="border-y border-white/10">
                      <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">時間</th>
                      <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">類型</th>
                      <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">IP 位址</th>
                      <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">系統與瀏覽器</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedLoginIPRecords.map((record) => (
                      <tr key={record.id} className={`group border-b transition-[background-color,box-shadow,filter] duration-200 ease-out last:border-b-0 ${record.action_type === 'login' ? 'border-emerald-300/15 bg-emerald-400/[0.045] hover:bg-emerald-400/[0.11] hover:shadow-[inset_3px_0_0_rgba(52,211,153,0.85)]' : 'border-rose-300/15 bg-rose-400/[0.045] hover:bg-rose-400/[0.11] hover:shadow-[inset_3px_0_0_rgba(251,113,133,0.85)]'}`}>
                        <td className={`whitespace-nowrap px-4 py-3.5 text-xs ${record.action_type === 'login' ? 'text-emerald-200' : 'text-rose-300'}`}>
                          <span className="flex items-center gap-2">
                            <span className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${record.action_type === 'login' ? 'bg-emerald-300/10 text-emerald-300 group-hover:bg-emerald-300/20' : 'bg-rose-300/10 text-rose-300 group-hover:bg-rose-300/20'}`}>
                              <Clock3 className="h-3.5 w-3.5" />
                            </span>
                            {formatDateTime(record.created_at)}
                          </span>
                        </td>
                        <td className="px-4 py-3.5">
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                            record.action_type === 'login'
                              ? 'border-emerald-300/20 bg-emerald-300/10 text-emerald-300'
                              : 'border-rose-300/20 bg-rose-300/10 text-rose-300'
                          }`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${record.action_type === 'login' ? 'bg-emerald-300' : 'bg-rose-300'}`} />
                            {record.action_type === 'login' ? '登入' : '登出'}
                          </span>
                        </td>
                        <td className={`px-4 py-3.5 text-xs font-mono ${record.action_type === 'login' ? 'text-emerald-200' : 'text-rose-300'}`}>
                          <span className="flex items-center gap-1.5">
                            <MapPin className={`h-3.5 w-3.5 ${record.action_type === 'login' ? 'text-emerald-300' : 'text-rose-300'}`} />
                            {record.ip_address || '未知 IP'}
                          </span>
                        </td>
                        <td className="px-4 py-3.5">
                          <LoginDeviceSummary
                            compact
                            deviceInfo={record.device_info}
                            userAgent={record.user_agent}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body
    );
  };

  const handleOpenWallet = useCallback(async (employee: {
    id: string;
    username: string;
    employeeId?: string;
    available?: number;
    pending?: number;
  }) => {
    if (walletAdjustingRef.current) return;

    const requestId = ++walletLoadRequestRef.current;
    const cachedWalletData = employee.available !== undefined && employee.pending !== undefined
      ? { available: employee.available, pending: employee.pending }
      : null;

    setWalletEmployee(employee);
    setWalletData(cachedWalletData);
    setWalletDataVerified(false);
    setWalletAdjustData({ amount: '', remarks: '' });
    setWalletAdjusting(false);
    setWalletNotification(null);
    walletAdjustmentOperationIdRef.current = null;
    setWalletLoading(!cachedWalletData);
    try {
      const latestWalletData = await loadWalletModalData(employee.id);
      if (requestId === walletLoadRequestRef.current) {
        setWalletData(latestWalletData);
        setWalletDataVerified(true);
      }
    } catch (err) {
      if (requestId !== walletLoadRequestRef.current) return;
      console.error('Error loading wallet:', formatSupabaseError(err));
      if (!cachedWalletData) setWalletData({ available: 0, pending: 0 });
      setWalletNotification({ type: 'error', message: '無法確認最新錢包餘額，請稍後再試' });
    } finally {
      if (requestId === walletLoadRequestRef.current) setWalletLoading(false);
    }
  }, []);

  const handleWalletAdjust = async (type: 'add' | 'subtract') => {
    if (walletAdjustingRef.current || !walletEmployee || !walletData) return;
    if (!walletDataVerified) {
      setWalletNotification({ type: 'error', message: '請等待最新錢包餘額確認完成' });
      return;
    }
    const amount = parseFloat(walletAdjustData.amount);
    if (isNaN(amount) || amount <= 0) {
      setWalletNotification({ type: 'error', message: '請輸入有效金額' });
      return;
    }
    if (!walletAdjustData.remarks.trim()) {
      setWalletNotification({ type: 'error', message: '請輸入備註' });
      return;
    }
    walletAdjustingRef.current = true;
    setWalletAdjusting(true);
    setWalletNotification(null);
    try {
      const adjustmentAmount = type === 'add' ? amount : -amount;
      walletAdjustmentOperationIdRef.current ||= createFinancialOperationId();
      const { data: result, error: adjustError } = await supabase.rpc('admin_adjust_wallet_balance_atomic', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_user_id: walletEmployee.id,
        p_amount: adjustmentAmount,
        p_remarks: walletAdjustData.remarks.trim(),
        p_operation_id: walletAdjustmentOperationIdRef.current,
      });
      if (adjustError) throw adjustError;
      if (!result?.success) {
        setWalletNotification({ type: 'error', message: result?.error || '調整餘額失敗' });
        return;
      }
      setWalletData(await loadWalletModalData(walletEmployee.id));
      walletAdjustmentOperationIdRef.current = null;
      setWalletAdjustData({ amount: '', remarks: '' });
      setWalletNotification({ type: 'success', message: '餘額調整成功' });
    } catch (err: unknown) {
      console.error('Error adjusting wallet:', formatSupabaseError(err));
      setWalletNotification({ type: 'error', message: formatSupabaseError(err) || '調整餘額失敗' });
    } finally {
      walletAdjustingRef.current = false;
      setWalletAdjusting(false);
    }
  };

  const renderWalletModal = () => {
    if (!walletEmployee) return null;

    const enteredAmount = Number.parseFloat(walletAdjustData.amount);
    const hasValidAmount = Number.isFinite(enteredAmount) && enteredAmount > 0;

    return createPortal(
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md"
        onClick={(event) => {
          if (event.target === event.currentTarget && !walletAdjustingRef.current) setWalletEmployee(null);
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="wallet-adjustment-title"
          className="relative flex h-[min(760px,calc(100dvh-2rem))] w-full max-w-xl flex-col overflow-hidden rounded-[28px] border border-amber-200/20 bg-[#07111f] text-slate-100 shadow-[0_28px_90px_rgba(2,6,23,0.75)] ring-1 ring-white/5"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-300 via-orange-400 to-cyan-300" />
          <div className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full bg-amber-400/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 -left-24 h-56 w-56 rounded-full bg-cyan-400/10 blur-3xl" />

          <div className="relative flex items-start justify-between gap-4 border-b border-white/10 bg-gradient-to-br from-amber-500/[0.13] via-slate-900/60 to-cyan-500/[0.08] px-5 py-5 sm:px-6">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-amber-200/30 bg-gradient-to-br from-amber-300/25 to-orange-500/10 text-amber-200 shadow-[0_0_28px_rgba(251,191,36,0.16)]">
                <Wallet className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.22em] text-amber-200/70">Financial control</p>
                <h3 id="wallet-adjustment-title" className="truncate text-xl font-bold tracking-tight text-white">調整錢包</h3>
                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2 text-[11px]">
                  <span className="max-w-[220px] truncate font-semibold text-amber-100">{walletEmployee.username}</span>
                  {walletEmployee.employeeId && <span className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-slate-300">ID · {walletEmployee.employeeId}</span>}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setWalletEmployee(null)}
              disabled={walletAdjusting}
              aria-label="關閉錢包調整面板"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-400 transition-all hover:border-amber-200/30 hover:bg-amber-400/15 hover:text-amber-100 active:scale-95"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="scrollbar-hide relative min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            {walletLoading ? (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-300/25 bg-amber-400/10">
                  <Loader2 className="h-6 w-6 animate-spin text-amber-300" />
                </div>
                <p className="text-xs font-medium text-slate-400">正在讀取錢包資料</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="relative overflow-hidden rounded-2xl border border-emerald-300/20 bg-gradient-to-br from-emerald-400/[0.14] via-emerald-950/45 to-slate-900/70 p-4 shadow-[0_12px_30px_rgba(16,185,129,0.08)]">
                    <div className="pointer-events-none absolute -right-5 -top-7 h-24 w-24 rounded-full bg-emerald-300/10 blur-2xl" />
                    <div className="relative flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-200/70">Available balance</p>
                        <p className="mt-2 text-2xl font-bold tabular-nums text-emerald-100">${(walletData?.available ?? 0).toFixed(2)}</p>
                        <p className="mt-1 text-[10px] font-medium text-emerald-200/55">可用餘額</p>
                      </div>
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-200/20 bg-emerald-300/10 text-emerald-200">
                        <DollarSign className="h-4 w-4" />
                      </span>
                    </div>
                  </div>
                  <div className="relative overflow-hidden rounded-2xl border border-amber-300/20 bg-gradient-to-br from-amber-400/[0.13] via-amber-950/45 to-slate-900/70 p-4 shadow-[0_12px_30px_rgba(245,158,11,0.07)]">
                    <div className="pointer-events-none absolute -right-5 -top-7 h-24 w-24 rounded-full bg-amber-300/10 blur-2xl" />
                    <div className="relative flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-amber-200/70">Withdrawal request funds</p>
                        <p className="mt-2 text-2xl font-bold tabular-nums text-amber-100">${(walletData?.pending ?? 0).toFixed(2)}</p>
                        <p className="mt-1 text-[10px] font-medium text-amber-200/55">申请提现资金</p>
                      </div>
                      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-200/20 bg-amber-300/10 text-amber-200">
                        <Wallet className="h-4 w-4" />
                      </span>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 shadow-inner shadow-black/10">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-bold text-white">調整內容</p>
                      <p className="mt-1 text-[10px] text-slate-500">請填寫金額與可追溯的操作備註</p>
                    </div>
                    <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-cyan-200">Audit required</span>
                  </div>

                  <div className="space-y-4">
                    <label className="block">
                      <span className="mb-2 flex items-center justify-between text-[11px] font-semibold text-slate-300">
                        <span>調整金額</span>
                        <span className="font-normal text-slate-500">正數金額</span>
                      </span>
                      <span className="relative block">
                        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-base font-bold text-amber-300">$</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={walletAdjustData.amount}
                          onChange={(e) => {
                            walletAdjustmentOperationIdRef.current = null;
                            setWalletAdjustData(d => ({ ...d, amount: e.target.value }));
                          }}
                          placeholder="0.00"
                          className="h-12 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-4 text-base font-semibold tabular-nums text-slate-900 outline-none shadow-[inset_0_1px_2px_rgba(15,23,42,0.08)] transition-all placeholder:text-slate-400 focus:border-amber-400 focus:bg-white focus:ring-4 focus:ring-amber-300/20"
                        />
                      </span>
                    </label>

                    <label className="block">
                      <span className="mb-2 flex items-center justify-between text-[11px] font-semibold text-slate-300">
                        <span>操作備註 <span className="text-rose-300">*</span></span>
                        <span className="font-normal text-slate-500">將記錄至財務流水</span>
                      </span>
                      <textarea
                        value={walletAdjustData.remarks}
                        onChange={(e) => {
                          walletAdjustmentOperationIdRef.current = null;
                          setWalletAdjustData(d => ({ ...d, remarks: e.target.value }));
                        }}
                        placeholder="例如：訂單補償、人工修正原因……"
                        rows={3}
                        className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm leading-6 text-slate-900 outline-none shadow-[inset_0_1px_2px_rgba(15,23,42,0.08)] transition-all placeholder:text-slate-400 focus:border-cyan-400 focus:bg-white focus:ring-4 focus:ring-cyan-300/20"
                      />
                    </label>
                  </div>
                </div>

                <div className="h-12">
                  {walletNotification ? (
                    <div className={`flex h-full items-center gap-2 overflow-hidden rounded-xl border px-3.5 py-2 text-xs font-medium ${walletNotification.type === 'success' ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-200' : 'border-rose-300/25 bg-rose-400/10 text-rose-200'}`}>
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${walletNotification.type === 'success' ? 'bg-emerald-300' : 'bg-rose-300'}`} />
                      <span>{walletNotification.message}</span>
                    </div>
                  ) : !walletDataVerified && !walletLoading ? (
                    <div className="flex h-full items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-400/[0.08] px-3.5 text-xs font-medium text-cyan-100">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>正在同步最新錢包餘額</span>
                    </div>
                  ) : hasValidAmount ? (
                    <div className="flex h-full items-center gap-2 rounded-xl border border-blue-300/15 bg-blue-400/[0.07] px-3 text-[11px] text-blue-100/80">
                      <Clock className="h-3.5 w-3.5 shrink-0 text-blue-300" />
                      <span>輸入金額：<strong className="font-semibold tabular-nums text-blue-100">${enteredAmount.toFixed(2)}</strong>，請確認操作方向後提交。</span>
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-col-reverse gap-2 border-t border-white/10 pt-4 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => setWalletEmployee(null)}
                    disabled={walletAdjusting}
                    className="h-11 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-xs font-semibold text-slate-300 transition-all hover:border-white/20 hover:bg-white/[0.09] hover:text-white active:scale-[0.98] sm:w-24"
                  >
                    關閉
                  </button>
                  <button
                    type="button"
                    onClick={() => handleWalletAdjust('subtract')}
                    disabled={walletAdjusting || !walletDataVerified}
                    className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-rose-300/30 bg-gradient-to-r from-rose-500/85 to-red-600/80 px-4 text-xs font-bold text-white shadow-[0_10px_24px_rgba(225,29,72,0.16)] transition-all hover:from-rose-400 hover:to-red-500 active:scale-[0.98] disabled:cursor-wait disabled:opacity-50"
                  >
                    {walletAdjusting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDown className="h-4 w-4" />}
                    扣除餘額
                  </button>
                  <button
                    type="button"
                    onClick={() => handleWalletAdjust('add')}
                    disabled={walletAdjusting || !walletDataVerified}
                    className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-emerald-300/30 bg-gradient-to-r from-emerald-500/85 to-teal-500/80 px-4 text-xs font-bold text-white shadow-[0_10px_24px_rgba(16,185,129,0.16)] transition-all hover:from-emerald-400 hover:to-teal-400 active:scale-[0.98] disabled:cursor-wait disabled:opacity-50"
                  >
                    {walletAdjusting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                    新增餘額
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body
    );
  };

  const renderActionsDropdown = useCallback((employee: EmployeeWithAdmin) => {
    const isOpen = openActionMenu === employee.id;
    return (
      <div className="relative" ref={isOpen ? actionMenuRef : undefined}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpenActionMenu(isOpen ? null : employee.id);
          }}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-all duration-150 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950 ${isOpen ? 'bg-blue-500/15 text-blue-200 shadow-[0_0_12px_rgba(59,130,246,0.3)]' : 'text-slate-500 hover:bg-slate-700/45 hover:text-white hover:shadow-[0_0_10px_rgba(148,163,184,0.2)]'}`}
          title="操作"
          aria-label={`開啟 ${employee.username} 的操作選單`}
          aria-expanded={isOpen}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {isOpen && (
          <div className="absolute right-8 top-1/2 z-50 flex h-7 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-xl border border-slate-400/55 bg-[#0b1220] px-1.5 shadow-[0_0_0_1px_rgba(255,255,255,0.05),0_12px_30px_rgba(2,6,23,0.86)] ring-1 ring-inset ring-blue-300/15">
            <button
              onClick={(e) => { e.stopPropagation(); setOpenActionMenu(null); openEmployeeEditor(employee); }}
              className="group inline-flex h-6 items-center gap-1.5 rounded-md border border-blue-300/45 border-l-2 border-l-blue-300/95 bg-blue-950/75 px-3 text-xs font-extrabold text-blue-100 shadow-[inset_0_1px_0_rgba(147,197,253,0.16)] transition-all duration-150 hover:-translate-y-px hover:border-blue-100 hover:bg-blue-600 hover:text-white hover:shadow-[0_0_14px_rgba(59,130,246,0.62)] active:translate-y-px active:scale-[0.96] active:bg-blue-800 active:shadow-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950"
              title="編輯詳情"
              aria-label="編輯員工"
            >
              <Pencil className="h-3.5 w-3.5 transition-transform duration-150 group-hover:scale-110" />
              <span>編輯</span>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setOpenActionMenu(null); setNewPassword(''); setShowResetPassword(false); setShowPasswordReset({ id: employee.id, username: employee.username, employeeId: employee.employee_id }); }}
              className="group inline-flex h-6 items-center gap-1.5 rounded-md border border-amber-200/55 border-l-2 border-l-amber-200/95 bg-amber-950/75 px-3 text-xs font-extrabold text-amber-100 shadow-[inset_0_1px_0_rgba(253,230,138,0.2)] transition-all duration-150 hover:-translate-y-px hover:border-amber-50 hover:bg-amber-400 hover:text-slate-950 hover:shadow-[0_0_14px_rgba(245,158,11,0.68)] active:translate-y-px active:scale-[0.96] active:bg-amber-700 active:text-white active:shadow-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950"
              title="重設密碼"
              aria-label="修改員工密碼"
            >
              <Key className="h-3.5 w-3.5 transition-transform duration-150 group-hover:rotate-[-8deg] group-hover:scale-110" />
              <span>改密碼</span>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setOpenActionMenu(null); setDeletingEmployee(employee); }}
              className="group inline-flex h-6 items-center gap-1.5 rounded-md border border-rose-300/50 border-l-2 border-l-rose-300/95 bg-rose-950/75 px-3 text-xs font-extrabold text-rose-100 shadow-[inset_0_1px_0_rgba(253,164,175,0.18)] transition-all duration-150 hover:-translate-y-px hover:border-rose-50 hover:bg-rose-600 hover:text-white hover:shadow-[0_0_14px_rgba(244,63,94,0.68)] active:translate-y-px active:scale-[0.96] active:bg-rose-800 active:shadow-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950"
              title="刪除"
              aria-label="刪除員工帳戶"
            >
              <Trash2 className="h-3.5 w-3.5 transition-transform duration-150 group-hover:scale-110" />
              <span>刪除</span>
            </button>
          </div>
        )}
      </div>
    );
  }, [openActionMenu, openEmployeeEditor]);

  const renderEmployeeRow = useCallback((employee: EmployeeWithAdmin, index: number, isSuperAdmin: boolean) => (
    <tr
      key={employee.id}
      className={`group border-t border-slate-700/50 transition-colors duration-75 ${
        employee.is_pinned
          ? 'bg-amber-500/10 hover:bg-amber-500/20'
          : isSuperAdmin ? 'hover:bg-yellow-500/15' : 'hover:bg-blue-500/15'
      }`}
    >
      <td className="relative w-[40px] py-0.5 pl-1.5 pr-0 text-xs text-left whitespace-nowrap">
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 left-0 w-1 transition-opacity duration-75 ${
            employee.is_pinned
              ? 'bg-amber-400 opacity-100'
              : isSuperAdmin
                ? 'bg-yellow-400 opacity-0 group-hover:opacity-100'
                : 'bg-blue-400 opacity-0 group-hover:opacity-100'
          }`}
        />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setPinConfirmEmployee({ id: employee.id, username: employee.username, employeeId: employee.employee_id, currentPinned: employee.is_pinned }); }}
          className={`inline-flex h-5 min-w-[32px] items-center justify-start rounded-md px-1.5 font-bold tabular-nums transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/80 ${employee.is_pinned ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 hover:text-amber-300' : 'text-slate-400 hover:bg-amber-500/10 hover:text-amber-300'}`}
          title={employee.is_pinned ? '取消釘選' : '釘選至頂端'}
          aria-label={employee.is_pinned ? `取消釘選 ${employee.username}` : `釘選 ${employee.username} 至頂端`}
        >
          {index + 1}
        </button>
      </td>
      <td className="w-[46px] py-0.5 px-0 text-center whitespace-nowrap">
        <span className="-ml-1 inline-flex">{employee.statsLoaded ? renderWorkStatusBadge(employee.workStatus) : <span className="text-xs text-slate-500" title="統計資料載入中">—</span>}</span>
      </td>
      <td className="group/withdrawal relative w-[104px] overflow-visible py-0.5 px-1 whitespace-nowrap cursor-pointer sm:w-[116px]" onClick={() => setViewingEmployee(employee)}>
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-0.5">
            <span title={employee.username} className={`block max-w-full truncate text-xs font-medium ${!employee.is_active ? 'text-red-400' : employee.workStatus === 'online' ? 'text-green-400' : employee.hasPendingWithdrawal ? 'text-orange-400' : 'text-white'}`}>{employee.username}</span>
          </div>
          {employee.hasPendingWithdrawal && (
            <div className="relative mt-0.5 flex min-w-0 items-center gap-1.5 whitespace-nowrap">
              {employee.pendingWithdrawals && employee.pendingWithdrawals.length > 1 ? (
                <>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded border border-orange-300/35 bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-bold text-orange-200 transition-colors group-hover/withdrawal:border-orange-200/60 group-hover/withdrawal:bg-orange-500/25">
                    多筆提現
                    <span className="rounded-full bg-orange-300/20 px-1 text-[9px] tabular-nums text-orange-100">{employee.pendingWithdrawals.length}</span>
                  </span>
                  <div className="pointer-events-none invisible absolute left-full top-1/2 z-50 ml-2 w-56 -translate-y-1/2 rounded-xl border border-orange-300/35 bg-slate-950/98 p-2.5 text-left opacity-0 shadow-2xl shadow-black/60 ring-1 ring-orange-300/10 transition-all duration-150 group-hover/withdrawal:pointer-events-auto group-hover/withdrawal:visible group-hover/withdrawal:opacity-100">
                    <div className="mb-2 flex items-center justify-between gap-2 border-b border-orange-300/20 pb-2">
                      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-orange-200">待提現明細</span>
                      <span className="rounded-full border border-orange-300/30 bg-orange-500/15 px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-orange-100">{employee.pendingWithdrawals.length} 筆</span>
                    </div>
                    <div className="max-h-44 overflow-y-auto dark-panel-scroll">
                      {employee.pendingWithdrawals?.map((withdrawal, withdrawalIndex) => (
                        <div key={withdrawal.id} className={`flex items-center justify-between gap-3 py-1.5 ${withdrawalIndex < employee.pendingWithdrawals!.length - 1 ? 'border-b border-slate-800' : ''}`}>
                          <span className="text-[10px] font-medium text-slate-400">第 {withdrawalIndex + 1} 筆</span>
                          <span className="text-right">
                            <span className="block text-[11px] font-bold tabular-nums text-orange-200">${withdrawal.amount.toFixed(2)}</span>
                            <span className="block text-[9px] font-medium tabular-nums text-slate-400">{formatWithdrawalDate(withdrawal.created_at)}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <span className="shrink-0 text-[10px] font-semibold tabular-nums text-orange-400">${employee.pendingWithdrawalAmount.toFixed(2)}</span>
                  {employee.pendingWithdrawalDate && (
                    <span className="shrink-0 border-l border-orange-400/30 pl-1.5 text-[9px] font-medium tabular-nums text-orange-200/75">
                      {formatWithdrawalDate(employee.pendingWithdrawalDate)}
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </td>
      <td title={employee.employee_id} className="hidden w-[100px] max-w-[100px] overflow-hidden text-ellipsis py-0.5 px-1 text-xs text-slate-300 font-mono whitespace-nowrap cursor-pointer lg:table-cell" onClick={() => setViewingEmployee(employee)}>{employee.employee_id}</td>
      <td className="hidden w-[72px] py-0.5 px-1 text-[10px] text-emerald-400 whitespace-nowrap xl:table-cell" onClick={(e) => e.stopPropagation()}>
        <span>{employee.created_at ? new Date(employee.created_at).toLocaleDateString('en-CA') : '-'}</span>
        <button
          onClick={() => {
            const d = employee.created_at ? formatWithdrawalDate(employee.created_at) : '';
            setEditingCreatedAt({ id: employee.id, username: employee.username, employeeId: employee.employee_id, currentDate: d });
            setNewCreatedAt(d);
            setRegistrationDateInputError(null);
            setRegistrationCalendarMonth(d ? d.slice(0, 7) : getCalendarMonthKey(new Date()));
            setRegistrationCalendarOpen(false);
          }}
          className="ml-0 inline-flex align-middle p-0.5 rounded text-slate-500 hover:text-blue-400 transition-colors"
          title="編輯註冊日期"
        >
          <Pencil className="w-2.5 h-2.5" />
        </button>
      </td>
      <td className="hidden w-[44px] py-0.5 pl-1 pr-0 align-middle relative group/ver xl:table-cell">
        <button
          onClick={(e) => { e.stopPropagation(); toggleVerification(employee.id, employee.is_verified, employee.username, employee.employee_id); }}
          className={`inline-flex h-5 items-center justify-center gap-0.5 px-1.5 py-0.5 align-middle leading-none rounded text-[10px] font-medium ${
            employee.is_verified ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
          }`}
        >
          {employee.is_verified ? <CheckCircle className="w-2.5 h-2.5" /> : <XCircle className="w-2.5 h-2.5" />}
          {employee.is_verified ? '是' : '否'}
        </button>
        {employee.verification && (
          <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover/ver:block bg-slate-950 border border-sky-500/40 rounded-lg p-3 shadow-2xl shadow-black/60 ring-1 ring-sky-500/20 text-xs whitespace-nowrap">
            <span className="text-slate-300"><span className="text-slate-500">姓名：</span> {employee.verification.real_name}</span>
            <span className="text-slate-600 mx-1">|</span>
            <span className="text-slate-300"><span className="text-slate-500">電話：</span> {employee.verification.phone}</span>
            <span className="text-slate-600 mx-1">|</span>
            <span className="text-slate-300"><span className="text-slate-500">電子郵件：</span> {employee.verification.email}</span>
            <span className="text-slate-600 mx-1">|</span>
            <span className="text-slate-300"><span className="text-slate-500">錢包：</span> {employee.verification.wallet_address}</span>
          </div>
        )}
      </td>
      <td className="w-[48px] py-0.5 pl-0 pr-1 align-middle">
        <button
          onClick={(e) => { e.stopPropagation(); toggleEmployeeStatus(employee.id, employee.is_active, employee.username, employee.employee_id); }}
          className={`inline-flex h-5 items-center justify-center px-1.5 py-0.5 align-middle leading-none rounded text-[10px] font-medium ${
            employee.is_active ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
          }`}
        >
          {employee.is_active ? '啟用' : '停用'}
        </button>
      </td>
      <td className="hidden w-[66px] py-0.5 px-1 relative group/remarks 2xl:table-cell" onClick={(e) => e.stopPropagation()}>
        <div className="flex min-w-0 items-center gap-0.5 max-w-[66px]">
          <span className="text-xs text-blue-400 truncate flex-1">{employee.remarks || '-'}</span>
          <button onClick={() => setEditingRemarksOnly(employee)} className="flex-shrink-0 rounded p-0.5 text-blue-400 opacity-0 transition-all hover:bg-blue-500/15 hover:text-cyan-300 group-hover/remarks:opacity-100">
            <Pencil className="h-2.5 w-2.5 text-blue-400 transition-colors group-hover/remarks:text-cyan-300" />
          </button>
        </div>
        {employee.remarks && employee.remarks.length > 8 && (
          <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover/remarks:block rounded-lg border border-blue-300 bg-blue-100 px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-blue-950">
            {employee.remarks}
          </div>
        )}
      </td>
      <td className="hidden w-[88px] py-0.5 px-1 relative group/tags 2xl:table-cell" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-0.5 max-w-[88px] min-w-0 overflow-hidden whitespace-nowrap">
          {(employee.tags || []).length > 0 && (
            <span className="min-w-0 flex-1 px-1.5 py-0 bg-amber-500/20 text-amber-400 text-[10px] font-medium rounded-full border border-amber-500/30 truncate">
              {(employee.tags || [])[0]}
            </span>
          )}
          {(employee.tags || []).length > 1 && <span className="flex-shrink-0 text-[10px] text-slate-500">+{(employee.tags || []).length - 1}</span>}
          <button onClick={() => setEditingTags(employee)} className="ml-1 flex-shrink-0 rounded-full border border-transparent bg-slate-700 px-1 py-0 text-[10px] text-slate-400 transition-all hover:border-amber-400/75 hover:bg-amber-500/15 hover:text-amber-400 hover:shadow-[0_0_8px_rgba(245,158,11,0.28)]">
            <Tag className="inline h-2.5 w-2.5 text-current" />+
          </button>
        </div>
        {(employee.tags || []).length > 0 && (
          <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover/tags:block rounded-lg border border-amber-300 bg-amber-100 px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-amber-950">
            <div className="flex gap-1">
              {(employee.tags || []).map((tag, idx) => (
                <span key={idx} className="rounded-full border border-amber-700 bg-amber-900 px-1.5 py-px text-[10px] font-medium text-amber-100">{tag}</span>
              ))}
            </div>
          </div>
        )}
      </td>
      {/* Orders group */}
      <td className="py-0.5 px-1 text-[10px] text-center whitespace-nowrap">
        {renderEmployeeStat(employee, <span className="text-blue-400">{employee.totalOrders}</span>)}
      </td>
      <td className="py-0.5 px-1 text-[10px] text-center whitespace-nowrap">
        {renderEmployeeStat(employee, <span className="text-cyan-400 font-medium">{employee.todayOrders}</span>)}
      </td>
      <td className="py-0.5 px-1 text-[10px] text-center whitespace-nowrap">
        {renderEmployeeStat(employee, <span className="text-green-400 font-bold">{employee.todayCompletedOrders}</span>)}
      </td>
      <td className="py-0.5 px-1 text-[10px] text-center whitespace-nowrap">
        {renderEmployeeStat(employee, <span className="text-red-400">{employee.failedOrders}</span>)}
      </td>
      {/* Money group */}
      <td className="hidden py-0.5 px-1 text-[10px] text-center whitespace-nowrap xl:table-cell">
        {renderEmployeeStat(employee, <span className="text-white font-medium">${(employee.walletBalance || 0).toFixed(2)}</span>)}
      </td>
      <td className="hidden py-0.5 px-1 text-[10px] text-center whitespace-nowrap lg:table-cell">
        {renderEmployeeStat(employee, <span className="text-blue-400 font-medium">${employee.accountBalance.toFixed(2)}</span>)}
      </td>
      <td className="py-0.5 px-1 text-[10px] text-center whitespace-nowrap">
        {renderEmployeeStat(employee, <span className="text-amber-400 font-medium">${employee.todayCommission.toFixed(2)}</span>)}
      </td>
      {/* Time group */}
      <td className="py-0.5 px-1 text-[10px] text-center whitespace-nowrap">
        {renderEmployeeStat(employee, <span className="text-white">{formatTime(employee.totalWorkMinutes)}</span>)}
      </td>
      <td className="py-0.5 px-1 text-[10px] text-center whitespace-nowrap">
        {renderEmployeeStat(employee, <span className="text-green-400">{formatTime(employee.todayWorkMinutes)}</span>)}
      </td>
      {/* Work days */}
      <td className="w-[52px] py-0.5 px-1 text-center whitespace-nowrap">
        {renderEmployeeStat(employee, <span className="text-[11px] font-normal tabular-nums text-cyan-300" title="每日明細中的獨立活動天數">{employee.workDays}</span>)}
      </td>
      <td className="w-[132px] py-0.5 px-1 text-center" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-center gap-1">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onQuickAction?.('message', {
                id: employee.id,
                username: employee.username,
                employeeId: employee.employee_id,
                adminId: employee.created_by,
                adminUsername: employee.admin?.username,
                isVerified: employee.is_verified,
                isActive: employee.is_active,
                remarks: employee.remarks || '',
                tags: employee.tags || [],
              });
            }}
            className="p-0.5 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/25 hover:text-blue-300 transition-all border border-blue-500/20 hover:border-blue-400/40"
            title={`傳送訊息給 ${employee.username}`}
          >
            <Bell className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onQuickAction?.('customerservice', {
                id: employee.id,
                username: employee.username,
                employeeId: employee.employee_id,
                adminId: employee.created_by,
                adminUsername: employee.admin?.username,
                isVerified: employee.is_verified,
                isActive: employee.is_active,
                remarks: employee.remarks || '',
                tags: employee.tags || [],
              });
            }}
            className="p-0.5 rounded bg-rose-500/10 text-rose-400 hover:bg-rose-500/25 hover:text-rose-300 transition-all border border-rose-500/20 hover:border-rose-400/40"
            title={`直接傳送模擬客戶訊息給 ${employee.username}`}
            aria-label={`直接傳送模擬客戶訊息給 ${employee.username}`}
          >
            <MessageCircle className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onQuickAction?.('cccservice', {
                id: employee.id,
                username: employee.username,
                employeeId: employee.employee_id,
                adminId: employee.created_by,
                adminUsername: employee.admin?.username,
                isVerified: employee.is_verified,
                isActive: employee.is_active,
                remarks: employee.remarks || '',
                tags: employee.tags || [],
              });
            }}
            className="p-0.5 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/25 hover:text-emerald-300 transition-all border border-emerald-500/20 hover:border-emerald-400/40"
            title={`直接傳送經理訊息給 ${employee.username}`}
            aria-label={`直接傳送經理訊息給 ${employee.username}`}
          >
            <Headphones className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void handleOpenWallet({
                id: employee.id,
                username: employee.username,
                employeeId: employee.employee_id,
                available: employee.statsLoaded ? employee.accountBalance : undefined,
                pending: employee.statsLoaded ? employee.pendingWithdrawalAmount : undefined,
              });
            }}
            className="p-0.5 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/25 hover:text-amber-300 transition-all border border-amber-500/20 hover:border-amber-400/40"
            title={`調整 ${employee.username} 的錢包`}
          >
            <DollarSign className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void handleViewLoginIP({ id: employee.id, username: employee.username, employeeId: employee.employee_id });
            }}
            className="p-0.5 rounded bg-sky-500/10 text-sky-400 hover:bg-sky-500/25 hover:text-sky-300 transition-all border border-sky-500/20 hover:border-sky-400/40"
            title={`檢視 ${employee.username} 的登入 IP`}
          >
            <Globe className="w-3.5 h-3.5" />
          </button>
          {renderActionsDropdown(employee)}
        </div>
      </td>
    </tr>
  ), [
    formatTime,
    handleOpenWallet,
    handleViewLoginIP,
    onQuickAction,
    renderActionsDropdown,
    renderEmployeeStat,
    renderWorkStatusBadge,
    toggleEmployeeStatus,
    toggleVerification,
  ]);
  const employeeRowsByGroup = useMemo(() => {
    const rows = new Map<string, ReactNode[]>();
    filteredEmployeeGroups.forEach(group => {
      if (!expandedGroups.has(group.admin.id)) return;
      const isSuperAdminGroup = group.admin.role === 'super_admin';
      rows.set(group.admin.id, group.employees.map((employee, index) => renderEmployeeRow(employee, index, isSuperAdminGroup)));
    });
    return rows;
  }, [expandedGroups, filteredEmployeeGroups, renderEmployeeRow]);

  const renderTableHeader = (adminId: string) => (
    <thead className="sticky top-0 z-20 isolate bg-blue-900 shadow-[0_2px_4px_rgba(0,0,0,0.35)] border-b-2 border-blue-300/40">
      <tr className="h-[40px]">
        <th className="w-[40px] pl-1.5 pr-0 py-1 text-left text-[10px] font-semibold text-white uppercase tracking-wider">#</th>
        <th className="h-[40px] w-[46px] px-0 py-1 text-center text-[10px] font-semibold text-white uppercase tracking-wider">工作狀態</th>
        <th className="w-[104px] px-1 py-1 text-left text-[10px] font-semibold text-white uppercase tracking-wider sm:w-[116px]">使用者</th>
        <th className="hidden w-[100px] px-1 py-1 text-left text-[10px] font-semibold text-white uppercase tracking-wider lg:table-cell">員工 ID</th>
        {renderSortableHeader(adminId, 'created_at', '建立日期', 'hidden w-[72px] xl:table-cell')}
        <th className="hidden h-[40px] w-[44px] pl-1 pr-0 py-1 text-left text-[10px] font-semibold text-white uppercase tracking-wider xl:table-cell">驗證</th>
        <th className="h-[40px] w-[48px] pl-0 pr-1 py-1 text-left text-[10px] font-semibold text-white uppercase tracking-wider">狀態</th>
        <th className="hidden h-[40px] w-[66px] px-1 py-1 text-left text-[10px] font-semibold text-white uppercase tracking-wider 2xl:table-cell">備註</th>
        <th className="hidden h-[40px] w-[88px] px-1 py-1 text-left text-[10px] font-semibold text-white uppercase tracking-wider 2xl:table-cell">標籤</th>
        {renderSortableHeader(adminId, 'totalOrders', '總數', 'w-[41px]')}
        {renderSortableHeader(adminId, 'todayOrders', '今日', 'w-[41px]')}
        {renderSortableHeader(adminId, 'todayCompletedOrders', '成功', 'w-[45px]')}
        {renderSortableHeader(adminId, 'failedOrders', '失敗', 'w-[43px]')}
        {renderSortableHeader(adminId, 'walletBalance', '錢包餘額', 'hidden w-[59px] xl:table-cell')}
        {renderSortableHeader(adminId, 'accountBalance', '可用餘額', 'hidden w-[59px] lg:table-cell')}
        {renderSortableHeader(adminId, 'todayCommission', '今日佣金', 'w-[58px]')}
        {renderSortableHeader(adminId, 'totalWorkMinutes', '總工時', 'w-[54px]')}
        {renderSortableHeader(adminId, 'todayWorkMinutes', '今日工時', 'w-[54px]')}
        {renderSortableHeader(adminId, 'workDays', '工作天數', 'w-[52px]')}
        <th className="h-[40px] w-[132px] px-1 py-1 text-center text-[10px] font-semibold text-white uppercase tracking-wider">操作</th>
      </tr>
    </thead>
  );

  const renderCreateForm = (targetAdminId: string, groupAdmin?: { role: string; username: string }) => {
    if (!showCreateForm || selectedAdminForCreate !== targetAdminId) return null;
    const isSuperGroup = groupAdmin?.role === 'super_admin';
    const activePlansForGroup = automationPlans.filter(plan => (
      plan.status === 'active' && plan.owner_admin_id === targetAdminId
    ));
    const fieldFocusClasses = isSuperGroup
      ? 'focus:border-amber-400 focus:ring-4 focus:ring-amber-400/15'
      : 'focus:border-cyan-400 focus:ring-4 focus:ring-cyan-400/15';
    const selectedAutomationPlan = activePlansForGroup.find(plan => plan.id === formData.automationPlanId);

    return createPortal(
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden bg-[#020617]/88 p-3 backdrop-blur-xl sm:p-6 animate-in fade-in duration-200"
        onPointerDown={(event) => {
          createBackdropPressRef.current = event.target === event.currentTarget
            ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
            : null;
        }}
        onPointerUp={(event) => {
          const press = createBackdropPressRef.current;
          createBackdropPressRef.current = null;
          if (
            !press
            || press.pointerId !== event.pointerId
            || event.target !== event.currentTarget
            || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6
          ) return;
          if (!creating) closeCreateEmployeeForm();
        }}
        onPointerCancel={() => {
          createBackdropPressRef.current = null;
        }}
      >
        <div aria-hidden="true" className={`pointer-events-none absolute -left-32 top-[-10rem] h-[32rem] w-[32rem] rounded-full blur-[100px] ${isSuperGroup ? 'bg-amber-500/10' : 'bg-blue-500/15'}`} />
        <div aria-hidden="true" className={`pointer-events-none absolute -bottom-48 right-[-8rem] h-[36rem] w-[36rem] rounded-full blur-[120px] ${isSuperGroup ? 'bg-yellow-700/10' : 'bg-cyan-500/10'}`} />
        <form
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-employee-title"
          onSubmit={handleCreateEmployee}
          onClick={(event) => event.stopPropagation()}
          className={`relative flex max-h-[calc(100vh-2rem)] w-full max-w-[800px] flex-col overflow-hidden rounded-[1.75rem] border shadow-[0_36px_120px_rgba(0,0,0,0.72)] ring-1 ring-inset ring-white/[0.08] animate-in zoom-in-95 duration-200 ${isSuperGroup ? 'border-amber-300/35 bg-[#11100e]' : 'border-cyan-300/30 bg-[#08111f]'}`}
        >
          <div className={`relative flex shrink-0 items-start justify-between gap-4 overflow-hidden border-b px-5 py-4 sm:px-6 ${isSuperGroup ? 'border-amber-300/15 bg-[linear-gradient(110deg,#2a1b07_0%,#17140f_48%,#111827_100%)]' : 'border-cyan-300/15 bg-[linear-gradient(110deg,#0b2b4a_0%,#0b1f36_48%,#101827_100%)]'}`}>
            <div className={`absolute inset-x-0 top-0 h-1 ${isSuperGroup ? 'bg-gradient-to-r from-amber-700 via-yellow-300 to-amber-600' : 'bg-gradient-to-r from-blue-700 via-cyan-300 to-blue-600'}`} />
            <div aria-hidden="true" className={`absolute right-16 top-[-5rem] h-44 w-44 rounded-full blur-3xl ${isSuperGroup ? 'bg-amber-400/10' : 'bg-cyan-400/10'}`} />
            <div className="relative flex min-w-0 items-center gap-4">
              <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border shadow-lg ring-1 ring-inset ring-white/10 ${isSuperGroup ? 'border-amber-300/35 bg-gradient-to-br from-amber-400/25 to-amber-800/20 text-amber-100 shadow-amber-950/40' : 'border-cyan-300/35 bg-gradient-to-br from-cyan-400/25 to-blue-700/20 text-cyan-100 shadow-blue-950/50'}`}>
                <UserPlus className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${isSuperGroup ? 'bg-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.9)]' : 'bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.9)]'}`} />
                  <p className={`text-[10px] font-bold uppercase tracking-[0.22em] ${isSuperGroup ? 'text-amber-300/85' : 'text-cyan-300/85'}`}>帳戶建立中心</p>
                </div>
                <h3 id="create-employee-title" className="text-xl font-black tracking-tight text-white">新增員工帳戶</h3>
                <p className={`mt-1 truncate text-xs ${isSuperGroup ? 'text-amber-100/60' : 'text-cyan-100/60'}`}>
                  {groupAdmin ? <>建立於 <strong className="font-bold text-white">{groupAdmin.username}</strong> 管理群組</> : '設定登入資訊與自動化通知方案'}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={`hidden rounded-full border px-3 py-1.5 text-[10px] font-bold tracking-[0.14em] sm:inline-flex ${isSuperGroup ? 'border-amber-300/25 bg-amber-400/10 text-amber-200' : 'border-cyan-300/25 bg-cyan-400/10 text-cyan-200'}`}>
                安全建立
              </span>
              <button
                type="button"
                onClick={closeCreateEmployeeForm}
                disabled={creating}
                aria-label="關閉新增員工"
                className={`rounded-xl border bg-slate-950/35 p-2 text-slate-400 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-50 ${isSuperGroup ? 'border-yellow-300/15 hover:border-yellow-300/40 hover:bg-yellow-400/10' : 'border-blue-300/15 hover:border-blue-300/40 hover:bg-blue-400/10'}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {createError && (
            <div className="mx-5 mt-4 flex items-start gap-2.5 rounded-xl border border-red-400/40 bg-red-500/10 px-3.5 py-3 text-sm text-red-200">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-red-400" />
              <span className="whitespace-pre-line leading-5">{createError}</span>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5 dark-panel-scroll">
            <div className="grid items-start gap-4 md:grid-cols-[1.08fr_0.92fr]">
              <div className={`rounded-2xl border p-4 shadow-inner ${isSuperGroup ? 'border-amber-300/15 bg-gradient-to-br from-amber-950/20 to-slate-950/45' : 'border-blue-300/15 bg-gradient-to-br from-blue-950/25 to-slate-950/45'}`}>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className={`text-[10px] font-black uppercase tracking-[0.18em] ${isSuperGroup ? 'text-amber-300/80' : 'text-cyan-300/80'}`}>01 · 基本資料</p>
                  <p className="mt-1 text-xs text-slate-500">建立員工專屬的登入識別資訊</p>
                </div>
                <Key className={`h-4 w-4 ${isSuperGroup ? 'text-amber-300/70' : 'text-cyan-300/70'}`} />
              </div>
              <div className="grid grid-cols-1 gap-3">
              <div>
                <label className={`mb-1.5 block text-[11px] font-semibold uppercase tracking-wide ${isSuperGroup ? 'text-yellow-100/75' : 'text-blue-100/75'}`}>使用者名稱</label>
                <input type="text" value={formData.username} onChange={(e) => setFormData({ ...formData, username: e.target.value })} disabled={creating} required placeholder="輸入使用者名稱" className={`w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 ${fieldFocusClasses} disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100`} />
              </div>
              <div>
                <label className={`mb-1.5 block text-[11px] font-semibold uppercase tracking-wide ${isSuperGroup ? 'text-yellow-100/75' : 'text-blue-100/75'}`}>密碼</label>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <input type={showPassword ? 'text' : 'password'} value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })} disabled={creating} required minLength={6} autoComplete="new-password" placeholder="建立安全密碼" className={`w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 pr-10 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 ${fieldFocusClasses} disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100`} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900">
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <button type="button" onClick={generatePassword} disabled={creating} className={`inline-flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border bg-white text-slate-600 shadow-sm transition-colors disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100 ${isSuperGroup ? 'border-yellow-300 hover:border-yellow-500 hover:bg-yellow-50 hover:text-yellow-700' : 'border-blue-300 hover:border-blue-500 hover:bg-blue-50 hover:text-blue-700'}`} title="產生高強度密碼">
                    <RefreshCw className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500">至少 6 個字元</p>
              </div>
              <div>
                <label className={`mb-1.5 block text-[11px] font-semibold uppercase tracking-wide ${isSuperGroup ? 'text-yellow-100/75' : 'text-blue-100/75'}`}>員工 ID</label>
                <input type="text" value={formData.employeeId} onChange={(e) => setFormData({ ...formData, employeeId: e.target.value })} disabled={creating} required placeholder="輸入員工 ID" className={`w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 ${fieldFocusClasses} disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100`} />
              </div>
              <div>
                <label className={`mb-1.5 block text-[11px] font-semibold uppercase tracking-wide ${isSuperGroup ? 'text-yellow-100/75' : 'text-blue-100/75'}`}>備註 <span className="font-normal normal-case tracking-normal text-slate-500">（選填）</span></label>
                <input type="text" value={formData.remarks} onChange={(e) => setFormData({ ...formData, remarks: e.target.value })} disabled={creating} placeholder="新增內部備註" className={`w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 ${fieldFocusClasses} disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100`} />
              </div>
              </div>
            </div>

              <div className="space-y-4">
                <div className={`rounded-2xl border p-4 shadow-inner ${isSuperGroup ? 'border-amber-300/20 bg-gradient-to-br from-amber-950/25 to-slate-950/55' : 'border-cyan-300/20 bg-gradient-to-br from-cyan-950/25 to-slate-950/55'}`}>
                  <label htmlFor={`create-dispatch-group-${targetAdminId}`} className={`mb-2 block text-[11px] font-semibold uppercase tracking-wide ${isSuperGroup ? 'text-yellow-100/75' : 'text-blue-100/75'}`}>
                    02 · 派單分組 <span className="font-normal normal-case tracking-normal text-slate-400">（必填）</span>
                  </label>
                  <select
                    id={`create-dispatch-group-${targetAdminId}`}
                    value={formData.dispatchGroupId}
                    onChange={(event) => setFormData(prev => ({ ...prev, dispatchGroupId: event.target.value }))}
                    disabled={creating || dispatchGroupsLoading || Boolean(dispatchGroupsError) || dispatchGroups.length === 0}
                    required
                    className={`w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition-colors ${fieldFocusClasses} disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 disabled:opacity-100`}
                  >
                    <option value="">{dispatchGroupsLoading ? '載入派單分組中…' : '請選擇派單分組'}</option>
                    {dispatchGroups.map(group => (
                      <option key={group.id} value={group.id}>
                        {group.group_name}{group.is_default ? '（預設分組）' : ''}
                      </option>
                    ))}
                  </select>
                  {dispatchGroupsLoading ? (
                    <p className="mt-2 text-[11px] text-slate-400">正在載入可用的派單分組…</p>
                  ) : dispatchGroupsError ? (
                    <p role="alert" className="mt-2 text-[11px] text-red-300">{dispatchGroupsError}</p>
                  ) : dispatchGroups.length === 0 ? (
                    <p className="mt-2 text-[11px] text-amber-200">目前沒有可用的派單分組，請先建立或啟用未封存的分組。</p>
                  ) : (
                    <p className="mt-2 text-[11px] text-slate-400">建立後會直接加入所選派單分組。</p>
                  )}
                </div>

              <div className={`rounded-2xl border p-4 shadow-inner ${isSuperGroup ? 'border-amber-300/20 bg-gradient-to-br from-amber-950/25 to-slate-950/55' : 'border-cyan-300/20 bg-gradient-to-br from-cyan-950/25 to-slate-950/55'}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className={`text-[10px] font-black uppercase tracking-[0.18em] ${isSuperGroup ? 'text-amber-300/80' : 'text-cyan-300/80'}`}>03 · 自動化通知方案</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">員工建立後會直接加入所選方案，立即套用方案內的通知任務。</p>
                </div>
                <Bell className={`mt-0.5 h-4 w-4 shrink-0 ${isSuperGroup ? 'text-yellow-300' : 'text-cyan-300'}`} />
              </div>
              {activePlansForGroup.length > 0 ? (
                <>
                  <button
                    ref={createPlanButtonRef}
                    id={`create-automation-plan-${targetAdminId}`}
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={createPlanMenuOpen}
                    onClick={() => toggleCreatePlanMenu(activePlansForGroup.length + 1)}
                    disabled={creating}
                    className={`group mt-3 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left shadow-lg outline-none transition-all disabled:cursor-not-allowed disabled:opacity-50 ${createPlanMenuOpen ? (isSuperGroup ? 'border-amber-200/90 bg-amber-400/20 ring-2 ring-amber-300/20' : 'border-cyan-200/90 bg-cyan-400/20 ring-2 ring-cyan-300/20') : selectedAutomationPlan ? (isSuperGroup ? 'border-amber-300/75 bg-gradient-to-r from-amber-500/25 via-amber-400/15 to-yellow-500/10 shadow-amber-950/50 ring-1 ring-amber-200/20 hover:border-amber-200' : 'border-cyan-300/75 bg-gradient-to-r from-cyan-500/25 via-cyan-400/15 to-blue-500/10 shadow-cyan-950/50 ring-1 ring-cyan-200/20 hover:border-cyan-200') : 'border-slate-600/80 bg-slate-900/90 hover:border-slate-400 hover:bg-slate-800/95'}`}
                  >
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${selectedAutomationPlan ? (isSuperGroup ? 'border-amber-200/60 bg-amber-300/20 text-amber-100 shadow-sm shadow-amber-950/40' : 'border-cyan-200/60 bg-cyan-300/20 text-cyan-100 shadow-sm shadow-cyan-950/40') : 'border-slate-600 bg-slate-800 text-slate-400'}`}>
                      <Bell className="h-3.5 w-3.5" />
                    </span>
                    <span className={`min-w-0 flex-1 truncate text-[11px] font-extrabold ${selectedAutomationPlan ? (isSuperGroup ? 'text-amber-50' : 'text-cyan-50') : 'text-white'}`}>{selectedAutomationPlan?.name || '不指定方案'}</span>
                    {selectedAutomationPlan && (
                      <>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-300/35 bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-100">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_7px_rgba(110,231,183,0.9)]" />
                          啟用中
                        </span>
                        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-bold ${isSuperGroup ? 'border-amber-200/35 bg-amber-300/15 text-amber-100' : 'border-cyan-200/35 bg-cyan-300/15 text-cyan-100'}`}>{Number(selectedAutomationPlan.selected_task_count) || 0} 個任務</span>
                      </>
                    )}
                    <ChevronDown className={`h-4 w-4 shrink-0 transition-transform duration-200 ${createPlanMenuOpen ? 'rotate-180 text-white' : selectedAutomationPlan ? (isSuperGroup ? 'text-amber-200' : 'text-cyan-200') : 'text-slate-400 group-hover:text-white'}`} />
                  </button>
                  {selectedAutomationPlan && (
                    <p className={`mt-2 flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] font-bold ${isSuperGroup ? 'border-amber-300/25 bg-amber-400/10 text-amber-100' : 'border-cyan-300/25 bg-cyan-400/10 text-cyan-100'}`}>
                      <CheckCircle className={`h-3.5 w-3.5 shrink-0 ${isSuperGroup ? 'text-amber-300' : 'text-cyan-300'}`} />
                      建立後直接加入此方案
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-4 rounded-xl border border-dashed border-slate-600/60 bg-slate-950/30 px-3 py-3 text-[11px] text-slate-500">此群組目前沒有可用的自動化通知方案。</p>
              )}
              </div>
              </div>
            </div>

            <div className="mt-4 flex flex-col-reverse items-stretch justify-between gap-3 border-t border-slate-700/60 pt-4 sm:flex-row sm:items-center">
              <p className="text-center text-[10px] leading-4 text-slate-600 sm:text-left">帳戶建立後可隨時修改方案與員工資料</p>
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={closeCreateEmployeeForm} disabled={creating} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-600 bg-slate-800/80 px-4 py-2.5 text-sm font-semibold text-slate-300 transition-all hover:border-slate-500 hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">
                  取消
                </button>
                <button type="submit" disabled={creating || !formData.username.trim() || !formData.password || !formData.employeeId.trim() || dispatchGroupsLoading || Boolean(dispatchGroupsError) || !dispatchGroups.some(group => group.id === formData.dispatchGroupId)} className={`inline-flex min-w-[132px] items-center justify-center gap-2 rounded-xl border px-5 py-2.5 text-sm font-bold text-white shadow-lg transition-all hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-40 ${isSuperGroup ? 'border-amber-300/60 bg-gradient-to-r from-amber-700 to-yellow-600 shadow-amber-950/40 hover:from-amber-600 hover:to-yellow-500' : 'border-cyan-300/50 bg-gradient-to-r from-blue-600 to-cyan-600 shadow-blue-950/50 hover:from-blue-500 hover:to-cyan-500'}`}>
                  {creating ? (<><div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />建立中……</>) : (<><UserPlus className="h-4 w-4" />建立員工</>)}
                </button>
              </div>
            </div>
          </div>
        </form>
        {createPlanMenuOpen && createPlanMenuPosition && createPortal(
          <div
            ref={createPlanMenuRef}
            role="listbox"
            aria-label="自動化通知方案"
            className={`fixed z-[10050] overflow-hidden rounded-2xl border bg-[#08111f]/98 p-1.5 shadow-[0_24px_70px_rgba(0,0,0,0.72)] backdrop-blur-xl ring-1 ring-inset ring-white/[0.08] animate-in fade-in zoom-in-95 duration-150 ${isSuperGroup ? 'border-amber-300/35' : 'border-cyan-300/35'}`}
            style={{ top: createPlanMenuPosition.top, left: createPlanMenuPosition.left, width: createPlanMenuPosition.width }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="max-h-[264px] space-y-0.5 overflow-y-auto dark-panel-scroll">
              {[null, ...activePlansForGroup].map(plan => {
                const value = plan?.id || '';
                const selected = formData.automationPlanId === value;
                return (
                  <button
                    key={value || 'none'}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setFormData(prev => ({ ...prev, automationPlanId: value }));
                      setCreatePlanMenuOpen(false);
                      setCreatePlanMenuPosition(null);
                    }}
                    className={`flex h-8 w-full items-center gap-2 rounded-lg border px-2 text-left transition-all ${selected ? (isSuperGroup ? 'border-amber-300/45 bg-gradient-to-r from-amber-500/20 to-yellow-500/5' : 'border-cyan-300/45 bg-gradient-to-r from-cyan-500/20 to-blue-500/5') : 'border-transparent hover:border-slate-600 hover:bg-slate-800/90'}`}
                  >
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${selected ? (isSuperGroup ? 'border-amber-300/35 bg-amber-400/15 text-amber-200' : 'border-cyan-300/35 bg-cyan-400/15 text-cyan-200') : 'border-slate-700 bg-slate-900 text-slate-500'}`}>
                      {plan ? <Bell className="h-3 w-3" /> : <X className="h-3 w-3" />}
                    </span>
                    <span className={`min-w-0 flex-1 truncate text-[11px] font-bold ${selected ? 'text-white' : 'text-slate-300'}`}>{plan?.name || '不指定方案'}</span>
                    {plan && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[9px] font-bold text-emerald-200">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                        啟用
                      </span>
                    )}
                    <span className={`shrink-0 text-[9px] font-bold ${selected ? (isSuperGroup ? 'text-amber-200' : 'text-cyan-200') : 'text-slate-300'}`}>{plan ? `${Number(plan.selected_task_count) || 0} 個任務` : '不加入'}</span>
                    {selected && <CheckCircle className={`h-3.5 w-3.5 shrink-0 ${isSuperGroup ? 'text-amber-300' : 'text-cyan-300'}`} />}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
      </div>,
      document.body,
    );
  };

  // ===== MAIN RENDER =====
  const totalEmployeeCount = employeeGroups.reduce((sum, group) => sum + group.employees.length, 0);
  const selectedGroup = employeeGroups.find((group) => group.admin.id === selectedAdminFilter);
  const selectedGroupLabel = selectedAdminFilter === 'all'
    ? `全部群組（${totalEmployeeCount}）`
    : selectedGroup
      ? `${selectedGroup.admin.username} (${selectedGroup.employees.length})`
      : '選擇群組';

  const confirmDialogStyle = confirmDialog
    ? confirmDialog.variant === 'verification'
      ? confirmDialog.nextStatus
        ? {
            panel: 'border-emerald-300/30 bg-gradient-to-b from-slate-900 via-slate-900 to-emerald-950/30 shadow-emerald-950/40',
            header: 'border-emerald-300/15 bg-gradient-to-r from-emerald-950/85 via-slate-900 to-slate-900',
            eyebrow: 'text-emerald-300/80',
            iconShell: 'border-emerald-300/35 bg-emerald-500/15 text-emerald-200 shadow-emerald-950/40',
            icon: 'text-emerald-300',
            message: 'border-emerald-300/15 bg-emerald-500/5',
            badge: 'border-emerald-300/25 bg-emerald-500/10 text-emerald-200',
            confirmButton: 'border-emerald-300/50 bg-emerald-600 shadow-emerald-950/40 hover:bg-emerald-500',
          }
        : {
            panel: 'border-amber-300/30 bg-gradient-to-b from-slate-900 via-slate-900 to-amber-950/25 shadow-amber-950/40',
            header: 'border-amber-300/15 bg-gradient-to-r from-amber-950/85 via-slate-900 to-slate-900',
            eyebrow: 'text-amber-300/80',
            iconShell: 'border-amber-300/35 bg-amber-500/15 text-amber-200 shadow-amber-950/40',
            icon: 'text-amber-300',
            message: 'border-amber-300/15 bg-amber-500/5',
            badge: 'border-amber-300/25 bg-amber-500/10 text-amber-200',
            confirmButton: 'border-amber-300/50 bg-amber-600 shadow-amber-950/40 hover:bg-amber-500',
          }
      : confirmDialog.nextStatus
        ? {
            panel: 'border-cyan-300/30 bg-gradient-to-b from-slate-900 via-slate-900 to-cyan-950/30 shadow-cyan-950/40',
            header: 'border-cyan-300/15 bg-gradient-to-r from-cyan-950/85 via-slate-900 to-slate-900',
            eyebrow: 'text-cyan-300/80',
            iconShell: 'border-cyan-300/35 bg-cyan-500/15 text-cyan-200 shadow-cyan-950/40',
            icon: 'text-cyan-300',
            message: 'border-cyan-300/15 bg-cyan-500/5',
            badge: 'border-cyan-300/25 bg-cyan-500/10 text-cyan-200',
            confirmButton: 'border-cyan-300/50 bg-cyan-600 shadow-cyan-950/40 hover:bg-cyan-500',
          }
        : {
            panel: 'border-rose-300/30 bg-gradient-to-b from-slate-900 via-slate-900 to-rose-950/30 shadow-rose-950/40',
            header: 'border-rose-300/15 bg-gradient-to-r from-rose-950/85 via-slate-900 to-slate-900',
            eyebrow: 'text-rose-300/80',
            iconShell: 'border-rose-300/35 bg-rose-500/15 text-rose-200 shadow-rose-950/40',
            icon: 'text-rose-300',
            message: 'border-rose-300/15 bg-rose-500/5',
            badge: 'border-rose-300/25 bg-rose-500/10 text-rose-200',
            confirmButton: 'border-rose-300/50 bg-rose-600 shadow-rose-950/40 hover:bg-rose-500',
          }
    : null;

  const [calendarYear, calendarMonthNumber] = registrationCalendarMonth.split('-').map(Number);
  const calendarMonthDate = new Date(calendarYear, calendarMonthNumber - 1, 1);
  const calendarDaysInMonth = new Date(calendarYear, calendarMonthNumber, 0).getDate();
  const calendarLeadingDays = calendarMonthDate.getDay();
  const calendarCells = Array.from(
    { length: 42 },
    (_, index) => {
      const day = index - calendarLeadingDays + 1;
      return day < 1 || day > calendarDaysInMonth ? null : day;
    },
  );
  const todayDateKey = formatWithdrawalDate(new Date().toISOString());
  const calendarMonthLabel = registrationCalendarMonth;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* Unified toolbar: search + group filter + countdown + refresh (super admin only) */}
      {admin.role === 'super_admin' && (
        <div className="relative z-40 flex h-9 w-full min-w-0 items-center overflow-visible rounded-none border border-cyan-200/45 bg-slate-950/95 shadow-lg shadow-cyan-950/25 shrink-0 sticky top-0 backdrop-blur-sm">
          <div className="group relative h-full min-w-[140px] flex-[1_1_0%] overflow-hidden border-r border-cyan-300/25 bg-gradient-to-r from-slate-950/80 via-blue-950/65 to-cyan-950/45 transition-colors focus-within:from-blue-950/90 focus-within:via-cyan-950/55 focus-within:to-blue-950/70">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-300/80 drop-shadow-[0_0_6px_rgba(103,232,249,0.35)] transition-all duration-200 group-focus-within:scale-110 group-focus-within:text-cyan-100" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => handleSearchTermChange(e.target.value)}
              placeholder="搜尋員工……"
              autoComplete="off"
              className="h-full w-full rounded-none bg-transparent pl-10 pr-10 text-[13px] font-semibold tracking-wide text-slate-50 placeholder:text-slate-400/80 outline-none transition-colors focus:bg-white/[0.035]"
            />
            {searchTerm && (
              <button type="button" onClick={() => handleSearchTermChange('')} aria-label="清除員工搜尋" className="absolute right-2.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-transparent text-cyan-200/70 transition-all hover:border-cyan-300/30 hover:bg-cyan-300/15 hover:text-cyan-50">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 bg-gradient-to-r from-cyan-300 via-blue-400 to-transparent opacity-90 transition-transform duration-300 group-focus-within:scale-x-100" />
          </div>
          <div ref={adminFilterRef} className="relative h-full w-[252px] min-w-[252px] max-w-[252px] shrink-0 border-r border-cyan-300/20 bg-gradient-to-r from-blue-950/75 via-slate-900/80 to-cyan-950/55">
            <button
              type="button"
              onClick={() => setAdminFilterOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={adminFilterOpen}
              className={`group flex h-full w-full items-center gap-2 px-3 text-xs font-semibold transition-colors ${adminFilterOpen ? 'bg-gradient-to-r from-blue-700/70 via-cyan-700/55 to-blue-900/70 text-white shadow-inner shadow-cyan-950/30' : 'text-slate-100 hover:bg-cyan-500/10 hover:text-white'}`}
            >
              <Users className={`h-4 w-4 shrink-0 transition-colors ${adminFilterOpen ? 'text-cyan-100' : 'text-cyan-300'}`} />
              <span className="min-w-0 flex-1 truncate text-left font-semibold">{selectedGroupLabel}</span>
              <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-cyan-200/80 transition-transform duration-200 ${adminFilterOpen ? 'rotate-180 text-cyan-100' : ''}`} />
            </button>
            {adminFilterOpen && (
              <div className="isolate absolute left-0 top-[calc(100%+0.3rem)] z-[60] w-[252px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-cyan-200/45 bg-gradient-to-b from-slate-800 via-blue-950 to-slate-950 p-1 shadow-[0_16px_36px_rgba(2,6,23,0.78)] ring-1 ring-inset ring-white/10" style={{ backgroundColor: '#0f172a' }}>
                <div className="mb-1 flex items-center justify-between rounded-lg border border-cyan-300/15 bg-gradient-to-r from-blue-950/80 via-cyan-950/30 to-slate-900/80 px-2.5 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Users className="h-4 w-4 shrink-0 text-cyan-200" />
                    <div className="min-w-0">
                      <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-cyan-300">員工群組</p>
                      <p className="mt-0.5 truncate text-[10px] text-slate-400">切換顯示群組</p>
                    </div>
                  </div>
                  <span className="inline-flex h-6 min-w-[38px] shrink-0 items-center justify-center gap-1 rounded-md border border-cyan-200/35 bg-gradient-to-b from-cyan-300/20 to-blue-500/15 px-2 text-[11px] font-extrabold tabular-nums text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_2px_6px_rgba(8,145,178,0.2)]">
                    <span className="text-[8px] font-bold uppercase tracking-wide text-cyan-200/70">總數</span>
                    {employeeGroups.length}
                  </span>
                </div>
                <div role="listbox" aria-label="篩選員工群組" className="max-h-[calc(100vh-9rem)] min-h-[112px] overflow-y-auto overscroll-contain scrollbar-dark">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedAdminFilter === 'all'}
                    onClick={() => {
                      setSelectedAdminFilter('all');
                      setExpandedGroups(new Set(employeeGroups.map(group => group.admin.id)));
                      setAdminFilterOpen(false);
                    }}
                    className={`group flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-all duration-150 ${selectedAdminFilter === 'all' ? 'border-emerald-300/55 bg-gradient-to-r from-emerald-500/25 via-green-500/20 to-transparent text-emerald-50 shadow-sm shadow-emerald-950/40' : 'border-transparent bg-slate-950/20 text-slate-300 hover:border-emerald-300/30 hover:bg-gradient-to-r hover:from-emerald-500/10 hover:via-green-500/10 hover:to-emerald-400/5 hover:text-slate-100 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_3px_9px_rgba(16,185,129,0.1)]'}`}
                  >
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[9px] font-black ${selectedAdminFilter === 'all' ? 'border-emerald-200/45 bg-emerald-300/20 text-emerald-50' : 'border-slate-600/70 bg-slate-800/80 text-slate-400 group-hover:border-emerald-300/35 group-hover:bg-emerald-400/10 group-hover:text-emerald-200'}`}>ALL</span>
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold">全部群組</span>
                    <span className={`inline-flex h-6 min-w-[42px] shrink-0 items-center justify-center rounded-md border px-2 text-xs font-extrabold leading-none tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] ${selectedAdminFilter === 'all' ? 'border-emerald-200/65 bg-gradient-to-b from-emerald-300/30 to-green-500/20 text-emerald-50' : 'border-slate-600/80 bg-slate-800/90 text-cyan-100 group-hover:border-emerald-300/35 group-hover:bg-gradient-to-b group-hover:from-emerald-300/10 group-hover:to-green-500/10 group-hover:text-emerald-100'}`}>{totalEmployeeCount}</span>
                  </button>
                  <div className="my-1.5 h-px bg-gradient-to-r from-transparent via-cyan-300/20 to-transparent" />
                  {employeeGroups.map((group) => {
                    const isSelected = selectedAdminFilter === group.admin.id;
                    return (
                      <button
                        key={group.admin.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          setSelectedAdminFilter(group.admin.id);
                          setExpandedGroups(new Set([group.admin.id]));
                          setAdminFilterOpen(false);
                        }}
                        className={`group flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-all duration-150 ${isSelected ? 'border-emerald-300/55 bg-gradient-to-r from-emerald-500/25 via-green-500/20 to-transparent text-emerald-50 shadow-sm shadow-emerald-950/40' : 'border-transparent bg-slate-950/20 text-slate-300 hover:border-emerald-300/30 hover:bg-gradient-to-r hover:from-emerald-500/10 hover:via-green-500/10 hover:to-emerald-400/5 hover:text-slate-100 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_3px_9px_rgba(16,185,129,0.1)]'}`}
                      >
                        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[9px] font-black uppercase ${isSelected ? 'border-emerald-200/45 bg-emerald-300/20 text-emerald-50' : 'border-slate-600/70 bg-slate-800/80 text-slate-400 group-hover:border-emerald-300/35 group-hover:bg-emerald-400/10 group-hover:text-emerald-200'}`}>{group.admin.username.slice(0, 1)}</span>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={group.admin.username}>{group.admin.username}</span>
                        <span className={`inline-flex h-6 min-w-[42px] shrink-0 items-center justify-center rounded-md border px-2 text-xs font-extrabold leading-none tabular-nums shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] ${isSelected ? 'border-emerald-200/65 bg-gradient-to-b from-emerald-300/30 to-green-500/20 text-emerald-50' : 'border-slate-600/80 bg-slate-800/90 text-cyan-100 group-hover:border-emerald-300/35 group-hover:bg-gradient-to-b group-hover:from-emerald-300/10 group-hover:to-green-500/10 group-hover:text-emerald-100'}`}>{group.employees.length}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => navigateGroupPanel(-1)}
            disabled={selectedAdminFilter !== 'all'}
            aria-label="顯示上一個群組"
            className="flex h-full w-[92px] shrink-0 items-center justify-center gap-1 border-r border-cyan-300/30 bg-gradient-to-r from-sky-600/85 to-cyan-500/80 px-2 text-[10px] font-bold text-white shadow-sm shadow-cyan-950/30 transition-all hover:from-sky-500 hover:to-cyan-400 active:from-sky-700 active:to-cyan-600 disabled:cursor-not-allowed disabled:border-slate-700/60 disabled:bg-slate-800/80 disabled:bg-none disabled:text-slate-500"
            title="顯示上一個群組"
          >
            <ChevronUp className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">上一個群組</span>
          </button>
          <button
            type="button"
            onClick={() => navigateGroupPanel(1)}
            disabled={selectedAdminFilter !== 'all'}
            aria-label="顯示下一個群組"
            className="flex h-full w-[92px] shrink-0 items-center justify-center gap-1 border-r border-orange-300/30 bg-gradient-to-r from-orange-600/85 to-amber-500/80 px-2 text-[10px] font-bold text-white shadow-sm shadow-orange-950/30 transition-all hover:from-orange-500 hover:to-amber-400 active:from-orange-700 active:to-amber-600 disabled:cursor-not-allowed disabled:border-slate-700/60 disabled:bg-slate-800/80 disabled:bg-none disabled:text-slate-500"
            title="顯示下一個群組"
          >
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-nowrap">下一個群組</span>
          </button>
          <button
            type="button"
            onClick={() => setAllGroupsExpanded(true)}
            disabled={selectedAdminFilter !== 'all'}
            aria-label="展開全部群組"
            className="flex h-full w-[108px] shrink-0 items-center justify-center gap-1.5 border-r border-emerald-300/25 bg-gradient-to-r from-emerald-600/85 to-green-500/75 px-2 text-[11px] font-bold text-white shadow-sm shadow-emerald-950/30 transition-all hover:from-emerald-500 hover:to-green-400 active:from-emerald-700 active:to-green-600 disabled:cursor-not-allowed disabled:border-slate-700/60 disabled:bg-slate-800/80 disabled:bg-none disabled:text-slate-500"
            title="展開全部群組"
          >
            <ChevronsDown className="h-4 w-4 shrink-0" />
            <span className="whitespace-nowrap">全部展開</span>
          </button>
          <button
            type="button"
            onClick={() => setAllGroupsExpanded(false)}
            disabled={selectedAdminFilter !== 'all'}
            aria-label="收合全部群組"
            className="flex h-full w-[108px] shrink-0 items-center justify-center gap-1.5 border-r border-rose-300/25 bg-gradient-to-r from-rose-600/85 to-red-500/75 px-2 text-[11px] font-bold text-white shadow-sm shadow-rose-950/30 transition-all hover:from-rose-500 hover:to-red-400 active:from-rose-700 active:to-red-600 disabled:cursor-not-allowed disabled:border-slate-700/60 disabled:bg-slate-800/80 disabled:bg-none disabled:text-slate-500"
            title="收合全部群組"
          >
            <ChevronsUp className="h-4 w-4 shrink-0" />
            <span className="whitespace-nowrap">全部收合</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setAdminFilterOpen(false);
              setCreateSecondaryAdminError(null);
              setShowCreateSecondaryAdmin(true);
            }}
            className="flex h-full w-[220px] shrink-0 items-center justify-center gap-2 border-l border-cyan-300/20 bg-gradient-to-r from-blue-600/80 to-cyan-600/80 px-4 text-xs font-semibold text-white transition-all hover:from-blue-500 hover:to-cyan-500 active:from-blue-700 active:to-cyan-700"
            title="建立次要管理員"
          >
            <UserPlus className="h-4 w-4" />
            新增次要管理員
          </button>
          <div className="w-px h-5 bg-cyan-300/30 shrink-0" />
          <div className="flex h-full w-[100px] shrink-0 items-center justify-center gap-1.5 bg-cyan-500/15 px-3">
            <Clock className="w-3.5 h-3.5 text-cyan-300 shrink-0" />
            <span className="text-sm text-cyan-100 font-mono font-bold tabular-nums w-[40px] text-center"><RefreshCountdown nextRefreshAt={nextRefreshAt} /></span>
          </div>
          <button
            type="button"
            onClick={() => { if (!loading && !isRefreshing && !statsLoading) void guardedLoadEmployeesRef.current?.(employeeGroups.length > 0); }}
            disabled={loading || isRefreshing || statsLoading}
            aria-label={(loading || isRefreshing || statsLoading) ? '正在重新整理員工資料' : '立即重新整理員工資料'}
            aria-busy={loading || isRefreshing || statsLoading}
            className="group relative flex h-full w-20 min-w-20 shrink-0 items-center justify-center overflow-hidden bg-gradient-to-r from-blue-500 to-cyan-500 px-4 text-white shadow-sm shadow-cyan-950/30 transition-all duration-300 hover:from-blue-400 hover:to-cyan-400 hover:shadow-md hover:shadow-cyan-500/25 active:from-blue-600 active:to-cyan-600 disabled:cursor-wait disabled:opacity-90"
            title={(loading || isRefreshing || statsLoading) ? '正在重新整理員工資料……' : '立即重新整理'}
          >
            <span className={`absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent transition-opacity ${(loading || isRefreshing || statsLoading) ? 'animate-pulse opacity-100' : 'opacity-0 group-hover:opacity-60'}`} />
            <span className="relative flex h-8 w-8 items-center justify-center">
              {(loading || isRefreshing || statsLoading) && <span className="absolute h-7 w-7 animate-ping rounded-full border border-white/60 [animation-duration:1200ms]" />}
              <RefreshCw className={`h-4 w-4 drop-shadow-sm ${(loading || isRefreshing || statsLoading) ? 'animate-[spin_700ms_linear_infinite]' : 'transition-transform duration-500 group-hover:rotate-180 group-active:rotate-[270deg]'}`} />
            </span>
          </button>
        </div>
      )}

      <div
        ref={employeeGroupsScrollRef}
        className={`${admin.role === 'super_admin' ? 'employee-super-admin-scrollbar overflow-y-auto' : 'dark-panel-scroll overflow-hidden'} flex min-h-0 min-w-0 w-full flex-1 flex-col overscroll-contain`}
        style={{ scrollbarGutter: 'stable' }}
      >
        {/* Content */}
        {loadError && employeeGroups.length > 0 && (
          <div role="status" className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-400/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-100">
            <span className="flex min-w-0 items-center gap-2">
              <XCircle className="h-4 w-4 shrink-0 text-amber-300" />
              <span className="truncate">{loadError}</span>
            </span>
            <button
              type="button"
              onClick={() => void guardedLoadEmployeesRef.current?.(true)}
              disabled={isRefreshing}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-amber-300/40 bg-amber-500/15 px-2.5 py-1 font-semibold text-amber-50 transition-colors hover:bg-amber-500/25 disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              重試
            </button>
          </div>
        )}
        {loading ? (
        <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center gap-4 text-center text-slate-400">
          <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-400/10 shadow-[0_0_30px_rgba(34,211,238,0.12)]">
            <span className="absolute inset-1 animate-ping rounded-xl border border-cyan-300/25 [animation-duration:1.6s]" />
            <Loader2 className="relative h-8 w-8 animate-spin text-cyan-300" />
          </div>
          <div>
            <p className="text-sm font-semibold text-cyan-100">正在載入員工資料</p>
            <p className="mt-1 text-[11px] text-slate-500">正在取得員工清單，請稍候……</p>
          </div>
        </div>
      ) : loadError && employeeGroups.length === 0 ? (
        <div role="alert" className="flex min-h-[280px] flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-red-400/30 bg-red-500/10">
            <XCircle className="h-7 w-7 text-red-300" />
          </div>
          <div>
            <p className="text-sm font-semibold text-red-100">員工資料載入失敗</p>
            <p className="mt-1 text-xs text-slate-400">{loadError}</p>
          </div>
          <button
            type="button"
            onClick={() => void guardedLoadEmployeesRef.current?.(false)}
            className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/40 bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500"
          >
            <RefreshCw className="h-4 w-4" />
            重試載入
          </button>
        </div>
      ) : admin.role === 'secondary_admin' ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Summary stats */}
              {(() => {
                const allEmps = employeeGroups[0]?.employees || [];
                const financialCounts = getFinancialFilterCounts(flatAdminId);
                return (
                  <div className="border-b border-blue-500/20 bg-blue-500/5 px-3 pb-1.5 pt-3">
                    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                      <div className="flex min-w-0 flex-wrap items-center gap-3">
                      <div className="inline-flex items-center gap-3 rounded-xl border border-blue-400/35 bg-gradient-to-r from-blue-950/90 via-cyan-950/65 to-slate-900 px-3 py-1 shadow-sm shadow-blue-950/40">
                        <Users className="h-4 w-4 text-cyan-300" />
                        <div className="flex min-w-[82px] flex-col">
                          <span className="text-base font-bold leading-none tabular-nums text-white">{allEmps.length}</span>
                          <span className="mt-0.5 whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.12em] text-cyan-200/80">員工總數</span>
                        </div>
                        <span className="h-7 w-px bg-cyan-300/30" />
                        <div className="flex min-w-[92px] flex-col">
                          <span className="text-base font-bold leading-none tabular-nums text-cyan-100">{flatFilteredEmployees.length}</span>
                          <span className="mt-0.5 whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.12em] text-cyan-200">符合篩選的員工</span>
                        </div>
                      </div>
                    {allEmps.every(employee => employee.statsLoaded) ? (
                      <>
                        <span className="text-slate-500">&bull;</span>
                        {renderSummaryFilterButton(
                          flatAdminId,
                          'today_working',
                          '今日已工作',
                          allEmps.filter(e => e.todayWorkMinutes > 0).length,

                        )}
                        <span className="text-slate-500">&bull;</span>
                        {renderSummaryFilterButton(
                          flatAdminId,
                          'new_today',
                          '今日新增',
                          allEmps.filter(e => {
                            if (!e.created_at) return false;
                            const today = new Date();
                            const created = new Date(e.created_at);
                            return created.toDateString() === today.toDateString();
                          }).length,

                        )}
                        <span className="text-slate-500">&bull;</span>
                        {renderSummaryFilterButton(
                          flatAdminId,
                          'currently_working',
                          '目前工作中',
                          allEmps.filter(e => e.workStatus === 'online').length,

                        )}
                        <span className="text-slate-500">&bull;</span>
                        {renderFinancialFilterButton(
                          flatAdminId,
                          'today_commission',
                          '今日有佣金',
                          financialCounts.todayCommission,
                        )}
                        {renderFinancialFilterButton(
                          flatAdminId,
                          'wallet',
                          '钱包有金额',
                          financialCounts.wallet,
                        )}
                      </>
                    ) : (
                      <span className="text-[10px] font-medium text-slate-500">統計資料載入中……</span>
                    )}
                      </div>
                      <div className="flex h-8 w-full max-w-[300px] items-center gap-2 justify-self-end md:w-[300px]">
                      <div className="group relative h-8 min-w-0 max-w-[168px] flex-1 overflow-hidden rounded-xl border border-cyan-300/30 bg-gradient-to-r from-slate-950/80 via-blue-950/60 to-cyan-950/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_3px_10px_rgba(2,6,23,0.28)] transition-all focus-within:border-cyan-200/70 focus-within:from-blue-950/90 focus-within:via-cyan-950/55 focus-within:to-blue-950/65 focus-within:shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_14px_rgba(34,211,238,0.16)]">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cyan-300/80 transition-all duration-200 group-focus-within:scale-110 group-focus-within:text-cyan-100" />
                        <input
                          type="text"
                          value={searchTerm}
                          onChange={(e) => handleSearchTermChange(e.target.value)}
                          placeholder="搜尋員工……"
                          autoComplete="off"
                          className="h-full w-full bg-transparent pl-8 pr-8 text-[11px] font-semibold tracking-wide text-cyan-50 placeholder:text-slate-400/80 outline-none transition-colors focus:bg-white/[0.035]"
                        />
                        {searchTerm && (
                          <button type="button" onClick={() => handleSearchTermChange('')} aria-label="清除員工搜尋" className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md border border-transparent text-cyan-200/70 transition-all hover:border-cyan-300/30 hover:bg-cyan-300/15 hover:text-cyan-50">
                            <X className="h-3 w-3" />
                          </button>
                        )}
                        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-gradient-to-r from-cyan-300 via-blue-400 to-transparent transition-transform duration-300 group-focus-within:scale-x-100" />
                      </div>
                      <div className="flex h-8 shrink-0 items-center overflow-hidden rounded-lg border border-cyan-300/45 bg-cyan-950/35 shadow-sm shadow-cyan-950/30">
                        <div className="flex h-full w-[82px] items-center justify-center gap-1.5 border-r border-cyan-300/30 bg-cyan-500/15 px-2">
                          <Clock className="w-3.5 h-3.5 text-cyan-300 shrink-0" />
                          <span className="text-xs text-cyan-100 font-mono font-bold tabular-nums w-[34px] text-center"><RefreshCountdown nextRefreshAt={nextRefreshAt} /></span>
                        </div>
                        <button
                          type="button"
                          onClick={() => { if (!loading && !isRefreshing && !statsLoading) void guardedLoadEmployeesRef.current?.(employeeGroups.length > 0); }}
                          disabled={loading || isRefreshing || statsLoading}
                          aria-label={(loading || isRefreshing || statsLoading) ? '正在重新整理員工資料' : '立即重新整理員工資料'}
                          aria-busy={loading || isRefreshing || statsLoading}
                          className="group relative flex h-full min-w-10 items-center justify-center overflow-hidden bg-gradient-to-r from-blue-500 to-cyan-500 px-2.5 text-white shadow-sm shadow-cyan-950/30 transition-all duration-300 hover:from-blue-400 hover:to-cyan-400 hover:shadow-md hover:shadow-cyan-500/25 active:from-blue-600 active:to-cyan-600 disabled:cursor-wait disabled:opacity-90"
                          title={(loading || isRefreshing || statsLoading) ? '正在重新整理員工資料……' : '立即重新整理'}
                        >
                          <span className={`absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent transition-opacity ${(loading || isRefreshing || statsLoading) ? 'animate-pulse opacity-100' : 'opacity-0 group-hover:opacity-60'}`} />
                          <span className="relative flex h-7 w-7 items-center justify-center">
                            {(loading || isRefreshing || statsLoading) && <span className="absolute h-6 w-6 animate-ping rounded-full border border-white/60 [animation-duration:1200ms]" />}
                            <RefreshCw className={`h-4 w-4 drop-shadow-sm ${(loading || isRefreshing || statsLoading) ? 'animate-[spin_700ms_linear_infinite]' : 'transition-transform duration-500 group-hover:rotate-180 group-active:rotate-[270deg]'}`} />
                          </span>
                        </button>
                      </div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {renderStatusFilterButtons(flatAdminId)}
                    </div>
                  </div>
                );
              })()}
              {/* Controls */}
              <div className="flex min-h-8 items-center gap-2 border-b border-blue-500/30 bg-blue-500/5 px-3 py-0.5">
                <div className="min-w-0 flex-1 overflow-x-auto scrollbar-hide">
                  <div className="flex w-max min-w-full items-center gap-1.5">
                    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-yellow-300">
                      <span className="flex h-5 w-5 items-center justify-center rounded-md bg-yellow-500/20 text-yellow-300">
                        <Tag className="h-3.5 w-3.5" />
                      </span>
                      標籤：
                    </span>
                    {getGroupTags(flatAdminId).map(tag => {
                      const selectedTags = getSelectedTagsForGroup(flatAdminId);
                      const isSelected = selectedTags.includes(tag);
                      return (
                        <button key={tag} onClick={() => {
                          if (isSelected) setSelectedTagsForGroup(flatAdminId, selectedTags.filter(t => t !== tag));
                          else setSelectedTagsForGroup(flatAdminId, [...selectedTags, tag]);
                        }} className={`inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-[11px] font-semibold transition-all ${isSelected ? 'border-yellow-200 bg-yellow-400 text-yellow-950 shadow-sm shadow-yellow-500/30 ring-1 ring-yellow-200/60' : 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300 hover:border-yellow-300/70 hover:bg-yellow-500/20 hover:text-yellow-100'}`}>
                          {tag}
                        </button>
                      );
                    })}
                    {getSelectedTagsForGroup(flatAdminId).length > 0 && (
                      <button onClick={() => setSelectedTagsForGroup(flatAdminId, [])} className="inline-flex h-6 shrink-0 items-center rounded-md border border-red-500/30 bg-red-600/15 px-2 text-[11px] font-semibold text-red-300 transition-colors hover:bg-red-600/30">清除</button>
                    )}
                  </div>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => openCreateEmployeeForm(admin.id)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-blue-400/40 bg-blue-600/85 px-2.5 text-xs font-semibold text-white shadow-sm shadow-blue-950/40 transition-all hover:border-blue-300/60 hover:bg-blue-500 active:bg-blue-700"
                  >
                    <UserPlus className="h-3.5 w-3.5" /> 建立員工
                  </button>
                </div>
              </div>

              {renderCreateForm(admin.id)}

              {/* Table - fixed ~22 rows */}
              <div className="-ml-1 flex min-h-0 min-w-0 flex-1 flex-col overflow-x-auto overflow-y-auto overscroll-contain bg-slate-900/50 pl-1 dark-panel-scroll">
                <table className="w-full min-w-0 shrink-0 table-fixed">
                  {renderTableHeader(flatAdminId)}
                  <tbody>
                    {flatFilteredEmployees.map((emp, idx) => renderEmployeeRow(emp, idx, true))}
                  </tbody>
                </table>
                {flatFilteredEmployees.length === 0 && (
                  <div className="flex min-h-[260px] flex-1 flex-col items-center justify-center bg-gradient-to-b from-blue-950/20 via-slate-900/40 to-slate-950/40 px-4 py-8 text-center">
                    <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-300/25 bg-gradient-to-br from-blue-500/20 to-cyan-400/10 text-cyan-200">
                      <Users className="h-7 w-7" />
                    </div>
                    <h3 className="text-lg font-semibold text-white">
                      {employeeGroups[0]?.employees.length ? '沒有符合條件的員工' : '目前沒有員工'}
                    </h3>
                    <p className="mt-2 text-sm text-slate-400">
                      {employeeGroups[0]?.employees.length ? '試著調整上方的搜尋或篩選條件。' : '建立第一位員工，即可在這裡查看員工資料。'}
                    </p>
                    {!employeeGroups[0]?.employees.length && (
                      <button
                        type="button"
                        onClick={() => openCreateEmployeeForm(admin.id)}
                        className="mt-6 inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 px-5 text-sm font-semibold text-white shadow-sm shadow-blue-950/40 transition-colors hover:from-blue-500 hover:to-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                      >
                        <UserPlus className="h-4 w-4" />
                        建立員工
                      </button>
                    )}
                  </div>
                )}
                <div aria-hidden="true" className="h-4 shrink-0 border-t border-blue-300/35 bg-gradient-to-r from-blue-950/10 via-blue-500/35 to-blue-950/10 shadow-[inset_0_1px_0_rgba(96,165,250,0.55),0_-4px_14px_rgba(59,130,246,0.18)]" />
              </div>
            </div>
      ) : filteredGroups.length === 0 ? (
        <div className="text-center py-8 text-slate-400">找不到員工</div>
      ) : (
        // ===== SUPER ADMIN: grouped view =====
        <div
          key={selectedAdminFilter}
          className={`${selectedAdminFilter === 'all' ? 'space-y-0' : 'flex min-h-0 flex-1 flex-col'} animate-[fadeIn_160ms_ease-out]`}
          style={{ animationFillMode: 'both' }}
        >
          {filteredGroups.map((group, groupIndex) => {
            const isSuperGroup = group.admin.role === 'super_admin';
            return (
              <Fragment key={group.admin.id}>
              <div
                data-admin-group-id={group.admin.id}
                className={`rounded-none overflow-hidden transition-colors duration-200 ${
                  isSuperGroup
                    ? `bg-gradient-to-br from-yellow-500/5 via-slate-800/40 to-slate-800/40 border-2 border-yellow-500/30 shadow-lg shadow-yellow-500/10 ${selectedAdminFilter !== 'all' && expandedGroups.has(group.admin.id) ? 'flex min-h-0 flex-1 flex-col' : ''}`
                    : `bg-gradient-to-br from-blue-500/5 via-slate-800/40 to-slate-800/40 border-2 border-blue-500/30 shadow-lg shadow-blue-500/10 ${selectedAdminFilter !== 'all' && expandedGroups.has(group.admin.id) ? 'flex min-h-0 flex-1 flex-col' : ''}`
                }`}
              >
                {/* Group header */}
                <div className={`w-full flex items-center justify-between gap-3 px-4 py-2 transition-all ${isSuperGroup ? 'hover:bg-yellow-500/10' : 'hover:bg-blue-500/10'}`}>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {group.admin.role === 'secondary_admin' && (
                      <button
                        onClick={() => toggleAdminPin(group.admin.id, group.admin.is_pinned || false)}
                        disabled={pinningAdminId !== null}
                        aria-busy={pinningAdminId === group.admin.id}
                        className={`shrink-0 rounded-lg border p-1.5 shadow-none transition-colors active:scale-95 disabled:cursor-wait disabled:opacity-70 ${
                          group.admin.is_pinned
                            ? 'border-amber-400/70 bg-amber-600 text-amber-50 hover:bg-amber-500'
                            : 'border-slate-600 bg-slate-700 text-slate-300 hover:border-amber-400/60 hover:bg-slate-600 hover:text-amber-100'
                        }`}
                        title={group.admin.is_pinned ? '取消釘選管理員群組' : '將管理員群組釘選至頂端'}
                      >
                        <Pin className={`h-4 w-4 ${group.admin.is_pinned ? 'fill-current rotate-12' : ''}`} />
                      </button>
                    )}
                    <div onClick={() => toggleGroup(group.admin.id)} className={`shrink-0 cursor-pointer rounded-lg p-1.5 ${isSuperGroup ? 'bg-yellow-500/20' : 'bg-blue-500/20'}`}>
                      <Users className={`h-5 w-5 ${isSuperGroup ? 'text-yellow-400' : 'text-blue-400'}`} />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <div onClick={() => toggleGroup(group.admin.id)} className="order-2 flex shrink-0 cursor-pointer items-center gap-2 rounded-xl border border-slate-600/90 bg-slate-900/85 px-2.5 py-1.5 transition-all hover:border-slate-400/80 hover:bg-slate-800 hover:shadow-[0_0_16px_rgba(59,130,246,0.18)]">
                        <span className={`max-w-[150px] truncate text-sm font-bold ${isSuperGroup ? 'text-yellow-100' : 'text-cyan-100'}`}>{group.admin.username}</span>
                        <span className="h-3.5 w-px bg-slate-600" />
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold tracking-wide ${isSuperGroup ? 'text-yellow-300' : 'text-cyan-300'}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${isSuperGroup ? 'bg-yellow-400' : 'bg-cyan-400'}`} />
                          {isSuperGroup ? '超級管理員' : '次要管理員'}
                        </span>
                        {group.admin.is_pinned && (
                          <>
                            <span className="h-3.5 w-px bg-slate-600" />
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold tracking-wide text-amber-300">
                              <Pin className="h-3 w-3" />
                              已釘選
                            </span>
                          </>
                        )}
                      </div>
                      <div className="flex min-w-0 items-center gap-2 flex-wrap">
                        {(() => {
                          const originalGroup = employeeGroups.find(g => g.admin.id === group.admin.id);
                          const allEmps = originalGroup?.employees || [];
                          const financialCounts = getFinancialFilterCounts(group.admin.id);
                          return (
                            <>
                              <div className={`inline-flex items-center gap-3 rounded-xl border px-3 py-1 shadow-sm ${isSuperGroup ? 'border-yellow-400/35 bg-gradient-to-r from-yellow-950/90 via-amber-950/60 to-slate-900 shadow-yellow-950/30' : 'border-blue-400/35 bg-gradient-to-r from-blue-950/90 via-cyan-950/60 to-slate-900 shadow-blue-950/30'}`}>
                                <Users className={`h-4 w-4 ${isSuperGroup ? 'text-yellow-300' : 'text-cyan-300'}`} />
                                <div className="flex min-w-[82px] flex-col">
                                  <span className="text-base font-bold leading-none tabular-nums text-white">{allEmps.length}</span>
                                  <span className={`mt-0.5 whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.12em] ${isSuperGroup ? 'text-yellow-200/80' : 'text-cyan-200/80'}`}>員工總數</span>
                                </div>
                                <span className={`h-7 w-px ${isSuperGroup ? 'bg-yellow-300/30' : 'bg-cyan-300/30'}`} />
                                <div className="flex min-w-[92px] flex-col">
                                  <span className={`text-base font-bold leading-none tabular-nums ${isSuperGroup ? 'text-yellow-100' : 'text-cyan-100'}`}>{group.employees.length}</span>
                                  <span className={`mt-0.5 whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.12em] ${isSuperGroup ? 'text-yellow-200' : 'text-cyan-200'}`}>符合篩選的員工</span>
                                </div>
                              </div>
                                  <span className="text-slate-500">•</span>
                                  {renderSummaryFilterButton(
                                    group.admin.id,
                                    'today_working',
                                    '今日已工作',
                                    allEmps.filter(e => e.todayWorkMinutes > 0).length,
          
                                  )}
                                  <span className="text-slate-500">•</span>
                                  {renderSummaryFilterButton(
                                    group.admin.id,
                                    'new_today',
                                    '今日新增',
                                    allEmps.filter(e => {
                                      if (!e.created_at) return false;
                                      const today = new Date();
                                      const created = new Date(e.created_at);
                                      return created.toDateString() === today.toDateString();
                                    }).length,
          
                                  )}
                                  <span className="text-slate-500">•</span>
                                  {renderSummaryFilterButton(
                                    group.admin.id,
                                    'currently_working',
                                    '目前工作中',
                                    allEmps.filter(e => e.workStatus === 'online').length,

                                  )}
                                  <span className="text-slate-500">•</span>
                                  {renderFinancialFilterButton(
                                    group.admin.id,
                                    'today_commission',
                                    '今日有佣金',
                          financialCounts.todayCommission,
                                  )}
                                  {renderFinancialFilterButton(
                                    group.admin.id,
                                    'wallet',
                                    '钱包有金额',
                                    financialCounts.wallet,
                                  )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div onClick={() => toggleGroup(group.admin.id)} className="cursor-pointer">
                      {expandedGroups.has(group.admin.id) ? (
                        <ChevronUp className={`w-6 h-6 ${isSuperGroup ? 'text-yellow-400' : 'text-blue-400'}`} />
                      ) : (
                        <ChevronDown className={`w-6 h-6 ${isSuperGroup ? 'text-yellow-400' : 'text-blue-400'}`} />
                      )}
                    </div>
                  </div>
                </div>

                {expandedGroups.has(group.admin.id) && (
                  <>
                    {renderCreateForm(group.admin.id, group.admin)}

                    <div className={`flex min-h-8 items-center border-b px-4 py-0.5 ${isSuperGroup ? 'border-yellow-500/30 bg-yellow-500/5' : 'border-blue-500/30 bg-blue-500/5'}`}>
                      <div className="min-w-0 flex-1 -translate-y-0.5 overflow-x-auto scrollbar-hide">
                        {renderStatusFilterButtons(group.admin.id)}
                      </div>
                      <button
                        type="button"
                        onClick={() => openCreateEmployeeForm(group.admin.id)}
                        className="ml-auto inline-flex h-7 shrink-0 -translate-y-0.5 items-center gap-1.5 rounded-lg border border-yellow-400/50 bg-yellow-600/80 px-2.5 py-1 text-[11px] font-semibold text-yellow-50 shadow-lg shadow-yellow-950/30 transition-all hover:border-yellow-300/70 hover:bg-yellow-500 active:bg-yellow-700"
                      >
                        <UserPlus className="h-3.5 w-3.5" /> 新增
                      </button>
                    </div>
                    <div className={`flex min-h-8 flex-wrap items-center gap-2 border-b px-4 py-0.5 ${isSuperGroup ? 'border-yellow-500/20 bg-yellow-500/5' : 'border-blue-500/20 bg-blue-500/5'}`}>
                      <div className="min-w-0 flex-1 overflow-x-auto scrollbar-hide">
                        <div className="flex w-max min-w-full items-center gap-1.5">
                          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-yellow-300">
                            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-yellow-500/20 text-yellow-300">
                              <Tag className="h-3.5 w-3.5" />
                            </span>
                            標籤：
                          </span>
                          {getGroupTags(group.admin.id).map(tag => {
                            const selectedTags = getSelectedTagsForGroup(group.admin.id);
                            const isSelected = selectedTags.includes(tag);
                            return (
                              <button key={tag} onClick={() => {
                                if (isSelected) setSelectedTagsForGroup(group.admin.id, selectedTags.filter(t => t !== tag));
                                else setSelectedTagsForGroup(group.admin.id, [...selectedTags, tag]);
                              }} className={`inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-[11px] font-semibold transition-all ${isSelected ? 'border-yellow-200 bg-yellow-400 text-yellow-950 shadow-sm shadow-yellow-500/30 ring-1 ring-yellow-200/60' : 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300 hover:border-yellow-300/70 hover:bg-yellow-500/20 hover:text-yellow-100'}`}>
                                {tag}
                              </button>
                            );
                          })}
                          {getSelectedTagsForGroup(group.admin.id).length > 0 && (
                            <button onClick={() => setSelectedTagsForGroup(group.admin.id, [])} className="inline-flex h-6 shrink-0 items-center rounded-md border border-red-500/30 bg-red-600/15 px-2 text-[11px] font-semibold text-red-300 transition-colors hover:bg-red-600/30">清除</button>
                          )}
                        </div>
                      </div>
                    </div>
                    {group.employees.length > 0 ? (
                      <div className={`-ml-1 pl-1 overflow-x-auto overflow-y-auto overscroll-contain bg-slate-900/50 min-h-[300px] dark-panel-scroll ${selectedAdminFilter !== 'all' ? 'min-h-0 flex-1' : 'max-h-[calc(100vh-160px)]'}`}>
                        <table className="w-full min-w-0 table-fixed">
                          {renderTableHeader(group.admin.id)}
                          <tbody>{employeeRowsByGroup.get(group.admin.id)}</tbody>
                        </table>
                        <div aria-hidden="true" className="h-4 shrink-0 border-t border-blue-300/35 bg-gradient-to-r from-blue-950/10 via-blue-500/35 to-blue-950/10 shadow-[inset_0_1px_0_rgba(96,165,250,0.55),0_-4px_14px_rgba(59,130,246,0.18)]" />
                      </div>
                    ) : (
                      <div className={`py-8 text-center ${selectedAdminFilter !== 'all' ? `flex flex-1 flex-col items-center justify-center ${isSuperGroup ? 'bg-yellow-500/5' : 'bg-blue-500/5'}` : isSuperGroup ? 'bg-yellow-500/5' : 'bg-blue-500/5'}`}>
                        <p className="text-slate-400 text-sm">沒有員工符合目前的篩選條件</p>
                      </div>
                    )}
                  </>
                )}
              </div>
              {groupIndex < filteredGroups.length - 1 && (
                <div
                  aria-hidden="true"
                  className="h-4 shrink-0 border-y border-blue-900/60 bg-gradient-to-r from-[#020617] via-[#071a35] to-[#020617] shadow-[inset_0_1px_0_rgba(30,64,175,0.18),inset_0_-1px_0_rgba(2,6,23,0.95)]"
                />
              )}
              </Fragment>
            );
          })}
        </div>
        )}
      </div>

      {/* ===== MODALS ===== */}

      {editingEmployee && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md animate-in fade-in duration-200"
          onPointerDown={(event) => {
            editBackdropPressRef.current = event.target === event.currentTarget
              ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
              : null;
          }}
          onPointerUp={(event) => {
            const press = editBackdropPressRef.current;
            editBackdropPressRef.current = null;
            if (
              !press
              || press.pointerId !== event.pointerId
              || event.target !== event.currentTarget
              || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6
            ) return;
            closeEmployeeEditor();
          }}
          onPointerCancel={() => {
            editBackdropPressRef.current = null;
          }}
        >
          <div className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-[820px] flex-col overflow-hidden rounded-[1.75rem] border border-blue-300/25 bg-gradient-to-b from-slate-900 via-slate-900 to-blue-950/35 shadow-[0_30px_110px_rgba(2,6,23,0.82)] ring-1 ring-inset ring-white/10 animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="relative shrink-0 overflow-hidden rounded-t-[1.75rem] border-b border-blue-300/15 bg-gradient-to-r from-blue-950/80 via-cyan-950/35 to-slate-900/80 px-5 py-4 sm:px-6">
              <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-cyan-300 to-blue-500" />
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-blue-300/35 bg-blue-400/15 text-blue-100 shadow-lg shadow-blue-950/35 ring-1 ring-inset ring-white/10">
                    <Pencil className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-300">帳戶資料</p>
                    <h3 className="mt-1 text-xl font-bold tracking-tight text-white">編輯員工</h3>
                    <p className="mt-1 text-xs text-blue-100/60">更新帳戶資料與自動化通知方案。</p>
                  </div>
                </div>
                <button type="button" onClick={closeEmployeeEditor} disabled={savingEmployeeEdit} aria-label="關閉編輯員工" className="rounded-xl border border-blue-300/15 bg-slate-950/35 p-2 text-slate-400 transition-colors hover:border-blue-300/40 hover:bg-blue-400/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5 dark-panel-scroll">
              <div className="grid items-start gap-4 md:grid-cols-[1.08fr_0.92fr]">
                <div className="rounded-2xl border border-blue-300/15 bg-gradient-to-br from-blue-950/30 to-slate-950/50 p-4 shadow-inner shadow-black/20">
                  <div className="mb-4 flex items-center gap-3 rounded-xl border border-blue-300/15 bg-slate-950/45 px-3 py-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-200">
                  <Users className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-300/75">01 · 基本資料</p>
                  <p className="mt-1 truncate text-sm font-bold text-white" title={editingEmployee.username}>{editingEmployee.username}</p>
                  <p className="mt-0.5 truncate text-[11px] font-medium tracking-wide text-cyan-200/70">目前 ID：{editingEmployee.employee_id}</p>
                </div>
                  </div>
                  <div className="space-y-3">
                <div>
                  <label className="mb-2 flex items-center justify-between gap-3 text-xs font-bold uppercase tracking-[0.14em] text-blue-100" htmlFor="edit-employee-username">
                    使用者名稱
                    <span className="rounded-full border border-blue-300/20 bg-blue-400/10 px-2 py-0.5 text-[9px] font-semibold normal-case tracking-normal text-blue-200">登入識別</span>
                  </label>
                  <input id="edit-employee-username" type="text" value={editingEmployee.username} onChange={(e) => setEditingEmployee({ ...editingEmployee, username: e.target.value })} disabled={savingEmployeeEdit} className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-900 shadow-[inset_0_1px_2px_rgba(15,23,42,0.08)] outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-400/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400" />
                </div>
                <div>
                  <label className="mb-2 flex items-center justify-between gap-3 text-xs font-bold uppercase tracking-[0.14em] text-blue-100" htmlFor="edit-employee-id">
                    員工 ID
                    <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-2 py-0.5 text-[9px] font-semibold normal-case tracking-normal text-cyan-200">內部識別</span>
                  </label>
                  <input id="edit-employee-id" type="text" value={editingEmployee.employee_id} onChange={(e) => setEditingEmployee({ ...editingEmployee, employee_id: e.target.value })} disabled={savingEmployeeEdit} className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 font-mono text-sm font-medium text-slate-900 shadow-[inset_0_1px_2px_rgba(15,23,42,0.08)] outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-400/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400" />
                </div>
                <div>
                  <label className="mb-2 block text-xs font-bold uppercase tracking-[0.14em] text-blue-100" htmlFor="edit-employee-remarks">備註</label>
                  <input id="edit-employee-remarks" type="text" value={editingEmployee.remarks || ''} onChange={(e) => setEditingEmployee({ ...editingEmployee, remarks: e.target.value })} disabled={savingEmployeeEdit} placeholder="輸入管理員備註……" className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-900 shadow-[inset_0_1px_2px_rgba(15,23,42,0.08)] outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-400/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400" />
                </div>
                  </div>
                </div>
              {(() => {
                const currentAssignment = automationAssignmentsByEmployee.get(editingEmployee.id);
                const activeOwnerPlans = automationPlans.filter(plan => (
                  plan.status === 'active' && plan.owner_admin_id === editingEmployee.created_by
                ));
                const selectedActivePlan = activeOwnerPlans.find(plan => plan.id === editingAutomationPlanId);
                const selectedPlanName = selectedActivePlan?.name || '不指定方案';
                const selectedPlanTaskCount = selectedActivePlan
                  ? Number(selectedActivePlan.selected_task_count) || 0
                  : null;
                const planOptions = [
                  { id: '', name: '不指定方案', meta: '不加入', disabled: false },
                  ...activeOwnerPlans.map(plan => ({
                    id: plan.id,
                    name: plan.name,
                    meta: `${Number(plan.selected_task_count) || 0} 個任務`,
                    disabled: false,
                  })),
                ];

                return (
                  <div className="rounded-2xl border border-cyan-300/20 bg-gradient-to-br from-cyan-950/30 to-slate-950/55 p-4 shadow-inner shadow-black/20">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <label htmlFor="edit-employee-automation-plan" className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-300/80">02 · 自動化通知方案</label>
                        <p className="mt-2 truncate text-[11px] font-medium text-slate-400">
                          目前方案：
                          <span className="ml-1 font-bold text-cyan-100">{currentAssignment ? currentAssignment.plan_name : '不指定方案'}</span>
                        </p>
                      </div>
                      <Bell className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                    </div>
                    <button
                      ref={editPlanButtonRef}
                      id="edit-employee-automation-plan"
                      type="button"
                      aria-haspopup="listbox"
                      aria-expanded={editPlanMenuOpen}
                      onClick={() => toggleEditPlanMenu(planOptions.length)}
                      disabled={savingEmployeeEdit}
                      className={`group mt-3 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left shadow-lg outline-none transition-all disabled:cursor-not-allowed disabled:opacity-50 ${editPlanMenuOpen ? 'border-cyan-200/90 bg-cyan-400/20 ring-2 ring-cyan-300/20' : selectedActivePlan ? 'border-cyan-300/75 bg-gradient-to-r from-cyan-500/25 via-cyan-400/15 to-blue-500/10 shadow-cyan-950/50 ring-1 ring-cyan-200/20 hover:border-cyan-200' : 'border-slate-600/80 bg-slate-900/90 hover:border-slate-400 hover:bg-slate-800/95'}`}
                    >
                      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${selectedActivePlan ? 'border-cyan-200/60 bg-cyan-300/20 text-cyan-100 shadow-sm shadow-cyan-950/40' : 'border-slate-600 bg-slate-800 text-slate-400'}`}>
                        <Bell className="h-3.5 w-3.5" />
                      </span>
                      <span className={`min-w-0 flex-1 truncate text-[11px] font-extrabold ${selectedActivePlan ? 'text-cyan-50' : 'text-white'}`}>{selectedPlanName}</span>
                      {selectedPlanTaskCount !== null && (
                        <>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-300/35 bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-100">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_7px_rgba(110,231,183,0.9)]" />
                            啟用中
                          </span>
                          <span className="shrink-0 rounded-md border border-cyan-200/35 bg-cyan-300/15 px-1.5 py-0.5 text-[9px] font-bold text-cyan-100">{selectedPlanTaskCount} 個任務</span>
                        </>
                      )}
                      <ChevronDown className={`h-4 w-4 shrink-0 transition-transform duration-200 ${editPlanMenuOpen ? 'rotate-180 text-white' : selectedActivePlan ? 'text-cyan-200' : 'text-slate-400 group-hover:text-white'}`} />
                    </button>
                    {activeOwnerPlans.length === 0 && !currentAssignment && (
                      <p className="mt-2 text-[11px] text-slate-500">此員工所屬群組目前沒有可指定的啟用方案。</p>
                    )}
                    {selectedActivePlan && (
                      <p className="mt-2 flex items-center gap-1.5 rounded-lg border border-cyan-300/25 bg-cyan-400/10 px-2 py-1.5 text-[10px] font-bold text-cyan-100">
                        <CheckCircle className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
                        儲存後直接加入此方案
                      </p>
                    )}
                    <p className="mt-3 border-t border-cyan-300/10 pt-3 text-[11px] leading-5 text-slate-400">變更會同步方案員工名單並影響後續通知任務；既有發送與執行歷史都會保留。</p>
                    {editPlanMenuOpen && editPlanMenuPosition && createPortal(
                      <div
                        ref={editPlanMenuRef}
                        role="listbox"
                        aria-label="編輯員工自動化通知方案"
                        className="fixed z-[10050] overflow-hidden rounded-2xl border border-cyan-300/35 bg-[#08111f]/98 p-1.5 shadow-[0_24px_70px_rgba(0,0,0,0.72)] backdrop-blur-xl ring-1 ring-inset ring-white/[0.08] animate-in fade-in zoom-in-95 duration-150"
                        style={{ top: editPlanMenuPosition.top, left: editPlanMenuPosition.left, width: editPlanMenuPosition.width }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="max-h-[264px] space-y-0.5 overflow-y-auto dark-panel-scroll">
                          {planOptions.map(option => {
                            const selected = editingAutomationPlanId === option.id;
                            return (
                              <button
                                key={option.id || 'none'}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                disabled={option.disabled || savingEmployeeEdit}
                                onClick={() => {
                                  setEditingAutomationPlanId(option.id);
                                  setEditingAutomationPlanTouched(true);
                                  setEditPlanMenuOpen(false);
                                  setEditPlanMenuPosition(null);
                                }}
                                className={`flex h-8 w-full items-center gap-2 rounded-lg border px-2 text-left transition-all disabled:cursor-not-allowed ${selected ? 'border-cyan-300/45 bg-gradient-to-r from-cyan-500/20 to-blue-500/5' : option.disabled ? 'border-transparent bg-slate-900/45 opacity-60' : 'border-transparent hover:border-slate-600 hover:bg-slate-800/90'}`}
                              >
                                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${selected ? 'border-cyan-300/35 bg-cyan-400/15 text-cyan-200' : 'border-slate-700 bg-slate-900 text-slate-500'}`}>
                                  {option.id ? <Bell className="h-3 w-3" /> : <X className="h-3 w-3" />}
                                </span>
                                <span className={`min-w-0 flex-1 truncate text-[11px] font-bold ${selected ? 'text-white' : 'text-slate-300'}`}>{option.name}</span>
                                {option.id && (
                                  <span className="inline-flex shrink-0 items-center gap-1 text-[9px] font-bold text-emerald-200">
                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                                    啟用
                                  </span>
                                )}
                                <span className={`shrink-0 text-[9px] font-bold ${selected ? 'text-cyan-200' : 'text-slate-300'}`}>{option.meta}</span>
                                {selected && <CheckCircle className="h-3.5 w-3.5 shrink-0 text-cyan-300" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>,
                      document.body,
                    )}
                  </div>
                );
              })()}
              </div>
              {editEmployeeError && (
                <div role="alert" className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-400/35 bg-red-500/10 px-3.5 py-2.5 text-xs leading-5 text-red-200">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{editEmployeeError}</span>
                </div>
              )}
              <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-blue-300/15 bg-blue-500/5 px-3.5 py-2.5 text-[11px] leading-5 text-slate-400">
                <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-300" />
                <span>儲存後，員工清單與相關管理檢視會從伺服器重新載入最新資料。</span>
              </div>
            </div>
            <div className="flex shrink-0 flex-col-reverse gap-2 overflow-hidden rounded-b-[1.75rem] border-t border-blue-300/15 bg-gradient-to-r from-slate-950/70 via-blue-950/25 to-slate-950/70 px-5 py-3.5 sm:flex-row sm:justify-end sm:px-6">
              <button type="button" onClick={closeEmployeeEditor} disabled={savingEmployeeEdit} className="rounded-xl border border-slate-600/80 bg-slate-800/70 px-5 py-2.5 text-sm font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">取消</button>
              <button type="button" onClick={() => void handleSaveEmployeeEdit()} disabled={savingEmployeeEdit || !editingEmployee.username.trim() || !editingEmployee.employee_id.trim()} className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-300/45 bg-gradient-to-r from-blue-600 to-cyan-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-blue-950/40 transition-all hover:-translate-y-0.5 hover:from-blue-500 hover:to-cyan-500 active:translate-y-0 disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-50">
                {savingEmployeeEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                {savingEmployeeEdit ? '儲存中…' : '儲存變更'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {editingRemarksOnly && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm" onClick={() => setEditingRemarksOnly(null)}>
          <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-blue-400/30 bg-slate-900 shadow-[0_24px_80px_rgba(2,6,23,0.65)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-blue-400/20 bg-gradient-to-r from-blue-950/80 via-slate-900 to-slate-900 px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-300/30 bg-blue-500/15 text-blue-200">
                  <Pencil className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-blue-300/80">員工備註</p>
                  <h3 title={editingRemarksOnly.username} className="truncate text-lg font-bold text-white">{editingRemarksOnly.username}</h3>
                  <p className="truncate text-xs text-slate-400">員工 ID：{editingRemarksOnly.employee_id}</p>
                </div>
              </div>
              <button type="button" onClick={() => setEditingRemarksOnly(null)} aria-label="關閉編輯備註" className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-700/80 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">備註</label>
                <textarea
                  value={editingRemarksOnly.remarks || ''}
                  onChange={(e) => setEditingRemarksOnly({ ...editingRemarksOnly, remarks: e.target.value })}
                  rows={5}
                  placeholder="輸入此員工的內部備註……"
                  className="min-h-[132px] w-full resize-none rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm leading-6 text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15"
                />
              </div>
              <div className="flex items-start gap-2.5 rounded-xl border border-blue-400/20 bg-blue-500/5 px-3.5 py-3 text-xs text-slate-400">
                <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-300" />
                <span>此備註會顯示給員工清單中的管理員。</span>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-700/70 pt-4">
                <button type="button" onClick={() => setEditingRemarksOnly(null)} className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-700 hover:text-white">取消</button>
                <button type="button" onClick={() => { handleUpdateEmployee(editingRemarksOnly.id, { remarks: editingRemarksOnly.remarks }); setEditingRemarksOnly(null); }} className="inline-flex items-center gap-2 rounded-lg border border-blue-400/50 bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-950/40 transition-all hover:bg-blue-500 active:bg-blue-700">
                  <CheckCircle className="h-4 w-4" />
                  儲存備註
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showPasswordReset && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md animate-in fade-in duration-200" onClick={() => { if (!resettingPassword) { setShowPasswordReset(null); setNewPassword(''); setShowResetPassword(false); } }}>
          <div className="relative w-full max-w-lg overflow-hidden rounded-[1.75rem] border border-amber-300/25 bg-gradient-to-b from-slate-900 via-slate-900 to-amber-950/25 shadow-[0_24px_90px_rgba(2,6,23,0.78)] ring-1 ring-inset ring-white/10 animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="relative overflow-hidden rounded-t-[1.75rem] border-b border-amber-300/15 bg-gradient-to-r from-amber-950/80 via-orange-950/30 to-slate-900/80 px-5 py-5 sm:px-6">
              <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-500 via-yellow-200 to-orange-500" />
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-amber-300/35 bg-amber-400/15 text-amber-100 shadow-lg shadow-amber-950/35 ring-1 ring-inset ring-white/10">
                    <Key className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-300">安全控制</p>
                    <h3 className="mt-1 text-xl font-bold tracking-tight text-white">修改登入密碼</h3>
                    <p className="mt-1 text-xs text-amber-100/60">更新後，舊密碼與既有會話將立即失效。</p>
                  </div>
                </div>
                <button type="button" onClick={() => { setShowPasswordReset(null); setNewPassword(''); setShowResetPassword(false); }} disabled={resettingPassword} aria-label="關閉修改密碼" className="rounded-xl border border-amber-300/15 bg-slate-950/35 p-2 text-slate-400 transition-colors hover:border-amber-300/40 hover:bg-amber-400/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="space-y-5 p-5 sm:p-6">
              <div className="flex items-center gap-3 rounded-2xl border border-amber-300/15 bg-slate-950/45 px-4 py-3.5 shadow-inner shadow-black/20">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-300/25 bg-amber-400/10 text-amber-200">
                  <Users className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">目標員工帳戶</p>
                  <p className="mt-1 truncate text-base font-bold text-white" title={showPasswordReset.username}>{showPasswordReset.username}</p>
                  <p className="mt-0.5 text-[11px] font-medium tracking-wide text-amber-200/70">密碼變更需要重新登入</p>
                </div>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label className="text-xs font-bold uppercase tracking-[0.14em] text-amber-100" htmlFor="reset-employee-password">新密碼</label>
                  <span className="rounded-full border border-amber-300/20 bg-amber-400/10 px-2 py-0.5 text-[9px] font-semibold text-amber-200">至少 6 位</span>
                </div>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Key className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-amber-300/70" />
                    <input id="reset-employee-password" type={showResetPassword ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="輸入新密碼" autoComplete="new-password" minLength={6} disabled={resettingPassword} className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-10 pr-11 text-sm font-medium text-slate-900 shadow-[inset_0_1px_2px_rgba(15,23,42,0.08)] outline-none transition-colors placeholder:text-slate-400 focus:border-amber-400 focus:bg-white focus:ring-4 focus:ring-amber-300/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100" />
                    <button type="button" onClick={() => setShowResetPassword(!showResetPassword)} disabled={resettingPassword} aria-label={showResetPassword ? '隱藏密碼' : '顯示密碼'} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-amber-400/10 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-50">
                      {showResetPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <button type="button" onClick={generateResetPassword} disabled={resettingPassword} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-300/25 bg-amber-400/10 text-amber-200 transition-all hover:border-amber-200/50 hover:bg-amber-400/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-50" title="產生高強度密碼" aria-label="產生高強度密碼">
                    <RefreshCw className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="flex items-start gap-2.5 rounded-xl border border-amber-300/15 bg-amber-400/5 px-3.5 py-3 text-xs leading-5 text-slate-400">
                <Key className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                <span>重設完成後，員工必須使用新密碼重新登入；系統也會撤銷目前的員工工作會話。</span>
              </div>
            </div>
            <div className="flex flex-col-reverse gap-2 overflow-hidden rounded-b-[1.75rem] border-t border-amber-300/15 bg-slate-950/45 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              <button type="button" onClick={() => { setShowPasswordReset(null); setNewPassword(''); setShowResetPassword(false); }} disabled={resettingPassword} className="rounded-xl border border-slate-600/80 bg-slate-800/70 px-5 py-2.5 text-sm font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">取消</button>
              <button type="button" onClick={() => { if (showPasswordReset) void handleResetPassword(showPasswordReset.id); }} disabled={resettingPassword || newPassword.length < 6} className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-200/50 bg-amber-500 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-lg shadow-amber-950/35 transition-colors hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50">
                {resettingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                {resettingPassword ? '重設中…' : '確認修改'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {editingCreatedAt && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md animate-in fade-in duration-200" onClick={closeRegistrationDateEditor}>
          <div className="relative w-full max-w-lg overflow-visible rounded-[1.75rem] border border-cyan-300/25 bg-gradient-to-b from-slate-900 via-slate-900 to-blue-950/35 shadow-[0_24px_90px_rgba(2,6,23,0.78)] ring-1 ring-inset ring-white/10 animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
            <div className="relative overflow-hidden rounded-t-[1.75rem] border-b border-cyan-300/15 bg-gradient-to-r from-blue-950/80 via-cyan-950/35 to-slate-900/80 px-5 py-5">
              <div className="absolute inset-x-0 top-0 h-1 rounded-t-[1.75rem] bg-gradient-to-r from-blue-500 via-cyan-300 to-blue-500" />
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-cyan-300/35 bg-cyan-400/15 text-cyan-100 shadow-lg shadow-cyan-950/35 ring-1 ring-inset ring-white/10">
                    <CalendarDays className="h-6 w-6" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300">註冊控制</p>
                    <h3 className="mt-1 text-xl font-bold tracking-tight text-white">編輯註冊日期</h3>
                    <p className="mt-1 text-xs text-cyan-100/60">安全地更新員工帳戶時間戳。</p>
                  </div>
                </div>
                <button type="button" onClick={closeRegistrationDateEditor} aria-label="關閉編輯註冊日期" className="rounded-xl border border-cyan-300/15 bg-slate-950/35 p-2 text-slate-400 transition-colors hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="relative space-y-5 p-5">
              <div className="rounded-2xl border border-cyan-300/15 bg-slate-950/45 px-4 py-3.5 shadow-inner shadow-black/20">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-blue-300/25 bg-blue-500/10 text-blue-200">
                    <Users className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">員工帳戶</p>
                    <p title={editingCreatedAt.username} className="mt-1 truncate text-base font-bold text-white">{editingCreatedAt.username}</p>
                    <p className="mt-0.5 truncate text-xs font-medium tracking-wide text-cyan-200/70">員工 ID：{editingCreatedAt.employeeId}</p>
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label htmlFor="employee-registration-date" className="text-xs font-bold uppercase tracking-[0.14em] text-cyan-100">註冊日期</label>
                  <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-200">僅日期</span>
                </div>
                <div ref={registrationCalendarRef} className="relative">
                  <input
                    id="employee-registration-date"
                    type="date"
                    autoComplete="off"
                    value={newCreatedAt}
                    onChange={event => {
                      const value = event.target.value;
                      setNewCreatedAt(value);
                      if (registrationDateInputError) setRegistrationDateInputError(null);
                      if (isValidCalendarDate(value)) setRegistrationCalendarMonth(value.slice(0, 7));
                    }}
                    onBlur={() => {
                      if (!newCreatedAt || !isValidCalendarDate(newCreatedAt)) {
                        setRegistrationDateInputError('請輸入有效日期，格式為 YYYY-MM-DD');
                      }
                    }}
                    className={`w-full rounded-xl border bg-slate-950/75 px-4 py-3 pr-14 text-sm font-semibold tracking-wide text-white shadow-inner shadow-black/20 outline-none transition-colors [color-scheme:dark] focus:ring-4 ${registrationDateInputError ? 'border-rose-400/70 focus:border-rose-300 focus:ring-rose-400/10' : 'border-cyan-300/30 focus:border-cyan-300/75 focus:ring-cyan-400/10'}`}
                  />
                  <button
                    type="button"
                    aria-label="開啟日期選擇器"
                    aria-haspopup="dialog"
                    aria-expanded={registrationCalendarOpen}
                    onClick={() => {
                      if (isValidCalendarDate(newCreatedAt)) setRegistrationCalendarMonth(newCreatedAt.slice(0, 7));
                      setRegistrationCalendarOpen(open => !open);
                    }}
                    className={`absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg border transition-colors ${registrationCalendarOpen ? 'border-cyan-300/60 bg-cyan-400/15 text-cyan-100' : 'border-cyan-300/20 bg-cyan-400/5 text-cyan-300 hover:border-cyan-300/50 hover:bg-cyan-400/15 hover:text-white'}`}
                  >
                    <CalendarDays className="h-4 w-4" />
                  </button>

                  {registrationCalendarOpen && (
                    <div className="absolute left-0 right-0 top-full z-[100] mt-2 h-[410px] overflow-hidden rounded-2xl border border-cyan-300/30 bg-gradient-to-b from-slate-800 via-blue-950 to-slate-950 shadow-[0_18px_50px_rgba(2,6,23,0.72)] ring-1 ring-inset ring-white/10 xl:left-full xl:right-auto xl:top-0 xl:mt-0 xl:ml-3 xl:w-[310px]">
                      <div className="h-1 bg-gradient-to-r from-blue-500 via-cyan-300 to-blue-500" />
                      <div className="flex items-center justify-between border-b border-cyan-300/15 bg-gradient-to-r from-blue-950/80 via-cyan-950/35 to-slate-900/80 px-3.5 py-3">
                        <button
                          type="button"
                          aria-label="上個月"
                          onClick={() => {
                            const previousMonth = new Date(calendarYear, calendarMonthNumber - 2, 1);
                            setRegistrationCalendarMonth(getCalendarMonthKey(previousMonth));
                          }}
                          className="rounded-lg border border-cyan-300/15 bg-slate-950/30 p-1.5 text-cyan-200 transition-colors hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-white"
                        >
                          <ChevronLeft className="h-4 w-4" />
                        </button>
                        <div className="text-center">
                          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300">日期選擇</p>
                          <p className="mt-0.5 text-sm font-bold text-white">{calendarMonthLabel}</p>
                        </div>
                        <button
                          type="button"
                          aria-label="下個月"
                          onClick={() => {
                            const nextMonth = new Date(calendarYear, calendarMonthNumber, 1);
                            setRegistrationCalendarMonth(getCalendarMonthKey(nextMonth));
                          }}
                          className="rounded-lg border border-cyan-300/15 bg-slate-950/30 p-1.5 text-cyan-200 transition-colors hover:border-cyan-300/40 hover:bg-cyan-400/10 hover:text-white"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="p-3.5">
                        <div className="mb-2 grid grid-cols-7 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">
                          {['日', '一', '二', '三', '四', '五', '六'].map(day => <span key={day}>{day}</span>)}
                        </div>
                        <div className="grid grid-cols-7 gap-1">
                          {calendarCells.map((day, index) => {
                            if (!day) return <span key={`empty-${index}`} className="h-9" />;
                            const dateKey = `${registrationCalendarMonth}-${String(day).padStart(2, '0')}`;
                            const isSelected = newCreatedAt === dateKey;
                            const isToday = todayDateKey === dateKey;
                            return (
                              <button
                                key={dateKey}
                                type="button"
                                aria-label={`選擇 ${formatCalendarDateLabel(dateKey)}`}
                                aria-pressed={isSelected}
                                onClick={() => {
                                  setNewCreatedAt(dateKey);
                                  setRegistrationDateInputError(null);
                                  setRegistrationCalendarOpen(false);
                                }}
                                className={`relative h-9 rounded-lg text-xs font-semibold transition-colors ${
                                  isSelected
                                    ? 'bg-cyan-500 text-slate-950 shadow-lg shadow-cyan-950/40'
                                    : isToday
                                      ? 'border border-amber-300/50 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20'
                                      : 'text-slate-200 hover:bg-cyan-400/15 hover:text-white'
                                }`}
                              >
                                {day}
                                {isToday && !isSelected && <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-amber-300" />}
                              </button>
                            );
                          })}
                        </div>
                        <div className="mt-3 flex items-center justify-between border-t border-cyan-300/15 pt-3">
                          <button
                            type="button"
                            onClick={() => {
                              const now = new Date();
                              setNewCreatedAt(formatWithdrawalDate(now.toISOString()));
                              setRegistrationDateInputError(null);
                              setRegistrationCalendarMonth(getCalendarMonthKey(now));
                              setRegistrationCalendarOpen(false);
                            }}
                            className="rounded-lg border border-amber-300/25 bg-amber-400/10 px-3 py-1.5 text-xs font-semibold text-amber-200 transition-colors hover:border-amber-300/50 hover:bg-amber-400/20"
                          >
                            今天
                          </button>
                          <button
                            type="button"
                            onClick={() => setRegistrationCalendarOpen(false)}
                            className="text-xs font-semibold text-cyan-200 transition-colors hover:text-white"
                          >
                            完成
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <p className={`mt-2 flex items-center gap-1.5 text-[11px] leading-5 ${registrationDateInputError ? 'text-rose-300' : 'text-slate-500'}`}>
                  <CalendarDays className={`h-3.5 w-3.5 shrink-0 ${registrationDateInputError ? 'text-rose-300' : 'text-cyan-300/70'}`} />
                  {registrationDateInputError || '可分別調整年、月、日，或點擊右側日曆圖示選擇日期。'}
                </p>
              </div>

              <div className="flex items-start gap-2.5 rounded-xl border border-blue-300/15 bg-blue-500/5 px-3.5 py-3 text-xs leading-5 text-slate-400">
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                <span>The change will be saved securely and reflected in the employee details page.</span>
              </div>
            </div>

            <div className="flex flex-col-reverse gap-2 overflow-hidden rounded-b-[1.75rem] border-t border-cyan-300/15 bg-slate-950/45 px-5 py-4 sm:flex-row sm:justify-end">
              <button type="button" onClick={closeRegistrationDateEditor} className="rounded-xl border border-slate-600/80 bg-slate-800/70 px-5 py-2.5 text-sm font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-700 hover:text-white">取消</button>
              <button
                type="button"
                disabled={savingCreatedAt}
                onClick={async () => {
                  if (!isValidCalendarDate(newCreatedAt)) {
                    setRegistrationDateInputError('請輸入有效日期，格式為 YYYY-MM-DD');
                    return;
                  }
                  setSavingCreatedAt(true);
                  try {
                    const isoDate = new Date(`${newCreatedAt}T12:00:00`).toISOString();
                    const { error } = await supabase.rpc('admin_update_employee_account', {
                      p_admin_session_token: getAdminFinancialSessionToken(),
                      p_user_id: editingCreatedAt.id,
                      p_updates: { created_at: isoDate },
                    });
                    if (error) throw error;
                    setEmployeeGroups(prev => prev.map(g => ({
                      ...g,
                      employees: g.employees.map(emp => emp.id === editingCreatedAt.id ? { ...emp, created_at: isoDate } : emp)
                    })));
                    closeRegistrationDateEditor();
                    setNotification({
                      show: true,
                      type: 'success',
                      category: 'profile',
                      title: '註冊日期已儲存',
                      message: '員工註冊日期已更新並同步至員工詳情資料。',
                      employee: { username: editingCreatedAt.username, employeeId: editingCreatedAt.employeeId },
                      details: [{ label: '註冊日期', value: newCreatedAt }],
                    });
                  } catch (error) {
                    console.error('Error updating employee registration date:', formatSupabaseError(error));
                    setNotification({ show: true, type: 'error', title: '錯誤', message: formatSupabaseError(error) || '更新註冊日期失敗' });
                  } finally {
                    setSavingCreatedAt(false);
                  }
                }}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-300/35 bg-cyan-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-cyan-950/35 transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckCircle className="h-4 w-4" />
                {savingCreatedAt ? '儲存中……' : '儲存日期'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {pinConfirmEmployee && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-[3px]" onClick={() => setPinConfirmEmployee(null)}>
          <div className="relative w-full max-w-md overflow-hidden rounded-[26px] border border-amber-200/25 bg-[#0b1724] shadow-[0_24px_90px_rgba(2,12,27,0.68)]" onClick={e => e.stopPropagation()}>
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(251,191,36,0.18),transparent_38%),linear-gradient(135deg,rgba(15,23,42,0.98),rgba(10,31,46,0.96))]" />
            <div className="relative border-b border-white/10 px-5 pb-4 pt-5 sm:px-6">
              <button
                type="button"
                onClick={() => setPinConfirmEmployee(null)}
                aria-label="關閉釘選確認面板"
                className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-slate-950/35 text-slate-400 transition-all hover:border-rose-300/60 hover:bg-rose-500/20 hover:text-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/70"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="flex items-start gap-3 pr-10">
                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border shadow-lg ${pinConfirmEmployee.currentPinned ? 'border-rose-300/35 bg-rose-400/15 text-rose-200 shadow-rose-950/40' : 'border-amber-300/35 bg-amber-400/15 text-amber-200 shadow-amber-950/40'}`}>
                  <Pin className={`h-5 w-5 ${pinConfirmEmployee.currentPinned ? 'rotate-45' : '-rotate-45'}`} />
                </div>
                <div className="min-w-0">
                  <p className={`text-[10px] font-bold uppercase tracking-[0.18em] ${pinConfirmEmployee.currentPinned ? 'text-rose-300/90' : 'text-amber-300/90'}`}>員工清單管理</p>
                  <h3 className="mt-1 text-xl font-bold tracking-tight text-white">{pinConfirmEmployee.currentPinned ? '取消釘選員工' : '釘選至頂端'}</h3>
                  <p className="mt-1 text-xs leading-5 text-slate-400">{pinConfirmEmployee.currentPinned ? '此員工將恢復一般排序位置。' : '此員工將固定顯示在員工清單頂端。'}</p>
                </div>
              </div>
            </div>
            <div className="relative space-y-3 px-5 py-5 sm:px-6">
              <div className="rounded-2xl border border-white/10 bg-slate-950/45 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">員工帳戶</p>
                <p className="mt-1.5 truncate text-2xl font-bold tracking-tight text-white" title={pinConfirmEmployee.username}>{pinConfirmEmployee.username}</p>
                {pinConfirmEmployee.employeeId && (
                  <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-3">
                    <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">員工 ID</span>
                    <span className="font-mono text-xs font-semibold tracking-wide text-cyan-200">{pinConfirmEmployee.employeeId}</span>
                  </div>
                )}
              </div>
              <p className="px-1 text-xs leading-5 text-slate-400">
                {pinConfirmEmployee.currentPinned ? '確定要取消此員工的置頂狀態嗎？' : '確定要將此員工釘選到清單頂端嗎？'}
              </p>
            </div>
            <div className="relative flex flex-col-reverse gap-2 border-t border-white/10 bg-slate-950/45 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              <button
                type="button"
                onClick={() => setPinConfirmEmployee(null)}
                className="inline-flex items-center justify-center rounded-xl border border-slate-600/80 bg-slate-800/70 px-5 py-2.5 text-sm font-semibold text-slate-300 transition-all hover:border-slate-500 hover:bg-slate-700 hover:text-white active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/70"
              >取消</button>
              <button
                type="button"
                onClick={() => { togglePin(pinConfirmEmployee.id, pinConfirmEmployee.currentPinned); setPinConfirmEmployee(null); }}
                className={`inline-flex items-center justify-center gap-2 rounded-xl border px-5 py-2.5 text-sm font-bold shadow-lg transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 ${pinConfirmEmployee.currentPinned ? 'border-rose-200/60 bg-rose-600 text-white shadow-rose-950/40 hover:bg-rose-500 focus-visible:ring-rose-300/80' : 'border-amber-200/60 bg-amber-400 text-slate-950 shadow-amber-950/40 hover:bg-amber-300 focus-visible:ring-amber-200/80'}`}
              >
                <Pin className={`h-4 w-4 ${pinConfirmEmployee.currentPinned ? 'rotate-45' : '-rotate-45'}`} />
                {pinConfirmEmployee.currentPinned ? '取消釘選' : '釘選至頂端'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {deletingEmployee && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md animate-in fade-in duration-200" onClick={() => { if (!isDeleting) { setDeletingEmployee(null); setDeleteError(null); } }}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-employee-title" className="relative w-full max-w-lg overflow-hidden rounded-[1.75rem] border border-rose-300/25 bg-gradient-to-b from-slate-900 via-slate-900 to-rose-950/25 shadow-[0_24px_90px_rgba(2,6,23,0.8)] ring-1 ring-inset ring-white/10 animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="relative overflow-hidden rounded-t-[1.75rem] border-b border-rose-300/15 bg-gradient-to-r from-rose-950/85 via-red-950/35 to-slate-900/80 px-5 py-5 sm:px-6">
              <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-rose-600 via-red-300 to-orange-400" />
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-rose-300/35 bg-rose-500/15 text-rose-100 shadow-lg shadow-rose-950/40 ring-1 ring-inset ring-white/10">
                    <Trash2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-rose-300">員工管理 · 刪除確認</p>
                    <h3 id="delete-employee-title" className="mt-1 text-xl font-bold tracking-tight text-white">刪除員工帳戶？</h3>
                    <p className="mt-1 text-xs text-slate-400">請確認要刪除的員工帳戶</p>
                  </div>
                </div>
                <button type="button" onClick={() => { setDeletingEmployee(null); setDeleteError(null); }} disabled={isDeleting} aria-label="關閉刪除員工" className="rounded-xl border border-rose-300/15 bg-slate-950/35 p-2 text-slate-400 transition-colors hover:border-rose-300/40 hover:bg-rose-400/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="space-y-4 p-5 sm:p-6">
              {deleteError && (
                <div className="flex items-start gap-2.5 rounded-xl border border-rose-400/40 bg-rose-500/10 px-3.5 py-3 text-sm leading-5 text-rose-200">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                  <span>{deleteError}</span>
                </div>
              )}
              <div className="flex items-center gap-3 rounded-2xl border border-rose-300/15 bg-slate-950/45 px-4 py-3.5 shadow-inner shadow-black/20">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-rose-300/25 bg-rose-400/10 text-rose-200">
                  <Users className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">目標員工帳戶</p>
                  <p className="mt-1 truncate text-base font-bold text-white" title={deletingEmployee.username}>{deletingEmployee.username}</p>
                  <p className="mt-0.5 truncate text-[11px] font-mono font-medium tracking-wide text-rose-200/70">員工 ID：{deletingEmployee.employee_id}</p>
                </div>
              </div>
              <p className="text-xs text-slate-400">請確認以上帳戶資訊無誤。</p>
            </div>
            <div className="flex flex-col-reverse gap-2 overflow-hidden rounded-b-[1.75rem] border-t border-rose-300/15 bg-slate-950/45 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              <button type="button" onClick={() => { setDeletingEmployee(null); setDeleteError(null); }} disabled={isDeleting} className="rounded-xl border border-slate-600/80 bg-slate-800/70 px-5 py-2.5 text-sm font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">取消</button>
              <button type="button" onClick={() => handleDeleteEmployee(deletingEmployee)} disabled={isDeleting} className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-200/50 bg-rose-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-rose-950/40 transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50">
                {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {isDeleting ? '刪除中…' : '確認刪除'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {editingTags && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm" onClick={() => { setEditingTags(null); setNewTag(''); }}>
          <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-amber-400/30 bg-slate-900 shadow-[0_24px_80px_rgba(2,6,23,0.65)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-amber-400/20 bg-gradient-to-r from-amber-950/70 via-slate-900 to-slate-900 px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-300/35 bg-amber-500/15 text-amber-200">
                  <Tag className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">員工標籤</p>
                  <h3 title={editingTags.username} className="truncate text-lg font-bold text-white">{editingTags.username}</h3>
                  <p className="truncate text-xs text-slate-400">Employee ID: {editingTags.employee_id}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-amber-400/25 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-200">{(editingTags.tags || []).length} 個啟用</span>
                <button type="button" onClick={() => { setEditingTags(null); setNewTag(''); }} aria-label="關閉標籤管理" className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-700/80 hover:text-white">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="space-y-4 p-5">
              <div className="rounded-xl border border-amber-400/20 bg-amber-500/5 p-4">
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-amber-200">新增標籤</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddTag(editingTags); }}
                    placeholder="輸入標籤名稱……"
                    className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-amber-500 focus:ring-4 focus:ring-amber-500/15"
                  />
                  <button type="button" onClick={() => handleAddTag(editingTags)} className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-amber-400/60 bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-amber-950/30 transition-all hover:bg-amber-500 active:bg-amber-700">
                    <Tag className="h-4 w-4" />
                    新增
                  </button>
                </div>
              </div>
              <div className="rounded-xl border border-slate-700/80 bg-slate-950/45 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">目前標籤</label>
                  <span className="text-[11px] text-slate-500">變更會立即儲存</span>
                </div>
                <div className="flex min-h-[92px] flex-wrap content-start gap-2">
                  {(editingTags.tags || []).length === 0 ? (
                    <div className="flex w-full flex-col items-center justify-center gap-1.5 py-5 text-center">
                      <Tag className="h-5 w-5 text-slate-600" />
                      <p className="text-sm text-slate-500">尚未指派任何標籤</p>
                    </div>
                  ) : (
                    (editingTags.tags || []).map((tag, idx) => (
                      <span key={idx} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/35 bg-amber-500/15 px-2.5 py-1.5 text-sm font-semibold text-amber-200">
                        {tag}
                        <button type="button" onClick={() => handleRemoveTag(editingTags, tag)} aria-label={`移除 ${tag}`} className="rounded-md p-0.5 text-amber-300 transition-colors hover:bg-amber-400/25 hover:text-white">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="flex justify-end border-t border-slate-700/70 pt-4">
                <button type="button" onClick={() => { setEditingTags(null); setNewTag(''); }} className="rounded-lg border border-slate-600 bg-slate-800 px-5 py-2 text-sm font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-700 hover:text-white">關閉</button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {viewingEmployee && (
        <EmployeeDetailModal
          employee={viewingEmployee}
          onClose={() => setViewingEmployee(null)}
        />
      )}

      {renderLoginIPModal()}

      {renderWalletModal()}

      {showCreateSecondaryAdmin && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !creatingSecondaryAdmin) {
              setShowCreateSecondaryAdmin(false);
              setCreateSecondaryAdminError(null);
              setSecondaryAdminForm({ username: '', password: '' });
              setShowSecondaryAdminPassword(false);
            }
          }}
        >
          <form
            onSubmit={handleCreateSecondaryAdmin}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-full max-w-lg overflow-hidden rounded-2xl border border-cyan-300/30 bg-slate-900 shadow-2xl shadow-slate-950/70"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-secondary-admin-title"
          >
            <div className="flex items-start justify-between border-b border-cyan-300/15 bg-gradient-to-r from-blue-600/20 via-cyan-500/10 to-transparent px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-400/15 text-cyan-200 ring-1 ring-cyan-300/25">
                  <UserPlus className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200/70">管理員存取權限</p>
                  <h2 id="create-secondary-admin-title" className="truncate text-lg font-semibold text-white">建立次要管理員</h2>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (creatingSecondaryAdmin) return;
                  setShowCreateSecondaryAdmin(false);
                  setCreateSecondaryAdminError(null);
                  setSecondaryAdminForm({ username: '', password: '' });
                  setShowSecondaryAdminPassword(false);
                }}
                className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-cyan-300/10 hover:text-cyan-100"
                aria-label="關閉建立次要管理員面板"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className="rounded-xl border border-cyan-300/15 bg-cyan-500/5 px-3.5 py-3 text-sm text-slate-300">
                此帳戶會連結至您的管理員帳戶，並可管理指派給它的員工。
              </div>
              {createSecondaryAdminError && (
                <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-200">
                  {createSecondaryAdminError}
                </div>
              )}
              <div>
                <label htmlFor="secondary-admin-username" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">使用者名稱</label>
                <input
                  id="secondary-admin-username"
                  type="text"
                  value={secondaryAdminForm.username}
                  onChange={(e) => setSecondaryAdminForm({ ...secondaryAdminForm, username: e.target.value })}
                  disabled={creatingSecondaryAdmin}
                  required
                  autoComplete="off"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-2 focus:ring-cyan-400/25 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100"
                  placeholder="輸入管理員使用者名稱"
                />
              </div>
              <div>
                <label htmlFor="secondary-admin-password" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">密碼</label>
                <div className="relative">
                  <input
                    id="secondary-admin-password"
                    type={showSecondaryAdminPassword ? 'text' : 'password'}
                    value={secondaryAdminForm.password}
                    onChange={(e) => setSecondaryAdminForm({ ...secondaryAdminForm, password: e.target.value })}
                    disabled={creatingSecondaryAdmin}
                    required
                    minLength={6}
                    autoComplete="new-password"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 pr-11 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-2 focus:ring-cyan-400/25 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100"
                    placeholder="至少 6 個字元"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecondaryAdminPassword((visible) => !visible)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                    aria-label={showSecondaryAdminPassword ? '隱藏密碼' : '顯示密碼'}
                  >
                    {showSecondaryAdminPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-slate-500">請使用至少 6 個字元。</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-800 bg-slate-950/35 px-5 py-4">
              <button
                type="button"
                onClick={() => {
                  if (creatingSecondaryAdmin) return;
                  setShowCreateSecondaryAdmin(false);
                  setCreateSecondaryAdminError(null);
                  setSecondaryAdminForm({ username: '', password: '' });
                  setShowSecondaryAdminPassword(false);
                }}
                disabled={creatingSecondaryAdmin}
                className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={creatingSecondaryAdmin || !secondaryAdminForm.username.trim() || !secondaryAdminForm.password}
                className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/40 bg-gradient-to-r from-blue-600 to-cyan-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-950/30 transition-all hover:from-blue-500 hover:to-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creatingSecondaryAdmin ? (
                  <><div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />建立中……</>
                ) : (
                  <><UserPlus className="h-4 w-4" />建立管理員</>
                )}
              </button>
            </div>
          </form>
        </div>,
        document.body
      )}

      {deleteFeedback && createPortal(
        <div role={deleteFeedback.type === 'error' ? 'alert' : 'status'} className={`fixed right-4 top-4 z-[10010] flex max-w-[calc(100vw-2rem)] items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl sm:max-w-md ${deleteFeedback.type === 'success' ? 'border-emerald-400/60 bg-emerald-950 text-emerald-50' : 'border-rose-400/60 bg-rose-950 text-rose-50'}`}>
          {deleteFeedback.type === 'success' ? <CheckCircle className="mt-0.5 h-5 w-5 shrink-0" /> : <XCircle className="mt-0.5 h-5 w-5 shrink-0" />}
          <span className="min-w-0 flex-1 break-words">{deleteFeedback.message}</span>
          <button type="button" onClick={() => setDeleteFeedback(null)} aria-label="關閉刪除結果提示" className="rounded p-0.5 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>, document.body,
      )}

      {notification?.show && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md animate-in fade-in duration-200">
          <div className={`relative w-full max-w-md overflow-hidden rounded-[1.75rem] border shadow-[0_24px_90px_rgba(2,6,23,0.78)] ring-1 ring-inset ring-white/10 animate-in zoom-in-95 duration-200 ${notification.type === 'success' ? 'border-emerald-300/25 bg-gradient-to-b from-slate-900 via-slate-900 to-emerald-950/30' : notification.type === 'error' ? 'border-red-300/25 bg-gradient-to-b from-slate-900 via-slate-900 to-red-950/30' : 'border-amber-300/25 bg-gradient-to-b from-slate-900 via-slate-900 to-amber-950/30'}`} role="dialog" aria-modal="true" aria-labelledby="employee-notification-title">
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-400/5 via-transparent to-cyan-400/5 pointer-events-none" />
            <div className={`absolute inset-x-0 top-0 h-1 ${notification.type === 'success' ? 'bg-gradient-to-r from-emerald-500 via-cyan-300 to-emerald-500' : notification.type === 'error' ? 'bg-gradient-to-r from-red-500 via-orange-300 to-red-500' : 'bg-gradient-to-r from-amber-500 via-yellow-200 to-orange-500'}`} />
            <div className="relative flex items-center gap-4 border-b border-white/10 px-6 py-6">
              <div className={`inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border shadow-lg ring-1 ring-inset ring-white/10 ${
                notification.type === 'success' ? 'border-emerald-300/35 bg-emerald-400/15 text-emerald-100 shadow-emerald-950/40' :
                notification.type === 'error' ? 'border-red-300/35 bg-red-400/15 text-red-100 shadow-red-950/40' :
                'border-amber-300/35 bg-amber-400/15 text-amber-100 shadow-amber-950/40'
              }`}>
                {notification.type === 'success' && (notification.category === 'password' ? <Key className="h-6 w-6" /> : notification.category === 'profile' ? <Pencil className="h-6 w-6" /> : <CheckCircle className="h-6 w-6" />)}
                {notification.type === 'error' && <XCircle className="h-6 w-6" />}
                {notification.type === 'warning' && <svg className="w-8 h-8 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>}
              </div>
              <div className="min-w-0">
                <p className={`text-[10px] font-bold uppercase tracking-[0.2em] ${notification.type === 'success' ? 'text-emerald-300' : notification.type === 'error' ? 'text-red-300' : 'text-amber-300'}`}>
                  {notification.type === 'success' ? '操作完成' : notification.type === 'error' ? '操作未完成' : '需要注意'}
                </p>
                <h3 id="employee-notification-title" className="mt-1 text-xl font-bold tracking-tight text-white">{notification.title}</h3>
              </div>
            </div>
            <div className="relative space-y-4 px-6 py-6">
              <p className="text-sm leading-6 text-slate-300">{notification.message}</p>
              {notification.employee && (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-xl border border-cyan-300/15 bg-cyan-400/5 px-3.5 py-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-cyan-300/80">員工帳戶</p>
                    <p className="mt-1 truncate text-sm font-bold text-white" title={notification.employee.username}>{notification.employee.username}</p>
                  </div>
                  <div className="border-l border-cyan-300/15 pl-3 text-right">
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-cyan-300/80">員工 ID</p>
                    <p className="mt-1 max-w-[9rem] truncate font-mono text-sm font-bold text-cyan-100" title={notification.employee.employeeId}>{notification.employee.employeeId}</p>
                  </div>
                </div>
              )}
              {notification.details && notification.details.length > 0 && (
                <div className="rounded-xl border border-white/10 bg-slate-950/35 px-3.5 py-3">
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">本次變更</p>
                  <div className="space-y-2">
                    {notification.details.map(detail => (
                      <div key={detail.label} className="flex items-start justify-between gap-4 text-xs">
                        <span className="shrink-0 font-semibold text-slate-400">{detail.label}</span>
                        <span className="min-w-0 text-right font-semibold text-slate-100">{detail.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className={`flex items-center justify-between rounded-xl border px-3.5 py-3 text-xs ${notification.type === 'success' ? 'border-emerald-300/15 bg-emerald-400/5 text-emerald-100/80' : notification.type === 'error' ? 'border-red-300/15 bg-red-400/5 text-red-100/80' : 'border-amber-300/15 bg-amber-400/5 text-amber-100/80'}`}>
                <span className="font-semibold uppercase tracking-[0.14em]">狀態</span>
                <span className="inline-flex items-center gap-1.5 font-semibold"><span className={`h-1.5 w-1.5 rounded-full ${notification.type === 'success' ? 'bg-emerald-300' : notification.type === 'error' ? 'bg-red-300' : 'bg-amber-300'}`} />{notification.type === 'success' ? '已同步' : notification.type === 'error' ? '請檢查後重試' : '請確認輸入內容'}</span>
              </div>
            </div>
            <div className="border-t border-white/10 bg-slate-950/40 px-6 py-4">
              <button type="button" onClick={() => setNotification(null)} className={`w-full rounded-xl border px-5 py-3 text-sm font-bold shadow-lg transition-all ${notification.type === 'success' ? 'border-emerald-300/35 bg-gradient-to-r from-emerald-600 to-cyan-600 text-white shadow-emerald-950/35 hover:from-emerald-500 hover:to-cyan-500' : notification.type === 'error' ? 'border-red-300/35 bg-gradient-to-r from-red-600 to-orange-600 text-white shadow-red-950/35 hover:from-red-500 hover:to-orange-500' : 'border-amber-300/35 bg-gradient-to-r from-amber-500 to-orange-500 text-slate-950 shadow-amber-950/35 hover:from-amber-400 hover:to-orange-400'}`}>確定</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {confirmDialog?.show && confirmDialogStyle && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm animate-in fade-in duration-200">
          <div className={`relative w-full max-w-lg overflow-hidden rounded-[1.75rem] border shadow-2xl ${confirmDialogStyle.panel}`} role="dialog" aria-modal="true" aria-labelledby="employee-status-dialog-title">
            <div className={`relative flex items-start justify-between gap-4 border-b px-5 py-4 ${confirmDialogStyle.header}`}>
              <div className="flex min-w-0 items-center gap-3">
                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border shadow-lg ${confirmDialogStyle.iconShell}`}>
                  {confirmDialog.variant === 'verification' ? (
                    <CheckCircle className={`h-5 w-5 ${confirmDialogStyle.icon}`} />
                  ) : confirmDialog.nextStatus ? (
                    <CheckCircle className={`h-5 w-5 ${confirmDialogStyle.icon}`} />
                  ) : (
                    <XCircle className={`h-5 w-5 ${confirmDialogStyle.icon}`} />
                  )}
                </div>
                <div className="min-w-0">
                  <p className={`text-[10px] font-bold uppercase tracking-[0.18em] ${confirmDialogStyle.eyebrow}`}>
                    {confirmDialog.variant === 'verification' ? '驗證控制' : '工作狀態控制'}
                  </p>
                  <h3 id="employee-status-dialog-title" className="mt-1 truncate text-xl font-bold tracking-tight text-white">{confirmDialog.title}</h3>
                  <p className="mt-1 text-xs text-slate-400">套用前請確認此帳戶變更。</p>
                </div>
              </div>
              <button type="button" onClick={() => setConfirmDialog(null)} aria-label="關閉確認面板" className="rounded-xl p-2 text-slate-400 transition-colors hover:bg-white/10 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <div className={`rounded-2xl border px-4 py-4 ${confirmDialogStyle.message}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className={`text-[10px] font-bold uppercase tracking-[0.16em] ${confirmDialogStyle.eyebrow}`}>員工帳戶</p>
                    <div className="mt-1 flex min-w-0 items-baseline gap-3">
                      <p title={confirmDialog.employeeUsername} className={`min-w-0 truncate text-xl font-black tracking-tight ${confirmDialogStyle.icon}`}>{confirmDialog.employeeUsername}</p>
                      <span className="shrink-0 text-sm font-extrabold tracking-wide text-slate-100 drop-shadow-sm">ID {confirmDialog.employeeId || '—'}</span>
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-lg border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${confirmDialogStyle.badge}`}>
                    {confirmDialog.variant === 'verification' ? '驗證' : '狀態'}
                  </span>
                </div>
                <p className="mt-3 border-t border-white/10 pt-3 text-sm leading-6 text-slate-200">{confirmDialog.message}</p>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                此變更會安全儲存，並反映在員工清單中。
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-700/70 bg-slate-950/35 px-5 py-4">
              <button type="button" onClick={() => setConfirmDialog(null)} className="rounded-xl border border-slate-600 bg-slate-800 px-5 py-2.5 text-sm font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-700 hover:text-white">取消</button>
              <button type="button" onClick={confirmDialog.onConfirm} className={`rounded-xl border px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition-all ${confirmDialogStyle.confirmButton}`}>
                {confirmDialog.nextStatus
                  ? confirmDialog.variant === 'verification' ? '驗證員工' : '啟用員工'
                  : confirmDialog.variant === 'verification' ? '取消員工驗證' : '停用員工'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
