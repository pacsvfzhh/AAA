/* @refresh reset */
import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { Users, Settings, FileText, LogOut, Shield, Package, UserCheck, Zap, Database, Lock, Eye, EyeOff, Bell, PackageSearch, MessageCircle, Search, History, UserCog, Activity, Headphones, ChevronDown, ChevronUp, ChevronsUpDown, SlidersHorizontal, RotateCcw, Save, X } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Admin } from '../../types';
import { getAdminFinancialSessionToken, logout, updateStoredUsername } from '../../lib/auth';
import { useCompanyName } from '../../lib/useCompanyName';
import { AdminBackground } from '../AdminBackground';
import { formatSupabaseError, isFinancialAdminSessionError, supabase } from '../../lib/supabase';
import { fetchAdminChatUnreadCounts, fetchConversationSummaryRows, invalidateConversationSummariesCache, prefetchAdminGroups, prefetchAdminWorkspaceData, prefetchConversationSummaries } from '../../lib/serviceWorkspaceCache';
import { uniqueRealtimeChannelName } from '../../lib/realtimeChannel';
import AdminPageLoading from './AdminPageLoading';

const EmployeeManagement = lazy(() => import('./EmployeeManagement'));
const ProductTypeManagement = lazy(() => import('./ProductTypeManagement'));
const WithdrawalReview = lazy(() => import('./WithdrawalReview'));
const VerificationReview = lazy(() => import('./VerificationReview'));
const AnnouncementManagement = lazy(() => import('./AnnouncementManagement'));
const SystemConfiguration = lazy(() => import('./SystemConfiguration'));
const SecondaryAdminConfiguration = lazy(() => import('./SecondaryAdminConfiguration'));
const AdminManagement = lazy(() => import('./AdminManagement'));
const ValidOrderDataManagement = lazy(() => import('./ValidOrderDataManagement'));
const loadMessageManagement = () => import('./MessageManagement');
const MessageManagement = lazy(loadMessageManagement);
const DispatchManagement = lazy(() => import('./DispatchManagement'));
const loadCustomerServiceManagement = () => import('./CustomerServiceManagement');
const loadCccServiceManagement = () => import('./CccServiceManagement');
const CustomerServiceManagement = lazy(loadCustomerServiceManagement);
const CccServiceManagement = lazy(loadCccServiceManagement);

function preloadServiceTab(tabId: string) {
  if (tabId === 'messages') void loadMessageManagement();
  if (tabId === 'customerservice') void loadCustomerServiceManagement();
  if (tabId === 'cccservice') void loadCccServiceManagement();
}

function formatRequestError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const details = error as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    const parts = [details.message, details.code, details.details, details.hint]
      .filter(value => typeof value === 'string' && value.length > 0)
      .map(value => String(value));
    if (parts.length > 0) return parts.join(' | ');
    try {
      return JSON.stringify(error);
    } catch {
      return 'Unknown request error';
    }
  }
  return String(error);
}

function ServiceWorkspaceSkeleton({ service }: { service: 'customerservice' | 'cccservice' }) {
  const isCustomerService = service === 'customerservice';

  return (
    <div className="flex min-h-[280px] flex-1 items-center justify-center bg-slate-950/30 text-slate-100">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className={`relative flex h-16 w-16 items-center justify-center rounded-2xl border shadow-[0_0_30px_rgba(15,23,42,0.35)] ${isCustomerService ? 'border-orange-300/30 bg-orange-400/15' : 'border-emerald-300/30 bg-emerald-400/15'}`}>
          <span className={`absolute inset-1 animate-ping rounded-xl border [animation-duration:1.6s] ${isCustomerService ? 'border-orange-300/25' : 'border-emerald-300/25'}`} />
          <span className={`relative h-8 w-8 animate-spin rounded-full border-[3px] ${isCustomerService ? 'border-orange-300/25 border-t-orange-300' : 'border-emerald-300/25 border-t-emerald-300'}`} />
        </div>
        <div>
          <p className={`text-sm font-semibold ${isCustomerService ? 'text-orange-100' : 'text-emerald-100'}`}>正在載入{isCustomerService ? '模擬客戶' : '經理'}分組</p>
          <p className="mt-1 text-[11px] text-slate-400">正在準備管理員工作區，請稍候……</p>
        </div>
      </div>
    </div>
  );
}

const EmployeeSearch = lazy(() => import('./EmployeeSearch'));
const HistoryDataManagement = lazy(() => import('./HistoryDataManagement'));
const AccountLockManagement = lazy(() => import('./AccountLockManagement'));
const EmployeeLoginHistory = lazy(() => import('./EmployeeLoginHistory'));

interface AdminDashboardProps {
  admin: Admin;
}

type AdminTabId = 'employees' | 'products' | 'withdrawals' | 'verifications' | 'announcements' | 'config' | 'admins' | 'validdata' | 'messages' | 'dispatch' | 'records' | 'customerservice' | 'cccservice' | 'employeesearch' | 'history' | 'accountlocks' | 'loginhistory';

interface NavigationTab {
  id: AdminTabId;
  label: string;
  icon: LucideIcon;
}

interface QuickActionEmployee {
  id: string;
  username: string;
  employeeId: string;
  adminId: string;
  adminUsername?: string;
  isVerified: boolean;
  isActive: boolean;
  remarks: string;
  tags: string[];
}

interface NavigationPreferences {
  order: AdminTabId[];
  labels: Partial<Record<AdminTabId, string>>;
}

const legacyNavigationLabelTranslations: Record<string, string> = {
  Employees: '員工詳情數據',
  Messages: '通知',
  '员工详情数据': '員工詳情數據',
  Withdrawals: '提款',
  Locked: '已鎖定',
  'Employee Search': '員工搜尋',
  'Employee Sea': '員工搜尋',
  'Login History': '登入紀錄',
  'Login Histor': '登入紀錄',
  Announcement: '公告',
  Announcements: '公告',
  'Order Assignment': '訂單指派',
  'Order Assign': '訂單指派',
  Verification: '身份驗證',
  Verifications: '身份驗證',
  Configuration: '設定',
  Configuratio: '設定',
  Products: '產品目錄',
  'Valid Data': '交單數據',
  Admins: '管理員',
  'History Data': '歷史資料',
};

const previousDefaultNavigationLabels: Partial<Record<AdminTabId, string[]>> = {
  messages: ['訊息', '讯息'],
  customerservice: ['模拟客户'],
  cccservice: ['经理'],
  verifications: ['驗證', '验证'],
  products: ['產品', '产品'],
  validdata: ['有效資料', '有效资料'],
};

