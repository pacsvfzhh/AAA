import { useState, useEffect, useCallback, useMemo, useRef, useTransition } from 'react';
import { Shield, Unlock, AlertTriangle, Clock, User, RefreshCw, History, Search, Users, ChevronDown, X } from 'lucide-react';
import { formatSupabaseError, isFinancialAdminSessionError, supabase } from '../../lib/supabase';
import { unlockAccount } from '../../lib/rateLimitService';
import { Admin } from '../../types';
import { getAdminFinancialSessionToken, logout } from '../../lib/auth';
import AdminPageLoading from './AdminPageLoading';

interface AccountLock {
  id: string;
  identifier: string;
  identifier_type: string;
  lock_until: string;
  lock_reason: string | null;
  failed_attempts: number;
  created_at: string;
  unlocked_at: string | null;
  unlocked_by: string | null;
  user_id: string | null;
  username: string | null;
  employee_id: string | null;
  lock_ip: string | null;
  admin_username: string | null;
  owner_admin_id?: string | null;
  owner_admin_username?: string | null;
}

interface AccountLockManagementProps {
  admin: Admin;
  isActive: boolean;
}

interface AdminGroupOption {
  id: string;
  username: string;
  role: Admin['role'];
}

export default function AccountLockManagement({ admin, isActive }: AccountLockManagementProps) {
  const [locks, setLocks] = useState<AccountLock[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [nextExpiry, setNextExpiry] = useState<number | null>(null);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [historyLocks, setHistoryLocks] = useState<AccountLock[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAdminId, setSelectedAdminId] = useState('all');
  const [adminGroups, setAdminGroups] = useState<AdminGroupOption[]>([]);
  const [adminGroupsLoading, setAdminGroupsLoading] = useState(false);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [isGroupTransitionPending, startGroupTransition] = useTransition();
  const initialLoadStartedRef = useRef(false);
  const locksLoadingRef = useRef(false);
  const historyLoadedRef = useRef(false);
  const historyLoadingRef = useRef(false);
  const historyRpcUnavailableRef = useRef(false);
  const adminGroupsLoadedRef = useRef(false);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const isActiveRef = useRef(isActive);
  const locksRefreshQueuedRef = useRef(false);
  const historyRefreshQueuedRef = useRef(false);

  const loadLocks = useCallback(async (isInitial = false) => {
    if (locksLoadingRef.current) {
      locksRefreshQueuedRef.current = true;
      return;
    }
    locksLoadingRef.current = true;

    try {
      if (isInitial) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      const { data, error } = await supabase.rpc('get_account_locks_for_admin', {
        p_admin_id: getAdminFinancialSessionToken()
      });

      if (error) throw error;

      const accountLocks = (data || []).filter(
        (lock: AccountLock) => lock.identifier_type === 'username'
      );
      const userIds = [...new Set(
        accountLocks
          .map(lock => lock.user_id)
          .filter((userId): userId is string => Boolean(userId))
      )];
      const employeeIdsByUserId = new Map<string, string>();
      const ownerAdminIdsByUserId = new Map<string, string>();

      if (userIds.length > 0) {
        const { data: employeeRows } = await supabase
          .from('users')
          .select('id, employee_id, created_by')
          .in('id', userIds);

        employeeRows?.forEach(employee => {
          employeeIdsByUserId.set(employee.id, employee.employee_id);
          ownerAdminIdsByUserId.set(employee.id, employee.created_by);
        });
      }

      const locksWithEmployeeIds = accountLocks.map(lock => ({
        ...lock,
        employee_id: lock.employee_id ?? employeeIdsByUserId.get(lock.user_id ?? '') ?? null,
        owner_admin_id: ownerAdminIdsByUserId.get(lock.user_id ?? '') ?? null
      }));
      const lockExpiryTimes = accountLocks
        .map(lock => new Date(lock.lock_until).getTime())
        .filter(expiry => Number.isFinite(expiry));
      const nextLockExpiry = lockExpiryTimes.length > 0
        ? Math.min(...lockExpiryTimes)
        : null;
      setLocks(locksWithEmployeeIds);
      setNextExpiry(nextLockExpiry);
      setMessage(null);
    } catch (error: unknown) {
      if (isFinancialAdminSessionError(error)) {
        void logout(false);
        return;
      }

      console.error('Failed to load locks:', formatSupabaseError(error));
      if (isInitial) {
        setMessage({
          type: 'error',
          text: '載入鎖定記錄失敗，請稍後再試。'
        });
      }
    } finally {
      const shouldRefreshAgain = locksRefreshQueuedRef.current;
      locksRefreshQueuedRef.current = false;
      locksLoadingRef.current = false;
      if (isInitial) {
        setLoading(false);
      } else {
        setRefreshing(false);
      }
      if (shouldRefreshAgain && isActiveRef.current) {
        void loadLocks(false);
      }
    }
  }, []);

  const loadHistory = useCallback(async (options: { force?: boolean; silent?: boolean } = {}) => {
    const { force = false, silent = false } = options;
    if (historyLoadingRef.current) {
      historyRefreshQueuedRef.current = true;
      return;
    }
    if (historyLoadedRef.current && !force) return;

    historyLoadingRef.current = true;
    setHistoryLoading(true);
    if (!silent) {
      setMessage(null);
    }

    try {
      let historyData: AccountLock[] | null = null;
      if (!historyRpcUnavailableRef.current) {
        const { data, error } = await supabase.rpc('get_account_lock_history_for_admin', {
          p_admin_id: getAdminFinancialSessionToken(),
          p_limit: 200
        });

        if (!error) {
          historyData = data || [];
        } else {
          if (isFinancialAdminSessionError(error)) throw error;
          if (error.code === 'PGRST202') {
            historyRpcUnavailableRef.current = true;
          }
          console.warn('Lock history RPC unavailable; falling back to active lock records:', error);
        }
      }

      if (!historyData) {
        const fallback = await supabase.rpc('get_account_locks_for_admin', {
          p_admin_id: getAdminFinancialSessionToken()
        });

        if (fallback.error) throw fallback.error;
        historyData = fallback.data || [];
      }

      const historyUserIds = [...new Set(
        historyData
          .map(lock => lock.user_id)
          .filter((userId): userId is string => Boolean(userId))
      )];
      const historyUsernames = [...new Set(
        historyData
          .map(lock => lock.username || lock.identifier)
          .filter((username): username is string => Boolean(username))
      )];
      const ownerAdminIdsByUserId = new Map<string, string>();
      const ownerAdminIdsByUsername = new Map<string, string>();
      const ownerAdminUsernames = new Map(
        adminGroups.map(group => [group.id, group.username])
      );

      const employeeQueries = await Promise.all([
        historyUserIds.length > 0
          ? supabase.from('users').select('id, username, created_by').in('id', historyUserIds)
          : Promise.resolve({ data: [], error: null }),
        historyUsernames.length > 0
          ? supabase.from('users').select('id, username, created_by').in('username', historyUsernames)
          : Promise.resolve({ data: [], error: null })
      ]);

      employeeQueries.forEach(({ data: employeeRows }) => {
        employeeRows?.forEach(employee => {
          if (employee.id && employee.created_by) {
            ownerAdminIdsByUserId.set(employee.id, employee.created_by);
          }
          if (employee.username && employee.created_by) {
            ownerAdminIdsByUsername.set(employee.username, employee.created_by);
          }
        });
      });

      const ownerAdminIds = [...new Set([
        ...ownerAdminIdsByUserId.values(),
        ...ownerAdminIdsByUsername.values()
      ])];
      if (ownerAdminIds.length > 0) {
        const { data: ownerAdminRows } = await supabase
          .from('admins')
          .select('id, username')
          .in('id', ownerAdminIds);

        ownerAdminRows?.forEach(owner => {
          ownerAdminUsernames.set(owner.id, owner.username);
        });
      }
      ownerAdminUsernames.set(admin.id, admin.username);

      setHistoryLocks(
        historyData
          .filter(lock => lock.identifier_type === 'username')
          .map(lock => {
            const ownerAdminId = (lock.user_id
              ? ownerAdminIdsByUserId.get(lock.user_id)
              : undefined)
              || ownerAdminIdsByUsername.get(lock.username || lock.identifier);
            return {
              ...lock,
              owner_admin_id: ownerAdminId ?? null,
              owner_admin_username: ownerAdminId
                ? ownerAdminUsernames.get(ownerAdminId) ?? null
                : null
            };
          })
      );
      historyLoadedRef.current = true;
    } catch (error: unknown) {
      if (isFinancialAdminSessionError(error)) {
        void logout(false);
        return;
      }

      console.error('Failed to load lock history:', formatSupabaseError(error));
      if (!silent) {
        setMessage({ type: 'error', text: '載入歷史鎖定記錄失敗，請稍後再試。' });
      }
    } finally {
      const shouldRefreshAgain = historyRefreshQueuedRef.current;
      historyRefreshQueuedRef.current = false;
      historyLoadingRef.current = false;
      setHistoryLoading(false);
      if (shouldRefreshAgain && isActiveRef.current) {
        void loadHistory({ force: true, silent: true });
      }
    }
  }, [admin.id, admin.username, adminGroups]);

  useEffect(() => {
    isActiveRef.current = isActive;
    return () => {
      isActiveRef.current = false;
    };
  }, [isActive]);

  useEffect(() => {
    if (!isActive || admin.role !== 'super_admin' || adminGroupsLoadedRef.current) return;

    let cancelled = false;
    const loadAdminGroups = async () => {
      setAdminGroupsLoading(true);
      const { data, error } = await supabase
        .from('admins')
        .select('id, username, role')
        .in('role', ['super_admin', 'secondary_admin', 'emergency_admin'])
        .order('username', { ascending: true });

      if (cancelled) return;

      const rows: AdminGroupOption[] = error
        ? [{ id: admin.id, username: admin.username, role: admin.role }]
        : (data || []).map(row => ({
            id: row.id,
            username: row.username,
            role: (row.role || 'secondary_admin') as Admin['role']
          }));

      if (error) {
        console.warn('Failed to load administrator groups:', error);
      }

      const uniqueGroups = new Map(
        rows
          .filter(row => row.role !== 'emergency_admin')
          .map(row => [row.id, row])
      );
      uniqueGroups.set(admin.id, { id: admin.id, username: admin.username, role: admin.role });
      setAdminGroups(
        Array.from(uniqueGroups.values()).sort((a, b) => {
          const roleOrder = (group: AdminGroupOption) => group.role === 'super_admin' ? 0 : 1;
          return roleOrder(a) - roleOrder(b) || a.username.localeCompare(b.username);
        })
      );
      adminGroupsLoadedRef.current = true;
      setAdminGroupsLoading(false);
    };

    void loadAdminGroups();
    return () => {
      cancelled = true;
    };
  }, [admin.id, admin.role, admin.username, isActive]);

  useEffect(() => {
    if (!groupMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(event.target as Node)) {
        setGroupMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [groupMenuOpen]);

  useEffect(() => {
    if (!isActive) return;

    setCountdownNow(Date.now());
    const countdownInterval = window.setInterval(() => {
      setCountdownNow(Date.now());
    }, 1000);

    return () => window.clearInterval(countdownInterval);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;

    const refreshVisibleData = () => {
      if (document.visibilityState !== 'visible') return;
      void loadLocks(false);
      if (showHistory) {
        void loadHistory({ force: true, silent: true });
      }
    };

    if (!initialLoadStartedRef.current) {
      initialLoadStartedRef.current = true;
      void loadLocks(true);
    } else {
      refreshVisibleData();
    }

    const subscription = supabase
      .channel('account_locks_changes')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'account_lock_events'
      }, refreshVisibleData)
      .subscribe((status, error) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('Account lock realtime is unavailable; low-frequency refresh remains active.', error);
        }
      });

    const fallbackRefreshInterval = window.setInterval(() => {
      refreshVisibleData();
    }, 60_000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshVisibleData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      subscription.unsubscribe();
      window.clearInterval(fallbackRefreshInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isActive, loadHistory, loadLocks, showHistory]);

  useEffect(() => {
    if (!isActive || !nextExpiry) return;

    const refreshDelay = Math.max(1000, nextExpiry - Date.now() + 1000);
    const timeout = window.setTimeout(() => {
      if (document.visibilityState === 'visible') {
        void loadLocks(false);
      }
    }, refreshDelay);

    return () => window.clearTimeout(timeout);
  }, [isActive, nextExpiry, loadLocks]);

  const handleUnlock = async (lock: AccountLock) => {
    try {
      setUnlocking(lock.id);
      setMessage(null);

      const result = await unlockAccount(lock.identifier, 'username');

      if (result.success) {
        const remainingLocks = locks.filter(item => (
          item.identifier !== lock.identifier || item.identifier_type !== lock.identifier_type
        ));
        const remainingExpiryTimes = remainingLocks
          .map(item => new Date(item.lock_until).getTime())
          .filter(expiry => Number.isFinite(expiry));

        setLocks(remainingLocks);
        setNextExpiry(remainingExpiryTimes.length > 0 ? Math.min(...remainingExpiryTimes) : null);
        setHistoryLocks(current => current.map(historyLock => (
          historyLock.identifier === lock.identifier
            && historyLock.identifier_type === lock.identifier_type
            && !historyLock.unlocked_at
            && !historyLock.unlocked_by
            ? {
                ...historyLock,
                unlocked_at: new Date().toISOString(),
                unlocked_by: admin.id,
                admin_username: admin.username,
              }
            : historyLock
        )));
        setMessage({ type: 'success', text: `已成功解除鎖定：${lock.identifier}` });
      } else {
        setMessage({ type: 'error', text: '解除鎖定失敗，請稍後再試。' });
      }
    } catch (error: unknown) {
      if (isFinancialAdminSessionError(error)) {
        void logout(false);
        return;
      }

      console.error('Unlock failed:', formatSupabaseError(error));
      setMessage({ type: 'error', text: '解除鎖定失敗，請稍後再試。' });
    } finally {
      setUnlocking(null);
    }
  };

  const formatRemainingTime = (seconds: number) => {
    if (seconds < 60) return `${seconds} 秒`;

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes} 分鐘 ${remainingSeconds} 秒`;

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) return `${hours} 小時 ${remainingMinutes} 分 ${remainingSeconds} 秒`;

    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days} 天 ${remainingHours} 小時 ${remainingMinutes} 分 ${remainingSeconds} 秒`;
  };

  const getRemainingTime = (lockUntil: string, currentTime: number) => {
    const until = new Date(lockUntil).getTime();
    const seconds = Math.max(0, Math.ceil((until - currentTime) / 1000));
    return formatRemainingTime(seconds);
  };

  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const selectedAdmin = useMemo(
    () => adminGroups.find(group => group.id === selectedAdminId),
    [adminGroups, selectedAdminId]
  );
  const filterLocks = useCallback((items: AccountLock[]) => items.filter(lock => {
    const matchesAdmin = selectedAdminId === 'all'
      || lock.owner_admin_id === selectedAdminId
      || (!lock.owner_admin_id && lock.admin_username?.toLocaleLowerCase() === selectedAdmin?.username.toLocaleLowerCase());
    if (!matchesAdmin) return false;
    if (!normalizedSearchQuery) return true;

    return [lock.username, lock.employee_id, lock.identifier]
      .filter(Boolean)
      .some(value => value!.toLocaleLowerCase().includes(normalizedSearchQuery));
  }), [normalizedSearchQuery, selectedAdmin, selectedAdminId]);
  const filteredLocks = useMemo(() => filterLocks(locks), [filterLocks, locks]);
  const filteredHistoryLocks = useMemo(() => filterLocks(historyLocks), [filterLocks, historyLocks]);
  const visibleLocks = useMemo(
    () => showHistory ? filteredHistoryLocks : filteredLocks,
    [filteredHistoryLocks, filteredLocks, showHistory]
  );
  const hasActiveFilters = Boolean(normalizedSearchQuery) || selectedAdminId !== 'all';
  const isInitialHistoryLoading = showHistory && historyLoading && !historyLoadedRef.current;
  const usernameLocks = filteredLocks.length;
  const expiringSoon = useMemo(() => filteredLocks.filter(lock => {
    const remaining = new Date(lock.lock_until).getTime() - countdownNow;
    return remaining > 0 && remaining <= 30 * 60 * 1000;
  }).length, [countdownNow, filteredLocks]);
  const manuallyResolvedHistoryCount = useMemo(
    () => filteredHistoryLocks.filter(lock => Boolean(lock.unlocked_by)).length,
    [filteredHistoryLocks]
  );
  const automaticallyResolvedHistoryCount = useMemo(
    () => filteredHistoryLocks.filter(
      lock => !lock.unlocked_by && new Date(lock.lock_until).getTime() <= countdownNow
    ).length,
    [countdownNow, filteredHistoryLocks]
  );
  const getLockStatus = (lock: AccountLock, currentTime: number) => {
    const hasBeenResolved = Boolean(lock.unlocked_at || lock.unlocked_by);
    const isCurrentlyLocked = !hasBeenResolved
      && new Date(lock.lock_until).getTime() > currentTime;

    if (!showHistory || isCurrentlyLocked) {
      return {
        label: showHistory ? '目前鎖定' : '鎖定中',
        badgeClass: 'border-rose-300/30 bg-rose-500/[0.12] text-rose-200',
        textClass: 'text-rose-300',
        metaLabelClass: 'text-rose-300/80',
        metaValueClass: 'text-rose-200',
        accountBadgeClass: 'border-rose-300/30 bg-rose-500/[0.12] text-rose-200',
        cardClass: 'border-rose-300/25 bg-rose-950/20 hover:border-rose-300/50 hover:bg-rose-950/35',
        accentClass: 'border-rose-400/80',
        iconClass: 'border-rose-300/30 bg-rose-400/[0.1] text-rose-300 group-hover:border-rose-200/60 group-hover:bg-rose-400/20'
      };
    }

    if (lock.unlocked_by) {
      return {
        label: '已解除',
        badgeClass: 'border-emerald-300/30 bg-emerald-400/[0.1] text-emerald-200',
        textClass: 'text-emerald-300',
        metaLabelClass: 'text-emerald-300/80',
        metaValueClass: 'text-emerald-200',
        accountBadgeClass: 'border-emerald-300/30 bg-emerald-400/[0.1] text-emerald-200',
        cardClass: 'border-emerald-300/25 bg-emerald-950/20 hover:border-emerald-300/50 hover:bg-emerald-950/35',
        accentClass: 'border-emerald-400/80',
        iconClass: 'border-emerald-300/30 bg-emerald-400/[0.1] text-emerald-300 group-hover:border-emerald-200/60 group-hover:bg-emerald-400/20'
      };
    }

    return {
      label: '自動解除',
      badgeClass: 'border-sky-300/30 bg-sky-400/[0.08] text-sky-200',
      textClass: 'text-sky-300',
      metaLabelClass: 'text-sky-300/80',
      metaValueClass: 'text-sky-200',
      accountBadgeClass: 'border-sky-300/30 bg-sky-400/[0.08] text-sky-200',
      cardClass: 'border-sky-300/20 bg-sky-950/15 hover:border-sky-300/45 hover:bg-sky-950/25',
      accentClass: 'border-sky-400/70',
      iconClass: 'border-sky-300/25 bg-sky-400/[0.08] text-sky-300 group-hover:border-sky-200/55 group-hover:bg-sky-400/15'
    };
  };

  const handleShowHistory = () => {
    setShowHistory(true);
    void loadHistory({ force: true });
  };

  const handleShowCurrentLocks = () => {
    setShowHistory(false);
  };

  const handleSelectAdminGroup = (groupId: string) => {
    setGroupMenuOpen(false);
    startGroupTransition(() => {
      setSelectedAdminId(groupId);
    });
  };

  const selectedGroupLabel = selectedAdminId === 'all'
    ? '總分組'
    : selectedAdmin?.username || '管理員分組';
  const visibleAdminGroups = useMemo(() => (
    adminGroups
      .filter(group => group.role !== 'emergency_admin')
      .sort((a, b) => {
        const roleOrder = (group: AdminGroupOption) => group.role === 'super_admin' ? 0 : 1;
        return roleOrder(a) - roleOrder(b) || a.username.localeCompare(b.username);
      })
  ), [adminGroups]);
  const isRefreshing = refreshing || historyLoading;
  const groupButtonToneClass = showHistory
    ? 'text-violet-100 hover:bg-violet-300/[0.08] hover:text-violet-50'
    : 'text-orange-100 hover:bg-orange-300/[0.08] hover:text-orange-50';
  const groupIconToneClass = showHistory
    ? 'text-violet-200 group-hover:text-violet-100'
    : 'text-orange-100 group-hover:text-orange-50';
  const groupValueToneClass = showHistory ? 'text-violet-50' : 'text-orange-50';
  const groupChevronToneClass = showHistory ? 'text-violet-200/80' : 'text-orange-100/80';
  const groupMenuBorderClass = showHistory ? 'border-violet-200/25' : 'border-orange-200/25';
  const groupMenuSelectedClass = showHistory
    ? 'border-violet-200/45 bg-violet-300/15 text-violet-50'
    : 'border-orange-200/45 bg-orange-300/15 text-orange-50';
  const groupMenuHoverClass = showHistory
    ? 'hover:border-violet-300/25 hover:bg-violet-300/[0.08]'
    : 'hover:border-orange-300/25 hover:bg-orange-300/[0.08]';
  const groupMenuSelectedDotClass = showHistory
    ? 'bg-violet-200 shadow-[0_0_10px_rgba(221,214,254,0.65)]'
    : 'bg-orange-200 shadow-[0_0_10px_rgba(253,186,116,0.65)]';

  if (loading || (admin.role === 'super_admin' && adminGroupsLoading)) {
    return <AdminPageLoading label="已鎖定" />;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_55%_at_88%_0%,rgba(245,158,11,0.1),transparent_62%),radial-gradient(ellipse_55%_65%_at_10%_100%,rgba(14,116,144,0.08),transparent_68%)]" />
      <div className={`relative shrink-0 border-b px-4 py-4 sm:px-6 lg:px-8 ${showHistory ? 'border-violet-400/20' : 'border-orange-400/15'}`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${showHistory ? 'border border-violet-300/30 bg-violet-400/10 text-violet-300 shadow-[0_0_24px_rgba(139,92,246,0.14)]' : 'border border-orange-300/25 bg-orange-400/10 text-orange-300 shadow-[0_0_24px_rgba(245,158,11,0.12)]'}`}>
              <Shield className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold tracking-tight text-white sm:text-2xl">{showHistory ? '歷史鎖定記錄' : '已鎖定帳戶'}</h1>
              <p className="mt-0.5 text-xs text-slate-400">{showHistory ? '檢視歷史帳戶防護鎖定記錄。' : '檢視目前的帳戶防護鎖定記錄。'}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2.5">
            <label className="group flex h-10 w-[180px] items-center gap-2 rounded-xl border border-cyan-300/25 bg-[linear-gradient(135deg,rgba(8,47,73,0.46),rgba(15,23,42,0.82))] px-3 text-slate-300 shadow-[0_6px_18px_rgba(2,6,23,0.2)] transition-[background-color,border-color,box-shadow] duration-150 focus-within:border-cyan-200/75 focus-within:bg-cyan-950/35 focus-within:shadow-[0_8px_24px_rgba(8,47,73,0.3)] sm:w-[220px]">
              <Search className="h-4 w-4 shrink-0 text-cyan-300/75 transition-colors group-focus-within:text-cyan-200" />
              <input
                type="text"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder="搜尋帳戶或 ID"
                aria-label="搜尋員工帳戶或員工 ID"
                className="min-w-0 flex-1 bg-transparent text-xs text-slate-100 outline-none placeholder:text-slate-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-300/45 bg-slate-800/85 text-slate-100 shadow-[0_2px_8px_rgba(2,6,23,0.35)] transition-[background-color,border-color,color,transform] duration-150 hover:scale-105 hover:border-rose-200/80 hover:bg-rose-500/80 hover:text-white active:scale-95"
                  aria-label="清除搜尋"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
            <button
              type="button"
              onClick={handleShowCurrentLocks}
              className={`inline-flex h-10 min-w-[108px] items-center justify-center gap-2 rounded-xl border px-3 text-xs font-bold transition-colors active:scale-[0.97] ${!showHistory
                ? 'border-orange-200 bg-orange-500 text-white'
                : 'border-orange-400/40 bg-orange-500/[0.12] text-orange-200 hover:border-orange-300/70 hover:bg-orange-500/20 hover:text-orange-100'
              }`}
              title="查看目前鎖定記錄"
              aria-pressed={!showHistory}
            >
              <Shield className={`h-4 w-4 ${!showHistory ? 'text-orange-50' : 'text-orange-300/75'}`} />
              目前鎖定
              {!showHistory && <span className="h-1.5 w-1.5 rounded-full bg-orange-50" aria-hidden="true" />}
            </button>
            <button
              type="button"
              onClick={handleShowHistory}
              className={`inline-flex h-10 min-w-[108px] items-center justify-center gap-2 rounded-xl border px-3 text-xs font-bold transition-colors active:scale-[0.97] ${showHistory
                ? 'border-violet-200 bg-violet-600 text-white'
                : 'border-violet-400/40 bg-violet-500/[0.12] text-violet-200 hover:border-violet-300/70 hover:bg-violet-500/20 hover:text-violet-100'
              }`}
              title="查看歷史鎖定記錄"
              aria-pressed={showHistory}
            >
              <History className={`h-4 w-4 ${showHistory ? 'text-violet-50' : 'text-violet-300/75'} ${historyLoading ? 'animate-pulse' : ''}`} />
              歷史鎖定
              {showHistory && <span className="h-1.5 w-1.5 rounded-full bg-violet-50" aria-hidden="true" />}
            </button>
            <button
              type="button"
              onClick={() => showHistory ? void loadHistory({ force: true }) : void loadLocks(false)}
              disabled={isRefreshing}
              aria-busy={isRefreshing}
              className="inline-flex h-10 w-[116px] min-w-[116px] shrink-0 items-center justify-center gap-2 rounded-xl border border-blue-200/80 bg-blue-600 px-3 text-xs font-bold text-white transition-[background-color,border-color,transform] duration-150 active:scale-[0.97] hover:border-blue-100 hover:bg-blue-500 disabled:cursor-wait disabled:border-blue-200/55 disabled:bg-blue-500/75 disabled:text-blue-50"
              title={showHistory ? '刷新歷史記錄' : '刷新鎖定記錄'}
            >
              <RefreshCw className={`h-4 w-4 shrink-0 text-blue-50 ${isRefreshing ? 'animate-spin' : ''}`} />
              <span className="inline-flex w-[60px] justify-center whitespace-nowrap">{isRefreshing ? '刷新中...' : '刷新'}</span>
            </button>
          </div>
        </div>

        <div className={`mt-5 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border px-3 py-1.5 sm:px-4 ${showHistory ? 'border-violet-300/25 bg-violet-500/[0.08] shadow-[0_8px_24px_rgba(139,92,246,0.08)]' : 'border-orange-300/25 bg-orange-500/[0.08] shadow-[0_8px_24px_rgba(245,158,11,0.08)]'}`}>
          {showHistory ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="h-2 w-2 rounded-full bg-violet-300 shadow-[0_0_9px_rgba(196,181,253,0.9)]" />
                <span className="text-[10px] font-bold tracking-wide text-violet-100/90">歷史鎖定</span>
                <span className="text-lg font-bold leading-none text-violet-50">{filteredHistoryLocks.length}</span>
              </div>
              <span className="hidden h-4 w-px bg-violet-200/25 sm:block" />
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-bold tracking-wide text-emerald-200/85">管理員解除</span>
                <span className="text-sm font-bold leading-none text-emerald-200">{manuallyResolvedHistoryCount}</span>
              </div>
              <span className="hidden h-4 w-px bg-violet-200/25 sm:block" />
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-bold tracking-wide text-sky-200/85">系統自動解除</span>
                <span className="text-sm font-bold leading-none text-sky-200">{automaticallyResolvedHistoryCount}</span>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-orange-300 shadow-[0_0_8px_rgba(253,186,116,0.85)]" />
                <span className="text-[10px] font-bold tracking-wide text-orange-100/85">目前鎖定</span>
                <span className="text-lg font-bold leading-none text-orange-50">{filteredLocks.length}</span>
              </div>
              <span className="hidden h-4 w-px bg-orange-200/25 sm:block" />
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-bold tracking-wide text-orange-100/75">使用者名稱鎖定</span>
                <span className="text-sm font-bold leading-none text-orange-50">{usernameLocks}</span>
              </div>
              <span className="hidden h-4 w-px bg-orange-200/25 sm:block" />
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-bold tracking-wide text-orange-100/75">即將到期</span>
                <span className="text-sm font-bold leading-none text-orange-50">{expiringSoon}</span>
              </div>
            </>
          )}
          {admin.role === 'super_admin' && (
            <div ref={groupMenuRef} className={`relative ml-auto shrink-0 border-l pl-4 ${showHistory ? 'border-violet-200/25' : 'border-orange-200/25'}`}>
              <button
                type="button"
                onClick={() => setGroupMenuOpen(open => !open)}
                disabled={adminGroupsLoading}
                aria-expanded={groupMenuOpen}
                aria-haspopup="listbox"
                aria-busy={isGroupTransitionPending}
                className={`group inline-flex h-8 w-[220px] items-center gap-2 rounded-lg px-1.5 text-left transition-colors duration-150 disabled:cursor-wait disabled:opacity-70 sm:w-[248px] ${groupButtonToneClass}`}
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center transition-colors ${groupIconToneClass}`}>
                  <Users className="h-3.5 w-3.5" />
                </span>
                <span className={`min-w-0 flex-1 truncate text-sm font-bold tracking-tight ${groupValueToneClass}`}>
                  {adminGroupsLoading ? '載入中...' : selectedGroupLabel}
                </span>
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${groupChevronToneClass} ${groupMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {groupMenuOpen && !adminGroupsLoading && (
                <div className={`absolute right-0 top-full z-50 mt-2 w-full animate-[fadeInScale_140ms_ease-out] overflow-hidden rounded-xl border ${groupMenuBorderClass} bg-[linear-gradient(160deg,rgba(15,23,42,0.98),rgba(20,28,55,0.98))] p-1.5 shadow-[0_18px_42px_rgba(2,6,23,0.62)] backdrop-blur-xl`}>
                  <button
                    type="button"
                    onClick={() => {
                      handleSelectAdminGroup('all');
                    }}
                    className={`group flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-left transition-[background-color,border-color] duration-150 ${selectedAdminId === 'all' ? groupMenuSelectedClass : `border-transparent text-slate-300 ${groupMenuHoverClass} hover:text-white`}`}
                    role="option"
                    aria-selected={selectedAdminId === 'all'}
                  >
                    <span className="flex min-w-0 items-center gap-2"><span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${showHistory ? 'border-violet-200/25 bg-violet-300/15 text-violet-200' : 'border-orange-200/25 bg-orange-300/15 text-orange-100'}`}><Users className="h-3 w-3" /></span><span className="truncate text-[11px] font-bold">總分組</span></span>
                    {selectedAdminId === 'all' && <span className={`h-1.5 w-1.5 rounded-full ${groupMenuSelectedDotClass}`} />}
                  </button>
                  <div className="mt-1 space-y-0.5">
                    {visibleAdminGroups.map(group => (
                      <button
                        key={group.id}
                        type="button"
                        onClick={() => {
                          handleSelectAdminGroup(group.id);
                        }}
                        className={`group flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-left transition-[background-color,border-color] duration-150 ${selectedAdminId === group.id ? groupMenuSelectedClass : `border-transparent text-slate-300 ${groupMenuHoverClass} hover:text-white`}`}
                        role="option"
                        aria-selected={selectedAdminId === group.id}
                      >
                        <span className="flex min-w-0 items-center gap-2"><span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[9px] font-black ${group.role === 'super_admin' ? 'border-amber-200/30 bg-amber-300/15 text-amber-100' : 'border-violet-200/25 bg-violet-300/15 text-violet-200'}`}>{group.username.slice(0, 1).toUpperCase()}</span><span className="truncate text-[11px] font-bold">{group.username}</span></span>
                        {selectedAdminId === group.id && <span className={`h-1.5 w-1.5 rounded-full ${groupMenuSelectedDotClass}`} />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {message && (
        <div className={`relative shrink-0 border-b px-4 py-3 text-sm sm:px-6 lg:px-8 ${
          message.type === 'success'
            ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200'
            : 'border-rose-400/20 bg-rose-400/[0.06] text-rose-200'
        }`}>
          <span className={`mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${message.type === 'success' ? 'bg-emerald-300' : 'bg-rose-300'}`} />
          {message.text}
        </div>
      )}

      {visibleLocks.length === 0 ? (
        isInitialHistoryLoading ? (
          <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-16 text-center text-slate-400">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-violet-300/25 border-t-violet-300" />
            <p className="mt-4 text-sm font-semibold text-slate-200">正在載入歷史鎖定記錄...</p>
          </div>
        ) : (
          <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-16 text-center text-slate-400">
          <Shield className="h-12 w-12 text-emerald-300/45" />
          <p className="mt-4 text-base font-semibold text-slate-200">{hasActiveFilters ? '沒有符合篩選條件的記錄' : showHistory ? '目前沒有歷史鎖定記錄' : '目前沒有被鎖定的帳戶'}</p>
          <p className="mt-1 text-xs text-slate-500">{showHistory ? '員工帳戶的過往防護鎖定會顯示在這裡。' : '系統偵測到異常登入行為時，會自動顯示防護記錄。'}</p>
          </div>
        )
      ) : (
        <div className={`relative min-h-0 flex-1 overflow-y-auto dark-panel-scroll px-4 pb-6 pt-4 transition-opacity duration-150 sm:px-6 lg:px-8 ${isGroupTransitionPending ? 'opacity-80' : 'opacity-100'}`}>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <p className={`text-[10px] font-bold uppercase tracking-[0.18em] ${showHistory ? 'text-violet-300/85' : 'text-orange-300/80'}`}>{showHistory ? '歷史清單' : '防護清單'}</p>
              <p className="mt-1 text-xs text-slate-500">{showHistory ? '查看員工帳戶過往的鎖定與解除記錄' : '目前仍生效的帳戶鎖定記錄'}</p>
            </div>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 ${showHistory
              ? 'border-violet-300/35 bg-violet-500/[0.12] text-violet-200 shadow-[0_0_18px_rgba(139,92,246,0.14)]'
              : 'border-orange-300/25 bg-orange-400/[0.1] text-orange-200/90'
            }`}>
              <History className={`h-3.5 w-3.5 ${showHistory ? 'text-violet-300' : 'text-orange-300'}`} />
              <span className="text-sm font-bold">{visibleLocks.length} 筆記錄</span>
            </span>
          </div>
          <div className="space-y-3">
            {visibleLocks.map((lock) => {
              const status = getLockStatus(lock, countdownNow);
              const isPendingHistoryLock = showHistory && status.label === '目前鎖定';
              const releaseTimeClass = lock.unlocked_by
                ? 'text-emerald-300'
                : status.label === '自動解除'
                  ? 'text-sky-300'
                  : 'text-rose-300';
              const releaseTimeLabelClass = lock.unlocked_by
                ? 'text-emerald-300/80'
                : status.label === '自動解除'
                  ? 'text-sky-300/80'
                  : 'text-rose-300/80';
              const releaseTimeValue = new Date(
                lock.unlocked_by ? lock.unlocked_at || lock.lock_until : lock.lock_until
              ).toLocaleString();

              return (
                <article
                  key={lock.id}
                  className={`group overflow-hidden border shadow-[0_10px_28px_rgba(2,6,23,0.24)] transition-colors duration-150 ${showHistory ? 'rounded-xl' : 'rounded-2xl'} ${status.cardClass}`}
                >
                  <div className={`border-l-2 px-4 sm:px-5 ${showHistory ? 'py-3' : 'py-4'} ${status.accentClass}`}>
                    <div className={`flex flex-col xl:flex-row xl:items-center ${showHistory ? 'gap-3' : 'gap-4'}`}>
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <div className={`flex shrink-0 items-center justify-center transition-colors ${showHistory ? 'h-10 w-10 rounded-lg' : 'h-11 w-11 rounded-xl'} ${status.iconClass}`}>
                          <User className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="max-w-full truncate font-mono text-base font-semibold text-slate-100">{lock.username || lock.identifier}</span>
                            <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold tracking-wide ${status.accountBadgeClass}`}>
                              使用者帳戶
                            </span>
                            <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold tracking-wide ${status.badgeClass}`}>
                              {status.label}
                            </span>
                          </div>
                          <div className={`mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-semibold ${status.metaLabelClass}`}>
                            <span>員工 ID：<span className={`font-mono ${status.metaValueClass}`}>{lock.employee_id || '未記錄'}</span></span>
                            <span>登入 IP：<span className={`font-mono ${status.metaValueClass}`}>{lock.lock_ip || '未記錄'}</span></span>
                          </div>
                          <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-slate-400">
                            <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${status.metaLabelClass}`} />
                            <span className="line-clamp-2">{lock.lock_reason || '系統偵測到異常登入活動，已啟用暫時防護。'}</span>
                          </p>
                        </div>
                      </div>

                      <div className={`grid grid-cols-2 border-t border-orange-300/15 xl:min-w-[500px] xl:border-l xl:border-t-0 xl:pl-5 ${showHistory ? 'gap-x-5 gap-y-2 pt-2.5 sm:grid-cols-3 xl:pt-0' : 'gap-x-6 gap-y-3 pt-3 sm:grid-cols-4 xl:pt-0'}`}>
                        <div>
                          <p className={`text-[10px] font-bold tracking-[0.12em] ${status.metaLabelClass}`}>防護狀態</p>
                          <p className={`mt-1 text-sm font-bold ${status.textClass}`}>{status.label}</p>
                          {showHistory && (
                            <p className={`mt-2 text-[10px] font-bold tracking-[0.08em] ${status.metaLabelClass}`}>
                              所屬管理員：<span className={`text-xs font-semibold ${status.metaValueClass}`}>{lock.owner_admin_username || adminGroups.find(group => group.id === lock.owner_admin_id)?.username || (admin.role === 'secondary_admin' ? admin.username : '未記錄')}</span>
                            </p>
                          )}
                        </div>
                        {showHistory ? (
                          <div className="min-w-0">
                            <p className="text-[10px] font-bold tracking-[0.12em] text-rose-300/80">鎖定時間</p>
                            <p className="mt-1 flex min-w-0 items-center gap-1.5 truncate text-xs font-semibold text-rose-300">
                              <Clock className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate whitespace-nowrap">{new Date(lock.created_at).toLocaleString()}</span>
                            </p>
                            <p className={`mt-2 text-[10px] font-bold tracking-[0.12em] ${releaseTimeLabelClass}`}>
                              {lock.unlocked_by ? '管理員手動解除時間' : status.label === '自動解除' ? '系統自動解除時間' : '預計解除時間'}
                            </p>
                            <p className={`mt-1 flex min-w-0 items-center gap-1.5 truncate text-xs font-semibold ${releaseTimeClass}`}>
                              <Unlock className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate whitespace-nowrap">{releaseTimeValue}</span>
                            </p>
                          </div>
                        ) : (
                          <div>
                            <p className={`text-[10px] font-bold tracking-[0.12em] ${status.metaLabelClass}`}>剩餘時間</p>
                            <p className={`mt-1 flex items-center gap-1.5 text-base font-bold ${status.textClass}`}>
                              <Clock className={`h-4 w-4 ${status.textClass}`} />
                              {getRemainingTime(lock.lock_until, countdownNow)}
                            </p>
                          </div>
                        )}
                        <div>
                          <p className="text-[10px] font-bold tracking-[0.12em] text-rose-300/80">失敗嘗試</p>
                          <p className="mt-1 text-sm font-bold text-rose-300">{lock.failed_attempts} 次</p>
                        </div>
                        {!showHistory && (
                          <div className="min-w-0">
                            <p className={`text-[10px] font-bold tracking-[0.12em] ${status.metaLabelClass}`}>鎖定時間</p>
                            <p className={`mt-1 truncate text-xs font-semibold ${status.textClass}`}>{new Date(lock.created_at).toLocaleString()}</p>
                          </div>
                        )}
                      </div>

                      <div className={`flex flex-wrap items-center justify-between border-t border-white/[0.08] xl:w-[150px] xl:shrink-0 xl:flex-col xl:items-stretch xl:border-t-0 xl:pl-1 ${showHistory ? 'gap-2 pt-2.5 xl:pt-0' : 'gap-3 pt-3 xl:pt-0'}`}>
                        {showHistory ? (
                          isPendingHistoryLock ? (
                            <div>
                              <p className="truncate text-xs font-bold text-rose-300">等待解除中</p>
                              <p className="mt-1 flex items-center gap-1.5 text-base font-bold text-rose-300">
                                <Clock className="h-4 w-4 shrink-0" />
                                {getRemainingTime(lock.lock_until, countdownNow)}
                              </p>
                            </div>
                          ) : lock.unlocked_by ? (
                            <p className="truncate text-xs font-medium text-emerald-300/80">手動解除：<span className="text-sm font-semibold text-emerald-200">{lock.admin_username || '管理員'}</span></p>
                          ) : (
                            <p className="truncate text-xs font-medium text-sky-300/80">系統自動解除</p>
                          )
                        ) : (
                          <>
                            {lock.admin_username && admin.role === 'super_admin' && (
                              <p className="truncate text-xs font-medium text-slate-400">鎖定所屬管理員：<span className="text-sm font-semibold text-cyan-200">{lock.admin_username}</span></p>
                            )}
                            <button
                              type="button"
                              onClick={() => handleUnlock(lock)}
                              disabled={unlocking === lock.id}
                              aria-busy={unlocking === lock.id}
                              className="group inline-flex h-10 min-w-[132px] items-center justify-center gap-2 rounded-xl border border-emerald-300 bg-emerald-600 px-4 text-xs font-bold text-white shadow-[0_6px_16px_rgba(5,150,105,0.28)] transition-[background-color,border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-emerald-100 hover:bg-emerald-500 hover:shadow-[0_8px_20px_rgba(16,185,129,0.35)] active:translate-y-0 active:scale-95 active:border-emerald-100 active:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:translate-y-0 disabled:cursor-wait disabled:border-emerald-200 disabled:bg-emerald-700 disabled:text-white disabled:shadow-none"
                            >
                              {unlocking === lock.id ? (
                                <>
                                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/50 border-t-white" />
                                  <span>解除鎖定中...</span>
                                </>
                              ) : (
                                <>
                                  <Unlock className="h-3.5 w-3.5" />
                                  <span>解除鎖定</span>
                                </>
                              )}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
