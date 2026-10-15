import { useState, useEffect, useRef } from 'react';
import { formatSupabaseError, supabase } from '../../lib/supabase';
import { getAdminFinancialSessionToken } from '../../lib/auth';
import { CheckCircle, XCircle, Clock, ArrowUpDown, ArrowUp, ArrowDown, ChevronDown, ChevronRight, Users, Shield, Pin, Search, DollarSign, RefreshCw } from 'lucide-react';

interface Admin {
  id: string;
  username: string;
  role: string;
  parent_id?: string | null;
  is_pinned: boolean;
}

interface EmployeeStats {
  employee_id: string;
  employee_username: string;
  employee_number: string;
  total_orders: number;
  today_orders: number;
  today_completed_orders: number;
  failed_orders: number;
  account_balance: number;
  today_commission: number;
  total_work_minutes: number;
  today_work_minutes: number;
  work_status: 'online' | 'offline' | 'never_started';
  last_activity_at?: string | null;
  verification?: {
    real_name: string;
    wallet_address: string;
    phone: string;
    email: string;
  } | null;
}

type SortField = 'total_orders' | 'today_orders' | 'today_completed_orders' | 'failed_orders' | 'account_balance' | 'today_commission' | 'total_work_minutes' | 'today_work_minutes';
type SortDirection = 'asc' | 'desc' | null;

interface AdminGroup {
  admin: Admin;
  stats: EmployeeStats[];
  originalStats: EmployeeStats[];
  isExpanded: boolean;
  sortField: SortField | null;
  sortDirection: SortDirection;
  statusFilter: 'all' | 'online' | 'offline' | 'never_started';
}

interface DispatchRecordsProps {
  admin: Admin;
}

function isFreshOnlineSession(session: {
  status: string;
  ended_at: string | null;
  last_activity_at: string | null;
}) {
  if (session.status !== 'online' || session.ended_at || !session.last_activity_at) return false;
  return new Date(session.last_activity_at).getTime() >= Date.now() - 3 * 60 * 1000;
}

