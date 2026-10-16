import { useState, useEffect, useRef } from 'react';
import { TrendingUp, Calendar, CalendarDays, CheckCircle, XCircle, DollarSign, ListChecks, BarChart3, Gift, ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useLanguage } from '../../lib/i18n/context';
import PageLoader from './PageLoader';
import PanelColorBlocks from './PanelColorBlocks';
import PanelEmptyIcon from './PanelEmptyIcon';

interface DailyStatisticsProps {
  employeeId: string;
}

interface DailyStats {
  date: string;
  dateKey: string;
  total_orders: number;
  success_count: number;
  failure_count: number;
  daily_commission: number;
  daily_tips: number;
  daily_earnings: number;
}

interface OverallStats {
  total_revenue: number;
  total_commission: number;
  total_tips: number;
  total_orders: number;
  total_success: number;
  total_failed: number;
}

export default function DailyStatistics({ employeeId }: DailyStatisticsProps) {
  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [overallStats, setOverallStats] = useState<OverallStats>({
    total_revenue: 0,
    total_commission: 0,
    total_tips: 0,
    total_orders: 0,
    total_success: 0,
    total_failed: 0,
  });
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);
  const ITEMS_PER_PAGE = 8;
  // Employee statistics always show US dollars, independent of the admin currency setting.
  const currencyUnit = '$';
  const { t, dateLocale } = useLanguage();
  const formatDay = (dateKey: string) =>
    new Date(`${dateKey}T00:00:00Z`).toLocaleDateString(dateLocale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const loadStatisticsRef = useRef<(() => Promise<void>) | null>(null);

  // Pagination for mobile/tablet
  const totalPages = Math.ceil(dailyStats.length / ITEMS_PER_PAGE);
  const paginatedStats = dailyStats.slice(
    currentPage * ITEMS_PER_PAGE,
    (currentPage + 1) * ITEMS_PER_PAGE
  );
  const canGoPrev = currentPage > 0;
  const canGoNext = currentPage < totalPages - 1;


  useEffect(() => {
    void loadStatisticsRef.current?.();
    const interval = setInterval(() => { void loadStatisticsRef.current?.(); }, 10000);
    return () => clearInterval(interval);
  }, [employeeId]);

  const loadStatistics = async () => {
    try {
      const [dailyResult, overallResult, tipsResult, dailyTipsResult] = await Promise.all([
        supabase.rpc('get_daily_order_stats', { p_user_id: employeeId }),
        supabase.rpc('get_overall_order_stats', { p_user_id: employeeId }),
        supabase
          .from('wallet_transactions')
          .select('amount')
          .eq('user_id', employeeId)
          .in('type', ['tip', 'performance_bonus']),
        supabase
          .from('wallet_transactions')
          .select('amount, created_at')
          .eq('user_id', employeeId)
          .in('type', ['tip', 'performance_bonus']),
      ]);

      if (dailyResult.error) throw dailyResult.error;
      if (overallResult.error) throw overallResult.error;

      const totalTips = (tipsResult.data || []).reduce(
        (sum: number, row: { amount: number }) => sum + Number(row.amount),
        0
      );

      // Group daily tips by date
      const dailyTipsMap: Record<string, number> = {};
      (dailyTipsResult.data || []).forEach((row: { amount: number; created_at: string }) => {
        const d = new Date(row.created_at);
        const dateKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        dailyTipsMap[dateKey] = (dailyTipsMap[dateKey] || 0) + Number(row.amount);
      });

      const formattedDaily: DailyStats[] = (dailyResult.data || []).map((row: {
        day_date: string;
        total_orders: number;
        success_count: number;
        failure_count: number;
        daily_earnings: number;
      }) => {
        const d = new Date(row.day_date + 'T00:00:00Z');
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        const year = d.getUTCFullYear();
        const dateKey = `${year}-${month}-${day}`;
        const commission = Number(row.daily_earnings);
        const tips = dailyTipsMap[dateKey] || 0;
        return {
          date: dateKey,
          dateKey,
          total_orders: Number(row.total_orders),
          success_count: Number(row.success_count),
          failure_count: Number(row.failure_count),
          daily_commission: commission,
          daily_tips: tips,
          daily_earnings: commission + tips,
        };
      });

      const orderDateKeys = new Set(formattedDaily.map(s => s.dateKey));
      Object.entries(dailyTipsMap).forEach(([dateKey, tips]) => {
        if (!orderDateKeys.has(dateKey)) {
          formattedDaily.push({
            date: dateKey,
            dateKey,
            total_orders: 0,
            success_count: 0,
            failure_count: 0,
            daily_commission: 0,
            daily_tips: tips,
            daily_earnings: tips,
          });
        }
      });

      formattedDaily.sort((a, b) => b.dateKey.localeCompare(a.dateKey));

      setDailyStats(formattedDaily);

      const overall = overallResult.data?.[0];
      if (overall) {
        const commission = Number(overall.total_revenue);
        setOverallStats({
          total_commission: commission,
          total_tips: totalTips,
          total_revenue: commission + totalTips,
          total_orders: Number(overall.total_orders),
          total_success: Number(overall.total_success),
          total_failed: Number(overall.total_failed),
        });
      } else {
        setOverallStats(prev => ({
          ...prev,
          total_tips: totalTips,
          total_revenue: totalTips,
        }));
      }
    } catch (error) {
      console.error('Error loading statistics:', error);
    } finally {
      setLoading(false);
    }
  };
  loadStatisticsRef.current = loadStatistics;

  if (loading) {
    return (
      <PageLoader label={t.statistics.loading} />
    );
  }

  return (
    <>
      <style>{`
        .employee-daily-statistics .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }

        @media (max-width: 1023px) {
          .employee-daily-statistics * {
            animation-duration: 0s !important;
            transition-duration: 0.15s !important;
          }

          .employee-daily-statistics .animate-pulse,
          .employee-daily-statistics .animate-spin,
          .employee-daily-statistics .animate-ping {
            animation: none !important;
          }
        }
      `}</style>
      <div className="employee-daily-statistics space-y-4">
        {/* Overall Statistics Summary */}
        <div className="relative bg-white rounded-xl lg:rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <span className="dispatch-waiting-accent pointer-events-none absolute inset-x-0 top-0 z-[2] h-1.5 bg-gradient-to-r from-blue-600 via-sky-400 to-blue-500 shadow-[0_3px_10px_rgba(37,99,235,0.3)]" aria-hidden="true" />
          <div className="p-3 sm:p-4 lg:p-6">
            {/* Header */}
            <div className="flex items-center gap-2 lg:gap-2.5 mb-3 sm:mb-4">
              <BarChart3 className="w-5 h-5 lg:w-5.5 lg:h-5.5 text-blue-600" />
              <h2 className="text-base lg:text-lg font-bold text-blue-600">{t.statistics.overview}</h2>
            </div>
            <div className="grid gap-2.5 sm:gap-3 lg:gap-4 grid-cols-2 min-[640px]:grid-cols-3">
              {/* Total Revenue Card (Commission + Tips) */}
              <div className="emp-stat-card rounded-xl p-3 sm:p-4 bg-gradient-to-b from-amber-50 to-white border border-amber-200 hover:border-amber-300 hover:shadow-sm transition-all duration-200 group">
                <div className="flex items-center gap-1.5 sm:gap-2 mb-2.5 sm:mb-3">
                  <div className="emp-stat-icon w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-amber-100 flex items-center justify-center group-hover:bg-amber-200 transition-colors">
                    <DollarSign className="w-4 h-4 text-amber-600" />
                  </div>
                  <span className="emp-stat-label text-[11px] sm:text-xs font-semibold text-amber-600/70 uppercase tracking-wider">{t.statistics.revenue}</span>
                </div>
                <div className="emp-stat-value flex min-w-0 items-baseline gap-0.5" style={{
                  fontSize: `clamp(1rem, ${Math.max(1, 1.5 - (overallStats.total_revenue.toFixed(2).length * 0.04))}rem, 1.5rem)`
                }}>
                  <span className="shrink-0 text-[1.15em] font-bold leading-none text-amber-600">{currencyUnit}</span>
                  <span
                    className="font-bold text-amber-700 leading-none truncate"
                    title={`${currencyUnit}${overallStats.total_revenue.toFixed(2)}`}
                  >
                    {overallStats.total_revenue.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Commission Card */}
              <div className="emp-stat-card rounded-xl p-3 sm:p-4 bg-gradient-to-b from-indigo-50 to-white border border-indigo-200 hover:border-indigo-300 hover:shadow-sm transition-all duration-200 group">
                <div className="flex items-center gap-1.5 sm:gap-2 mb-2.5 sm:mb-3">
                  <div className="emp-stat-icon w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-indigo-100 flex items-center justify-center group-hover:bg-indigo-200 transition-colors">
                    <TrendingUp className="w-4 h-4 text-indigo-600" />
                  </div>
                  <span className="emp-stat-label text-[11px] sm:text-xs font-semibold text-indigo-600/70 uppercase tracking-wider">{t.statistics.commission}</span>
                </div>
                <div className="emp-stat-value flex min-w-0 items-baseline gap-0.5" style={{
                  fontSize: `clamp(1rem, ${Math.max(1, 1.5 - (overallStats.total_commission.toFixed(2).length * 0.04))}rem, 1.5rem)`
                }}>
                  <span className="shrink-0 text-[1.15em] font-bold leading-none text-indigo-600">{currencyUnit}</span>
                  <span
                    className="font-bold text-indigo-700 leading-none truncate"
                    title={`${currencyUnit}${overallStats.total_commission.toFixed(2)}`}
                  >
                    {overallStats.total_commission.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Tips Card */}
              <div className="emp-stat-card rounded-xl p-3 sm:p-4 bg-gradient-to-b from-pink-50 to-white border border-pink-200 hover:border-pink-300 hover:shadow-sm transition-all duration-200 group">
                <div className="flex items-center gap-1.5 sm:gap-2 mb-2.5 sm:mb-3">
                  <div className="emp-stat-icon w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-pink-100 flex items-center justify-center group-hover:bg-pink-200 transition-colors">
                    <Gift className="w-4 h-4 text-pink-600" />
                  </div>
                  <span className="emp-stat-label text-[11px] sm:text-xs font-semibold text-pink-600/70 uppercase tracking-wider">{t.statistics.tips}</span>
                </div>
                <div className="emp-stat-value flex min-w-0 items-baseline gap-0.5" style={{
                  fontSize: `clamp(1rem, ${Math.max(1, 1.5 - (overallStats.total_tips.toFixed(2).length * 0.04))}rem, 1.5rem)`
                }}>
                  <span className="shrink-0 text-[1.15em] font-bold leading-none text-pink-600">{currencyUnit}</span>
                  <span
                    className="font-bold text-pink-700 leading-none truncate"
                    title={`${currencyUnit}${overallStats.total_tips.toFixed(2)}`}
                  >
                    {overallStats.total_tips.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Orders Card */}
              <div className="emp-stat-card rounded-xl p-3 sm:p-4 bg-gradient-to-b from-blue-50 to-white border border-blue-200 hover:border-blue-300 hover:shadow-sm transition-all duration-200 group">
                <div className="flex items-center gap-1.5 sm:gap-2 mb-2.5 sm:mb-3">
                  <div className="emp-stat-icon w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-blue-100 flex items-center justify-center group-hover:bg-blue-200 transition-colors">
                    <ListChecks className="w-4 h-4 text-blue-600" />
                  </div>
                  <span className="emp-stat-label text-[11px] sm:text-xs font-semibold text-blue-600/70 uppercase tracking-wider">{t.statistics.orders}</span>
                </div>
                <div className="emp-stat-value text-xl sm:text-2xl font-bold text-blue-700 leading-none">
                  {overallStats.total_orders}
                </div>
              </div>

              {/* Success Card */}
              <div className="emp-stat-card rounded-xl p-3 sm:p-4 bg-gradient-to-b from-emerald-50 to-white border border-emerald-200 hover:border-emerald-300 hover:shadow-sm transition-all duration-200 group">
                <div className="flex items-center gap-1.5 sm:gap-2 mb-2.5 sm:mb-3">
                  <div className="emp-stat-icon w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-emerald-100 flex items-center justify-center group-hover:bg-emerald-200 transition-colors">
                    <CheckCircle className="w-4 h-4 text-emerald-600" />
                  </div>
                  <span className="emp-stat-label text-[11px] sm:text-xs font-semibold text-emerald-600/70 uppercase tracking-wider">{t.statistics.success}</span>
                </div>
                <div className="emp-stat-value text-xl sm:text-2xl font-bold text-emerald-600 leading-none">
                  {overallStats.total_success}
                </div>
              </div>

              {/* Failed Card */}
              <div className="emp-stat-card rounded-xl p-3 sm:p-4 bg-gradient-to-b from-red-50 to-white border border-red-200 hover:border-red-300 hover:shadow-sm transition-all duration-200 group">
                <div className="flex items-center gap-1.5 sm:gap-2 mb-2.5 sm:mb-3">
                  <div className="emp-stat-icon w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-red-100 flex items-center justify-center group-hover:bg-red-200 transition-colors">
                    <XCircle className="w-4 h-4 text-red-500" />
                  </div>
                  <span className="emp-stat-label text-[11px] sm:text-xs font-semibold text-red-500/70 uppercase tracking-wider">{t.statistics.failed}</span>
                </div>
                <div className="emp-stat-value text-xl sm:text-2xl font-bold text-red-500 leading-none">
                  {overallStats.total_failed}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Daily Breakdown List */}
        <div className="bg-white rounded-xl lg:rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="relative bg-gradient-to-r from-blue-600 to-blue-500 overflow-hidden">
            <div className="absolute top-0 right-0 w-20 sm:w-32 h-20 sm:h-32 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2"></div>
            <div className="absolute bottom-0 left-1/4 w-16 sm:w-24 h-16 sm:h-24 bg-white/5 rounded-full translate-y-1/2"></div>
            <div className="absolute top-1/2 right-1/3 w-8 h-8 bg-sky-300/10 rounded-full -translate-y-1/2 blur-sm"></div>
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
            <div className="relative px-[14px] py-[10px] md:px-5 md:py-[14px] lg:px-6 lg:py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-[10px] lg:gap-3">
                  <div className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[10px] border border-white/25 bg-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] backdrop-blur-sm md:h-10 md:w-10 md:rounded-xl">
                    <Calendar className="h-[17px] w-[17px] text-white md:h-5 md:w-5" />
                  </div>
                  <h2 className="truncate text-[15px] font-bold leading-[22px] text-white md:text-lg lg:text-xl">{t.statistics.dailyBreakdown}</h2>
                  {dailyStats.length > 0 && (
                    <span className="flex h-5 flex-shrink-0 items-center rounded-full border border-white/25 bg-white/15 px-2 text-[11px] font-semibold leading-none text-blue-50 tabular-nums lg:text-xs">
                      {dailyStats.length} {dailyStats.length === 1 ? t.statistics.day : t.statistics.days}
                    </span>
                  )}
                </div>
                {/* Desktop: show day count on right */}
                {dailyStats.length > 0 && dailyStats.length <= ITEMS_PER_PAGE && (
                  <div className="hidden md:block text-sm text-blue-100 font-medium">
                    {dailyStats.length} {dailyStats.length === 1 ? t.statistics.day : t.statistics.days}
                  </div>
                )}
              </div>
            </div>
            {/* Pagination sub-bar - mobile/tablet only */}
            {dailyStats.length > ITEMS_PER_PAGE && (
              <div className="md:hidden relative flex items-center justify-between gap-3 border-t border-white/15 bg-blue-900/20 px-[14px] py-[6px]">
                <button
                  type="button"
                  onClick={() => setCurrentPage(p => p - 1)}
                  disabled={!canGoPrev}
                  aria-label="Previous page"
                  className="flex !h-8 !min-h-0 !w-8 !min-w-0 flex-shrink-0 items-center justify-center rounded-full border border-white/30 bg-white/15 !p-0 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition-all active:scale-95 active:bg-white/25 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-white/35 disabled:shadow-none"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <ChevronLeft className="h-[18px] w-[18px] -translate-x-px" strokeWidth={2.5} />
                </button>
                <div className="flex min-w-0 items-center gap-2" aria-live="polite">
                  {totalPages <= 7 && (
                    <div className="flex items-center gap-1" aria-hidden="true">
                      {Array.from({ length: totalPages }, (_, i) => (
                        <span key={i} className={`h-1.5 rounded-full transition-all duration-200 ${i === currentPage ? 'w-4 bg-white' : 'w-1.5 bg-white/35'}`} />
                      ))}
                    </div>
                  )}
                  <span className="rounded-full bg-white/15 px-2.5 py-[3px] text-xs font-bold leading-4 text-white tabular-nums">
                    {currentPage + 1} / {totalPages}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setCurrentPage(p => p + 1)}
                  disabled={!canGoNext}
                  aria-label="Next page"
                  className="flex !h-8 !min-h-0 !w-8 !min-w-0 flex-shrink-0 items-center justify-center rounded-full border border-white/30 bg-white/15 !p-0 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition-all active:scale-95 active:bg-white/25 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-white/35 disabled:shadow-none"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <ChevronRight className="h-[18px] w-[18px] translate-x-px" strokeWidth={2.5} />
                </button>
              </div>
            )}
          </div>

          <div className="relative isolate p-4 md:p-0" style={{ background: 'linear-gradient(145deg, #ffffff 0%, #f0f7ff 25%, #e6f2fe 50%, #f5faff 75%, #ffffff 100%)' }}>
          <PanelColorBlocks className="-z-10" />
          {dailyStats.length === 0 ? (
            <div className="text-center py-12 lg:py-16">
              <PanelEmptyIcon icon={CalendarDays} badge={BarChart3} />
              <p className="text-sm font-semibold text-blue-900 lg:text-base">{t.statistics.noData}</p>
              <p className="mt-1 text-xs text-blue-800/60 lg:text-sm">{t.statistics.noDataHint}</p>
            </div>
          ) : (
            <>
              {/* Mobile View - Optimized */}
                <div className="relative md:hidden space-y-1.5">
                {paginatedStats.map((stat, index) => (
                  <div
                    key={`${stat.date}-${index}`}
                    className="relative bg-gray-50 rounded border border-gray-200 overflow-hidden shadow-sm"
                    style={{ willChange: 'auto' }}
                  >
                    <div className="relative px-3 py-2">
                      {/* First Row: Date and Order Counts */}
                      <div className="flex items-center justify-between gap-1.5 mb-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                          <span className="truncate text-xs font-bold text-gray-900">{formatDay(stat.dateKey)}</span>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-1">
                          <div className="flex items-center gap-1 px-2 py-0.5 bg-blue-500/10 rounded-full border border-blue-500/20">
                            <TrendingUp className="w-3 h-3 text-blue-400 flex-shrink-0" />
                            <span className="text-xs font-bold text-blue-700">{stat.total_orders}</span>
                          </div>
                          <div className="flex items-center gap-1 px-2 py-0.5 bg-green-500/10 rounded border border-green-500/20">
                            <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0" />
                            <span className="text-xs font-bold text-green-400">{stat.success_count}</span>
                          </div>
                          <div className="flex items-center gap-1 px-2 py-0.5 bg-red-500/10 rounded border border-red-500/20">
                            <XCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
                            <span className="text-xs font-bold text-red-400">{stat.failure_count}</span>
                          </div>
                        </div>
                      </div>

                      {/* Third Row: Commission, Tips, Earnings */}
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5">
                          {/* Commission */}
                          <div className="flex items-center gap-0.5 px-1.5 py-0.5 bg-indigo-500/10 rounded border border-indigo-500/20">
                            <TrendingUp className="w-3 h-3 text-indigo-400 flex-shrink-0" />
                            <span className="text-[11px] font-bold text-indigo-500">{currencyUnit}{stat.daily_commission.toFixed(2)}</span>
                          </div>

                          {/* Tips */}
                          <div className="flex items-center gap-0.5 px-1.5 py-0.5 bg-pink-500/10 rounded border border-pink-500/20">
                            <Gift className="w-3 h-3 text-pink-400 flex-shrink-0" />
                            <span className="text-[11px] font-bold text-pink-500">{currencyUnit}{stat.daily_tips.toFixed(2)}</span>
                          </div>
                        </div>

                        {/* Earnings */}
                        <div className="flex items-center gap-0.5 px-2.5 py-1 bg-gradient-to-r from-emerald-500/15 to-teal-500/15 rounded border border-emerald-500/30">
                          <DollarSign className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                          <span className="text-sm font-black text-emerald-400 whitespace-nowrap">
                            {stat.daily_earnings.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                </div>

              {/* Desktop View */}
                <div className="hidden md:block overflow-hidden">
                <div className="h-[500px] overflow-auto hide-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                  <table className="w-full">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-3 lg:px-4 py-2.5 align-bottom text-[11px] lg:text-xs font-bold text-gray-600 uppercase tracking-wide lg:tracking-wider leading-tight hyphens-auto break-words">
                          <div className="flex items-center gap-2">
                            <Calendar className="hidden lg:block w-3.5 h-3.5 shrink-0 text-blue-400" />
                            {t.statistics.date}
                          </div>
                        </th>
                        <th className="text-left px-2 lg:px-3 py-2.5 align-bottom text-[11px] lg:text-xs font-bold text-gray-600 uppercase tracking-wide lg:tracking-wider leading-tight hyphens-auto break-words">
                          <div className="flex items-center gap-1.5">
                            <TrendingUp className="hidden lg:block w-3.5 h-3.5 shrink-0 text-blue-400" />
                            {t.statistics.totalOrders}
                          </div>
                        </th>
                        <th className="text-left px-2 lg:px-3 py-2.5 align-bottom text-[11px] lg:text-xs font-bold text-gray-600 uppercase tracking-wide lg:tracking-wider leading-tight hyphens-auto break-words">
                          <div className="flex items-center gap-1.5">
                            <CheckCircle className="hidden lg:block w-3.5 h-3.5 shrink-0 text-green-400" />
                            {t.statistics.successOrders}
                          </div>
                        </th>
                        <th className="text-left px-2 lg:px-3 py-2.5 align-bottom text-[11px] lg:text-xs font-bold text-gray-600 uppercase tracking-wide lg:tracking-wider leading-tight hyphens-auto break-words">
                          <div className="flex items-center gap-1.5">
                            <XCircle className="hidden lg:block w-3.5 h-3.5 shrink-0 text-red-400" />
                            {t.statistics.failedOrders}
                          </div>
                        </th>
                        <th className="text-left px-2 lg:px-3 py-2.5 align-bottom text-[11px] lg:text-xs font-bold text-gray-600 uppercase tracking-wide lg:tracking-wider leading-tight hyphens-auto break-words">
                          <div className="flex items-center gap-1.5">
                            <TrendingUp className="hidden lg:block w-3.5 h-3.5 shrink-0 text-indigo-400" />
                            {t.statistics.commission}
                          </div>
                        </th>
                        <th className="text-left px-2 lg:px-3 py-2.5 align-bottom text-[11px] lg:text-xs font-bold text-gray-600 uppercase tracking-wide lg:tracking-wider leading-tight hyphens-auto break-words">
                          <div className="flex items-center gap-1.5">
                            <Gift className="hidden lg:block w-3.5 h-3.5 shrink-0 text-pink-400" />
                            {t.statistics.tips}
                          </div>
                        </th>
                        <th className="text-left px-3 lg:px-4 py-2.5 align-bottom text-[11px] lg:text-xs font-bold text-gray-600 uppercase tracking-wide lg:tracking-wider leading-tight hyphens-auto break-words">
                          <div className="flex items-center gap-1.5">
                            <DollarSign className="hidden lg:block w-3.5 h-3.5 shrink-0 text-emerald-400" />
                            {t.statistics.earned}
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {dailyStats.map((stat, index) => (
                        <tr
                          key={`${stat.date}-${index}`}
                          className="group border-b border-gray-200 transition-colors duration-150 hover:bg-blue-100/80"
                        >
                          <td className="px-3 lg:px-4 py-2.5 whitespace-nowrap shadow-[inset_3px_0_0_transparent] transition-shadow duration-150 group-hover:shadow-[inset_3px_0_0_#2563eb]">
                            <div className="flex items-center gap-2">
                              <div className="w-1 h-1 rounded-full bg-blue-400 transition-transform duration-150 group-hover:scale-[2] group-hover:bg-blue-600"></div>
                              <span className="text-[13px] lg:text-sm text-gray-700 font-medium transition-colors group-hover:text-[#12356d]">{formatDay(stat.dateKey)}</span>
                            </div>
                          </td>
                          <td className="px-2 lg:px-3 py-2.5">
                            <span className="text-[13px] lg:text-sm font-bold text-blue-500">{stat.total_orders}</span>
                          </td>
                          <td className="px-2 lg:px-3 py-2.5">
                            <span className="text-[13px] lg:text-sm font-bold text-green-400">{stat.success_count}</span>
                          </td>
                          <td className="px-2 lg:px-3 py-2.5">
                            <span className="text-[13px] lg:text-sm font-bold text-red-400">{stat.failure_count}</span>
                          </td>
                          <td className="px-2 lg:px-3 py-2.5 whitespace-nowrap">
                            <span className="text-[13px] lg:text-sm font-bold text-indigo-500">{currencyUnit}{stat.daily_commission.toFixed(2)}</span>
                          </td>
                          <td className="px-2 lg:px-3 py-2.5 whitespace-nowrap">
                            <span className="text-[13px] lg:text-sm font-bold text-pink-500">{currencyUnit}{stat.daily_tips.toFixed(2)}</span>
                          </td>
                          <td className="px-3 lg:px-4 py-2.5 whitespace-nowrap">
                            <span className="text-[13px] lg:text-sm font-bold text-emerald-400">
                              {currencyUnit}{stat.daily_earnings.toFixed(2)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                </div>
            </>
          )}
          </div>
        </div>
      </div>
    </>
  );
}
