import { useState, useEffect, useRef } from 'react';
import { RefreshCw, Clock, CheckCircle, XCircle, DollarSign, Package, Percent, Gift, ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase, formatSupabaseError, isSupabaseTransientError } from '../../lib/supabase';
import { getTodayStartUTC } from '../../lib/dateUtils';
import { Order } from '../../types';
import { useDeviceOptimization } from '../../lib/useDeviceOptimization';
import { useLanguage } from '../../lib/i18n/context';
import PageLoader from './PageLoader';

interface OrderListProps {
  employeeId: string;
}

interface OrderWithProduct extends Order {
  product_name?: string;
}

interface TipRecord {
  id: string;
  amount: number;
  created_at: string;
  remarks: string;
}

export default function OrderList({ employeeId }: OrderListProps) {
  const [todayOrders, setTodayOrders] = useState<OrderWithProduct[]>([]);
  const [allTodayOrders, setAllTodayOrders] = useState<OrderWithProduct[]>([]);
  const [todayTips, setTodayTips] = useState<TipRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { isMobile } = useDeviceOptimization();
  const [ordersPage, setOrdersPage] = useState(0);
  const ORDERS_PER_PAGE = isMobile ? 8 : 21;
  const { t } = useLanguage();
  const loadOrdersRef = useRef<((isManualRefresh?: boolean) => Promise<void>) | null>(null);
  const loadInFlightRef = useRef(false);

  useEffect(() => {
    void loadOrdersRef.current?.();
    const interval = setInterval(() => { void loadOrdersRef.current?.(); }, 5000);

    const ordersChannel = supabase
      .channel('orders_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          filter: `user_id=eq.${employeeId}`
        },
        () => {
          void loadOrdersRef.current?.();
        }
      )
      .subscribe();

    const productTypesChannel = supabase
      .channel('product_types_changes_orderlist')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'product_types'
        },
        () => {
          void loadOrdersRef.current?.();
        }
      )
      .subscribe();

    const tipsChannel = supabase
      .channel('tips_changes_orderlist')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'wallet_transactions',
          filter: `user_id=eq.${employeeId}`
        },
        (payload) => {
          if ((payload.new as { type?: string }).type === 'tip') {
            void loadOrdersRef.current?.();
          }
        }
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(ordersChannel);
      supabase.removeChannel(productTypesChannel);
      supabase.removeChannel(tipsChannel);
    };
  }, [employeeId]);

  const loadOrders = async (isManualRefresh = false) => {
    if (loadInFlightRef.current && !isManualRefresh) return;
    loadInFlightRef.current = true;
    try {
      if (isManualRefresh) {
        setIsRefreshing(true);
      }

      const todayStartUTC = getTodayStartUTC();

      const { data: ordersData, error: ordersError } = await supabase
        .from('orders')
        .select('*')
        .eq('user_id', employeeId)
        .order('created_at', { ascending: false });

      if (ordersError) throw ordersError;

      const { data: productTypes, error: productError } = await supabase
        .from('product_types')
        .select('*');

      if (productError) throw productError;

      const productMap = new Map(productTypes.map((p) => [p.id, p.name]));

      const todayOrdersFiltered = ordersData?.filter(order =>
        order.created_at >= todayStartUTC
      ).map((order) => ({
        ...order,
        product_name: productMap.get(order.product_type_id) || 'Unknown',
      })) || [];

      // Fetch today's tips
      const { data: tipsData } = await supabase
        .from('wallet_transactions')
        .select('id, amount, created_at, remarks')
        .eq('user_id', employeeId)
        .eq('type', 'tip')
        .gte('created_at', todayStartUTC)
        .order('created_at', { ascending: false });

      setTodayTips(tipsData || []);
      setAllTodayOrders(todayOrdersFiltered);
      setTodayOrders(todayOrdersFiltered);
    } catch (error) {
      // Background polling retries every 5s and keeps the last data, so transient network failures are not worth surfacing.
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (!isAbort && (isManualRefresh || !isSupabaseTransientError(error))) {
        console.error('Error loading orders:', formatSupabaseError(error));
      }
    } finally {
      loadInFlightRef.current = false;
      setLoading(false);
      if (isManualRefresh) {
        setIsRefreshing(false);
      }
    }
  };
  loadOrdersRef.current = loadOrders;

  const totalTipAmount = todayTips.reduce((sum, t) => sum + t.amount, 0);

  const todayStats = {
    total: allTodayOrders.length,
    success: allTodayOrders.filter(o => o.status === 'success').length,
    processing: allTodayOrders.filter(o => o.status === 'processing').length,
    failure: allTodayOrders.filter(o => o.status === 'failure').length,
    totalValue: allTodayOrders.reduce((sum, o) => sum + o.product_value, 0),
    totalCommission: allTodayOrders.reduce((sum, o) => sum + (o.commission_amount || 0), 0) + totalTipAmount,
  };

  // Pagination for mobile/tablet
  const allItems = [...todayTips.map(t => ({ type: 'tip' as const, data: t })), ...todayOrders.map(o => ({ type: 'order' as const, data: o }))];
  const totalOrderPages = Math.ceil(allItems.length / ORDERS_PER_PAGE);
  const paginatedItems = allItems.slice(ordersPage * ORDERS_PER_PAGE, (ordersPage + 1) * ORDERS_PER_PAGE);
  const canGoPrevOrders = ordersPage > 0;
  const canGoNextOrders = ordersPage < totalOrderPages - 1;

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm">
        <PageLoader variant="inline" />
      </div>
    );
  }

  return (
    <div>
      <style>{`
        .order-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .order-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .order-scrollbar::-webkit-scrollbar-thumb {
          background: #bfdbfe;
          border-radius: 3px;
        }
        .order-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #93c5fd;
        }
        .order-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: #bfdbfe transparent;
        }
        @media (max-width: 1023px) {
          .order-scrollbar::-webkit-scrollbar { display: none; }
          .order-scrollbar { scrollbar-width: none; -ms-overflow-style: none; }
        }
      `}</style>

      <div className="relative rounded-2xl shadow-lg shadow-blue-500/5 overflow-hidden" style={{ background: 'linear-gradient(180deg, #f0f7ff 0%, #ffffff 100%)' }}>
        {/* Header */}
        <div className="relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #1e40af 0%, #2563eb 50%, #3b82f6 100%)' }}>
          <div className="absolute top-0 right-0 w-20 sm:w-32 h-20 sm:h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2"></div>
          <div className="absolute bottom-0 left-1/4 w-16 sm:w-24 h-16 sm:h-24 bg-white/5 rounded-full translate-y-1/2"></div>
          <div className="absolute top-1/2 right-1/3 w-8 h-8 bg-sky-300/10 rounded-full -translate-y-1/2 blur-sm"></div>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
          <div className="relative px-4 py-3 sm:px-5 sm:py-3 lg:px-6 lg:py-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="flex min-w-0 items-center gap-2.5 text-base font-bold leading-6 text-white sm:max-lg:gap-3 sm:text-lg lg:text-xl">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-white/25 bg-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] backdrop-blur-sm sm:max-lg:h-10 sm:max-lg:w-10">
                  <Package className="h-[18px] w-[18px] text-white" />
                </div>
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="truncate">{t.orderList.todaysOrders}</span>
                    {allTodayOrders.length > 0 && (
                      <span className="flex h-5 min-w-[20px] flex-shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/15 px-1.5 text-[11px] font-semibold tabular-nums leading-none text-blue-50">
                        {allTodayOrders.length}
                      </span>
                    )}
                  </span>
                  <span className="hidden truncate text-[13px] font-normal leading-5 text-blue-100/90 sm:max-lg:block">
                    {allTodayOrders.length > 0
                      ? `${allTodayOrders.length} ${t.orderList.ordersProcessed}`
                      : t.orderList.realTimeTracking}
                  </span>
                </span>
              </h2>
              <button
                type="button"
                onClick={() => loadOrders(true)}
                disabled={isRefreshing}
                className="order-list-refresh group -mr-1 flex flex-shrink-0 items-center justify-center rounded-xl text-white disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                style={{ WebkitTapHighlightColor: 'transparent' }}
                title={t.orderList.refreshOrders}
                aria-label={t.orderList.refreshOrders}
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/25 bg-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition-all group-hover:bg-white/25 group-active:scale-95 group-disabled:opacity-60 sm:max-lg:h-10 sm:max-lg:w-10">
                  <RefreshCw className={`h-4 w-4 shrink-0 sm:max-lg:h-[18px] sm:max-lg:w-[18px] ${isRefreshing ? 'animate-spin' : ''}`} strokeWidth={2.25} />
                </span>
              </button>
            </div>
            {/* Subtitle - tablet/desktop only */}
            <p className="hidden lg:block text-sm text-blue-100/90 mt-1 ml-[46px]">
              {allTodayOrders.length > 0
                ? `${allTodayOrders.length} ${t.orderList.ordersProcessed}`
                : t.orderList.realTimeTracking}
            </p>
          </div>
          {/* Pagination sub-bar - mobile/tablet only */}
          {allItems.length > ORDERS_PER_PAGE && (
            <div className="lg:hidden relative flex items-center justify-between px-4 sm:px-6 py-0.5 bg-gradient-to-r from-blue-900/30 via-blue-800/20 to-blue-900/30 border-t border-white/10">
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -left-4 top-1/2 -translate-y-1/2 w-16 h-16 bg-sky-400/8 rounded-full blur-md"></div>
                <div className="absolute -right-4 top-1/2 -translate-y-1/2 w-12 h-12 bg-blue-300/8 rounded-full blur-md"></div>
              </div>
              <button
                onClick={() => setOrdersPage(p => p - 1)}
                disabled={!canGoPrevOrders}
                className="relative w-8 h-6 rounded flex items-center justify-center text-white disabled:opacity-30 disabled:cursor-not-allowed active:bg-white/15 transition-all"
              >
                <ChevronLeft className="w-5 h-5" strokeWidth={3} />
              </button>
              <span className="relative text-sm font-bold text-white tabular-nums">
                {ordersPage + 1} / {totalOrderPages}
              </span>
              <button
                onClick={() => setOrdersPage(p => p + 1)}
                disabled={!canGoNextOrders}
                className="relative w-8 h-6 rounded flex items-center justify-center text-white disabled:opacity-30 disabled:cursor-not-allowed active:bg-white/15 transition-all"
              >
                <ChevronRight className="w-5 h-5" strokeWidth={3} />
              </button>
            </div>
          )}
        </div>

        <div className="p-3 sm:p-5">
          {/* Stats Grid */}
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3 mb-4 sm:mb-5">
            {/* Total */}
            <div className="relative flex flex-col items-center text-center rounded-xl px-1.5 py-2.5 sm:block sm:text-left sm:p-3.5 bg-gradient-to-br from-blue-50 via-white to-sky-50/50 border border-blue-100/80 ring-1 ring-blue-50 group hover:border-blue-200 hover:shadow-md hover:shadow-blue-100/50 transition-all duration-200">
              <div className="contents sm:flex sm:flex-wrap sm:items-center sm:gap-x-1.5 sm:gap-y-1 sm:mb-2">
                <div className="order-1 mb-1.5 shrink-0 sm:mb-0 w-5 h-5 sm:w-6 sm:h-6 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shadow-sm shadow-blue-200">
                  <Package className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-white" />
                </div>
                <span className="order-3 mt-1 min-h-[2.5em] sm:mt-0 sm:min-h-0 min-w-0 max-w-full emp-stat-label text-[11px] font-semibold text-blue-600/70 uppercase tracking-wide leading-tight break-words hyphens-auto">{t.orderList.total}</span>
              </div>
              <div className="emp-stat-num order-2 text-xl sm:text-2xl font-bold text-blue-600 leading-none">{todayStats.total}</div>
            </div>

            {/* Success */}
            <div className="relative flex flex-col items-center text-center rounded-xl px-1.5 py-2.5 sm:block sm:text-left sm:p-3.5 bg-gradient-to-br from-emerald-50 via-white to-teal-50/50 border border-emerald-100/80 ring-1 ring-emerald-50 group hover:border-emerald-200 hover:shadow-md hover:shadow-emerald-100/50 transition-all duration-200">
              <div className="contents sm:flex sm:flex-wrap sm:items-center sm:gap-x-1.5 sm:gap-y-1 sm:mb-2">
                <div className="order-1 mb-1.5 shrink-0 sm:mb-0 w-5 h-5 sm:w-6 sm:h-6 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-sm shadow-emerald-200">
                  <CheckCircle className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-white" />
                </div>
                <span className="order-3 mt-1 min-h-[2.5em] sm:mt-0 sm:min-h-0 min-w-0 max-w-full emp-stat-label text-[11px] font-semibold text-emerald-600/70 uppercase tracking-wide leading-tight break-words hyphens-auto">{t.orderList.success}</span>
              </div>
              <div className="emp-stat-num order-2 text-xl sm:text-2xl font-bold text-emerald-600 leading-none">{todayStats.success}</div>
            </div>

            {/* Failed */}
            <div className="relative flex flex-col items-center text-center rounded-xl px-1.5 py-2.5 sm:block sm:text-left sm:p-3.5 bg-gradient-to-br from-rose-50 via-white to-red-50/50 border border-rose-100/80 ring-1 ring-rose-50 group hover:border-rose-200 hover:shadow-md hover:shadow-rose-100/50 transition-all duration-200">
              <div className="contents sm:flex sm:flex-wrap sm:items-center sm:gap-x-1.5 sm:gap-y-1 sm:mb-2">
                <div className="order-1 mb-1.5 shrink-0 sm:mb-0 w-5 h-5 sm:w-6 sm:h-6 rounded-lg bg-gradient-to-br from-rose-500 to-red-600 flex items-center justify-center shadow-sm shadow-rose-200">
                  <XCircle className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-white" />
                </div>
                <span className="order-3 mt-1 min-h-[2.5em] sm:mt-0 sm:min-h-0 min-w-0 max-w-full emp-stat-label text-[11px] font-semibold text-rose-600/70 uppercase tracking-wide leading-tight break-words hyphens-auto">{t.orderList.failed}</span>
              </div>
              <div className="emp-stat-num order-2 text-xl sm:text-2xl font-bold text-rose-500 leading-none">{todayStats.failure}</div>
            </div>

            {/* Pending */}
            <div className="relative flex flex-col items-center text-center rounded-xl px-1.5 py-2.5 sm:block sm:text-left sm:p-3.5 bg-gradient-to-br from-amber-50 via-white to-orange-50/50 border border-amber-100/80 ring-1 ring-amber-50 group hover:border-amber-200 hover:shadow-md hover:shadow-amber-100/50 transition-all duration-200">
              <div className="contents sm:flex sm:flex-wrap sm:items-center sm:gap-x-1.5 sm:gap-y-1 sm:mb-2">
                <div className="order-1 mb-1.5 shrink-0 sm:mb-0 w-5 h-5 sm:w-6 sm:h-6 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-sm shadow-amber-200">
                  <Clock className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-white" />
                </div>
                <span className="order-3 mt-1 min-h-[2.5em] sm:mt-0 sm:min-h-0 min-w-0 max-w-full emp-stat-label text-[11px] font-semibold text-amber-600/70 uppercase tracking-wide leading-tight break-words hyphens-auto">{t.orderList.pending}</span>
              </div>
              <div className="emp-stat-num order-2 text-xl sm:text-2xl font-bold text-amber-600 leading-none">{todayStats.processing}</div>
            </div>

            {/* Rate */}
            <div className="relative flex flex-col items-center text-center rounded-xl px-1.5 py-2.5 sm:block sm:text-left sm:p-3.5 bg-gradient-to-br from-cyan-50 via-white to-sky-50/50 border border-cyan-100/80 ring-1 ring-cyan-50 group hover:border-cyan-200 hover:shadow-md hover:shadow-cyan-100/50 transition-all duration-200">
              <div className="contents sm:flex sm:flex-wrap sm:items-center sm:gap-x-1.5 sm:gap-y-1 sm:mb-2">
                <div className="order-1 mb-1.5 shrink-0 sm:mb-0 w-5 h-5 sm:w-6 sm:h-6 rounded-lg bg-gradient-to-br from-cyan-500 to-sky-600 flex items-center justify-center shadow-sm shadow-cyan-200">
                  <Percent className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-white" />
                </div>
                <span className="order-3 mt-1 min-h-[2.5em] sm:mt-0 sm:min-h-0 min-w-0 max-w-full emp-stat-label text-[11px] font-semibold text-cyan-600/70 uppercase tracking-wide leading-tight break-words hyphens-auto">{t.orderList.rate}</span>
              </div>
              <div className="emp-stat-num order-2 text-xl sm:text-2xl font-bold text-cyan-600 leading-none">
                {(todayStats.success + todayStats.failure) > 0 ? `${((todayStats.success / (todayStats.success + todayStats.failure)) * 100).toFixed(0)}%` : '0%'}
              </div>
            </div>

            {/* Earned */}
            <div className="relative flex flex-col items-center text-center rounded-xl px-1.5 py-2.5 sm:block sm:text-left sm:p-3.5 bg-gradient-to-br from-teal-50 via-white to-emerald-50/50 border border-teal-100/80 ring-1 ring-teal-50 group hover:border-teal-200 hover:shadow-md hover:shadow-teal-100/50 transition-all duration-200">
              <div className="contents sm:flex sm:flex-wrap sm:items-center sm:gap-x-1.5 sm:gap-y-1 sm:mb-2">
                <div className="order-1 mb-1.5 shrink-0 sm:mb-0 w-5 h-5 sm:w-6 sm:h-6 rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shadow-sm shadow-teal-200">
                  <DollarSign className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-white" />
                </div>
                <span className="order-3 mt-1 min-h-[2.5em] sm:mt-0 sm:min-h-0 min-w-0 max-w-full emp-stat-label text-[11px] font-semibold text-teal-600/70 uppercase tracking-wide leading-tight break-words hyphens-auto">{t.orderList.earned}</span>
              </div>
              <div className="order-2 flex max-w-full items-baseline justify-center gap-0.5 min-w-0 sm:justify-start">
                <span className="text-sm sm:text-base font-bold text-teal-600">$</span>
                <span
                  className="font-bold text-teal-600 leading-none truncate"
                  style={{
                    fontSize: `clamp(0.875rem, ${Math.max(1, 1.5 - (todayStats.totalCommission.toFixed(2).length * 0.05))}rem, 1.5rem)`
                  }}
                  title={`$${todayStats.totalCommission.toFixed(2)}`}
                >
                  {todayStats.totalCommission.toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          {/* Order List */}
          {todayOrders.length === 0 && todayTips.length === 0 ? (
            <div className="text-center py-12 sm:py-16">
              <div className="w-14 h-14 sm:w-16 sm:h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-blue-50 to-sky-50 border border-blue-100 flex items-center justify-center">
                <Package className="w-6 h-6 sm:w-7 sm:h-7 text-blue-300" />
              </div>
              <p className="text-sm sm:text-base font-medium text-gray-500 mb-1">{t.orderList.noOrdersToday}</p>
              <p className="text-xs sm:text-sm text-gray-400">{t.orderList.startSubmitting}</p>
            </div>
          ) : (
            <div
              className="space-y-2.5 lg:h-[870px] lg:overflow-y-auto order-scrollbar lg:pr-1"
              style={{ WebkitOverflowScrolling: 'touch' }}
            >
              {/* Mobile/Tablet: paginated items */}
              <div className="lg:hidden space-y-2.5">
                {paginatedItems.map((item) => {
                  if (item.type === 'tip') {
                    const tip = item.data as TipRecord;
                    return (
                      <div
                        key={tip.id}
                        className="relative rounded-xl overflow-hidden border-2 border-amber-300/80 ring-1 ring-amber-200/50 bg-gradient-to-r from-amber-50 via-yellow-50/80 to-orange-50/60 transition-all duration-200"
                      >
                        <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-amber-400 via-yellow-400 to-orange-400"></div>
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-amber-100/30 to-transparent opacity-50"></div>
                        <div className="relative pl-5 pr-3 sm:pr-4 py-3 sm:py-3.5">
                          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 mb-2">
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-md shadow-amber-300/40">
                                <Gift className="w-4 h-4 sm:w-4.5 sm:h-4.5 text-white" />
                              </div>
                              <div>
                                <div className="text-xs sm:text-sm font-bold text-amber-800">{t.orderList.customerTip}</div>
                              </div>
                            </div>
                            <div className="ml-auto flex items-center gap-2">
                              {/* Phones show the badge icon only: the word repeats the title and pushed longer languages onto a second row */}
                              <div className="flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-full bg-gradient-to-r from-amber-100 to-orange-100 border border-amber-300/60 text-[11px] font-bold text-amber-700 uppercase tracking-wider" title={t.orderList.tipBadge}>
                                <Gift className="w-3 h-3" />
                                <span className="hidden sm:inline">{t.orderList.tipBadge}</span>
                              </div>
                              <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-[11px] text-amber-600 font-medium">
                                <Clock className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                                {new Date(tip.created_at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center justify-between pl-10 sm:pl-11">
                            <div className="flex items-center gap-1.5">
                              <span className="emp-stat-label text-[11px] font-semibold text-amber-500 uppercase">{t.orderList.amount}</span>
                              <span className="text-base sm:text-lg font-black text-amber-600">+${tip.amount.toFixed(2)}</span>
                            </div>
                            <div className="w-2.5 h-2.5 rounded-full bg-gradient-to-br from-amber-400 to-orange-400 shadow-sm shadow-amber-300"></div>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  const order = item.data as OrderWithProduct;
                  const statusConfig = order.status === 'success'
                    ? { gradient: 'from-emerald-50 via-white to-teal-50/30', border: 'border-emerald-200/80', ring: 'ring-emerald-50', accent: 'bg-gradient-to-b from-emerald-400 to-teal-500', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', iconBg: 'from-emerald-500 to-teal-600', hoverShadow: '0 4px 12px rgba(16,185,129,0.1)' }
                    : order.status === 'failure'
                    ? { gradient: 'from-rose-50 via-white to-red-50/30', border: 'border-rose-200/80', ring: 'ring-rose-50', accent: 'bg-gradient-to-b from-rose-400 to-red-500', badge: 'bg-rose-50 text-rose-700 border-rose-200', iconBg: 'from-rose-500 to-red-600', hoverShadow: '0 4px 12px rgba(244,63,94,0.1)' }
                    : { gradient: 'from-amber-50 via-white to-orange-50/30', border: 'border-amber-200/80', ring: 'ring-amber-50', accent: 'bg-gradient-to-b from-amber-400 to-orange-500', badge: 'bg-amber-50 text-amber-700 border-amber-200', iconBg: 'from-amber-500 to-orange-600', hoverShadow: '0 4px 12px rgba(245,158,11,0.1)' };
                  return (
                    <div
                      key={order.id}
                      className={`relative rounded-xl overflow-hidden border ${statusConfig.border} ring-1 ${statusConfig.ring} bg-gradient-to-r ${statusConfig.gradient} transition-all duration-200`}
                      style={{ willChange: 'auto' }}
                    >
                      <div className={`absolute left-0 top-0 bottom-0 w-1 ${statusConfig.accent}`}></div>
                      <div className="pl-4 pr-3 sm:pr-4 py-3 sm:py-3.5">
                        <div className="flex flex-nowrap items-start justify-between gap-x-2 mb-2.5">
                          <div className="flex items-start gap-2.5 flex-1 min-w-0">
                            <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-gradient-to-br ${statusConfig.iconBg} flex items-center justify-center shadow-sm flex-shrink-0`}>
                              {order.status === 'success' ? <CheckCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" /> : order.status === 'failure' ? <XCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" /> : <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" />}
                            </div>
                            <div className="min-w-0">
                              <div className="font-mono text-xs text-blue-700 font-semibold truncate">{order.order_number}</div>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[11px] sm:text-xs text-gray-500 font-medium truncate">{order.product_name}</span>
                              </div>
                            </div>
                          </div>
                          <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                            <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold flex-shrink-0 whitespace-nowrap border ${statusConfig.badge}`}>
                              {order.status === 'success' ? <><span className="hidden sm:inline">{t.orderList.statusSuccess}</span><span className="sm:hidden">{t.orderList.statusOk}</span></> : order.status === 'failure' ? <><span className="hidden sm:inline">{t.orderList.statusFailed}</span><span className="sm:hidden">X</span></> : <><span className="hidden sm:inline">{t.orderList.statusPending}</span><span className="sm:hidden">...</span></>}
                            </div>
                            <div className="flex shrink-0 items-center gap-1 whitespace-nowrap px-2 py-0.5 rounded-full bg-slate-50 border border-slate-200 text-[11px] text-slate-500 font-medium">
                              <Clock className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                              {new Date(order.created_at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-2 xs:pl-9 sm:pl-10">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-4">
                            <div className="flex items-center gap-1.5">
                              <span className="emp-stat-label text-[11px] font-semibold text-gray-400 uppercase">{t.orderList.value}</span>
                              <span className="text-xs sm:text-sm font-bold text-gray-700">${order.product_value.toFixed(2)}</span>
                            </div>
                            <div className="hidden xs:block w-px h-3 bg-gray-200"></div>
                            <div className="flex items-center gap-1.5">
                              <span className={`emp-stat-label text-[11px] font-semibold uppercase ${order.status === 'failure' ? 'text-rose-400' : order.status === 'processing' ? 'text-amber-400' : 'text-emerald-500'}`}>{t.orderList.commission}</span>
                              <span className={`text-xs sm:text-sm font-bold ${order.status === 'failure' ? 'text-rose-500' : order.status === 'processing' ? 'text-amber-500' : 'text-emerald-600'}`}>
                                {order.commission_amount ? `$${order.commission_amount.toFixed(2)}` : '-'}
                              </span>
                            </div>
                          </div>
                          <div className={`w-2 h-2 rounded-full ${order.status === 'success' ? 'bg-emerald-400' : order.status === 'failure' ? 'bg-rose-400' : 'bg-amber-400 animate-pulse'}`}></div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Desktop: paginated list */}
              <div className="hidden lg:block space-y-2.5">
              {/* Tip cards - shown at top with distinct styling */}
              {paginatedItems.filter(i => i.type === 'tip').map((item) => {
                const tip = item.data as TipRecord;
                return (
                <div
                  key={tip.id}
                  className="relative rounded-xl overflow-hidden border-2 border-amber-300/80 ring-1 ring-amber-200/50 bg-gradient-to-r from-amber-50 via-yellow-50/80 to-orange-50/60 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-amber-200/40"
                >
                  {/* Left accent bar - gold gradient */}
                  <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-amber-400 via-yellow-400 to-orange-400"></div>

                  {/* Shimmer overlay */}
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-amber-100/30 to-transparent opacity-50"></div>

                  <div className="relative pl-5 pr-3 sm:pr-4 py-3 sm:py-3.5">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-md shadow-amber-300/40">
                          <Gift className="w-4 h-4 sm:w-4.5 sm:h-4.5 text-white" />
                        </div>
                        <div>
                          <div className="text-xs sm:text-sm font-bold text-amber-800">{t.orderList.customerTip}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-gradient-to-r from-amber-100 to-orange-100 border border-amber-300/60 text-[11px] font-bold text-amber-700 uppercase tracking-wider">
                          <Gift className="w-3 h-3" />
                          {t.orderList.tipBadge}
                        </div>
                        <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-[11px] text-amber-600 font-medium">
                          <Clock className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                          {new Date(tip.created_at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pl-10 sm:pl-11">
                      <div className="flex items-center gap-1.5">
                        <span className="emp-stat-label text-[11px] font-semibold text-amber-500 uppercase">{t.orderList.amount}</span>
                        <span className="text-base sm:text-lg font-black text-amber-600">+${tip.amount.toFixed(2)}</span>
                      </div>
                      <div className="w-2.5 h-2.5 rounded-full bg-gradient-to-br from-amber-400 to-orange-400 shadow-sm shadow-amber-300"></div>
                    </div>
                  </div>
                </div>
                );
              })}

              {paginatedItems.filter(i => i.type === 'order').map((item) => {
                const order = item.data as OrderWithProduct;
                const statusConfig = order.status === 'success'
                  ? { gradient: 'from-emerald-50 via-white to-teal-50/30', border: 'border-emerald-200/80', ring: 'ring-emerald-50', accent: 'bg-gradient-to-b from-emerald-400 to-teal-500', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', iconBg: 'from-emerald-500 to-teal-600', hoverShadow: '0 4px 12px rgba(16,185,129,0.1)' }
                  : order.status === 'failure'
                  ? { gradient: 'from-rose-50 via-white to-red-50/30', border: 'border-rose-200/80', ring: 'ring-rose-50', accent: 'bg-gradient-to-b from-rose-400 to-red-500', badge: 'bg-rose-50 text-rose-700 border-rose-200', iconBg: 'from-rose-500 to-red-600', hoverShadow: '0 4px 12px rgba(244,63,94,0.1)' }
                  : { gradient: 'from-amber-50 via-white to-orange-50/30', border: 'border-amber-200/80', ring: 'ring-amber-50', accent: 'bg-gradient-to-b from-amber-400 to-orange-500', badge: 'bg-amber-50 text-amber-700 border-amber-200', iconBg: 'from-amber-500 to-orange-600', hoverShadow: '0 4px 12px rgba(245,158,11,0.1)' };

                return (
                  <div
                    key={order.id}
                    className={`relative rounded-xl overflow-hidden border ${statusConfig.border} ring-1 ${statusConfig.ring} bg-gradient-to-r ${statusConfig.gradient} transition-all duration-200 ${!isMobile ? 'hover:-translate-y-0.5' : ''}`}
                    style={{ willChange: 'auto', boxShadow: !isMobile ? undefined : 'none' }}
                    onMouseEnter={(e) => { if (!isMobile) e.currentTarget.style.boxShadow = statusConfig.hoverShadow; }}
                    onMouseLeave={(e) => { if (!isMobile) e.currentTarget.style.boxShadow = 'none'; }}
                  >
                    {/* Left accent bar */}
                    <div className={`absolute left-0 top-0 bottom-0 w-1 ${statusConfig.accent}`}></div>

                    <div className="pl-4 pr-3 sm:pr-4 py-3 sm:py-3.5">
                      {/* Top row: icon, order number, status badge, time */}
                      <div className="flex items-center justify-between mb-2.5">
                        <div className="flex items-center gap-2.5 flex-1 min-w-0">
                          <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-gradient-to-br ${statusConfig.iconBg} flex items-center justify-center shadow-sm flex-shrink-0`}>
                            {order.status === 'success' ? (
                              <CheckCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" />
                            ) : order.status === 'failure' ? (
                              <XCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" />
                            ) : (
                              <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="font-mono text-xs text-blue-700 font-semibold truncate">{order.order_number}</div>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className="text-[11px] sm:text-xs text-gray-500 font-medium truncate">{order.product_name}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold flex-shrink-0 border ${statusConfig.badge}`}>
                            {order.status === 'success' ? (
                              <>
                                <span className="hidden sm:inline">{t.orderList.statusSuccess}</span>
                                <span className="sm:hidden">{t.orderList.statusOk}</span>
                              </>
                            ) : order.status === 'failure' ? (
                              <>
                                <span className="hidden sm:inline">{t.orderList.statusFailed}</span>
                                <span className="sm:hidden">X</span>
                              </>
                            ) : (
                              <>
                                <span className="hidden sm:inline">{t.orderList.statusPending}</span>
                                <span className="sm:hidden">...</span>
                              </>
                            )}
                          </div>
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-50 border border-slate-200 text-[11px] text-slate-500 font-medium">
                            <Clock className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                            {new Date(order.created_at).toLocaleString([], {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false
                            })}
                          </div>
                        </div>
                      </div>

                      {/* Bottom row: value and commission */}
                      <div className="flex items-center justify-between pl-9 sm:pl-10">
                        <div className="flex items-center gap-3 sm:gap-4">
                          <div className="flex items-center gap-1.5">
                            <span className="emp-stat-label text-[11px] font-semibold text-gray-400 uppercase">{t.orderList.value}</span>
                            <span className="text-xs sm:text-sm font-bold text-gray-700">${order.product_value.toFixed(2)}</span>
                          </div>
                          <div className="w-px h-3 bg-gray-200"></div>
                          <div className="flex items-center gap-1.5">
                            <span className={`emp-stat-label text-[11px] font-semibold uppercase ${
                              order.status === 'failure' ? 'text-rose-400' : order.status === 'processing' ? 'text-amber-400' : 'text-emerald-500'
                            }`}>{t.orderList.commission}</span>
                            <span className={`text-xs sm:text-sm font-bold ${
                              order.status === 'failure' ? 'text-rose-500' : order.status === 'processing' ? 'text-amber-500' : 'text-emerald-600'
                            }`}>
                              {order.commission_amount ? `$${order.commission_amount.toFixed(2)}` : '-'}
                            </span>
                          </div>
                        </div>
                        <div className={`w-2 h-2 rounded-full ${
                          order.status === 'success' ? 'bg-emerald-400' : order.status === 'failure' ? 'bg-rose-400' : 'bg-amber-400 animate-pulse'
                        }`}></div>
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
