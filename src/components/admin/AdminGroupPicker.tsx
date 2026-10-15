import { useEffect, useMemo } from 'react';
import { Activity, ArrowUpRight, BellRing, ChevronRight, MessageCircle, RefreshCw, Shield, UserCog, Users } from 'lucide-react';

export interface AdminGroup {
  admin_id: string;
  admin_username: string;
  admin_role: string;
  employee_count: number;
  customer_count: number;
  conversation_count: number;
}

interface AdminGroupPickerProps {
  service: 'customer' | 'manager';
  groups: AdminGroup[];
  unreadCounts: Record<string, number>;
  fallbackUnreadCount?: number;
  loading: boolean;
  onSelect: (group: AdminGroup) => void;
  onPrefetch?: (group: AdminGroup) => void;
  onRefresh: () => void;
}

const serviceStyles = {
  customer: {
    Icon: MessageCircle,
    accent: 'text-orange-300',
    border: 'border-orange-500/25',
    headerIcon: 'border-orange-400/35 bg-orange-500/15 text-orange-200',
    chip: 'border-orange-400/25 bg-orange-500/10 text-orange-200',
    row: 'border-orange-500/20 bg-orange-950/20 hover:border-orange-300/80 hover:bg-orange-500/15 hover:shadow-[0_12px_35px_-18px_rgba(251,146,60,0.75)]',
    rowIcon: 'border-orange-400/25 bg-orange-500/10 text-orange-200 group-hover:border-orange-300/60 group-hover:bg-orange-400/25',
    action: 'bg-orange-500/15 text-orange-100 ring-1 ring-orange-400/25 group-hover:bg-orange-400 group-hover:text-white group-hover:ring-orange-300/70',
    metric: 'border-orange-500/15 bg-orange-950/35',
    skeleton: 'bg-orange-500/10',
    rail: 'bg-gradient-to-b from-orange-300 via-orange-500 to-amber-500',
    unreadBadge: 'border-cyan-200/65 bg-gradient-to-r from-cyan-500/30 via-sky-500/20 to-slate-950/55 text-cyan-50 shadow-[0_8px_24px_-10px_rgba(34,211,238,0.95)] ring-1 ring-cyan-300/15',
    unreadIcon: 'bg-cyan-300/20 text-cyan-100 ring-cyan-200/60',
  },
  manager: {
    Icon: Users,
    accent: 'text-emerald-300',
    border: 'border-emerald-500/25',
    headerIcon: 'border-emerald-400/35 bg-emerald-500/15 text-emerald-200',
    chip: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200',
    row: 'border-emerald-500/20 bg-emerald-950/20 hover:border-emerald-300/80 hover:bg-emerald-500/15 hover:shadow-[0_12px_35px_-18px_rgba(52,211,153,0.75)]',
    rowIcon: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200 group-hover:border-emerald-300/60 group-hover:bg-emerald-400/25',
    action: 'bg-emerald-500/15 text-emerald-100 ring-1 ring-emerald-400/25 group-hover:bg-emerald-400 group-hover:text-white group-hover:ring-emerald-300/70',
    metric: 'border-emerald-500/15 bg-emerald-950/35',
    skeleton: 'bg-emerald-500/10',
    rail: 'bg-gradient-to-b from-emerald-300 via-emerald-500 to-teal-500',
    unreadBadge: 'border-amber-200/70 bg-gradient-to-r from-amber-400/35 via-yellow-500/20 to-slate-950/55 text-amber-50 shadow-[0_8px_24px_-10px_rgba(251,191,36,0.95)] ring-1 ring-amber-300/15',
    unreadIcon: 'bg-amber-300/20 text-amber-100 ring-amber-200/65',
  },
};

const formatRole = (role: string) => {
  if (role === 'super_admin') return '超級管理員';
  if (role === 'secondary_admin') return '二級管理員';
  return role;
};

const getRoleIcon = (role: string) => role === 'super_admin' ? Shield : UserCog;

