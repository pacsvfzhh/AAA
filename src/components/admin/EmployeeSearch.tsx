import { useState, useRef, useCallback } from 'react';
import { Search, X, User, Calendar, Mail, Phone, Wallet, CheckCircle, XCircle, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { formatSupabaseError, isFinancialAdminSessionError, supabase } from '../../lib/supabase';
import { getAdminFinancialSessionToken, logout } from '../../lib/auth';
import { formatDateUTC } from '../../lib/dateUtils';

interface EmployeeSearchResult {
  id: string;
  username: string;
  employee_id: string;
  created_at: string;
  is_active: boolean;
  is_verified: boolean;
  remarks: string | null;
  tags: string[];
  total_income: number;
  first_success_order_date: string | null;
  admin_info?: {
    username: string;
    role: string;
  } | null;
  verification_info?: {
    real_name: string | null;
    email: string | null;
    phone: string | null;
    wallet_address: string | null;
    created_at: string | null;
  } | null;
}

interface SearchProgress {
  step: number;
  totalSteps: number;
  currentTask: string;
  percentage: number;
}

export default function EmployeeSearch() {
  const [searchValue, setSearchValue] = useState('');
  const [results, setResults] = useState<EmployeeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchAbortController = useRef<AbortController | null>(null);
  const searchRequestIdRef = useRef(0);

  const handleSearch = useCallback(async () => {
    const trimmedValue = searchValue.trim();
    if (!trimmedValue) {
      return;
    }

    if (searchAbortController.current) {
      searchAbortController.current.abort();
    }

    const requestId = ++searchRequestIdRef.current;
    const requestController = new AbortController();
    searchAbortController.current = requestController;
    setLoading(true);
    setHasSearched(true);
    setError(null);
    setProgress({ step: 0, totalSteps: 5, currentTask: '正在初始化搜尋...', percentage: 0 });

    try {
      setProgress({ step: 1, totalSteps: 5, currentTask: '正在搜尋全部員工分組...', percentage: 20 });
      const { data, error } = await supabase
        .rpc('search_all_employees_for_admin', {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_search_term: trimmedValue,
          p_limit: 100,
        })
        .abortSignal(requestController.signal);
      if (requestId !== searchRequestIdRef.current) return;
      if (error) throw error;

      setProgress({ step: 4, totalSteps: 5, currentTask: '正在整理搜尋結果...', percentage: 80 });
      setResults(Array.isArray(data) ? data as EmployeeSearchResult[] : []);
      setProgress({ step: 5, totalSteps: 5, currentTask: '完成', percentage: 100 });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Search aborted');
        setProgress(null);
        return;
      }
      if (isFinancialAdminSessionError(error)) {
        setError('管理員登入已失效，請重新登入。');
        void logout(false);
        return;
      }
      console.error('Search error:', error);
      setError(formatSupabaseError(error) || '搜尋失敗，請稍後再試。');
      setResults([]);
    } finally {
      if (requestId === searchRequestIdRef.current) {
        setLoading(false);
        setTimeout(() => setProgress(null), 500);
      }
    }
  }, [searchValue]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const clearSearch = () => {
    setSearchValue('');
    setResults([]);
    setHasSearched(false);
    setExpandedCard(null);
    setError(null);
  };

  const toggleCard = (userId: string) => {
    setExpandedCard(expandedCard === userId ? null : userId);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 text-slate-100">
      <section className="relative shrink-0 border-b border-cyan-900/60 pb-4 sm:pb-5">
        <div className="relative flex flex-col gap-4 xl:flex-row xl:items-end">
          <div className="min-w-0 xl:w-[260px] xl:shrink-0">
            <h2 className="mt-0 bg-gradient-to-r from-cyan-300 via-cyan-100 to-blue-300 bg-clip-text text-2xl font-bold tracking-tight text-transparent sm:text-[28px]">搜尋員工資料</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-300">跨全部管理員分組，透過使用者名稱、員工編號或已驗證的聯絡資料尋找帳戶。</p>
          </div>

          <div className="min-w-0 flex-1">
            <label className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-bold tracking-[0.08em] text-cyan-100">
              搜尋員工記錄
              <span className="font-medium tracking-normal text-slate-300">使用者名稱 · 員工編號 · 姓名 · 電子郵件 · 電話 · 錢包地址</span>
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-700" />
                <input
                  type="text"
                  value={searchValue}
                  onChange={(e) => setSearchValue(e.target.value)}
                  onKeyDown={handleKeyPress}
                  placeholder="輸入員工使用者名稱、員工編號或聯絡資料..."
                  className="h-12 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 text-sm font-medium text-slate-900 shadow-[0_8px_24px_rgba(2,6,23,0.16)] outline-none transition-[border-color,box-shadow,background-color,transform] placeholder:text-slate-500 hover:border-cyan-400 hover:shadow-[0_10px_28px_rgba(6,182,212,0.14)] focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-400/20 focus:shadow-[0_10px_30px_rgba(6,182,212,0.2)]"
                />
              </div>
              {searchValue && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition-[border-color,background-color,color,transform] hover:-translate-y-px hover:border-slate-400 hover:bg-white hover:text-slate-950"
                  title="清除搜尋"
                >
                  <X className="h-4 w-4" />
                  清除
                </button>
              )}
              <button
                type="button"
                onClick={handleSearch}
                disabled={loading || !searchValue.trim()}
                className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl border border-cyan-300/60 bg-gradient-to-r from-blue-600 via-cyan-600 to-cyan-500 px-5 text-sm font-bold text-white shadow-[0_8px_22px_rgba(8,145,178,0.24)] transition-[filter,transform,box-shadow] hover:-translate-y-px hover:brightness-110 hover:shadow-[0_12px_30px_rgba(8,145,178,0.34)] active:translate-y-0 disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-45 disabled:shadow-none sm:min-w-[126px]"
              >
                {loading ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    搜尋中
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4" />
                    搜尋
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {progress && (
          <div className="relative border-t border-cyan-900/50 bg-slate-950/35 px-4 py-3 sm:px-5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <div className="flex min-w-0 items-center gap-2 text-cyan-100">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-cyan-200/30 border-t-cyan-200" />
                <span className="truncate">{progress.currentTask}</span>
              </div>
              <span className="shrink-0 font-bold text-cyan-300">{progress.step}/{progress.totalSteps}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-300 transition-all duration-300" style={{ width: `${progress.percentage}%` }} />
            </div>
          </div>
        )}
        {error && (
          <div className="border-t border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-medium text-rose-200 sm:px-5">
            {error}
          </div>
        )}
      </section>

      {hasSearched ? (
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800/90 px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300/75">搜尋結果</p>
              <h3 className="mt-1 truncate text-base font-semibold text-cyan-100">員工帳戶</h3>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs font-bold text-cyan-100">
              <User className="h-3.5 w-3.5 text-cyan-300" />
              {results.length} 筆員工
            </span>
          </div>

          {results.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-14 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
                <Search className="h-7 w-7" />
              </span>
              <p className="mt-4 text-base font-semibold text-cyan-100">找不到員工</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-300">請嘗試其他使用者名稱、員工編號或已驗證的聯絡資料。</p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pt-3 dark-panel-scroll sm:pt-4">
              {results.map(employee => (
                <article
                  key={employee.id}
                  className="overflow-hidden rounded-xl border border-slate-700/80 bg-slate-950/45 shadow-[0_8px_22px_rgba(2,6,23,0.18)] transition-[border-color,background-color,box-shadow] hover:border-cyan-700/70 hover:bg-slate-950/65 hover:shadow-[0_12px_28px_rgba(2,6,23,0.28)]"
                >
                  {employee.admin_info && (
                    <div className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5 sm:px-5 ${employee.admin_info.role === 'super_admin' ? 'border-amber-300/20 bg-gradient-to-r from-amber-500/15 via-slate-900/40 to-cyan-500/10' : 'border-cyan-300/20 bg-gradient-to-r from-blue-500/15 via-slate-900/40 to-cyan-500/10'}`}>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${employee.admin_info.role === 'super_admin' ? 'border-amber-300/30 bg-amber-300/10 text-amber-200' : 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200'}`}>
                          <User className="h-3.5 w-3.5" />
                        </span>
                        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-300">所屬管理員</span>
                        <span className={`truncate text-sm font-bold ${employee.admin_info.role === 'super_admin' ? 'text-amber-100' : 'text-cyan-100'}`}>{employee.admin_info.username}</span>
                      </div>
                      <span className={`rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.14em] ${employee.admin_info.role === 'super_admin' ? 'border-amber-300/25 bg-amber-300/10 text-amber-200' : 'border-cyan-300/25 bg-cyan-300/10 text-cyan-200'}`}>
                        {employee.admin_info.role === 'super_admin' ? '超級管理員' : '二級管理員'}
                      </span>
                    </div>
                  )}

                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={expandedCard === employee.id}
                    onClick={() => toggleCard(employee.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        toggleCard(employee.id);
                      }
                    }}
                    className="group flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5 outline-none transition-colors hover:bg-cyan-400/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/60 sm:px-5"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-gradient-to-br from-blue-500/80 to-cyan-500/80 shadow-[0_6px_16px_rgba(6,182,212,0.18)]">
                        <User className="h-5 w-5 text-white" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                          <h4 className="truncate text-sm font-bold text-cyan-100 sm:text-base">{employee.username}</h4>
                          <span className="rounded-md border border-slate-700 bg-slate-900/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">員工編號 {employee.employee_id}</span>
                          {employee.is_verified && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300"><CheckCircle className="h-3.5 w-3.5" />已驗證</span>
                          )}
                          {!employee.is_active && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-300"><XCircle className="h-3.5 w-3.5" />未啟用</span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-300">
                          <Calendar className="h-3.5 w-3.5 text-slate-400" />
                          註冊時間 {formatDateUTC(employee.created_at)}
                        </div>
                      </div>
                    </div>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/70 text-slate-300 transition-colors group-hover:border-cyan-500/50 group-hover:text-cyan-200">
                      {expandedCard === employee.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </span>
                  </div>

                  {expandedCard === employee.id && (
                    <div className="border-t border-slate-800/90 bg-slate-900/45 px-4 py-4 sm:px-5">
                      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
                          <h5 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-cyan-200"><User className="h-4 w-4 text-cyan-300" />帳戶資料</h5>
                          <div className="mt-3 space-y-2.5">
                            <InfoRow label="使用者名稱" value={employee.username} />
                            <InfoRow label="員工編號" value={employee.employee_id} />
                            <InfoRow label="註冊日期" value={formatDateUTC(employee.created_at)} />
                            <InfoRow label="狀態" value={<span className={`inline-flex items-center gap-1 font-semibold ${employee.is_active ? 'text-emerald-300' : 'text-rose-300'}`}>{employee.is_active ? <CheckCircle className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}{employee.is_active ? '啟用' : '未啟用'}</span>} />
                            <InfoRow label="身分驗證" value={<span className={`inline-flex items-center gap-1 font-semibold ${employee.is_verified ? 'text-emerald-300' : 'text-rose-300'}`}>{employee.is_verified ? <CheckCircle className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}{employee.is_verified ? '已驗證' : '未驗證'}</span>} />
                            <InfoRow label="錢包餘額" value={`$${(employee.total_income || 0).toFixed(2)}`} />
                            <InfoRow label="首次成功訂單" value={employee.first_success_order_date ? formatDateUTC(employee.first_success_order_date) : '尚未開始工作'} />
                          </div>
                        </div>

                        <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
                          <h5 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-cyan-200"><CheckCircle className="h-4 w-4 text-cyan-300" />驗證資料</h5>
                          {employee.verification_info ? (
                            <div className="mt-3 space-y-2.5">
                              <InfoRow label="法定姓名" value={employee.verification_info.real_name || '無資料'} />
                              <InfoRow label="電子郵件" value={employee.verification_info.email || '無資料'} icon={<Mail className="h-3.5 w-3.5 text-slate-300" />} />
                              <InfoRow label="電話號碼" value={employee.verification_info.phone || '無資料'} icon={<Phone className="h-3.5 w-3.5 text-slate-300" />} />
                              <InfoRow label="錢包地址" value={employee.verification_info.wallet_address || '無資料'} icon={<Wallet className="h-3.5 w-3.5 text-slate-300" />} breakAll />
                              <InfoRow label="驗證日期" value={employee.verification_info.created_at ? formatDateUTC(employee.verification_info.created_at) : '無資料'} icon={<Calendar className="h-3.5 w-3.5 text-slate-300" />} />
                            </div>
                          ) : (
                            <div className="mt-4 flex items-center gap-2 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2.5 text-xs text-rose-300"><Clock className="h-4 w-4" />沒有可用的驗證資料</div>
                          )}
                        </div>

                        {(employee.tags?.length > 0 || employee.remarks) && (
                          <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/35 p-4 lg:col-span-2">
                            {employee.tags?.length > 0 && (
                              <div>
                                <label className="mb-2 block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">標籤</label>
                                <div className="flex flex-wrap gap-2">
                                  {employee.tags.map((tag, index) => <span key={index} className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 text-xs font-semibold text-cyan-200">{tag}</span>)}
                                </div>
                              </div>
                            )}
                            {employee.remarks && (
                              <div>
                                <label className="mb-2 block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">備註</label>
                                <p className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 text-xs leading-relaxed text-slate-300">{employee.remarks}</p>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-6 py-12 text-center">
          <div className="max-w-md">
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300 shadow-[0_0_28px_rgba(34,211,238,0.08)]"><Search className="h-7 w-7" /></span>
            <p className="mt-4 text-base font-semibold text-cyan-100">搜尋員工記錄</p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-300">使用上方搜尋欄，即可查看帳戶、驗證、錢包與所屬管理員資料。</p>
          </div>
        </section>
      )}
    </div>
  );
}

function InfoRow({
  label,
  value,
  icon,
  truncate = false,
  breakAll = false
}: {
  label: string;
  value: string | React.ReactNode;
  icon?: React.ReactNode;
  truncate?: boolean;
  breakAll?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-slate-800/70 pb-2 last:border-0 last:pb-0">
      <span className="w-[112px] shrink-0 text-[11px] font-medium text-slate-300">{label}</span>
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {icon}
        {typeof value === 'string' ? (
          <span
            className={`min-w-0 text-xs text-slate-200 ${truncate ? 'truncate' : ''} ${breakAll ? 'break-all' : ''}`}
            title={truncate ? value : undefined}
          >
            {value}
          </span>
        ) : (
          value
        )}
      </div>
    </div>
  );
}