interface NavigationDragState {
  tabId: AdminTabId;
  direction: -1 | 1;
  pointerId: number;
  pointerX: number;
  pointerY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

const NAVIGATION_PREFERENCES_KEY = 'admin_navigation_preferences';
const NAVIGATION_LABEL_MAX_LENGTH = 12;

function getNavigationPreferencesOwnerId(admin: Admin): string | null {
  if (admin.role === 'super_admin') return admin.id;
  if (admin.role === 'secondary_admin') return admin.parent_id;
  return null;
}

function getLegacyNavigationPreferencesKey(ownerId: string): string {
  return `${NAVIGATION_PREFERENCES_KEY}:${ownerId}`;
}

function parseNavigationPreferences(value: unknown): NavigationPreferences {
  if (!value || typeof value !== 'object') return { order: [], labels: {} };

  const parsed = value as { order?: unknown; labels?: unknown };
  const order = Array.isArray(parsed.order)
    ? parsed.order.filter((entry): entry is AdminTabId => typeof entry === 'string')
    : [];
  const labels = parsed.labels && typeof parsed.labels === 'object'
    ? Object.fromEntries(
        Object.entries(parsed.labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      ) as Partial<Record<AdminTabId, string>>
    : {};

  return { order, labels };
}

function hasNavigationPreferences(preferences: NavigationPreferences): boolean {
  return preferences.order.length > 0 || Object.keys(preferences.labels).length > 0;
}

function loadStoredNavigationPreferences(storageKey: string): NavigationPreferences {
  try {
    const stored = localStorage.getItem(storageKey);
    return stored ? parseNavigationPreferences(JSON.parse(stored)) : { order: [], labels: {} };
  } catch {
    return { order: [], labels: {} };
  }
}

function loadNavigationPreferences(legacyOwnerId: string | null): NavigationPreferences {
  const globalPreferences = loadStoredNavigationPreferences(NAVIGATION_PREFERENCES_KEY);
  if (hasNavigationPreferences(globalPreferences) || !legacyOwnerId) return globalPreferences;

  return loadStoredNavigationPreferences(getLegacyNavigationPreferencesKey(legacyOwnerId));
}

function saveLocalNavigationPreferences(preferences: NavigationPreferences) {
  try {
    localStorage.setItem(NAVIGATION_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    return;
  }
}

async function loadSharedNavigationPreferences(legacyOwnerId: string | null): Promise<{
  preferences: NavigationPreferences;
  isLegacy: boolean;
} | null> {
  const keys = [NAVIGATION_PREFERENCES_KEY];
  if (legacyOwnerId) keys.push(getLegacyNavigationPreferencesKey(legacyOwnerId));

  const { data, error } = await supabase
    .from('system_configs')
    .select('key, value')
    .in('key', keys);

  if (error) throw error;

  const sharedConfig = data?.find(config => config.key === NAVIGATION_PREFERENCES_KEY) || data?.[0];
  return sharedConfig
    ? {
        preferences: parseNavigationPreferences(sharedConfig.value),
        isLegacy: sharedConfig.key !== NAVIGATION_PREFERENCES_KEY,
      }
    : null;
}

async function saveSharedNavigationPreferences(preferences: NavigationPreferences) {
  try {
    const { error } = await supabase.rpc('admin_save_shared_system_config', {
      p_admin_session_token: getAdminFinancialSessionToken(),
      p_key: NAVIGATION_PREFERENCES_KEY,
      p_value: preferences,
    });

    if (error) throw error;
  } catch (error: unknown) {
    console.warn(
      'Unable to persist shared navigation preferences:',
      error instanceof Error ? error.message : error
    );
  }
}

export default function AdminDashboard({ admin }: AdminDashboardProps) {
  const navigationPreferencesOwnerId = getNavigationPreferencesOwnerId(admin);
  const [activeTab, setActiveTab] = useState<AdminTabId>(
    admin.role === 'emergency_admin' ? 'accountlocks' : 'employees'
  );
  const [loadedTabs, setLoadedTabs] = useState<Set<string>>(new Set([admin.role === 'emergency_admin' ? 'accountlocks' : 'employees']));
  const [pendingWithdrawalsCount, setPendingWithdrawalsCount] = useState(0);
  const [pendingVerificationsCount, setPendingVerificationsCount] = useState(0);
  const [unreadCustomerServiceCount, setUnreadCustomerServiceCount] = useState(0);
  const [unreadCccServiceCount, setUnreadCccServiceCount] = useState(0);
  const [lockedAccountsCount, setLockedAccountsCount] = useState(0);
  const [nextLockedAccountExpiry, setNextLockedAccountExpiry] = useState<number | null>(null);
  const [productOrderDirty, setProductOrderDirty] = useState(false);
  const pendingCountsRequestRef = useRef(0);
  const lockedCountsRequestRef = useRef(0);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordData, setPasswordData] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [showUsernameModal, setShowUsernameModal] = useState(false);
  const [usernameData, setUsernameData] = useState({ newUsername: '', currentPassword: '' });
  const [showUsernamePassword, setShowUsernamePassword] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [usernameSuccess, setUsernameSuccess] = useState(false);
  const [changingUsername, setChangingUsername] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const sidebarAccountMenuRef = useRef<HTMLDivElement>(null);
  const mobileAccountMenuRef = useRef<HTMLDivElement>(null);
  const [showNavigationSettings, setShowNavigationSettings] = useState(false);
  const [navigationPreferences, setNavigationPreferences] = useState<NavigationPreferences>(() =>
    loadNavigationPreferences(navigationPreferencesOwnerId)
  );
  const [navigationDraft, setNavigationDraft] = useState<Array<{ id: AdminTabId; label: string }>>([]);
  const [navigationSelectedItemId, setNavigationSelectedItemId] = useState<AdminTabId | null>(null);
  const [navigationDragState, setNavigationDragState] = useState<NavigationDragState | null>(null);
  const navigationListRef = useRef<HTMLDivElement>(null);
  const navigationDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationDragOriginRef = useRef<{
    tabId: AdminTabId;
    direction: -1 | 1;
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);
  const navigationDragActiveRef = useRef(false);
  const navigationDragFrameRef = useRef<number | null>(null);
  const navigationDragPointerRef = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);
  const navigationDragPreviewRef = useRef<HTMLDivElement>(null);
  const navigationDragLastTargetRef = useRef<AdminTabId | null>(null);
  const navigationDragSuppressClickUntilRef = useRef(0);
  const { companyName } = useCompanyName(admin.id);

  useEffect(() => {
    if (!accountMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!sidebarAccountMenuRef.current?.contains(target) && !mobileAccountMenuRef.current?.contains(target)) {
        setAccountMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [accountMenuOpen]);

  useEffect(() => {
    const localPreferences = loadNavigationPreferences(navigationPreferencesOwnerId);
    setNavigationPreferences(localPreferences);
    setNavigationDraft([]);
    setShowNavigationSettings(false);

    let cancelled = false;
    void loadSharedNavigationPreferences(navigationPreferencesOwnerId)
      .then(sharedConfig => {
        if (cancelled) return;

        if (sharedConfig) {
          saveLocalNavigationPreferences(sharedConfig.preferences);
          setNavigationPreferences(sharedConfig.preferences);

          if (admin.role === 'super_admin' && sharedConfig.isLegacy) {
            void saveSharedNavigationPreferences(sharedConfig.preferences);
          }
          return;
        }

        if (admin.role === 'super_admin' && hasNavigationPreferences(localPreferences)) {
          void saveSharedNavigationPreferences(localPreferences);
        }
      })
      .catch(error => {
        if (!cancelled) {
          console.warn(
            'Unable to load shared navigation preferences:',
            error instanceof Error ? error.message : error
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [admin.role, navigationPreferencesOwnerId]);

  useEffect(() => () => {
    if (navigationDragTimerRef.current) {
      clearTimeout(navigationDragTimerRef.current);
    }
    if (navigationDragFrameRef.current !== null) {
      cancelAnimationFrame(navigationDragFrameRef.current);
    }
    navigationDragPointerRef.current = null;
    navigationDragLastTargetRef.current = null;
  }, []);

  useEffect(() => {
    if (!showNavigationSettings) return;

    const bodyOverflow = document.body.style.overflow;
    const bodyOverscrollBehavior = document.body.style.overscrollBehavior;
    const documentOverflow = document.documentElement.style.overflow;
    const documentOverscrollBehavior = document.documentElement.style.overscrollBehavior;

    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'none';

    return () => {
      document.body.style.overflow = bodyOverflow;
      document.body.style.overscrollBehavior = bodyOverscrollBehavior;
      document.documentElement.style.overflow = documentOverflow;
      document.documentElement.style.overscrollBehavior = documentOverscrollBehavior;
    };
  }, [showNavigationSettings]);

  useEffect(() => {
    const preload = () => {
      if (admin.role === 'super_admin') {
        void prefetchAdminGroups(admin.id, 'customer').catch(error => {
          console.warn('Unable to prefetch customer service workspaces:', error);
        });
        void prefetchAdminGroups(admin.id, 'manager').catch(error => {
          console.warn('Unable to prefetch manager workspaces:', error);
        });
      } else if (admin.role !== 'emergency_admin') {
        void prefetchAdminWorkspaceData(admin.id, 'customer').catch(error => {
          console.warn('Unable to prefetch customer service data:', error);
        });
        void prefetchAdminWorkspaceData(admin.id, 'manager').catch(error => {
          console.warn('Unable to prefetch manager service data:', error);
        });
        void prefetchConversationSummaries(admin.id, 'customer', () => (
          fetchConversationSummaryRows(admin.id, 'customer')
        )).catch(error => {
          console.warn('Unable to prefetch customer service sessions:', error);
        });
        void prefetchConversationSummaries(admin.id, 'manager', () => (
          fetchConversationSummaryRows(admin.id, 'manager')
        )).catch(error => {
          console.warn('Unable to prefetch manager service sessions:', error);
        });
      }

    };

    if ('requestIdleCallback' in window) {
      const idleId = window.requestIdleCallback(preload, { timeout: 1500 });
      return () => window.cancelIdleCallback(idleId);
    }

    const timerId = globalThis.setTimeout(preload, 800);
    return () => globalThis.clearTimeout(timerId);
  }, [admin.id, admin.role]);

  // Cross-tab navigation targets
  const [navigateToMessageEmployee, setNavigateToMessageEmployee] = useState<QuickActionEmployee | null>(null);
  const [navigateToCustomerServiceEmployee, setNavigateToCustomerServiceEmployee] = useState<QuickActionEmployee | null>(null);
  const [navigateToCccServiceEmployee, setNavigateToCccServiceEmployee] = useState<QuickActionEmployee | null>(null);
  const consumeCustomerServiceEmployee = useCallback(() => setNavigateToCustomerServiceEmployee(null), []);
  const consumeCccServiceEmployee = useCallback(() => setNavigateToCccServiceEmployee(null), []);

  const defaultTabs = useMemo<NavigationTab[]>(() => admin.role === 'emergency_admin' ? [
    { id: 'accountlocks', label: '已鎖定', icon: Shield },
  ] : [
    { id: 'employees', label: '員工詳情數據', icon: Users },
    { id: 'employeesearch', label: '員工搜尋', icon: Search },
    { id: 'loginhistory', label: '登入紀錄', icon: Activity },
    { id: 'accountlocks', label: '已鎖定', icon: Shield },
    { id: 'messages', label: '通知', icon: Bell },
    { id: 'announcements', label: '公告', icon: FileText },
    { id: 'customerservice', label: '模擬客戶', icon: MessageCircle },
    { id: 'cccservice', label: '經理', icon: Headphones },
    { id: 'dispatch', label: '訂單指派', icon: PackageSearch },
    { id: 'withdrawals', label: '提款', icon: FileText },
    { id: 'verifications', label: '身份驗證', icon: UserCheck },
    { id: 'config', label: '設定', icon: Settings },
    ...(admin.role === 'super_admin' ? [
      { id: 'products' as const, label: '產品目錄', icon: Package },
      { id: 'validdata' as const, label: '交單數據', icon: Database },
      { id: 'admins' as const, label: '管理員', icon: Shield },
      { id: 'history' as const, label: '歷史資料', icon: History },
    ] : []),
  ], [admin.role]);

  const tabs = useMemo<NavigationTab[]>(() => {
    const tabsById = new Map(defaultTabs.map(tab => [tab.id, tab]));
    const orderedIds = navigationPreferences.order.filter(id => tabsById.has(id));
    defaultTabs.forEach(tab => {
      if (!orderedIds.includes(tab.id)) orderedIds.push(tab.id);
    });

    return orderedIds.map(id => {
      const tab = tabsById.get(id)!;
      const customLabel = navigationPreferences.labels[id]?.trim();
      return {
        ...tab,
        label: customLabel && !previousDefaultNavigationLabels[id]?.includes(customLabel)
          ? legacyNavigationLabelTranslations[customLabel] || customLabel
          : tab.label,
      };
    });
  }, [defaultTabs, navigationPreferences]);

  const openNavigationSettings = () => {
    if (admin.role !== 'super_admin') return;
    setNavigationDraft(tabs.map(tab => ({ id: tab.id, label: tab.label })));
    setNavigationSelectedItemId(null);
    setShowNavigationSettings(true);
  };

  const startNavigationDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    tabId: AdminTabId,
    direction: -1 | 1
  ) => {
    if (admin.role !== 'super_admin') return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    setNavigationSelectedItemId(tabId);

    const card = event.currentTarget.closest<HTMLElement>('[data-navigation-item-id]');
    if (!card) return;

    const rect = card.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    navigationDragOriginRef.current = {
      tabId,
      direction,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
    navigationDragActiveRef.current = false;
    navigationDragLastTargetRef.current = null;

    if (navigationDragTimerRef.current) clearTimeout(navigationDragTimerRef.current);
    navigationDragTimerRef.current = setTimeout(() => {
      const origin = navigationDragOriginRef.current;
      if (!origin || origin.pointerId !== event.pointerId) return;

      navigationDragActiveRef.current = true;
      navigationDragSuppressClickUntilRef.current = Date.now() + 400;
      setNavigationDragState({
        tabId: origin.tabId,
        direction: origin.direction,
        pointerId: origin.pointerId,
        pointerX: origin.startX,
        pointerY: origin.startY,
        offsetX: origin.offsetX,
        offsetY: origin.offsetY,
        width: origin.width,
        height: origin.height,
      });
    }, 260);
  };

  const updateNavigationDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = navigationDragOriginRef.current;
    if (!origin || origin.pointerId !== event.pointerId) return;

    navigationDragPointerRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    };

    if (!navigationDragActiveRef.current) {
      const directionalDistance = event.clientY - origin.startY;
      if (Math.abs(directionalDistance) <= 5) return;

      if (navigationDragTimerRef.current) {
        clearTimeout(navigationDragTimerRef.current);
        navigationDragTimerRef.current = null;
      }

      navigationDragActiveRef.current = true;
      navigationDragSuppressClickUntilRef.current = Date.now() + 400;
      setNavigationDragState({
        tabId: origin.tabId,
        direction: directionalDistance < 0 ? -1 : 1,
        pointerId: origin.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        offsetX: origin.offsetX,
        offsetY: origin.offsetY,
        width: origin.width,
        height: origin.height,
      });
    }

    event.preventDefault();
    if (navigationDragFrameRef.current !== null) return;

    const processNavigationDrag = () => {
      navigationDragFrameRef.current = null;
      const pointer = navigationDragPointerRef.current;
      const currentOrigin = navigationDragOriginRef.current;
      const list = navigationListRef.current;
      if (!pointer || !currentOrigin || !list || !navigationDragActiveRef.current) return;

      const listRect = list.getBoundingClientRect();
      const edgeDistance = 52;
      const distanceToTop = pointer.clientY - listRect.top;
      const distanceToBottom = listRect.bottom - pointer.clientY;
      let scrollStep = 0;

      if (distanceToTop < edgeDistance) {
        scrollStep = -Math.max(6, Math.min(28, Math.round((edgeDistance - distanceToTop) * 0.65)));
      } else if (distanceToBottom < edgeDistance) {
        scrollStep = Math.max(6, Math.min(28, Math.round((edgeDistance - distanceToBottom) * 0.65)));
      }

      if (scrollStep !== 0) list.scrollTop += scrollStep;

      const direction = pointer.clientY < currentOrigin.startY ? -1 : 1;
      if (navigationDragPreviewRef.current) {
        navigationDragPreviewRef.current.style.transform = `translate3d(${pointer.clientX - currentOrigin.offsetX}px, ${pointer.clientY - currentOrigin.offsetY}px, 0)`;
      }
      setNavigationDragState(current => current && current.direction !== direction
        ? { ...current, direction }
        : current);

      const cards = Array.from(list.querySelectorAll<HTMLElement>('[data-navigation-item-id]'));
      if (cards.length > 0) {
        let targetCard = cards[0];
        let closestDistance = Number.POSITIVE_INFINITY;
        cards.forEach(card => {
          const rect = card.getBoundingClientRect();
          const distance = Math.abs(pointer.clientY - (rect.top + rect.height / 2));
          if (distance < closestDistance) {
            closestDistance = distance;
            targetCard = card;
          }
        });

        const targetId = targetCard.dataset.navigationItemId as AdminTabId | undefined;
        if (targetId === currentOrigin.tabId) {
          navigationDragLastTargetRef.current = null;
        } else if (targetId && targetId !== navigationDragLastTargetRef.current) {
          navigationDragLastTargetRef.current = targetId;
          setNavigationDraft(current => {
            const currentIndex = current.findIndex(item => item.id === currentOrigin.tabId);
            const targetIndex = current.findIndex(item => item.id === targetId);
            if (currentIndex < 0 || targetIndex < 0) return current;
            const next = [...current];
            const [movedItem] = next.splice(currentIndex, 1);
            next.splice(targetIndex, 0, movedItem);
            return next;
          });
        }
      }

      if (scrollStep !== 0 && navigationDragPointerRef.current?.pointerId === currentOrigin.pointerId) {
        navigationDragFrameRef.current = requestAnimationFrame(processNavigationDrag);
      }
    };

    navigationDragFrameRef.current = requestAnimationFrame(processNavigationDrag);
  };

  const endNavigationDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = navigationDragOriginRef.current;
    if (!origin || origin.pointerId !== event.pointerId) return;

    if (navigationDragTimerRef.current) {
      clearTimeout(navigationDragTimerRef.current);
      navigationDragTimerRef.current = null;
    }

    if (navigationDragActiveRef.current) {
      navigationDragSuppressClickUntilRef.current = Date.now() + 400;
    }

    navigationDragActiveRef.current = false;
    navigationDragOriginRef.current = null;
    navigationDragPointerRef.current = null;
    navigationDragLastTargetRef.current = null;
    if (navigationDragFrameRef.current !== null) {
      cancelAnimationFrame(navigationDragFrameRef.current);
      navigationDragFrameRef.current = null;
    }
    setNavigationDragState(null);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const restoreNavigationItemLabel = (tabId: AdminTabId) => {
    if (admin.role !== 'super_admin') return;
    const originalLabel = defaultTabs.find(tab => tab.id === tabId)?.label;
    if (!originalLabel) return;

    setNavigationDraft(current => current.map(item =>
      item.id === tabId ? { ...item, label: originalLabel } : item
    ));
  };

  const saveNavigationDraft = () => {
    if (admin.role !== 'super_admin') return;
    const defaultLabels = new Map(defaultTabs.map(tab => [tab.id, tab.label]));
    const nextPreferences: NavigationPreferences = {
      order: navigationDraft.map(item => item.id),
      labels: Object.fromEntries(navigationDraft.map(item => [
        item.id,
        item.label.trim().slice(0, NAVIGATION_LABEL_MAX_LENGTH) || defaultLabels.get(item.id) || item.id,
      ])) as Partial<Record<AdminTabId, string>>,
    };
    setNavigationPreferences(nextPreferences);
    saveLocalNavigationPreferences(nextPreferences);
    void saveSharedNavigationPreferences(nextPreferences);
    setShowNavigationSettings(false);
  };

  const loadLockedAccountsCount = useCallback(async () => {
    const requestId = ++lockedCountsRequestRef.current;

    try {
      const { data, error } = await supabase.rpc('get_account_locks_for_admin', {
        p_admin_id: getAdminFinancialSessionToken()
      });

      if (error) throw error;
      if (requestId !== lockedCountsRequestRef.current) return;

      const employeeLocks = (data || []).filter(lock => lock.identifier_type === 'username');
      const expiryTimes = employeeLocks
        .map(lock => new Date(lock.lock_until).getTime())
        .filter(expiry => Number.isFinite(expiry));

      setLockedAccountsCount(employeeLocks.length);
      setNextLockedAccountExpiry(expiryTimes.length > 0 ? Math.min(...expiryTimes) : null);
    } catch (error) {
      if (isFinancialAdminSessionError(error)) {
        void logout(false);
        return;
      }

      console.warn('Locked accounts notification is temporarily unavailable:', formatRequestError(error));
    }
  }, []);

  const chatUnreadRequestRef = useRef(0);
  const loadChatUnreadCounts = useCallback(async () => {
    const requestId = ++chatUnreadRequestRef.current;
    try {
      const { rows } = await fetchAdminChatUnreadCounts();
      if (requestId !== chatUnreadRequestRef.current) return;
      let unreadAaa = 0;
      let unreadCcc = 0;
      rows.forEach(row => {
        if (row.source_type === 'aaa_service') unreadAaa += Number(row.unread_count);
        if (row.source_type === 'ccc_service') unreadCcc += Number(row.unread_count);
      });
      setUnreadCustomerServiceCount(unreadAaa);
      setUnreadCccServiceCount(unreadCcc);
    } catch (error) {
      console.warn('Chat unread counts are temporarily unavailable:', formatRequestError(error));
    }
  }, []);

  const loadPendingCounts = useCallback(async () => {
    const requestId = ++pendingCountsRequestRef.current;
    void loadChatUnreadCounts();
    try {
      // Scoped in the database: a large group's employee IDs would not fit in the request URL.
      const verificationsQuery = admin.role === 'secondary_admin'
        ? supabase
          .from('verification_requests')
          .select('id, users!inner(created_by)', { count: 'exact', head: true })
          .eq('status', 'pending')
          .eq('users.created_by', admin.id)
        : supabase
          .from('verification_requests')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'pending');

      const [withdrawalResult, verificationResult] = await Promise.allSettled([
        supabase.rpc('get_pending_withdrawal_count_for_admin', { p_admin_session_token: getAdminFinancialSessionToken() }),
        verificationsQuery,
      ]);
      if (requestId !== pendingCountsRequestRef.current) return;

      if (withdrawalResult.status === 'fulfilled' && !withdrawalResult.value.error) {
        setPendingWithdrawalsCount(Number(withdrawalResult.value.data || 0));
      } else {
        console.warn('Pending withdrawal count is temporarily unavailable:', formatRequestError(
          withdrawalResult.status === 'fulfilled' ? withdrawalResult.value.error : withdrawalResult.reason,
        ));
      }

      if (verificationResult.status === 'fulfilled' && !verificationResult.value.error) {
        setPendingVerificationsCount(verificationResult.value.count || 0);
      } else {
        console.warn('Pending verification count is temporarily unavailable:', formatRequestError(
          verificationResult.status === 'fulfilled' ? verificationResult.value.error : verificationResult.reason,
        ));
      }

    } catch (error) {
      console.warn('Pending counts are temporarily unavailable:', formatRequestError(error));
    }
  }, [admin.id, admin.role, loadChatUnreadCounts]);

  const handleCustomerServiceUnreadChange = useCallback((delta: number) => {
    setUnreadCustomerServiceCount(prev => Math.max(0, prev + delta));
  }, []);

  const handleCccServiceUnreadChange = useCallback((delta: number) => {
    setUnreadCccServiceCount(prev => Math.max(0, prev + delta));
  }, []);

  const handleTabChange = useCallback((tabId: typeof activeTab) => {
    if (
      activeTab === 'products'
      && tabId !== 'products'
      && productOrderDirty
      && !window.confirm('產品順序尚未儲存，確定要放棄變更並離開嗎？')
    ) {
      return;
    }

    setActiveTab(tabId);
    setLoadedTabs(prev => prev.has(tabId) ? prev : new Set([...prev, tabId]));
  }, [activeTab, productOrderDirty]);

  const handleEmployeeQuickAction = useCallback((action: 'message' | 'customerservice' | 'cccservice', employee: QuickActionEmployee) => {
    const targetTab: AdminTabId = action === 'message'
      ? 'messages'
      : action === 'customerservice'
        ? 'customerservice'
        : 'cccservice';

    preloadServiceTab(targetTab);
    setNavigateToMessageEmployee(action === 'message' ? employee : null);
    setNavigateToCustomerServiceEmployee(action === 'customerservice' ? employee : null);
    setNavigateToCccServiceEmployee(action === 'cccservice' ? employee : null);
    setActiveTab(targetTab);
    setLoadedTabs(prev => prev.has(targetTab) ? prev : new Set([...prev, targetTab]));
  }, []);

  useEffect(() => {
    if (!nextLockedAccountExpiry) return;

    const refreshDelay = Math.max(1000, nextLockedAccountExpiry - Date.now() + 1000);
    const timeout = window.setTimeout(() => {
      if (document.visibilityState === 'visible') {
        void loadLockedAccountsCount();
      }
    }, refreshDelay);

    return () => window.clearTimeout(timeout);
  }, [nextLockedAccountExpiry, loadLockedAccountsCount]);

  useEffect(() => {
    void loadLockedAccountsCount();

    const pendingCountsTimer = window.setTimeout(() => {
      void loadPendingCounts();
    }, 1500);
    const pendingCountsFallbackTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadPendingCounts();
      }
    }, 60000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadPendingCounts();
        void loadLockedAccountsCount();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Set up real-time subscriptions for withdrawals
    const withdrawalChannel = supabase
      .channel('admin-withdrawals')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'withdrawal_events',
          ...(admin.role === 'secondary_admin' ? { filter: `admin_id=eq.${admin.id}` } : {}),
        },
        () => {
          loadPendingCounts();
        }
      )
      .subscribe();

    // Set up real-time subscriptions for verifications
    const verificationChannel = supabase
      .channel('admin-verifications')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'verification_requests' },
        () => {
          loadPendingCounts();
        }
      )
      .subscribe();

    let chatUnreadRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    // Throttled, not debounced: a steady stream of messages must not keep postponing the refresh.
    const scheduleChatUnreadRefresh = () => {
      if (chatUnreadRefreshTimer) return;
      chatUnreadRefreshTimer = setTimeout(() => {
        chatUnreadRefreshTimer = null;
        void loadChatUnreadCounts();
      }, 1000);
    };
    const handleConversationRealtime = () => {
      invalidateConversationSummariesCache(admin.id, 'customer');
      invalidateConversationSummariesCache(admin.id, 'manager');
      scheduleChatUnreadRefresh();
    };

    // Set up real-time subscriptions for customer service conversations
    const customerServiceChannel = supabase
      .channel(uniqueRealtimeChannelName('admin-customer-service'))
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'customer_employee_conversations' },
        handleConversationRealtime,
      )
      .subscribe((status, error) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('Customer service notifications are temporarily unavailable.', error);
          scheduleChatUnreadRefresh();
        }
      });

    // Set up real-time subscriptions for account locks
    const accountLocksChannel = supabase
      .channel('admin-account-locks')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'account_lock_events' },
        (payload) => {
          const signal = payload.new && typeof payload.new === 'object'
            ? payload.new as { event_type?: unknown }
            : null;
          if (!signal?.event_type) return;

          void loadLockedAccountsCount();
        }
      )
      .subscribe((status, error) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('Account lock notifications are temporarily unavailable.', error);
        }
      });

    return () => {
      window.clearTimeout(pendingCountsTimer);
      window.clearInterval(pendingCountsFallbackTimer);
      if (chatUnreadRefreshTimer) clearTimeout(chatUnreadRefreshTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      supabase.removeChannel(withdrawalChannel);
      supabase.removeChannel(verificationChannel);
      supabase.removeChannel(customerServiceChannel);
      supabase.removeChannel(accountLocksChannel);

    };
  }, [loadPendingCounts, loadChatUnreadCounts, loadLockedAccountsCount, admin.id, admin.role]);

  const handleChangePassword = async () => {
    setPasswordError(null);
    setPasswordSuccess(false);

    if (!passwordData.currentPassword || !passwordData.newPassword || !passwordData.confirmPassword) {
      setPasswordError('請填寫所有欄位');
      return;
    }

    if (passwordData.newPassword !== passwordData.confirmPassword) {
      setPasswordError('新密碼不一致');
      return;
    }

    if (passwordData.newPassword.length < 6) {
      setPasswordError('密碼至少需要 6 個字元');
      return;
    }

    if (passwordData.currentPassword === passwordData.newPassword) {
      setPasswordError('新密碼不能與目前密碼相同');
      return;
    }

    setChangingPassword(true);

    try {
      const { data, error: updateError } = await supabase.rpc('change_admin_password_atomic', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_current_password: passwordData.currentPassword,
        p_new_password: passwordData.newPassword,
      });

      if (updateError) throw updateError;
      if (!data) throw new Error('密碼變更失敗');

      setPasswordSuccess(true);
      setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });

      setTimeout(() => {
        setShowPasswordModal(false);
        setPasswordSuccess(false);
      }, 2000);
    } catch (error: unknown) {
      if (isFinancialAdminSessionError(error)) {
        void logout(false);
        return;
      }

      console.error('Error changing password:', formatSupabaseError(error));
      setPasswordError(formatSupabaseError(error) || '密碼變更失敗');
    } finally {
      setChangingPassword(false);
    }
  };

  const handleChangeUsername = async () => {
    setUsernameError(null);
    setUsernameSuccess(false);

    const newUsername = usernameData.newUsername.trim();
    if (!newUsername || !usernameData.currentPassword) {
      setUsernameError('請填寫所有欄位');
      return;
    }

    if (newUsername.length < 3) {
      setUsernameError('使用者名稱至少需要 3 個字元');
      return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(newUsername)) {
      setUsernameError('使用者名稱只能包含英文字母、數字與底線');
      return;
    }

    if (newUsername === admin.username) {
      setUsernameError('新使用者名稱不能與目前名稱相同');
      return;
    }

    setChangingUsername(true);

    try {
      const { data, error: updateError } = await supabase.rpc('change_admin_username_atomic', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_current_password: usernameData.currentPassword,
        p_new_username: newUsername,
      });

      if (updateError) {
        if (updateError.code === '23505') throw new Error('使用者名稱已存在');
        throw updateError;
      }
      if (!data?.success) throw new Error('使用者名稱變更失敗');

      setUsernameSuccess(true);
      setUsernameData({ newUsername: '', currentPassword: '' });

      // Update localStorage and trigger state update
      updateStoredUsername(newUsername);

      setTimeout(() => {
        setShowUsernameModal(false);
        setUsernameSuccess(false);
      }, 2000);
    } catch (error: unknown) {
      if (isFinancialAdminSessionError(error)) {
        void logout(false);
        return;
      }

      console.error('Error changing username:', formatSupabaseError(error));
      setUsernameError(formatSupabaseError(error) || '使用者名稱變更失敗');
    } finally {
      setChangingUsername(false);
    }
  };

  const renderAccountMenu = (variant: 'sidebar' | 'mobile') => {
    const isSidebar = variant === 'sidebar';

    return (
      <div ref={isSidebar ? sidebarAccountMenuRef : mobileAccountMenuRef} className={`relative ${isSidebar ? 'z-40 w-full' : 'shrink-0'}`}>
        <button
          type="button"
          onClick={() => setAccountMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={accountMenuOpen}
          className={`flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors duration-200 ${isSidebar ? `h-8 w-full justify-between border-l-2 border-emerald-300 bg-emerald-700 px-1.5 text-[10px] text-white hover:border-emerald-100 hover:bg-emerald-600 ${accountMenuOpen ? 'border-emerald-100 bg-emerald-600' : ''}` : `h-7 border border-emerald-300/90 bg-emerald-700 px-2 text-[10px] text-white hover:border-emerald-100 hover:bg-emerald-600 sm:px-2.5 sm:text-[11px] ${accountMenuOpen ? 'border-emerald-100 bg-emerald-600' : ''}`}`}
          title="帳戶操作"
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-emerald-600">
            <UserCog className="h-3 w-3 text-white" />
          </span>
          <span className="flex-1 text-left tracking-wide">帳戶</span>
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-emerald-100 transition-transform duration-200 ${accountMenuOpen ? 'rotate-180 text-white' : ''}`} />
        </button>
        {accountMenuOpen && (
          <div
            role="menu"
            className={`absolute z-[70] flex w-full min-w-0 flex-col gap-1 overflow-hidden rounded-lg border border-emerald-400/50 bg-slate-950 p-1 shadow-xl shadow-emerald-950/40 ring-1 ring-emerald-200/10 animate-[fadeIn_120ms_ease-out] ${isSidebar ? 'left-0 right-0 top-[calc(100%+0.35rem)]' : 'right-0 top-[calc(100%+0.35rem)] min-w-[164px]'}`}
          >
            {admin.role === 'super_admin' && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  setShowUsernameModal(true);
                }}
                className="flex h-7 w-full items-center gap-1.5 rounded-md border-l-2 border-violet-300 bg-violet-700 px-1.5 text-left text-[10px] font-medium text-white transition-colors hover:bg-violet-600"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-violet-600">
                  <UserCog className="h-3 w-3 text-violet-100" />
                </span>
                <span>使用者名稱</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAccountMenuOpen(false);
                setShowPasswordModal(true);
              }}
              className="flex h-7 w-full items-center gap-1.5 rounded-md border-l-2 border-cyan-200 bg-cyan-700 px-1.5 text-left text-[10px] font-medium text-white transition-colors hover:bg-cyan-600"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-cyan-600">
                <Lock className="h-3 w-3 text-cyan-100" />
              </span>
              <span>密碼</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAccountMenuOpen(false);
                logout();
              }}
              className="flex h-7 w-full items-center gap-1.5 rounded-md border-l-2 border-rose-300 bg-rose-700 px-1.5 text-left text-[10px] font-medium text-white transition-colors hover:bg-rose-600"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-rose-600">
                <LogOut className="h-3 w-3 text-rose-100" />
              </span>
              <span>登出</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="admin-dashboard-root h-screen relative bg-slate-950 overflow-hidden" style={{ touchAction: 'pan-y' }}>
      {/* Professional dark background for admin interface */}
      <AdminBackground />

      <div className="relative z-10 m-0 p-0 w-full h-full flex flex-col">
        <header className="bg-slate-900/90 backdrop-blur-xl border-b border-blue-500/30 w-full m-0 flex-shrink-0 lg:hidden" style={{ WebkitBackdropFilter: 'blur(24px)' }}>
          <div className="absolute inset-0 bg-gradient-to-r from-blue-600/5 via-cyan-500/10 to-blue-600/5 pointer-events-none"></div>
          <div className="w-full px-2 sm:px-2.5 lg:px-3 py-0 relative">
            <div className="flex min-h-[38px] items-center justify-between gap-2 py-1 leading-none">
              <div className="grid min-w-0 flex-1 grid-cols-[16px_minmax(0,1fr)] items-center gap-x-1.5 gap-y-0.5">
                <div className="relative flex h-4 w-4 shrink-0 items-center justify-center justify-self-center rounded bg-gradient-to-br from-blue-600 via-blue-500 to-cyan-500 shadow-md">
                  <Zap className="h-2.5 w-2.5 text-white" fill="currentColor" />
                </div>
                <h1 className="min-w-0 truncate text-[11px] font-bold leading-none bg-gradient-to-r from-blue-400 via-cyan-300 to-blue-400 bg-clip-text text-transparent sm:text-xs">
                  {companyName}
                </h1>
                <Shield className="h-3.5 w-3.5 shrink-0 justify-self-center text-purple-400" />
                <span className="min-w-0 truncate text-[9px] font-semibold uppercase text-purple-200">
                  {admin.role === 'super_admin' ? '超級管理員' : '管理員'}
                </span>
                <span className="h-2 w-2 shrink-0 justify-self-center rounded-full border border-green-200/70 bg-green-400 shadow-sm shadow-green-500/40" />
                <span className="min-w-0 truncate text-[11px] font-semibold tracking-wide text-cyan-100 drop-shadow-[0_0_5px_rgba(103,232,249,0.25)]">{admin.username}</span>
              </div>
              {renderAccountMenu('mobile')}
            </div>
          </div>
        </header>

        <style>{`
          .scrollbar-hide::-webkit-scrollbar { display: none; }
          .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
        `}</style>

        <div className="flex w-full flex-1 min-h-0">
          {/* Desktop: Vertical Left Sidebar */}
          <aside className={`relative isolate hidden flex-shrink-0 overflow-y-auto bg-[linear-gradient(180deg,#071225_0%,#092433_34%,#171b2e_68%,#292116_100%)] scrollbar-hide lg:flex lg:w-32 lg:flex-col xl:w-36 ${activeTab === 'history' ? 'shadow-none' : 'border-r border-cyan-800/70 shadow-[6px_0_18px_rgba(2,6,23,0.72)]'}`}>
            {activeTab !== 'history' && <div className="pointer-events-none absolute inset-y-0 right-0 w-[2px] bg-gradient-to-b from-blue-600/80 via-cyan-700/75 to-amber-700/75" aria-hidden="true" />}
            <div className="relative z-30 shrink-0 border-b border-cyan-800/55 bg-gradient-to-br from-blue-950/90 via-cyan-950/65 to-amber-950/45 px-1.5 py-2.5 shadow-[0_8px_18px_rgba(2,6,23,0.35)]">
              <div className="grid min-w-0 grid-cols-[20px_minmax(0,1fr)] items-center gap-x-1.5 gap-y-1">
                <div className="flex h-5 w-5 shrink-0 items-center justify-center justify-self-center rounded-md bg-gradient-to-br from-blue-600 via-blue-500 to-cyan-500 shadow-md shadow-blue-950/40">
                  <Zap className="h-3 w-3 text-white" fill="currentColor" />
                </div>
                <h1 className="min-w-0 truncate bg-gradient-to-r from-blue-300 via-cyan-200 to-amber-200 bg-clip-text text-[11px] font-bold leading-tight text-transparent" title={companyName}>
                  {companyName}
                </h1>
                <Shield className="h-4 w-4 shrink-0 justify-self-center text-purple-400" />
                <span className="min-w-0 truncate text-[9px] font-semibold uppercase tracking-wide text-purple-200">
                  {admin.role === 'super_admin' ? '超級管理員' : '管理員'}
                </span>
                <span className="h-2 w-2 shrink-0 justify-self-center rounded-full border border-green-200/70 bg-green-400 shadow-sm shadow-green-500/40" />
                <span className="min-w-0 truncate text-[11px] font-semibold tracking-wide text-cyan-100" title={admin.username}>
                  {admin.username}
                </span>
              </div>
              <div className="mt-4">
                {renderAccountMenu('sidebar')}
              </div>
            </div>
            <nav className="relative z-10 flex flex-col gap-0.5 border-t border-blue-300/15 bg-slate-950/10 p-1.5 pt-8">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const pendingCount = tab.id === 'withdrawals' ? pendingWithdrawalsCount : tab.id === 'verifications' ? pendingVerificationsCount : tab.id === 'customerservice' ? unreadCustomerServiceCount : tab.id === 'cccservice' ? unreadCccServiceCount : tab.id === 'accountlocks' ? lockedAccountsCount : 0;
                const showBadge = pendingCount > 0;

                return (
                  <button
                    key={tab.id}
                    onClick={() => handleTabChange(tab.id)}
                    onMouseDown={(event) => event.preventDefault()}
                    className={`relative flex items-center gap-1.5 rounded-lg border border-transparent px-1.5 py-1.5 text-left font-medium transition-colors outline-none focus:outline-none focus-visible:border-cyan-500/60 focus-visible:outline-none ${
                      activeTab === tab.id
                        ? tab.id === 'customerservice'
                          ? 'bg-orange-700 text-white shadow-lg shadow-orange-900/40'
                          : tab.id === 'cccservice'
                            ? 'bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 text-white shadow-lg shadow-emerald-900/50'
                            : 'bg-gradient-to-r from-blue-700 via-cyan-800 to-slate-800 text-white shadow-md shadow-slate-950/45'
                        : tab.id === 'customerservice'
                          ? 'text-orange-400 hover:bg-orange-950/70 hover:text-orange-100'
                          : tab.id === 'cccservice'
                            ? 'text-emerald-400 hover:bg-emerald-950/70 hover:text-emerald-100'
                            : 'text-slate-300 hover:border-cyan-900/60 hover:bg-gradient-to-r hover:from-blue-950/90 hover:via-cyan-950/70 hover:to-amber-950/45 hover:text-white'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="text-[11px] font-medium truncate">{tab.label}</span>
                    {showBadge && (
                      <span className={`ml-auto flex items-center justify-center min-w-[20px] h-[20px] px-1 text-xs font-bold rounded-full shadow-lg ${tab.id === 'customerservice' || tab.id === 'cccservice' ? 'session-unread-count' : 'animate-pulse'} ${
                        tab.id === 'customerservice'
                          ? 'bg-white text-orange-600'
                          : tab.id === 'cccservice'
                            ? 'bg-white text-emerald-600'
                            : 'bg-gradient-to-r from-orange-500 to-red-500 text-white'
                      }`}>
                        {pendingCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
            {admin.role === 'super_admin' && (
              <div className="relative z-10 mt-auto border-t border-cyan-900/60 bg-slate-950/35 p-1.5">
                <button
                  type="button"
                  onClick={openNavigationSettings}
                  className="group flex h-8 w-full items-center gap-1.5 rounded-lg border border-cyan-800/70 bg-gradient-to-r from-blue-950/90 via-cyan-950/70 to-amber-950/50 px-2 text-left text-[10px] font-semibold text-slate-200 shadow-sm shadow-slate-950/60 transition-all hover:-translate-y-px hover:border-cyan-500/80 hover:from-blue-900/90 hover:via-cyan-900/75 hover:to-amber-900/55 hover:text-white hover:shadow-md hover:shadow-cyan-950/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/80 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950"
                  title="自訂導覽順序與名稱"
                  aria-label="自訂導覽順序與名稱"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-cyan-300 transition-colors group-hover:text-cyan-100" />
                  <span className="min-w-0 flex-1 truncate">導航設定</span>
                  <Settings className="h-3 w-3 shrink-0 text-amber-300/80 transition-colors group-hover:text-amber-100" />
                </button>
              </div>
            )}
          </aside>

          {/* Mobile: Horizontal Scrolling Tabs */}
          <div className={`flex-1 min-w-0 flex flex-col ${activeTab === 'withdrawals' || activeTab === 'verifications' || activeTab === 'admins' || activeTab === 'validdata' || activeTab === 'config' || activeTab === 'history' ? 'overflow-hidden' : activeTab === 'messages' ? 'lg:overflow-hidden' : 'lg:overflow-y-auto'} scrollbar-hide`} style={activeTab === 'customerservice' ? {
            background: `
              radial-gradient(ellipse 80% 60% at 10% 15%, rgba(249,115,22,0.11) 0%, transparent 50%),
              radial-gradient(ellipse 60% 50% at 80% 10%, rgba(245,158,11,0.1) 0%, transparent 50%),
              radial-gradient(ellipse 70% 70% at 50% 55%, rgba(234,88,12,0.08) 0%, transparent 50%),
              radial-gradient(ellipse 50% 60% at 90% 80%, rgba(251,146,60,0.09) 0%, transparent 50%),
              radial-gradient(ellipse 55% 80% at 20% 85%, rgba(154,52,18,0.12) 0%, transparent 50%),
              linear-gradient(135deg, #120b04 0%, #190d05 25%, #160b04 50%, #1d0e04 75%, #0e0803 100%)
            `
          } : activeTab === 'cccservice' ? {
            background: `
              radial-gradient(ellipse 80% 60% at 10% 15%, rgba(34,197,94,0.11) 0%, transparent 50%),
              radial-gradient(ellipse 60% 50% at 80% 10%, rgba(16,185,129,0.09) 0%, transparent 50%),
              radial-gradient(ellipse 70% 70% at 50% 55%, rgba(5,150,105,0.07) 0%, transparent 50%),
              radial-gradient(ellipse 50% 60% at 90% 80%, rgba(22,163,74,0.08) 0%, transparent 50%),
              radial-gradient(ellipse 55% 80% at 20% 85%, rgba(6,95,70,0.1) 0%, transparent 50%),
              linear-gradient(135deg, #040e09 0%, #06160e 25%, #05120b 50%, #071d12 75%, #030a06 100%)
            `
          } : undefined}>
            <div className="lg:hidden flex gap-1.5 px-2 pt-2 pb-1.5 overflow-x-auto scrollbar-hide" style={{ WebkitOverflowScrolling: 'touch' }}>
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const pendingCount = tab.id === 'withdrawals' ? pendingWithdrawalsCount : tab.id === 'verifications' ? pendingVerificationsCount : tab.id === 'customerservice' ? unreadCustomerServiceCount : tab.id === 'cccservice' ? unreadCccServiceCount : tab.id === 'accountlocks' ? lockedAccountsCount : 0;
                const showBadge = pendingCount > 0;

                return (
                  <button
                    key={tab.id}
                    onClick={() => handleTabChange(tab.id)}
                    onMouseDown={(event) => event.preventDefault()}
                    className={`relative flex flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-transparent px-2 py-1.5 font-medium transition-colors outline-none focus:outline-none focus-visible:border-cyan-500/60 focus-visible:outline-none ${
                      activeTab === tab.id
                        ? tab.id === 'customerservice'
                          ? 'bg-orange-700 text-white shadow-lg shadow-orange-900/40'
                          : tab.id === 'cccservice'
                            ? 'bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 text-white shadow-lg shadow-emerald-900/50'
                            : 'bg-blue-600 text-white shadow-lg shadow-blue-500/50'
                        : tab.id === 'customerservice'
                          ? 'bg-orange-950/70 text-orange-300 hover:bg-orange-950 hover:text-orange-100'
                          : tab.id === 'cccservice'
                            ? 'bg-emerald-950/70 text-emerald-300 hover:bg-emerald-950 hover:text-emerald-100'
                            : 'bg-slate-800/50 text-slate-400 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="text-xs font-semibold">{tab.label}</span>
                    {showBadge && (
                      <span className={`flex items-center justify-center min-w-[20px] h-5 px-1 text-xs font-bold rounded-full shadow-lg ${tab.id === 'customerservice' || tab.id === 'cccservice' ? 'session-unread-count' : 'animate-pulse'} ${
                        tab.id === 'customerservice'
                          ? 'bg-white text-orange-600'
                          : tab.id === 'cccservice'
                            ? 'bg-white text-emerald-600'
                            : 'bg-gradient-to-r from-orange-500 to-red-500 text-white'
                      }`}>
                        {pendingCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Content Area - Full Width */}
            <div className="w-full flex-1 min-h-0 flex flex-col">
          <Suspense fallback={
            activeTab === 'customerservice' || activeTab === 'cccservice'
              ? <ServiceWorkspaceSkeleton service={activeTab} />
              : <AdminPageLoading label={tabs.find(tab => tab.id === activeTab)?.label || '頁面'} />
          }>

            {loadedTabs.has('employees') && (
              <div className={activeTab === 'employees' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                <EmployeeManagement admin={admin} isActive={activeTab === 'employees'} onQuickAction={handleEmployeeQuickAction} />
              </div>
            )}
            {loadedTabs.has('employeesearch') && (
              <div className={activeTab === 'employeesearch' ? 'flex min-h-0 flex-1 flex-col px-2 py-1.5 sm:px-3 sm:py-2 lg:px-4' : 'hidden'}>
                <EmployeeSearch />
              </div>
            )}
            {loadedTabs.has('loginhistory') && (
              <div className={activeTab === 'loginhistory' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
                <EmployeeLoginHistory admin={admin} />
              </div>
            )}
            {loadedTabs.has('messages') && (
              <div className={activeTab === 'messages' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                <MessageManagement admin={admin} isActive={activeTab === 'messages'} initialEmployee={navigateToMessageEmployee} onConsumeInitialEmployee={() => setNavigateToMessageEmployee(null)} />
              </div>
            )}
            {loadedTabs.has('customerservice') && (
              <div className={activeTab === 'customerservice' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                <CustomerServiceManagement
                  adminId={admin.id}
                  isSuperAdmin={admin.role === 'super_admin'}
                  isActive={activeTab === 'customerservice'}
                  initialEmployee={navigateToCustomerServiceEmployee}
                  onConsumeInitialEmployee={consumeCustomerServiceEmployee}
                  onUnreadCountChange={handleCustomerServiceUnreadChange}
                />
              </div>
            )}
            {loadedTabs.has('cccservice') && (
              <div className={activeTab === 'cccservice' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                <CccServiceManagement
                  adminId={admin.id}
                  isSuperAdmin={admin.role === 'super_admin'}
                  isActive={activeTab === 'cccservice'}
                  initialEmployee={navigateToCccServiceEmployee}
                  onConsumeInitialEmployee={consumeCccServiceEmployee}
                  onUnreadCountChange={handleCccServiceUnreadChange}
                />
              </div>
            )}
            {loadedTabs.has('dispatch') && (
              <div className={activeTab === 'dispatch' ? 'flex min-h-0 w-full flex-1 flex-col' : 'hidden'}>
                <DispatchManagement />
              </div>
            )}
            {loadedTabs.has('withdrawals') && (
              <div className={activeTab === 'withdrawals' ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'hidden'}>
                <WithdrawalReview admin={admin} />
              </div>
            )}
            {loadedTabs.has('verifications') && (
              <div className={activeTab === 'verifications' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
                <VerificationReview admin={admin} />
              </div>
            )}
            {loadedTabs.has('config') && (
              <div className={activeTab === 'config' ? 'flex min-h-0 w-full flex-1 flex-col overflow-hidden' : 'hidden'}>
                {admin.role === 'super_admin' ? (
                  <SystemConfiguration admin={admin} isActive={activeTab === 'config'} />
                ) : (
                  <SecondaryAdminConfiguration admin={admin} />
                )}
              </div>
            )}
            {loadedTabs.has('announcements') && (
              <div className={activeTab === 'announcements' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
                <AnnouncementManagement admin={admin} />
              </div>
            )}
            {admin.role === 'super_admin' && (
              <>
                {loadedTabs.has('products') && (
                  <div className={activeTab === 'products' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
                    <ProductTypeManagement
                      isActive={activeTab === 'products'}
                      onOrderDirtyChange={setProductOrderDirty}
                    />
                  </div>
                )}
                {loadedTabs.has('validdata') && (
                  <div className={activeTab === 'validdata' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
                    <ValidOrderDataManagement adminId={admin.id} />
                  </div>
                )}
                {loadedTabs.has('admins') && (
                  <div className={activeTab === 'admins' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
                    <AdminManagement admin={admin} />
                  </div>
                )}
                {loadedTabs.has('history') && (
                  <div className={activeTab === 'history' ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
                    <HistoryDataManagement isActive={activeTab === 'history'} />
                  </div>
                )}
              </>
            )}

            {loadedTabs.has('accountlocks') && (
              <div className={activeTab === 'accountlocks' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
                <AccountLockManagement
                  admin={admin}
                  isActive={activeTab === 'accountlocks'}
                />
              </div>
            )}

          </Suspense>
          </div>
          </div>
        </div>
      </div>

      {admin.role === 'super_admin' && showNavigationSettings && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden overscroll-none bg-slate-950/90 p-3 backdrop-blur-sm sm:p-5">
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-cyan-800/80 bg-[#172235] shadow-[0_24px_70px_rgba(2,10,24,0.78)]">
            <div className="flex shrink-0 items-center justify-between border-b border-cyan-800/70 bg-[linear-gradient(110deg,#172f55_0%,#164653_55%,#42361f_100%)] px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-950/30 text-cyan-100 ring-1 ring-cyan-700/70">
                  <SlidersHorizontal className="h-[18px] w-[18px]" strokeWidth={2.4} />
                </div>
                <div className="min-w-0">
                  <h3 className="truncate text-base font-bold text-white">導航設定</h3>
                  <p className="text-[11px] text-slate-300">預覽會即時更新，儲存後套用。</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowNavigationSettings(false)}
                className="ml-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-500/70 bg-slate-950/30 text-slate-300 transition-colors hover:border-cyan-600 hover:bg-slate-700/70 hover:text-white"
                aria-label="關閉導航設定"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid min-h-0 flex-1 lg:grid-cols-[180px_minmax(0,1fr)]">
              <aside className="hidden min-h-0 border-r border-cyan-800/60 bg-[linear-gradient(180deg,#11253f_0%,#123743_58%,#3a311f_100%)] lg:flex lg:flex-col">
                <div className="shrink-0 border-b border-cyan-800/60 bg-slate-950/25 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-cyan-200/75">
                  即時預覽
                </div>
                <div className="min-h-0 flex-1 space-y-0.5 overflow-hidden p-2">
                  {navigationDraft.map((item, index) => {
                    const definition = defaultTabs.find(tab => tab.id === item.id);
                    const Icon = definition?.icon || Settings;
                    const previewLabel = item.label.trim() || definition?.label || item.id;
                    const previewBadgeCount = item.id === 'customerservice'
                      ? 3
                      : item.id === 'cccservice'
                        ? 2
                        : item.id === 'accountlocks' || item.id === 'withdrawals' || item.id === 'verifications'
                          ? 1
                          : 0;

                    return (
                      <div
                        key={item.id}
                        className={`flex h-6 items-center gap-1.5 rounded px-1.5 text-left ${index === 0 ? 'bg-blue-700 text-white shadow-sm' : 'text-slate-300 hover:bg-cyan-900/35 hover:text-white'}`}
                      >
                        <Icon className="h-3 w-3 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-[10px] font-medium leading-none">{previewLabel}</span>
                        {previewBadgeCount > 0 && (
                          <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-orange-300/70 bg-orange-600 px-1 text-[8px] font-bold leading-none text-white shadow-sm" title="通知預覽">
                            {previewBadgeCount}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </aside>

              <div ref={navigationListRef} className="min-h-0 overflow-y-auto overscroll-contain bg-[linear-gradient(180deg,#1b293b_0%,#233143_100%)] p-2.5 scrollbar-dark sm:p-3">
                <div className="space-y-1.5">
                  {navigationDraft.map((item, index) => {
                    const definition = defaultTabs.find(tab => tab.id === item.id);
                    const originalLabel = definition?.label || item.id;
                    const hasCustomLabel = item.label.trim() !== originalLabel;
                    const Icon = definition?.icon || Settings;

                    return (
                      <div
                        key={item.id}
                        data-navigation-item-id={item.id}
                        onClick={() => setNavigationSelectedItemId(item.id)}
                        className={`group relative grid grid-cols-[26px_30px_minmax(0,1fr)] items-center gap-2 rounded-lg border p-2 shadow-sm transition-all duration-150 sm:grid-cols-[26px_30px_minmax(0,1fr)_132px] ${navigationDragState?.tabId === item.id ? 'scale-[0.99] border-cyan-300 bg-cyan-950/60 opacity-30' : navigationSelectedItemId === item.id ? 'scale-[1.005] border-blue-300 bg-blue-950/65 shadow-[0_0_0_1px_rgba(96,165,250,0.5),0_7px_16px_rgba(2,6,23,0.55)] ring-1 ring-blue-400/50 hover:border-cyan-300 hover:bg-blue-900/60' : 'border-slate-600/90 bg-slate-800/85 hover:scale-[1.01] hover:border-cyan-400 hover:bg-cyan-950/35 hover:shadow-[0_0_0_1px_rgba(34,211,238,0.28),0_6px_14px_rgba(2,6,23,0.48)]'}`}
                      >
                        <div className="flex h-7 w-[26px] items-center justify-center rounded-md border border-yellow-200/70 bg-yellow-400 text-[10px] font-black tabular-nums text-slate-950 shadow-sm shadow-yellow-950/30 transition-transform group-hover:scale-105 group-focus-within:scale-105" title={`位置 ${index + 1}`}>
                          {String(index + 1).padStart(2, '0')}
                        </div>
                        <div className="flex h-7 w-[30px] items-center justify-center rounded-md border border-cyan-700/70 bg-cyan-950/65 text-cyan-200 transition-colors group-hover:border-cyan-400 group-hover:bg-cyan-800/70 group-hover:text-white group-focus-within:border-blue-400 group-focus-within:bg-blue-800/70 group-focus-within:text-white" title={originalLabel}>
                          <Icon className="h-3.5 w-3.5" strokeWidth={2.3} />
                        </div>
                        <div className="min-w-0">
                          <label htmlFor={`navigation-label-${item.id}`} className="sr-only">{originalLabel} 的顯示名稱</label>
                          <input
                            id={`navigation-label-${item.id}`}
                            type="text"
                            value={item.label}
                            maxLength={NAVIGATION_LABEL_MAX_LENGTH}
                            onFocus={() => setNavigationSelectedItemId(item.id)}
                            onChange={(event) => {
                              setNavigationSelectedItemId(item.id);
                              const label = event.target.value.slice(0, NAVIGATION_LABEL_MAX_LENGTH);
                              setNavigationDraft(current => current.map(entry => entry.id === item.id ? { ...entry, label } : entry));
                            }}
                            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-950 shadow-sm outline-none transition-all placeholder:text-slate-400 hover:border-cyan-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
                            placeholder={originalLabel}
                            title={`原始名稱：${originalLabel}`}
                          />
                        </div>
                        <div className="col-span-3 flex items-center justify-end gap-1 sm:col-span-1">
                          <button
                            type="button"
                            onClick={() => {
                              setNavigationSelectedItemId(item.id);
                              restoreNavigationItemLabel(item.id);
                            }}
                            onFocus={() => setNavigationSelectedItemId(item.id)}
                            disabled={!hasCustomLabel}
                            className="inline-flex h-8 w-[66px] items-center justify-center gap-1 rounded-md border border-amber-500/80 bg-gradient-to-b from-amber-700/80 to-amber-900 px-1.5 text-[10px] font-bold text-amber-100 shadow-sm shadow-slate-950/60 transition-colors hover:border-yellow-300 hover:from-amber-500 hover:to-amber-700 hover:text-white disabled:cursor-not-allowed disabled:border-slate-700 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-600 disabled:shadow-none"
                            title={`還原「${originalLabel}」`}
                          >
                            <RotateCcw className="h-3 w-3" />
                            重設
                          </button>
                          <button
                            type="button"
                            onClick={() => setNavigationSelectedItemId(item.id)}
                            onPointerDown={(event) => startNavigationDrag(event, item.id, 1)}
                            onFocus={() => setNavigationSelectedItemId(item.id)}
                            onPointerMove={updateNavigationDrag}
                            onPointerUp={endNavigationDrag}
                            onPointerCancel={endNavigationDrag}
                            className="flex h-8 w-[60px] touch-none select-none items-center justify-center gap-1 rounded-md border border-cyan-400/80 bg-gradient-to-b from-blue-700 to-cyan-800 text-white shadow-sm shadow-slate-950/60 transition-colors hover:border-cyan-100 hover:from-blue-600 hover:to-cyan-700"
                            aria-label={`將 ${item.label || originalLabel} 上下移動；按住並拖曳以重新排序。`}
                            title="按住並拖曳上下重新排序"
                          >
                            <ChevronsUpDown className="h-4 w-4" strokeWidth={2.6} />
                            <span className="text-[9px] font-bold uppercase tracking-wide">移動</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-cyan-800/60 bg-[#17263a] px-4 py-3 sm:px-5">
              <button
                type="button"
                onClick={() => setShowNavigationSettings(false)}
                className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-4 text-xs font-semibold text-slate-200 shadow-sm transition-colors hover:border-slate-500 hover:bg-slate-700 hover:text-white"
              >
                取消
              </button>
              <button
                type="button"
                onClick={saveNavigationDraft}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-cyan-700/70 bg-gradient-to-r from-blue-700 to-cyan-700 px-4 text-xs font-bold text-white shadow-md shadow-slate-950/40 transition-colors hover:from-blue-600 hover:to-cyan-600"
              >
                <Save className="h-3.5 w-3.5" />
                儲存設定
              </button>
            </div>
          </div>

          {navigationDragState && (() => {
            const draggedItem = navigationDraft.find(item => item.id === navigationDragState.tabId);
            const definition = defaultTabs.find(tab => tab.id === navigationDragState.tabId);
            const Icon = definition?.icon || Settings;
            const label = draggedItem?.label.trim() || definition?.label || navigationDragState.tabId;

            return (
              <div
                ref={navigationDragPreviewRef}
                className="pointer-events-none fixed left-0 top-0 z-[10000] flex items-center gap-2 rounded-lg border-2 border-cyan-300 bg-cyan-950/95 p-2 text-white opacity-95 shadow-[0_0_10px_rgba(34,211,238,0.95),0_0_28px_rgba(6,182,212,0.75)] will-change-transform"
                style={{
                  transform: `translate3d(${navigationDragState.pointerX - navigationDragState.offsetX}px, ${navigationDragState.pointerY - navigationDragState.offsetY}px, 0)`,
                  width: navigationDragState.width,
                  height: navigationDragState.height,
                }}
                aria-hidden="true"
              >
                <div className="flex h-7 w-[26px] shrink-0 items-center justify-center rounded-md bg-yellow-400 text-[10px] font-black text-slate-950">
                  {String(navigationDraft.findIndex(item => item.id === navigationDragState.tabId) + 1).padStart(2, '0')}
                </div>
                <div className="flex h-7 w-[30px] shrink-0 items-center justify-center rounded-md border border-cyan-300/70 bg-cyan-800 text-cyan-50">
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <span className="min-w-0 flex-1 truncate text-xs font-bold">{label}</span>
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-cyan-500 text-white">
                  {navigationDragState.direction === -1
                    ? <ChevronUp className="h-4 w-4" strokeWidth={2.7} />
                    : <ChevronDown className="h-4 w-4" strokeWidth={2.7} />}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* 變更密碼 Modal */}
      {showPasswordModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-900 p-5 shadow-[0_24px_70px_rgba(2,6,23,0.7)] sm:p-6">
            <div className="mb-5 flex items-center gap-3 border-b border-slate-700/70 pb-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-300/30 bg-cyan-500/15">
                <Lock className="h-5 w-5 text-cyan-200" />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-bold text-white sm:text-xl">變更密碼</h3>
                <p className="mt-0.5 text-xs text-slate-400">更新管理員登入憑證</p>
              </div>
            </div>

            {passwordSuccess && (
              <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-emerald-400/35 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-200">
                <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center">
                  <span className="text-white text-xs">✓</span>
                </div>
                密碼變更成功！
              </div>
            )}

            {passwordError && (
              <div className="mb-4 rounded-xl border border-rose-400/35 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-200">
                {passwordError}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-300">
                  目前密碼
                </label>
                <div className="relative">
                  <input
                    type={showCurrentPassword ? 'text' : 'password'}
                    value={passwordData.currentPassword}
                    onChange={(e) => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
                    autoComplete="current-password"
                    className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 pr-10 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                    placeholder="輸入目前密碼"
                    disabled={changingPassword}
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  >
                    {showCurrentPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-300">
                  新密碼
                </label>
                <div className="relative">
                  <input
                    type={showNewPassword ? 'text' : 'password'}
                    value={passwordData.newPassword}
                    onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
                    autoComplete="new-password"
                    className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 pr-10 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                    placeholder="輸入新密碼"
                    disabled={changingPassword}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  >
                    {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-300">
                  確認新密碼
                </label>
                <div className="relative">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={passwordData.confirmPassword}
                    onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                    autoComplete="new-password"
                    className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 pr-10 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                    placeholder="確認新密碼"
                    disabled={changingPassword}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter' && !changingPassword) {
                        handleChangePassword();
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-6 flex gap-2.5 border-t border-slate-700/70 pt-4">
              <button
                onClick={() => {
                  setShowPasswordModal(false);
                  setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
                  setPasswordError(null);
                  setPasswordSuccess(false);
                }}
                className="flex-1 rounded-xl border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={changingPassword}
              >
                取消
              </button>
              <button
                onClick={handleChangePassword}
                disabled={changingPassword}
                className="flex-1 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:from-cyan-500 hover:to-blue-500 disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {changingPassword ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    變更中…
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4" />
                    變更密碼
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 變更使用者名稱 Modal */}
      {showUsernameModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-900 p-5 shadow-[0_24px_70px_rgba(2,6,23,0.7)] sm:p-6">
            <div className="mb-5 flex items-center gap-3 border-b border-slate-700/70 pb-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-violet-300/30 bg-violet-500/15">
                <UserCog className="h-5 w-5 text-violet-200" />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-bold text-white sm:text-xl">變更使用者名稱</h3>
                <p className="mt-0.5 text-xs text-slate-400">為管理員帳戶設定新的使用者名稱</p>
              </div>
            </div>

            {usernameSuccess && (
              <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-emerald-400/35 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-200">
                <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center">
                  <span className="text-white text-xs">✓</span>
                </div>
                使用者名稱變更成功！重新載入中…
              </div>
            )}

            {usernameError && (
              <div className="mb-4 rounded-xl border border-rose-400/35 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-200">
                {usernameError}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-300">
                  新使用者名稱
                </label>
                <input
                  type="text"
                  value={usernameData.newUsername}
                  onChange={(e) => setUsernameData({ ...usernameData, newUsername: e.target.value })}
                  autoComplete="username"
                  className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                  placeholder="輸入新的使用者名稱"
                  disabled={changingUsername}
                />
                <p className="mt-1.5 text-[11px] text-slate-400">
                  僅限英文字母、數字與底線（至少 3 個字元）
                </p>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-300">
                  目前密碼
                </label>
                <div className="relative">
                  <input
                    type={showUsernamePassword ? 'text' : 'password'}
                    value={usernameData.currentPassword}
                    onChange={(e) => setUsernameData({ ...usernameData, currentPassword: e.target.value })}
                    autoComplete="current-password"
                    className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 pr-10 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                    placeholder="輸入密碼以確認"
                    disabled={changingUsername}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter' && !changingUsername) {
                        handleChangeUsername();
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowUsernamePassword(!showUsernamePassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  >
                    {showUsernamePassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-6 flex gap-2.5 border-t border-slate-700/70 pt-4">
              <button
                onClick={() => {
                  setShowUsernameModal(false);
                  setUsernameData({ newUsername: '', currentPassword: '' });
                  setUsernameError(null);
                  setUsernameSuccess(false);
                }}
                className="flex-1 rounded-xl border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={changingUsername}
              >
                取消
              </button>
              <button
                onClick={handleChangeUsername}
                disabled={changingUsername}
                className="flex-1 rounded-xl bg-gradient-to-r from-violet-600 to-purple-700 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:from-violet-500 hover:to-purple-600 disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {changingUsername ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    變更中…
                  </>
                ) : (
                  <>
                    <UserCog className="w-4 h-4" />
                    變更使用者名稱
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