const getRoleIconStyles = (role: string) => role === 'super_admin'
  ? 'border-amber-300/45 bg-gradient-to-br from-amber-300/25 via-amber-500/15 to-yellow-700/10 text-amber-200 shadow-[0_8px_20px_-12px_rgba(251,191,36,0.95)] group-hover:border-amber-200/75 group-hover:from-amber-300/35 group-hover:text-amber-100'
  : 'border-sky-300/40 bg-gradient-to-br from-sky-300/20 via-blue-500/15 to-indigo-700/10 text-sky-200 shadow-[0_8px_20px_-12px_rgba(56,189,248,0.9)] group-hover:border-sky-200/75 group-hover:from-sky-300/30 group-hover:text-sky-100';

const getRoleChipStyles = (role: string) => role === 'super_admin'
  ? 'text-amber-200'
  : 'text-sky-200';

export default function AdminGroupPicker({ service, groups, unreadCounts, fallbackUnreadCount = 0, loading, onSelect, onPrefetch, onRefresh }: AdminGroupPickerProps) {
  const styles = serviceStyles[service];
  const Icon = styles.Icon;
  const getUnreadCount = (group: AdminGroup) => unreadCounts[group.admin_id] ?? (groups.length === 1 ? fallbackUnreadCount : 0);
  const totalEmployees = groups.reduce((total, group) => total + Number(group.employee_count || 0), 0);
  const totalCustomers = groups.reduce((total, group) => total + Number(group.customer_count || 0), 0);
  const totalConversations = groups.reduce((total, group) => total + Number(group.conversation_count || 0), 0);
  const totalUnread = groups.reduce((total, group) => total + getUnreadCount(group), 0);
  const sortedGroups = useMemo(() => [...groups].sort((a, b) => {
    const aUnread = unreadCounts[a.admin_id] ?? (groups.length === 1 ? fallbackUnreadCount : 0);
    const bUnread = unreadCounts[b.admin_id] ?? (groups.length === 1 ? fallbackUnreadCount : 0);
    return bUnread - aUnread;
  }), [fallbackUnreadCount, groups, unreadCounts]);

  useEffect(() => {
    if (loading || !onPrefetch) return;

    const timers = sortedGroups.slice(0, 4).map((group, index) => globalThis.setTimeout(() => {
      onPrefetch(group);
    }, 150 + index * 250));

    return () => timers.forEach(timer => globalThis.clearTimeout(timer));
  }, [loading, onPrefetch, sortedGroups]);

  if (loading) {
    return (
      <div className="flex min-h-[320px] flex-1 items-center justify-center bg-slate-950/30 text-slate-100">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className={`relative flex h-16 w-16 items-center justify-center rounded-2xl border ${service === 'customer' ? 'border-orange-300/30 bg-orange-400/15 shadow-[0_0_30px_rgba(251,146,60,0.14)]' : 'border-emerald-300/30 bg-emerald-400/15 shadow-[0_0_30px_rgba(52,211,153,0.14)]'}`}>
            <span className={`absolute inset-1 animate-ping rounded-xl border [animation-duration:1.6s] ${service === 'customer' ? 'border-orange-300/25' : 'border-emerald-300/25'}`} />
            <span className={`relative h-8 w-8 animate-spin rounded-full border-[3px] ${service === 'customer' ? 'border-orange-300/25 border-t-orange-300' : 'border-emerald-300/25 border-t-emerald-300'}`} />
          </div>
          <div>
            <p className={`text-sm font-semibold ${service === 'customer' ? 'text-orange-100' : 'text-emerald-100'}`}>正在載入{service === 'customer' ? '模擬客戶' : '經理'}分組</p>
            <p className="mt-1 text-[11px] text-slate-400">正在取得管理員工作區，請稍候……</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col text-slate-100">
      <section className="flex min-h-0 flex-1 flex-col">
        <header className={`relative flex shrink-0 flex-col gap-4 border-b px-4 py-4 sm:px-6 sm:py-5 ${styles.border}`}>
          <div className={`absolute inset-x-0 top-0 h-px ${styles.rail}`} />
          <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${styles.headerIcon}`}>
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold tracking-tight text-white">管理員工作區</h2>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${styles.chip}`}>{groups.length} 個可用</span>
                </div>
              </div>
            </div>

            <div className="flex w-full max-w-[560px] shrink-0 flex-wrap justify-start gap-2 lg:justify-end">
              <div className="group/metric relative w-[104px] overflow-hidden rounded-xl border border-cyan-300/35 bg-gradient-to-br from-cyan-400/25 via-cyan-900/25 to-slate-950/70 px-2.5 py-2 shadow-[0_10px_24px_-16px_rgba(34,211,238,0.55),inset_0_1px_0_rgba(165,243,252,0.25)] transition-[border-color,box-shadow] duration-300 hover:border-cyan-200/70 hover:shadow-[0_10px_26px_-12px_rgba(34,211,238,0.5),inset_0_1px_0_rgba(165,243,252,0.4)]">
                <span aria-hidden="true" className="pointer-events-none absolute -right-3 -top-5 h-12 w-12 rounded-full border border-cyan-200/20 bg-cyan-300/10 blur-[1px]" />
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-2 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/70 to-transparent" />
                <div className="relative flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-cyan-100/90"><Users className="h-3 w-3 shrink-0 text-cyan-300" /> <span className="truncate">群組</span></div>
                <div className="relative mt-1 text-base font-bold tabular-nums text-cyan-50">{groups.length}</div>
              </div>
              <div className="group/metric relative w-[104px] overflow-hidden rounded-xl border border-violet-300/35 bg-gradient-to-br from-violet-400/25 via-violet-900/25 to-slate-950/70 px-2.5 py-2 shadow-[0_10px_24px_-16px_rgba(167,139,250,0.55),inset_0_1px_0_rgba(221,214,254,0.25)] transition-[border-color,box-shadow] duration-300 hover:border-violet-200/70 hover:shadow-[0_10px_26px_-12px_rgba(167,139,250,0.5),inset_0_1px_0_rgba(221,214,254,0.4)]">
                <span aria-hidden="true" className="pointer-events-none absolute -right-3 -top-5 h-12 w-12 rounded-full border border-violet-200/20 bg-violet-300/10 blur-[1px]" />
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-2 top-0 h-px bg-gradient-to-r from-transparent via-violet-200/70 to-transparent" />
                <div className="relative flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-violet-100/90"><UserCog className="h-3 w-3 shrink-0 text-violet-300" /> <span className="truncate">員工</span></div>
                <div className="relative mt-1 text-base font-bold tabular-nums text-violet-50">{totalEmployees}</div>
              </div>
              <div className="group/metric relative w-[104px] overflow-hidden rounded-xl border border-sky-300/35 bg-gradient-to-br from-sky-400/25 via-sky-900/25 to-slate-950/70 px-2.5 py-2 shadow-[0_10px_24px_-16px_rgba(56,189,248,0.55),inset_0_1px_0_rgba(186,230,253,0.25)] transition-[border-color,box-shadow] duration-300 hover:border-sky-200/70 hover:shadow-[0_10px_26px_-12px_rgba(56,189,248,0.5),inset_0_1px_0_rgba(186,230,253,0.4)]">
                <span aria-hidden="true" className="pointer-events-none absolute -right-3 -top-5 h-12 w-12 rounded-full border border-sky-200/20 bg-sky-300/10 blur-[1px]" />
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-2 top-0 h-px bg-gradient-to-r from-transparent via-sky-200/70 to-transparent" />
                <div className="relative flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-sky-100/90"><MessageCircle className="h-3 w-3 shrink-0 text-sky-300" /> <span className="truncate">客戶</span></div>
                <div className="relative mt-1 text-base font-bold tabular-nums text-sky-50">{totalCustomers}</div>
              </div>
              <div className="group/metric relative w-[104px] overflow-hidden rounded-xl border border-indigo-300/35 bg-gradient-to-br from-indigo-400/25 via-indigo-900/25 to-slate-950/70 px-2.5 py-2 shadow-[0_10px_24px_-16px_rgba(129,140,248,0.55),inset_0_1px_0_rgba(199,210,254,0.25)] transition-[border-color,box-shadow] duration-300 hover:border-indigo-200/70 hover:shadow-[0_10px_26px_-12px_rgba(129,140,248,0.5),inset_0_1px_0_rgba(199,210,254,0.4)]">
                <span aria-hidden="true" className="pointer-events-none absolute -right-3 -top-5 h-12 w-12 rounded-full border border-indigo-200/20 bg-indigo-300/10 blur-[1px]" />
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-2 top-0 h-px bg-gradient-to-r from-transparent via-indigo-200/70 to-transparent" />
                <div className="relative flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-indigo-100/90"><Activity className="h-3 w-3 shrink-0 text-indigo-300" /> <span className="truncate">對話</span></div>
                <div className="relative mt-1 text-base font-bold tabular-nums text-indigo-50">{totalConversations}</div>
              </div>
              <div className="group/metric relative w-[104px] overflow-hidden rounded-xl border border-orange-300/45 bg-gradient-to-br from-orange-400/30 via-amber-900/25 to-slate-950/70 px-2.5 py-2 shadow-[0_10px_24px_-16px_rgba(251,146,60,0.65),inset_0_1px_0_rgba(253,186,116,0.3)] transition-[border-color,box-shadow] duration-300 hover:border-orange-200/75 hover:shadow-[0_10px_26px_-12px_rgba(251,146,60,0.6),inset_0_1px_0_rgba(253,186,116,0.45)]">
                <span aria-hidden="true" className="pointer-events-none absolute -right-3 -top-5 h-12 w-12 rounded-full border border-orange-200/25 bg-orange-300/15 blur-[1px]" />
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-2 top-0 h-px bg-gradient-to-r from-transparent via-orange-200/80 to-transparent" />
                {totalUnread > 0 && <span aria-hidden="true" className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-orange-300 shadow-[0_0_9px_rgba(253,186,116,0.9)] motion-safe:animate-pulse" />}
                <div className="relative flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-orange-100/90"><BellRing className="h-3 w-3 shrink-0 text-orange-300" /> <span className="truncate">未讀</span></div>
                <div className={`relative mt-1 text-base font-bold tabular-nums ${totalUnread > 0 ? 'text-orange-50' : 'text-orange-200/70'}`}>{totalUnread}</div>
              </div>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-dark p-0 sm:p-1">
          {groups.length > 0 ? (
            <div className={`overflow-hidden rounded-xl border bg-slate-900/35 ${styles.border}`}>
              <div className="hidden grid-cols-[minmax(200px,1fr)_repeat(3,90px)_150px] items-center gap-4 border-b border-slate-700/70 bg-slate-900/80 px-4 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300/75 sm:grid">
                <span>工作區</span><span>員工</span><span>客戶</span><span>對話</span><span className="text-right">操作</span>
              </div>
              <div className="space-y-1 p-1">
                {sortedGroups.map(group => {
                  const unread = getUnreadCount(group);
                  const RoleIcon = getRoleIcon(group.admin_role);
                  return (
                    <button
                      key={group.admin_id}
                      type="button"
                      onPointerEnter={() => onPrefetch?.(group)}
                      onFocus={() => onPrefetch?.(group)}
                      onPointerDown={(event) => event.currentTarget.blur()}
                      onClick={() => onSelect(group)}
                      className={`group relative flex w-full flex-col gap-3 overflow-hidden rounded-lg border px-3 py-3 text-left transition-all duration-200 hover:-translate-y-px focus:outline-none focus:ring-0 focus:ring-offset-0 sm:grid sm:grid-cols-[minmax(200px,1fr)_repeat(3,90px)_150px] sm:items-center sm:gap-4 sm:px-4 ${styles.row}`}
                      style={{ WebkitTapHighlightColor: 'transparent', outline: 'none' }}
                    >
                      <span className={`absolute inset-y-0 left-0 w-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 ${styles.rail}`} />
                      <div className="flex min-w-0 items-center gap-3">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-all duration-200 ${getRoleIconStyles(group.admin_role)}`} title={formatRole(group.admin_role)}>
                          <RoleIcon className="h-[18px] w-[18px]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="min-w-0 max-w-full truncate text-sm font-bold leading-tight text-white sm:text-[15px]">{group.admin_username}</span>
                            <span
                              aria-hidden={unread === 0}
                              className={`inline-flex min-h-9 min-w-[112px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-2xl border px-3 py-1.5 text-xs font-bold transition-[opacity,transform,box-shadow] duration-300 motion-reduce:animate-none ${unread > 0 ? 'animate-pulse' : 'invisible'} ${styles.unreadBadge}`}
                            >
                              <span className={`relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ${styles.unreadIcon}`}>
                                <BellRing className="relative z-10 h-3 w-3" />
                                <span className={`absolute inset-0 rounded-full bg-current/35 motion-reduce:animate-none ${unread > 0 ? 'animate-ping' : ''}`} />
                              </span>
                              <span className="text-base font-black leading-none tabular-nums">{unread > 99 ? '99+' : unread}</span>
                              <span className="text-xs font-bold">未讀</span>
                            </span>
                          </div>
                          <span className={`mt-1 block max-w-full truncate text-[10px] font-bold leading-none ${getRoleChipStyles(group.admin_role)}`}>{formatRole(group.admin_role)}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2 sm:contents">
                        <div className={`flex items-center justify-between rounded-lg border px-3 py-2 sm:block sm:border-0 sm:bg-transparent sm:p-0 ${styles.metric}`}>
                          <span className="text-[10px] font-bold tracking-wider text-slate-300/70 sm:block">員工</span>
                          <span className="text-base font-bold text-white sm:mt-1 sm:block">{Number(group.employee_count || 0)}</span>
                        </div>
                        <div className={`flex items-center justify-between rounded-lg border px-3 py-2 sm:block sm:border-0 sm:bg-transparent sm:p-0 ${styles.metric}`}>
                          <span className="text-[10px] font-bold tracking-wider text-slate-300/70 sm:block">客戶</span>
                          <span className="text-base font-bold text-white sm:mt-1 sm:block">{Number(group.customer_count || 0)}</span>
                        </div>
                        <div className={`flex items-center justify-between rounded-lg border px-3 py-2 sm:block sm:border-0 sm:bg-transparent sm:p-0 ${styles.metric}`}>
                          <span className="text-[10px] font-bold tracking-wider text-slate-300/70 sm:block">對話</span>
                          <span className="text-base font-bold text-white sm:mt-1 sm:block">{Number(group.conversation_count || 0)}</span>
                        </div>
                      </div>

                      <div className="flex items-center justify-end gap-2">
                        <span className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-xs font-bold transition-all ${styles.action}`}>
                          開啟 <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                        </span>
                      </div>
                      <ChevronRight className={`pointer-events-none absolute -bottom-5 -right-3 h-20 w-20 opacity-[0.04] transition-all duration-300 group-hover:translate-x-1 group-hover:-translate-y-1 group-hover:opacity-10 ${styles.accent}`} />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-[280px] items-center justify-center rounded-xl border border-dashed border-slate-700/80 bg-slate-900/30 px-6 py-12 text-center">
              <div className="max-w-sm">
                <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border ${styles.headerIcon}`}><Users className="h-7 w-7" /></div>
                <h4 className="mt-5 text-base font-bold text-white">目前沒有可用工作區</h4>
                <p className="mt-2 text-sm font-medium leading-6 text-slate-300/80">目前沒有可管理的啟用中管理員工作區，請重新整理以查看最新群組。</p>
                <button type="button" onClick={onRefresh} className={`mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs font-bold text-white shadow-lg transition-all ${styles.action}`}>
                  <RefreshCw className="h-3.5 w-3.5" /> 重新整理工作區
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
