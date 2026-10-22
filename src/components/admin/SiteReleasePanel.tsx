import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import type { SiteReleaseReceipt, SiteReleaseSession, SiteReleaseStatus } from '../../lib/employeeTransfer/siteRelease';
import type { SourceCutoff } from '../../lib/employeeTransfer/sourceCutover';

interface Props {
  session: SiteReleaseSession;
  jobId: string;
  cutoff: SourceCutoff | null;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  onReceipt?: (receipt: SiteReleaseReceipt) => void | Promise<void>;
}
const confirmationText = '確認啟用新站';
const button = 'inline-flex max-w-full items-center justify-center gap-2 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40';
const input = 'mt-1 w-full min-w-0 rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400';
const blockerLabels: Record<string, string> = {
  missing_cutoff: '沒有切站截止憑據；日常備份包不能啟用新站。',
  cutoff_expired: '切站截止憑據已超過同一 UTC 日，不能啟用。',
  not_verified: '尚未取得本次十領域服務端總核對，不能啟用。',
  task_not_running: '導入任務已不在可啟用的執行狀態。',
  maintenance_mismatch: '目前新站維護狀態與本次任務不一致。',
};
const countLabels = [
  ['employees', '匯入員工'], ['active_employees', '恢復啟用的員工'], ['active_admins', '恢復啟用的管理員'],
  ['active_plans', '恢復執行的方案'], ['active_tasks', '恢復執行的任務'], ['queued_employees', '續接排程的員工'],
] as const;
function timestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '時間未確認';
  return `${new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date)}（UTC+8）`;
}
function deadline(cutoff: SourceCutoff): string {
  const date = new Date(cutoff.frozen_at);
  date.setUTCHours(24, 0, 0, 0);
  return timestamp(date.toISOString());
}
function checkedReceipt(value: SiteReleaseReceipt, jobId: string, cutoff: SourceCutoff | null): SiteReleaseReceipt {
  if (!value || value.version !== 1 || value.success !== true || value.scope !== 'site-release'
    || value.job_id !== jobId || !cutoff || value.source_site_id !== cutoff.site_id
    || value.cutoff_id !== cutoff.cutoff_id || value.cutoff_hash !== cutoff.cutoff_hash
    || !value.package_id || !value.verification_hash || value.released !== true || value.maintenance !== false
    || value.accounts_restored !== true || value.automation_resumed !== true
    || value.source_shutdown !== 'operator-managed' || value.full_site_complete !== false
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.released_at)
    || !Number.isFinite(Date.parse(value.released_at)) || !value.counts
    || !countLabels.every(([key]) => Number.isSafeInteger(value.counts[key]) && value.counts[key] >= 0)) {
    throw new Error('Unconfirmed site release receipt.');
  }
  return value;
}
function checkedStatus(value: SiteReleaseStatus, jobId: string, cutoff: SourceCutoff | null): SiteReleaseStatus {
  if (!value || value.version !== 1 || value.success !== true || value.scope !== 'site-release-status'
    || value.job_id !== jobId || !value.source_site_id || !value.package_id || value.full_site_complete !== false
    || typeof value.released !== 'boolean' || typeof value.maintenance !== 'boolean' || typeof value.can_release !== 'boolean'
    || !Array.isArray(value.blockers) || value.blockers.some(code => !Object.prototype.hasOwnProperty.call(blockerLabels, code))
    || (value.cutoff === null) !== (cutoff === null)
    || (cutoff && (value.cutoff?.site_id !== cutoff.site_id || value.source_site_id !== cutoff.site_id
      || value.cutoff?.cutoff_id !== cutoff.cutoff_id || value.cutoff?.cutoff_hash !== cutoff.cutoff_hash
      || value.cutoff?.frozen_at !== cutoff.frozen_at))
    || (value.can_release && (value.released || !value.maintenance || value.blockers.length > 0 || !value.cutoff || !value.verification_hash))
    || (value.released && (value.can_release || !value.receipt))
    || (!value.released && value.receipt !== null)) throw new Error('Unconfirmed site release status.');
  if (value.receipt) {
    const receipt = checkedReceipt(value.receipt, jobId, cutoff);
    if (receipt.source_site_id !== value.source_site_id || receipt.package_id !== value.package_id
      || receipt.verification_hash !== value.verification_hash) throw new Error('Mismatched site release receipt.');
  }
  return value;
}