export default function DispatchRecords({ admin }: DispatchRecordsProps) {
  // For super admin: show groups
  const [adminGroups, setAdminGroups] = useState<AdminGroup[]>([]);
  // For secondary admin: show flat list
  const [employeeStats, setEmployeeStats] = useState<EmployeeStats[]>([]);
  const [originalEmployeeStats, setOriginalEmployeeStats] = useState<EmployeeStats[]>([]);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline' | 'never_started'>('all');
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [, setTimeTick] = useState(0);
  const isTogglingPinRef = useRef(false);
  const loadDispatchRecordsRef = useRef<((silent?: boolean) => Promise<void>) | null>(null);

  // Use refs to track current sort state for use in async functions
  const sortFieldRef = useRef<SortField | null>(null);
  const sortDirectionRef = useRef<SortDirection>(null);
  const statusFilterRef = useRef<'all' | 'online' | 'offline' | 'never_started'>('all');

  // Sync state to refs whenever they change
  useEffect(() => {
    sortFieldRef.current = sortField;
  }, [sortField]);

  useEffect(() => {
    sortDirectionRef.current = sortDirection;
  }, [sortDirection]);

  useEffect(() => {
    statusFilterRef.current = statusFilter;
  }, [statusFilter]);

  useEffect(() => {
    void loadDispatchRecordsRef.current?.();

    // Auto-refresh every 3 minutes
    const autoRefreshInterval = setInterval(() => {
      if (!isTogglingPinRef.current) {
        void loadDispatchRecordsRef.current?.(true);
      }
    }, 180000);

    const timeUpdateInterval = setInterval(() => {
      setTimeTick(tick => tick + 1);
    }, 30000);

    return () => {
      clearInterval(autoRefreshInterval);
      clearInterval(timeUpdateInterval);
    };
  }, [admin.id, admin.role]);

  const loadDispatchRecords = async (silent: boolean = false) => {
    if (!silent) {
      setLoading(true);
    }
    if (silent) {
      setIsRefreshing(true);
    }
    try {
      // Use UTC midnight for consistency across all views
      const now = new Date();
      const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
      const todayISO = todayUTC.toISOString();

      if (admin.role === 'super_admin') {
        // Super admin: load all secondary admins and their employees
        await loadSuperAdminView(todayISO);
      } else {
        // Secondary admin: load only own employees
        await loadSecondaryAdminView(todayISO);
      }
    } catch (error: unknown) {
      console.error('Failed to load dispatch records:', formatSupabaseError(error));
    } finally {
      if (!silent) {
        setLoading(false);
      }
      if (silent) {
        setIsRefreshing(false);
      }
      setLastUpdated(new Date());
    }
  };

  const handleManualRefresh = async () => {
    await loadDispatchRecords(true);
  };

  const formatLastUpdated = () => {
    const now = new Date();
    const diff = Math.floor((now.getTime() - lastUpdated.getTime()) / 1000);

    if (diff < 5) return 'Just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return lastUpdated.toLocaleTimeString();
  };
  loadDispatchRecordsRef.current = loadDispatchRecords;

  const loadSecondaryAdminView = async (todayISO: string) => {
    // Fetch users for this admin
    const { data: allUsers, error: usersError } = await supabase
      .from('users')
      .select('id, username, employee_id, created_by')
      .eq('created_by', admin.id)
      .limit(10000);

    if (usersError) throw usersError;

    // If no users, return empty array
    if (!allUsers || allUsers.length === 0) {
      setEmployeeStats([]);
      setOriginalEmployeeStats([]);
      return;
    }

      const userIds = allUsers.map(u => u.id);

      // Fetch all order statistics in parallel with optimized queries
      const [
        totalOrdersResult,
        todayOrdersResult,
        todayCompletedOrdersResult,
        failedOrdersResult,
        todayCommissionResult,
        walletsResult,
        verificationsResult,
        workStatusResult
      ] = await Promise.all([
        // Total orders per user
        (async () => {
          try {
            return await supabase.rpc('count_orders_by_user', { user_ids: userIds });
          } catch {
            return { data: null, error: null };
          }
        })(),

        // Today's orders per user
        (async () => {
          try {
            return await supabase.rpc('count_today_orders_by_user', {
              user_ids: userIds,
              today_start: todayISO
            });
          } catch {
            return { data: null, error: null };
          }
        })(),

        // Today's completed orders per user
        (async () => {
          try {
            return await supabase.rpc('count_today_completed_orders_by_user', {
              user_ids: userIds,
              today_start: todayISO
            });
          } catch {
            return { data: null, error: null };
          }
        })(),

        // Failed orders per user
        (async () => {
          try {
            return await supabase.rpc('count_today_valid_data_failed_orders_by_user', {
              user_ids: userIds,
              today_start: todayISO
            });
          } catch {
            return { data: null, error: null };
          }
        })(),

        // Today's commission per user (from orders table to match employee view)
        supabase
          .from('orders')
          .select('user_id, commission_amount')
          .in('user_id', userIds)
          .eq('status', 'success')
          .gte('created_at', todayISO)
          .limit(50000),

        // Wallet balances
        supabase.from('wallets').select('user_id, available_balance').in('user_id', userIds),

        // Verification data
        supabase.from('verification_requests').select('user_id, real_name, wallet_address, phone, email').eq('status', 'approved').in('user_id', userIds),

        // Work status (latest dispatch session for each user)
        supabase
          .from('dispatch_sessions')
          .select('user_id, status, ended_at, last_activity_at')
          .in('user_id', userIds)
          .order('started_at', { ascending: false })
          .limit(10000)
      ]);

      // Build wallet balance map
      const walletBalanceMap = new Map(
        walletsResult.data?.map(w => [w.user_id, Number(w.available_balance) || 0]) || []
      );

      // Build verification map
      const verificationMap = new Map(
        verificationsResult.data?.map(v => [v.user_id, {
          real_name: v.real_name,
          wallet_address: v.wallet_address,
          phone: v.phone,
          email: v.email
        }]) || []
      );

      // Build work status map (get latest session for each user)
      const workStatusMap = new Map<string, { status: string; ended_at: string | null; last_activity_at: string | null }>();
      if (workStatusResult.data) {
        workStatusResult.data.forEach((session) => {
          if (session.user_id && !workStatusMap.has(session.user_id)) {
            workStatusMap.set(session.user_id, {
              status: session.status || '',
              ended_at: session.ended_at,
              last_activity_at: session.last_activity_at
            });
          }
        });
      }

      // Build user stats map
      const userStatsMap = new Map<string, EmployeeStats>();

      allUsers.forEach(user => {
        const sessionData = workStatusMap.get(user.id);
        let workStatus: 'online' | 'offline' | 'never_started' = 'never_started';

        if (sessionData) {
          if (isFreshOnlineSession(sessionData)) {
            workStatus = 'online';
          } else {
            workStatus = 'offline';
          }
        }

        userStatsMap.set(user.id, {
          employee_id: user.id,
          employee_username: user.username,
          employee_number: user.employee_id,
          total_orders: 0,
          today_orders: 0,
          today_completed_orders: 0,
          failed_orders: 0,
          account_balance: walletBalanceMap.get(user.id) || 0,
          today_commission: 0,
          total_work_minutes: 0,
          today_work_minutes: 0,
          work_status: workStatus,
          last_activity_at: sessionData?.last_activity_at || null,
          verification: verificationMap.get(user.id) || null,
        });
      });

      // Aggregate total orders
      if (totalOrdersResult.data) {
        totalOrdersResult.data.forEach((row) => {
          const stats = userStatsMap.get(row.user_id);
          if (stats) stats.total_orders = row.count || 0;
        });
      }

      // Aggregate today's orders
      if (todayOrdersResult.data) {
        todayOrdersResult.data.forEach((row) => {
          const stats = userStatsMap.get(row.user_id);
          if (stats) stats.today_orders = row.count || 0;
        });
      }

      // Aggregate today's completed orders
      if (todayCompletedOrdersResult.data) {
        todayCompletedOrdersResult.data.forEach((row) => {
          const stats = userStatsMap.get(row.user_id);
          if (stats) stats.today_completed_orders = row.count || 0;
        });
      }

      // Aggregate failed orders
      if (failedOrdersResult.data) {
        failedOrdersResult.data.forEach((row) => {
          const stats = userStatsMap.get(row.user_id);
          if (stats) stats.failed_orders = row.count || 0;
        });
      }

      // Aggregate today's commission from orders
      if (todayCommissionResult.data) {
        const commissionMap = new Map<string, number>();
        todayCommissionResult.data.forEach((order) => {
          const currentTotal = commissionMap.get(order.user_id) || 0;
          commissionMap.set(order.user_id, currentTotal + (Number(order.commission_amount) || 0));
        });

        commissionMap.forEach((total, userId) => {
          const stats = userStatsMap.get(userId);
          if (stats) stats.today_commission = total;
        });
      }

      // Calculate work time from work_sessions table (batch query)
      try {
        const { data: workTimeData, error: workTimeError } = await supabase.rpc('get_batch_work_time', {
          p_user_ids: userIds
        });

        if (workTimeError) throw workTimeError;

        if (workTimeData) {
          workTimeData.forEach((row) => {
            const stats = userStatsMap.get(row.user_id);
            if (stats) {
              stats.total_work_minutes = row.total_work_minutes || 0;
              stats.today_work_minutes = row.today_work_minutes || 0;
            }
          });
        }
      } catch (error) {
        console.error('Failed to get work time:', error);
      }

    // Build employee stats array
    const stats = allUsers
      .map(u => userStatsMap.get(u.id)!)
      .filter(s => s);

    // Apply current sorting if exists (use refs to get latest values)
    let sortedStats = stats;
    if (sortFieldRef.current && sortDirectionRef.current) {
      sortedStats = [...stats].sort((a, b) => {
        const aValue = a[sortFieldRef.current!];
        const bValue = b[sortFieldRef.current!];
        return sortDirectionRef.current === 'desc' ? bValue - aValue : aValue - bValue;
      });
    }

    setEmployeeStats(sortedStats);
    setOriginalEmployeeStats(stats);
  };

  const loadSuperAdminView = async (todayISO: string) => {
    // Fetch all admins (both super admin and secondary admins), excluding emergency_admin
    const { data: allAdmins, error: adminsError } = await supabase
      .from('admins')
      .select('id, username, role, parent_id, is_pinned')
      .neq('role', 'emergency_admin')
      .order('username');

    if (adminsError) throw adminsError;

    // Fetch all users
    const { data: allUsers, error: usersError } = await supabase
      .from('users')
      .select('id, username, employee_id, created_by')
      .limit(10000);

    if (usersError) throw usersError;

    if (!allUsers || allUsers.length === 0) {
      setAdminGroups((allAdmins || []).map(admin => ({
        admin,
        stats: [],
        originalStats: [],
        isExpanded: true,
        sortField: null,
        sortDirection: null,
        statusFilter: 'all',
      })));
      return;
    }

    const userIds = allUsers.map(u => u.id);

    // Fetch all order statistics in parallel
    const [
      totalOrdersResult,
      todayOrdersResult,
      todayCompletedOrdersResult,
      failedOrdersResult,
      todayCommissionResult,
      walletsResult,
      verificationsResult,
      workStatusResult
    ] = await Promise.all([
      (async () => {
        try {
          return await supabase.rpc('count_orders_by_user', { user_ids: userIds });
        } catch {
          return { data: null, error: null };
        }
      })(),
      (async () => {
        try {
          return await supabase.rpc('count_today_orders_by_user', {
            user_ids: userIds,
            today_start: todayISO
          });
        } catch {
          return { data: null, error: null };
        }
      })(),
      (async () => {
        try {
          return await supabase.rpc('count_today_completed_orders_by_user', {
            user_ids: userIds,
            today_start: todayISO
          });
        } catch {
          return { data: null, error: null };
        }
      })(),
      (async () => {
        try {
          return await supabase.rpc('count_today_valid_data_failed_orders_by_user', {
            user_ids: userIds,
            today_start: todayISO
          });
        } catch {
          return { data: null, error: null };
        }
      })(),
      // Today's commission per user (from orders table to match employee view)
      supabase
        .from('orders')
        .select('user_id, commission_amount')
        .in('user_id', userIds)
        .eq('status', 'success')
        .gte('created_at', todayISO)
        .limit(50000),
      supabase.from('wallets').select('user_id, available_balance').in('user_id', userIds),
      supabase.from('verification_requests').select('user_id, real_name, wallet_address, phone, email').eq('status', 'approved').in('user_id', userIds),

      // Work status (latest dispatch session for each user)
      supabase
        .from('dispatch_sessions')
        .select('user_id, status, ended_at, last_activity_at')
        .in('user_id', userIds)
        .order('started_at', { ascending: false })
        .limit(10000)
    ]);

    // Build wallet balance map
    const walletBalanceMap = new Map(
      walletsResult.data?.map(w => [w.user_id, Number(w.available_balance) || 0]) || []
    );

    // Build verification map
    const verificationMap = new Map(
      verificationsResult.data?.map(v => [v.user_id, {
        real_name: v.real_name,
        wallet_address: v.wallet_address,
        phone: v.phone,
        email: v.email
      }]) || []
    );

    // Build work status map (get latest session for each user)
    const workStatusMap = new Map<string, { status: string; ended_at: string | null; last_activity_at: string | null }>();
    if (workStatusResult.data) {
      workStatusResult.data.forEach((session) => {
        if (session.user_id && !workStatusMap.has(session.user_id)) {
          workStatusMap.set(session.user_id, {
            status: session.status || '',
            ended_at: session.ended_at,
            last_activity_at: session.last_activity_at
          });
        }
      });
    }

    // Build user stats map
    const userStatsMap = new Map<string, EmployeeStats>();

    allUsers.forEach(user => {
      const sessionData = workStatusMap.get(user.id);
      let workStatus: 'online' | 'offline' | 'never_started' = 'never_started';

      if (sessionData) {
        if (isFreshOnlineSession(sessionData)) {
          workStatus = 'online';
        } else {
          workStatus = 'offline';
        }
      }

      userStatsMap.set(user.id, {
        employee_id: user.id,
        employee_username: user.username,
        employee_number: user.employee_id,
        total_orders: 0,
        today_orders: 0,
        today_completed_orders: 0,
        failed_orders: 0,
        account_balance: walletBalanceMap.get(user.id) || 0,
        today_commission: 0,
        total_work_minutes: 0,
        today_work_minutes: 0,
        work_status: workStatus,
        last_activity_at: sessionData?.last_activity_at || null,
        verification: verificationMap.get(user.id) || null,
      });
    });

    // Aggregate statistics
    if (totalOrdersResult.data) {
      totalOrdersResult.data.forEach((row) => {
        const stats = userStatsMap.get(row.user_id);
        if (stats) stats.total_orders = row.count || 0;
      });
    }

    if (todayOrdersResult.data) {
      todayOrdersResult.data.forEach((row) => {
        const stats = userStatsMap.get(row.user_id);
        if (stats) stats.today_orders = row.count || 0;
      });
    }

    if (todayCompletedOrdersResult.data) {
      todayCompletedOrdersResult.data.forEach((row) => {
        const stats = userStatsMap.get(row.user_id);
        if (stats) stats.today_completed_orders = row.count || 0;
      });
    }

    if (failedOrdersResult.data) {
      failedOrdersResult.data.forEach((row) => {
        const stats = userStatsMap.get(row.user_id);
        if (stats) stats.failed_orders = row.count || 0;
      });
    }

    // Aggregate today's commission from orders
    if (todayCommissionResult.data) {
      const commissionMap = new Map<string, number>();
      todayCommissionResult.data.forEach((order) => {
        const currentTotal = commissionMap.get(order.user_id) || 0;
        commissionMap.set(order.user_id, currentTotal + (Number(order.commission_amount) || 0));
      });

      commissionMap.forEach((total, userId) => {
        const stats = userStatsMap.get(userId);
        if (stats) stats.today_commission = total;
      });
    }

    // Calculate work time
    try {
      const { data: workTimeData, error: workTimeError } = await supabase.rpc('get_batch_work_time', {
        p_user_ids: userIds
      });

      if (workTimeError) throw workTimeError;

      if (workTimeData) {
        workTimeData.forEach((row) => {
          const stats = userStatsMap.get(row.user_id);
          if (stats) {
            stats.total_work_minutes = row.total_work_minutes || 0;
            stats.today_work_minutes = row.today_work_minutes || 0;
          }
        });
      }
    } catch (error) {
      console.error('Failed to get work time:', error);
    }

    // Build admin groups using functional update to access latest state
    // This prevents closure issues where adminGroups might be stale
    setAdminGroups(currentGroups => {
      // Preserve current state (sorting, expansion, filters) if exists
      const currentGroupsMap = new Map(
        currentGroups.map(g => [g.admin.id, {
          isExpanded: g.isExpanded,
          sortField: g.sortField,
          sortDirection: g.sortDirection,
          statusFilter: g.statusFilter
        }])
      );

      const groups: AdminGroup[] = (allAdmins || []).map(adminUser => {
        const employees = allUsers.filter(u => u.created_by === adminUser.id);
        const stats = employees
          .map(u => userStatsMap.get(u.id)!)
          .filter(s => s);

        // Get previous state for this admin
        const prevState = currentGroupsMap.get(adminUser.id);

        // Apply sorting if it was previously set
        let sortedStats = stats;
        if (prevState?.sortField && prevState?.sortDirection) {
          sortedStats = [...stats].sort((a, b) => {
            const aValue = a[prevState.sortField!];
            const bValue = b[prevState.sortField!];
            return prevState.sortDirection === 'desc' ? bValue - aValue : aValue - bValue;
          });
        }

        return {
          admin: adminUser,
          stats: sortedStats,
          originalStats: stats,
          isExpanded: prevState?.isExpanded ?? true,
          sortField: prevState?.sortField ?? null,
          sortDirection: prevState?.sortDirection ?? null,
          statusFilter: prevState?.statusFilter ?? 'all',
        };
      });

      // Sort groups: super admin first, then pinned, then by username
      groups.sort((a, b) => {
        // Super admin always first
        if (a.admin.role === 'super_admin' && b.admin.role !== 'super_admin') {
          return -1;
        }
        if (a.admin.role !== 'super_admin' && b.admin.role === 'super_admin') {
          return 1;
        }
        // Then pinned items
        if (a.admin.is_pinned !== b.admin.is_pinned) {
          return a.admin.is_pinned ? -1 : 1;
        }
        // Then by username
        return a.admin.username.localeCompare(b.admin.username);
      });

      return groups;
    });
  };

  const toggleAdminExpand = (adminId: string) => {
    setAdminGroups(groups =>
      groups.map(g =>
        g.admin.id === adminId ? { ...g, isExpanded: !g.isExpanded } : g
      )
    );
  };

  const togglePin = async (adminId: string, currentPinned: boolean) => {
    try {
      // Set flag to prevent reload during pin toggle
      isTogglingPinRef.current = true;

      const { error } = await supabase.rpc('admin_update_admin_account', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_target_admin_id: adminId,
        p_updates: { is_pinned: !currentPinned },
      });

      if (error) throw error;

      // Update local state
      setAdminGroups(groups => {
        const newGroups = groups.map(g =>
          g.admin.id === adminId
            ? { ...g, admin: { ...g.admin, is_pinned: !currentPinned } }
            : g
        );

        // Re-sort after pin state change (same logic as loadSuperAdminView)
        newGroups.sort((a, b) => {
          // Super admin always first
          if (a.admin.role === 'super_admin' && b.admin.role !== 'super_admin') {
            return -1;
          }
          if (a.admin.role !== 'super_admin' && b.admin.role === 'super_admin') {
            return 1;
          }
          // Then pinned items
          if (a.admin.is_pinned !== b.admin.is_pinned) {
            return a.admin.is_pinned ? -1 : 1;
          }
          // Then by username
          return a.admin.username.localeCompare(b.admin.username);
        });

        return newGroups;
      });

      // Clear flag after a short delay to allow the update to propagate
      setTimeout(() => {
        isTogglingPinRef.current = false;
      }, 500);
    } catch (error: unknown) {
      console.error('Failed to toggle pin:', formatSupabaseError(error));
      alert('Failed to toggle pin: ' + formatSupabaseError(error));
      isTogglingPinRef.current = false;
    }
  };

  const handleGroupStatusFilter = (adminId: string, filter: 'all' | 'online' | 'offline' | 'never_started') => {
    setAdminGroups(groups =>
      groups.map(g => {
        if (g.admin.id !== adminId) return g;

        let filteredStats = g.originalStats;
        if (filter !== 'all') {
          filteredStats = filteredStats.filter(stat => stat.work_status === filter);
        }

        return {
          ...g,
          stats: filteredStats,
          statusFilter: filter,
          sortField: null,
          sortDirection: null,
        };
      })
    );
  };

  const handleGroupSort = (adminId: string, field: SortField) => {
    setAdminGroups(groups =>
      groups.map(g => {
        if (g.admin.id !== adminId) return g;

        let newDirection: SortDirection = 'desc';
        if (g.sortField === field) {
          if (g.sortDirection === 'desc') newDirection = 'asc';
          else if (g.sortDirection === 'asc') newDirection = null;
        }

        let sortedStats: EmployeeStats[];
        if (newDirection === null) {
          sortedStats = [...g.originalStats];
        } else {
          sortedStats = [...g.stats];
          sortedStats.sort((a, b) => {
            const aValue = a[field];
            const bValue = b[field];
            return newDirection === 'desc' ? bValue - aValue : aValue - bValue;
          });
        }

        return {
          ...g,
          stats: sortedStats,
          sortField: newDirection ? field : null,
          sortDirection: newDirection,
        };
      })
    );
  };

  const getGroupSortIcon = (group: AdminGroup, field: SortField) => {
    if (group.sortField !== field) {
      return <ArrowUpDown className="w-4 h-4 text-slate-500" />;
    }
    if (group.sortDirection === 'desc') {
      return <ArrowDown className="w-4 h-4 text-blue-400" />;
    }
    return <ArrowUp className="w-4 h-4 text-blue-400" />;
  };

  const handleSort = (field: SortField) => {
    let newDirection: SortDirection = 'desc';
    if (sortField === field) {
      if (sortDirection === 'desc') newDirection = 'asc';
      else if (sortDirection === 'asc') newDirection = null;
    }

    const newField = newDirection ? field : null;
    setSortField(newField);
    setSortDirection(newDirection);
    // Update refs
    sortFieldRef.current = newField;
    sortDirectionRef.current = newDirection;

    if (newDirection === null) {
      // Restore original order instead of reloading data
      setEmployeeStats([...originalEmployeeStats]);
    } else {
      const sorted = [...employeeStats].sort((a, b) => {
        const aValue = a[field];
        const bValue = b[field];
        return newDirection === 'desc' ? bValue - aValue : aValue - bValue;
      });
      setEmployeeStats(sorted);
    }
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="w-4 h-4 text-slate-500" />;
    }
    if (sortDirection === 'desc') {
      return <ArrowDown className="w-4 h-4 text-blue-400" />;
    }
    return <ArrowUp className="w-4 h-4 text-blue-400" />;
  };

  const formatTime = (minutes: number): string => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };


  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center space-y-3">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400"></div>
          <div className="text-white">Loading dispatch records...</div>
        </div>
      </div>
    );
  }

  // Render secondary admin view
  if (admin.role === 'secondary_admin') {
    let filteredEmployeeStats = employeeStats;

    // Apply status filter
    if (statusFilter !== 'all') {
      filteredEmployeeStats = filteredEmployeeStats.filter(stat => stat.work_status === statusFilter);
    }

    // Apply search filter
    if (searchTerm) {
      filteredEmployeeStats = filteredEmployeeStats.filter(
        (stat) => {
          const searchLower = searchTerm.toLowerCase();
          return (
            stat.employee_username.toLowerCase().includes(searchLower) ||
            stat.employee_id.toLowerCase().includes(searchLower) ||
            (stat.verification?.real_name && stat.verification.real_name.toLowerCase().includes(searchLower)) ||
            (stat.verification?.phone && stat.verification.phone.includes(searchTerm)) ||
            (stat.verification?.email && stat.verification.email.toLowerCase().includes(searchLower)) ||
            (stat.verification?.wallet_address && stat.verification.wallet_address.toLowerCase().includes(searchLower))
          );
        }
      );
    }

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="text-sm text-slate-400">
              Last updated: <span className="text-slate-300 font-medium">{formatLastUpdated()}</span>
            </div>
            <button
              onClick={handleManualRefresh}
              disabled={isRefreshing}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        <div className="flex gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-white" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search employees..."
              className="w-full pl-10 pr-4 py-2 bg-slate-800/70 border border-slate-600 rounded-lg text-white placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                statusFilter === 'all'
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-700/50'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setStatusFilter('online')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                statusFilter === 'online'
                  ? 'bg-green-600 text-white'
                  : 'bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-700/50'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-green-400"></span>
              Online
            </button>
            <button
              onClick={() => setStatusFilter('offline')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                statusFilter === 'offline'
                  ? 'bg-red-600 text-white'
                  : 'bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-700/50'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-red-400"></span>
              Offline
            </button>
            <button
              onClick={() => setStatusFilter('never_started')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                statusFilter === 'never_started'
                  ? 'bg-slate-600 text-white'
                  : 'bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-700/50'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-slate-400"></span>
              Never Started
            </button>
          </div>
        </div>

        {filteredEmployeeStats.length > 0 ? (
          <div className="bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-700/50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-slate-300 uppercase tracking-wide">
                      Username
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-slate-300 uppercase tracking-wide">
                      ID
                    </th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                      Status
                    </th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                      <button
                        onClick={() => handleSort('total_orders')}
                        className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                      >
                        <span>Total</span>
                        {getSortIcon('total_orders')}
                      </button>
                    </th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                      <button
                        onClick={() => handleSort('today_orders')}
                        className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                      >
                        <span>Orders</span>
                        {getSortIcon('today_orders')}
                      </button>
                    </th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                      <button
                        onClick={() => handleSort('today_completed_orders')}
                        className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                      >
                        <span>Success</span>
                        {getSortIcon('today_completed_orders')}
                      </button>
                    </th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                      <button
                        onClick={() => handleSort('failed_orders')}
                        className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                      >
                        <span>Failed</span>
                        {getSortIcon('failed_orders')}
                      </button>
                    </th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                      <button
                        onClick={() => handleSort('account_balance')}
                        className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                      >
                        <span>Balance</span>
                        {getSortIcon('account_balance')}
                      </button>
                    </th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                      <button
                        onClick={() => handleSort('today_commission')}
                        className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                      >
                        <span>Commission</span>
                        {getSortIcon('today_commission')}
                      </button>
                    </th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                      <button
                        onClick={() => handleSort('total_work_minutes')}
                        className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                      >
                        <span>Total Time</span>
                        {getSortIcon('total_work_minutes')}
                      </button>
                    </th>
                    <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                      <button
                        onClick={() => handleSort('today_work_minutes')}
                        className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                      >
                        <span>Today Time</span>
                        {getSortIcon('today_work_minutes')}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-slate-800/50">
                  {filteredEmployeeStats.map((stat) => (
                    <tr key={stat.employee_id} className="border-b border-slate-700 hover:bg-slate-700/30 transition-colors">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="text-xs font-medium text-white">{stat.employee_username}</div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="text-xs text-slate-300 font-mono">{stat.employee_number}</div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center">
                          {stat.work_status === 'online' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 border border-green-500/50">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
                              <span className="text-xs font-medium text-green-400">On</span>
                            </span>
                          ) : stat.work_status === 'offline' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/20 border border-red-500/50">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                              <span className="text-xs font-medium text-red-400">Off</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-500/20 border border-slate-500/50">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                              <span className="text-xs font-medium text-slate-400">New</span>
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center space-x-1">
                          <CheckCircle className="w-3.5 h-3.5 text-blue-400" />
                          <span className="text-xs text-white">{stat.total_orders}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center space-x-1">
                          <CheckCircle className="w-3.5 h-3.5 text-cyan-400" />
                          <span className="text-xs text-cyan-400 font-medium">{stat.today_orders}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center space-x-1">
                          <CheckCircle className="w-3.5 h-3.5 text-green-400" />
                          <span className="text-xs text-green-400 font-bold">{stat.today_completed_orders}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center space-x-1">
                          <XCircle className="w-3.5 h-3.5 text-red-400" />
                          <span className="text-xs text-red-400">{stat.failed_orders}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center space-x-1">
                          <DollarSign className="w-3.5 h-3.5 text-blue-400" />
                          <span className="text-xs text-blue-400 font-bold">{stat.account_balance.toFixed(2)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center space-x-1">
                          <DollarSign className="w-3.5 h-3.5 text-amber-400" />
                          <span className="text-xs text-amber-400 font-semibold">{stat.today_commission.toFixed(2)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center space-x-1">
                          <Clock className="w-3.5 h-3.5 text-blue-400" />
                          <span className="text-xs text-white">{formatTime(stat.total_work_minutes)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        <div className="flex items-center justify-center space-x-1">
                          <Clock className="w-3.5 h-3.5 text-green-400" />
                          <span className="text-xs text-green-400 font-medium">{formatTime(stat.today_work_minutes)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-xl px-6 py-12 text-center text-slate-400">
            No employees found
          </div>
        )}
      </div>
    );
  }

  // Render super admin view (grouped by secondary admins)
  const filteredAdminGroups = searchTerm
    ? adminGroups.map((group) => ({
        ...group,
        stats: group.stats.filter(
          (stat) => {
            const searchLower = searchTerm.toLowerCase();
            return (
              stat.employee_username.toLowerCase().includes(searchLower) ||
              stat.employee_id.toLowerCase().includes(searchLower) ||
              (stat.verification?.real_name && stat.verification.real_name.toLowerCase().includes(searchLower)) ||
              (stat.verification?.phone && stat.verification.phone.includes(searchTerm)) ||
              (stat.verification?.email && stat.verification.email.toLowerCase().includes(searchLower)) ||
              (stat.verification?.wallet_address && stat.verification.wallet_address.toLowerCase().includes(searchLower))
            );
          }
        ),
      })).filter((group) => group.stats.length > 0)
    : adminGroups;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="text-sm text-slate-400">
            Last updated: <span className="text-slate-300 font-medium">{formatLastUpdated()}</span>
          </div>
          <button
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-white" />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search employees..."
          className="w-full pl-10 pr-4 py-2 bg-slate-800/70 border border-slate-600 rounded-lg text-white placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="space-y-4">
        {filteredAdminGroups.map((group) => {
          const isSuperAdmin = group.admin.role === 'super_admin';
          const IconComponent = isSuperAdmin ? Shield : Users;
          const badgeColor = isSuperAdmin ? 'amber' : 'blue';

          return (
            <div
              key={group.admin.id}
              className="bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-xl overflow-hidden"
            >
              <div className="flex items-center justify-between px-6 py-4">
                <div
                  onClick={() => toggleAdminExpand(group.admin.id)}
                  className="flex items-center space-x-4 flex-1 cursor-pointer hover:opacity-80 transition-opacity"
                >
                  {group.isExpanded ? (
                    <ChevronDown className="w-5 h-5 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-slate-400" />
                  )}
                  <IconComponent className={`w-5 h-5 text-${badgeColor}-400`} />
                  <div>
                    <h3 className="text-lg font-semibold text-white flex items-center space-x-2">
                      <span>{group.admin.username}</span>
                      <span className={`text-xs px-2 py-0.5 bg-${badgeColor}-500/20 text-${badgeColor}-400 rounded`}>
                        {isSuperAdmin ? 'Super Admin' : 'Secondary Admin'}
                      </span>
                      {group.admin.is_pinned && (
                        <Pin className="w-4 h-4 text-yellow-400 fill-yellow-400" />
                      )}
                    </h3>
                    <p className="text-sm text-slate-400">
                      {group.stats.length} {group.stats.length === 1 ? 'Employee' : 'Employees'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => handleGroupStatusFilter(group.admin.id, 'all')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        group.statusFilter === 'all'
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-700/50 text-slate-400 hover:text-white hover:bg-slate-600/50'
                      }`}
                    >
                      All
                    </button>
                    <button
                      onClick={() => handleGroupStatusFilter(group.admin.id, 'online')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                        group.statusFilter === 'online'
                          ? 'bg-green-600 text-white'
                          : 'bg-slate-700/50 text-slate-400 hover:text-white hover:bg-slate-600/50'
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400"></span>
                      Online
                    </button>
                    <button
                      onClick={() => handleGroupStatusFilter(group.admin.id, 'offline')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                        group.statusFilter === 'offline'
                          ? 'bg-red-600 text-white'
                          : 'bg-slate-700/50 text-slate-400 hover:text-white hover:bg-slate-600/50'
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                      Offline
                    </button>
                    <button
                      onClick={() => handleGroupStatusFilter(group.admin.id, 'never_started')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                        group.statusFilter === 'never_started'
                          ? 'bg-slate-600 text-white'
                          : 'bg-slate-700/50 text-slate-400 hover:text-white hover:bg-slate-600/50'
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                      Never Started
                    </button>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(group.admin.id, group.admin.is_pinned);
                    }}
                    className={`p-2 rounded-lg transition-all ${
                      group.admin.is_pinned
                        ? 'bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400'
                        : 'bg-slate-700/50 hover:bg-slate-600/50 text-slate-400 hover:text-yellow-400'
                    }`}
                    title={group.admin.is_pinned ? 'Unpin' : 'Pin to top'}
                  >
                    <Pin className={`w-4 h-4 ${group.admin.is_pinned ? 'fill-current' : ''}`} />
                  </button>
                </div>
              </div>

              {group.isExpanded && (
                <div className="border-t border-slate-700">
                  {group.stats.length > 0 ? (
                    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                      <table className="w-full">
                        <thead className="bg-slate-700/50 sticky top-0 z-10">
                          <tr>
                            <th className="px-3 py-2 text-left text-xs font-medium text-slate-300 uppercase tracking-wide">
                              Username
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-medium text-slate-300 uppercase tracking-wide">
                              ID
                            </th>
                            <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                              Status
                            </th>
                            <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                              <button
                                onClick={() => handleGroupSort(group.admin.id, 'total_orders')}
                                className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                              >
                                <span>Total</span>
                                {getGroupSortIcon(group, 'total_orders')}
                              </button>
                            </th>
                            <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                              <button
                                onClick={() => handleGroupSort(group.admin.id, 'today_orders')}
                                className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                              >
                                <span>Orders</span>
                                {getGroupSortIcon(group, 'today_orders')}
                              </button>
                            </th>
                            <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                              <button
                                onClick={() => handleGroupSort(group.admin.id, 'today_completed_orders')}
                                className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                              >
                                <span>Success</span>
                                {getGroupSortIcon(group, 'today_completed_orders')}
                              </button>
                            </th>
                            <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                              <button
                                onClick={() => handleGroupSort(group.admin.id, 'failed_orders')}
                                className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                              >
                                <span>Failed</span>
                                {getGroupSortIcon(group, 'failed_orders')}
                              </button>
                            </th>
                            <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                              <button
                                onClick={() => handleGroupSort(group.admin.id, 'account_balance')}
                                className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                              >
                                <span>Balance</span>
                                {getGroupSortIcon(group, 'account_balance')}
                              </button>
                            </th>
                            <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                              <button
                                onClick={() => handleGroupSort(group.admin.id, 'today_commission')}
                                className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                              >
                                <span>Commission</span>
                                {getGroupSortIcon(group, 'today_commission')}
                              </button>
                            </th>
                            <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                              <button
                                onClick={() => handleGroupSort(group.admin.id, 'total_work_minutes')}
                                className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                              >
                                <span>Total Time</span>
                                {getGroupSortIcon(group, 'total_work_minutes')}
                              </button>
                            </th>
                            <th className="px-3 py-2 text-center text-xs font-medium text-slate-300 uppercase tracking-wide">
                              <button
                                onClick={() => handleGroupSort(group.admin.id, 'today_work_minutes')}
                                className="flex items-center justify-center space-x-1 w-full hover:text-white transition-colors"
                              >
                                <span>Today Time</span>
                                {getGroupSortIcon(group, 'today_work_minutes')}
                              </button>
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-slate-800/50">
                          {group.stats.map((stat) => (
                            <tr key={stat.employee_id} className="border-b border-slate-700 hover:bg-slate-700/30 transition-colors">
                              <td className="px-3 py-2 whitespace-nowrap">
                                <div className="text-xs font-medium text-white">{stat.employee_username}</div>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                <div className="text-xs text-slate-300 font-mono">{stat.employee_number}</div>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-center">
                                <div className="flex items-center justify-center">
                                  {stat.work_status === 'online' ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 border border-green-500/50">
                                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
                                      <span className="text-xs font-medium text-green-400">On</span>
                                    </span>
                                  ) : stat.work_status === 'offline' ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/20 border border-red-500/50">
                                      <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                                      <span className="text-xs font-medium text-red-400">Off</span>
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-500/20 border border-slate-500/50">
                                      <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                                      <span className="text-xs font-medium text-slate-400">New</span>
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-center">
                                <div className="flex items-center justify-center space-x-1">
                                  <CheckCircle className="w-3.5 h-3.5 text-blue-400" />
                                  <span className="text-xs text-white">{stat.total_orders}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-center">
                                <div className="flex items-center justify-center space-x-1">
                                  <CheckCircle className="w-3.5 h-3.5 text-cyan-400" />
                                  <span className="text-xs text-cyan-400 font-medium">{stat.today_orders}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-center">
                                <div className="flex items-center justify-center space-x-1">
                                  <CheckCircle className="w-3.5 h-3.5 text-green-400" />
                                  <span className="text-xs text-green-400 font-bold">{stat.today_completed_orders}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-center">
                                <div className="flex items-center justify-center space-x-1">
                                  <XCircle className="w-3.5 h-3.5 text-red-400" />
                                  <span className="text-xs text-red-400">{stat.failed_orders}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-center">
                                <div className="flex items-center justify-center space-x-1">
                                  <DollarSign className="w-3.5 h-3.5 text-blue-400" />
                                  <span className="text-xs text-blue-400 font-bold">{stat.account_balance.toFixed(2)}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-center">
                                <div className="flex items-center justify-center space-x-1">
                                  <DollarSign className="w-3.5 h-3.5 text-amber-400" />
                                  <span className="text-xs text-amber-400 font-semibold">{stat.today_commission.toFixed(2)}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-center">
                                <div className="flex items-center justify-center space-x-1">
                                  <Clock className="w-3.5 h-3.5 text-blue-400" />
                                  <span className="text-xs text-white">{formatTime(stat.total_work_minutes)}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-center">
                                <div className="flex items-center justify-center space-x-1">
                                  <Clock className="w-3.5 h-3.5 text-green-400" />
                                  <span className="text-xs text-green-400 font-medium">{formatTime(stat.today_work_minutes)}</span>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="px-6 py-8 text-center text-slate-400">
                      No employees under this admin
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {adminGroups.length === 0 && (
          <div className="bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-xl px-6 py-12 text-center text-slate-400">
            No secondary admins found
          </div>
        )}
      </div>
    </div>
  );
}