export default function SiteReleasePanel({ session, jobId, cutoff, disabled = false, onBusyChange, onReceipt }: Props) {
  const id = useId();
  const [status, setStatus] = useState<SiteReleaseStatus | null>(null);
  const [receipt, setReceipt] = useState<SiteReleaseReceipt | null>(null);
  const [activity, setActivity] = useState<'status' | 'release' | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const operation = useRef<{ kind: 'status' | 'release'; controller: AbortController } | null>(null);
  const uncertainRef = useRef(false);
  const reported = useRef(false);
  const callbacks = useRef({ onBusyChange, onReceipt });
  callbacks.current = { onBusyChange, onReceipt };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving never releases maintenance or makes an in-flight write safe to forget.
      if (operation.current?.kind === 'release' || uncertainRef.current) callbacks.current.onBusyChange(true);
      else operation.current?.controller.abort();
    };
  }, []);
  const publishReceipt = async (value: SiteReleaseReceipt) => {
    setReceipt(value);
    if (reported.current) return;
    reported.current = true;
    try { await callbacks.current.onReceipt?.(value); }
    catch { if (mounted.current) setNotice('服務端已確認啟用，但本機報告未確認保存；不要因此重試啟用。'); }
  };
  const query = async () => {
    // An unknown write locks siblings, not the fresh read needed to reconcile it.
    if (operation.current || !mounted.current || (disabled && !uncertainRef.current)) return;
    const controller = new AbortController(); operation.current = { kind: 'status', controller };
    setActivity('status'); setNotice(null); setStatus(null); setPassword(''); setConfirmation('');
    callbacks.current.onBusyChange(true);
    try {
      const value = checkedStatus(await session.status(controller.signal), jobId, cutoff);
      if (!mounted.current || controller.signal.aborted) return;
      setStatus(value);
      if (value.receipt) await publishReceipt(value.receipt);
      uncertainRef.current = false; setUncertain(false);
    } catch {
      if (mounted.current) setNotice('未能確認啟用條件，可能是登入、連線或回執不符；不會自動重試。若先前啟用結果未知，互鎖仍保留，請再次查詢。');
    } finally {
      operation.current = null;
      if (mounted.current) { setActivity(null); callbacks.current.onBusyChange(uncertainRef.current); }
    }
  };
  const ready = !disabled && activity === null && !uncertain && !receipt && status?.can_release === true
    && password.length > 0 && confirmation === confirmationText;
  const release = async () => {
    if (!ready || !status || operation.current || uncertainRef.current || !mounted.current) return;
    const controller = new AbortController(); operation.current = { kind: 'release', controller };
    let secret = password;
    const submittedConfirmation = confirmation;
    setActivity('release'); setNotice(null); setPassword(''); setConfirmation(''); setStatus(null);
    callbacks.current.onBusyChange(true);
    let confirmed: SiteReleaseReceipt | null = null;
    try {
      const value = checkedReceipt(await session.release(secret, submittedConfirmation, controller.signal), jobId, cutoff);
      if (value.source_site_id !== status.source_site_id || value.package_id !== status.package_id) throw new Error('Mismatched release.');
      confirmed = value;
    } catch {
      uncertainRef.current = true;
      if (mounted.current) {
        setUncertain(true);
        setNotice('本次啟用結果未知，服務端可能已提交；不會自動重試或回滾。其他操作保持互鎖，請按「查詢啟用條件」重新核對。');
      }
    } finally { secret = ''; }
    // Saving a report is independent of the committed release and must never cause a second write.
    if (confirmed && mounted.current) await publishReceipt(confirmed);
    operation.current = null;
    if (mounted.current) { setActivity(null); callbacks.current.onBusyChange(uncertainRef.current); }
  };
  return <section aria-labelledby={`${id}-title`} aria-busy={activity !== null} className="min-w-0 space-y-4 rounded-xl border border-cyan-700 bg-slate-900 p-4 text-slate-100">
    <h3 id={`${id}-title`} className="flex items-start gap-2 font-semibold"><ShieldAlert className="h-5 w-5 shrink-0 text-cyan-300" aria-hidden="true" />新站最終啟用</h3>
    <p className="text-sm text-slate-300">舊站由操作者自行停用，伺服器不連線或管控舊站。</p>
    <p className="text-sm text-amber-100">查詢只提供候選門檻，不代表已放行。提交時伺服器會原子重新核對十領域，恢復來源帳號原啟用／停用狀態（不是全員啟用）及自動化原狀態，保留進度、啟動時間、版本與獎勵防重複，再解除新站維護。取消或離開不會自動啟用或解除維護。</p>
    <p className="break-all text-xs text-slate-400">本次任務：{jobId}</p>
    {cutoff ? <dl className="grid min-w-0 gap-3 rounded-lg border border-slate-700 p-3 text-sm sm:grid-cols-2">
      <div className="min-w-0"><dt className="text-slate-400">來源凍結時間</dt><dd>{timestamp(cutoff.frozen_at)}</dd></div>
      <div className="min-w-0"><dt className="text-slate-400">啟用期限（同一 UTC 日）</dt><dd>{deadline(cutoff)} 前</dd></div>
      <div className="min-w-0"><dt className="text-slate-400">切站截止編號</dt><dd className="break-all font-mono text-xs">{cutoff.cutoff_id}</dd></div>
      <div className="min-w-0"><dt className="text-slate-400">截止校驗值</dt><dd className="break-all font-mono text-xs">{cutoff.cutoff_hash}</dd></div>
    </dl> : <p className="text-sm text-amber-200">僅有日常備份包，無切站憑據，不能啟用新站。</p>}
    <p className="text-xs text-slate-400">凍結與啟用必須在同一 UTC 日；UTC 換日為 UTC+8 每日 08:00，以伺服器時間核對，查詢通過也不能越過期限。</p>
    <button type="button" className={button} disabled={activity !== null || (disabled && !uncertain)} onClick={() => void query()}>{activity === 'status' && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}查詢啟用條件</button>
    <div role="status" aria-live="polite" className="space-y-2 text-sm">
      {activity === 'release' ? <p className="text-amber-200">{receipt ? '服務端已確認本次啟用，正在保存本機回執；請保留本頁。' : '正在核對並請求啟用，尚待服務端確認；請勿重複提交、重新整理或離開。'}</p> : uncertain ? <p className="text-amber-200">啟用結果未知，其他操作持續互鎖；請查詢核對。</p> : !receipt && <p>{status ? status.can_release ? '本次候選條件通過，尚未啟用；仍須密碼與精確確認語。' : '本次條件未通過，不能啟用。' : '尚未確認啟用條件，請先明確查詢。'}</p>}
      {status?.released && status.maintenance && <p className="text-amber-200">目前另有維護保護；以下是先前啟用的回執，不代表目前維護已解除。</p>}
      {status && status.blockers.length > 0 && <ul aria-label="啟用阻擋項目" className="list-disc space-y-2 pl-5 text-amber-200">{status.blockers.map(code => <li key={code}>{blockerLabels[code]}</li>)}</ul>}
    </div>
    <form onSubmit={event => { event.preventDefault(); void release(); }} className="min-w-0 space-y-3">
      <fieldset disabled={disabled || activity !== null || uncertain || !!receipt || !status?.can_release} className="grid min-w-0 gap-3 disabled:opacity-50 sm:grid-cols-2">
        <legend className="sr-only">新站啟用驗證</legend>
        <label className="block min-w-0 text-sm" htmlFor={`${id}-password`}>新站超級管理員密碼<input id={`${id}-password`} type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required className={input} /></label>
        <label className="block min-w-0 text-sm" htmlFor={`${id}-confirmation`}>輸入「{confirmationText}」<input id={`${id}-confirmation`} type="text" autoComplete="off" spellCheck={false} value={confirmation} onChange={event => setConfirmation(event.target.value)} required aria-invalid={confirmation.length > 0 && confirmation !== confirmationText} className={input} /></label>
      </fieldset>
      <button type="submit" disabled={!ready} className={`${button} border-cyan-600 bg-cyan-950`}>{activity === 'release' && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}核對並啟用新站</button>
    </form>
    {notice && <p role="alert" className="break-words rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-100">{notice}</p>}
    {receipt && <section aria-label="新站啟用回執" className="min-w-0 space-y-3 rounded-lg border border-emerald-700 bg-emerald-950/40 p-3 text-sm text-emerald-100">
      <h4 className="font-bold">服務端已確認新站啟用</h4>
      <p>{status?.released && status.maintenance ? '回執記錄本次啟用時已恢復來源帳號原啟用／停用狀態與自動化原狀態，並解除當時的新站維護；目前另有維護，以最新查詢為準。' : '已恢復來源帳號原啟用／停用狀態與自動化原狀態，新站維護已解除；不是全員啟用。'}</p>
      <p>啟用時間：{timestamp(receipt.released_at)}</p>
      <dl className="grid min-w-0 gap-3 sm:grid-cols-3">{countLabels.map(([key, label]) => <div key={key} className="min-w-0"><dt className="text-xs">{label}</dt><dd className="break-all font-semibold">{receipt.counts[key]}</dd></div>)}</dl>
      <p className="break-all text-xs">啟用核對摘要：{receipt.verification_hash}</p>
      <p>此回執不表示所有遷移缺項已完成（full_site_complete=false）；請保留來源檔、備份與兩份報告。</p>
    </section>}
  </section>;
}
