import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertTriangle, Loader2, LockKeyhole, RefreshCw, ShieldAlert, UnlockKeyhole } from 'lucide-react';
import {
  freezeSourceCutover,
  getSourceCutoverStatus,
  resumeSourceCutover,
  type SourceCutoverStatus,
} from '../../lib/employeeTransfer/sourceCutover';

interface Props {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onUncertainChange: (uncertain: boolean) => void;
}

type Operation = 'refresh' | 'freeze' | 'resume';
const freezeText = '確認暫停舊站業務並導出';
const resumeText = '確認恢復舊站業務並放棄切站';
const buttonClass = 'inline-flex max-w-full items-center justify-center gap-2 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40';
const inputClass = 'mt-1 w-full min-w-0 rounded-lg border border-slate-600 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50';
const countLabels = [
  ['pending_automation', '待處理自動化佇列'],
  ['failed_automation', '自動化失敗紀錄'],
  ['processing_orders', '處理中訂單'],
] as const;
const blockerLabels: Record<string, string> = {
  pending_automation: '自動化佇列尚未清空，請先處理完畢。',
  failed_automation: '仍有自動化失敗紀錄，請先核對並處理。',
  processing_orders: '仍有處理中訂單，請先處理至零。',
  automation_queue_not_drained: '自動化佇列尚未清空，不能建立切站截止點。',
  automation_failures_present: '仍有自動化失敗紀錄，不能略過後切站。',
  processing_orders_present: '仍有處理中訂單，不能略過後切站。',
  source_already_frozen: '舊站已暫停，請刷新並核對目前截止點。',
  source_not_frozen: '舊站目前未暫停，請刷新狀態。',
  cutoff_mismatch: '切站截止點已改變，請刷新後重新確認。',
  maintenance_active: '另有維護保護，請先核對服務端狀態。',
  transfer_running: '仍有進行中的遷移任務，請先核對任務狀態。',
  other_maintenance: '另有導入維護保護，不能使用舊站切換操作解除。',
  super_admin_required: '此操作僅限目前登入的超級管理員。',
  session_expired: '管理員驗證已失效，請重新登入後核對狀態。',
};

function checkedStatus(value: unknown, expectedSiteId: string | null): SourceCutoverStatus {
  if (!value || typeof value !== 'object') throw new Error('Invalid source cutover status.');
  const status = value as SourceCutoverStatus;
  const nonempty = (text: unknown): text is string => typeof text === 'string' && text.trim().length > 0;
  const counts = status.counts;
  if (status.version !== 1 || status.success !== true || status.scope !== 'source-cutover'
    || status.full_site_complete !== false || !nonempty(status.site_id)
    || (expectedSiteId !== null && status.site_id !== expectedSiteId)
    || typeof status.frozen !== 'boolean' || !Array.isArray(status.blockers)
    || !status.blockers.every(code => nonempty(code)) || !counts
    || !countLabels.every(([key]) => Number.isSafeInteger(counts[key]) && counts[key] >= 0)) {
    throw new Error('Invalid source cutover status.');
  }
  const cutoff = status.cutoff;
  if (cutoff !== null && (!cutoff || typeof cutoff !== 'object' || cutoff.version !== 1
    || cutoff.policy !== 'drained-queue-v1' || cutoff.site_id !== status.site_id
    || !nonempty(cutoff.cutoff_id) || !nonempty(cutoff.cutoff_hash)
    || !nonempty(cutoff.frozen_at) || !Number.isFinite(Date.parse(cutoff.frozen_at)))) {
    throw new Error('Invalid source cutoff.');
  }
  if (status.frozen && cutoff === null) throw new Error('Missing source cutoff.');
  return status;
}

function frozenTime(value: string): string {
  return `${new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(value))}（UTC+8）`;
}

export default function SourceCutoverPanel({ disabled, onBusyChange, onUncertainChange }: Props) {
  const id = useId();
  const [status, setStatus] = useState<SourceCutoverStatus | null>(null);
  const [readState, setReadState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [activity, setActivity] = useState<Operation | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const mounted = useRef(false);
  const operation = useRef<{ kind: Operation; controller: AbortController } | null>(null);
  const siteId = useRef<string | null>(null);
  const uncertainRef = useRef(false);
  const callbacks = useRef({ onBusyChange, onUncertainChange });
  useEffect(() => { callbacks.current = { onBusyChange, onUncertainChange }; }, [onBusyChange, onUncertainChange]);

  const markUncertain = useCallback((value: boolean) => {
    uncertainRef.current = value;
    if (mounted.current) setUncertain(value);
    callbacks.current.onUncertainChange(value);
  }, []);

  const refreshStatus = useCallback(async () => {
    if (operation.current || !mounted.current) return;
    const controller = new AbortController();
    operation.current = { kind: 'refresh', controller };
    setActivity('refresh'); setReadState('loading'); setNotice(null);
    callbacks.current.onBusyChange(true);
    try {
      const value = checkedStatus(await getSourceCutoverStatus(controller.signal), siteId.current);
      if (!mounted.current || controller.signal.aborted) return;
      siteId.current = value.site_id;
      setStatus(value); setReadState('ready');
      // Only a successful, validated read may release an unknown-write interlock.
      markUncertain(false);
      setNotice({ error: false, text: '已重新讀取並核對服務端狀態。以下為本次查詢結果，不代表業務已回滾、整站遷移完成或新站已放行。' });
    } catch {
      if (mounted.current && !controller.signal.aborted) {
        setReadState('unavailable');
        setNotice({ error: true, text: '無法確認舊站狀態，可能是接口尚未部署、登入驗證或連線問題。未取得的數量不是零；請刷新狀態核對，不要據此判定已暫停或已恢復。' });
      }
    } finally {
      if (operation.current?.controller === controller) {
        operation.current = null;
        if (mounted.current) { setActivity(null); setPassword(''); setConfirmation(''); }
        callbacks.current.onBusyChange(false);
      }
    }
  }, [markUncertain]);

  useEffect(() => {
    mounted.current = true;
    void refreshStatus();
    return () => {
      mounted.current = false;
      const active = operation.current;
      operation.current = null;
      // Aborting a browser request cannot undo a server-side write.
      if (active && active.kind !== 'refresh') markUncertain(true);
      active?.controller.abort();
      if (active) callbacks.current.onBusyChange(false);
    };
  }, [markUncertain, refreshStatus]);

  const busy = activity !== null;
  const resuming = status?.frozen === true;
  const confirmationText = resuming ? resumeText : freezeText;
  const drained = status !== null && countLabels.every(([key]) => status.counts[key] === 0);
  const formAllowed = !disabled && !busy && !uncertain && readState === 'ready' && status !== null
    && (resuming ? status.cutoff !== null : drained && status.blockers.length === 0);
  const ready = formAllowed && password.length > 0 && confirmation === confirmationText;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !status || operation.current || uncertainRef.current || !mounted.current) return;
    const kind = resuming ? 'resume' : 'freeze';
    const cutoffId = status.cutoff?.cutoff_id;
    if (kind === 'resume' && !cutoffId) return;
    const controller = new AbortController();
    operation.current = { kind, controller };
    let secret = password;
    const submittedConfirmation = confirmation;
    setActivity(kind); setNotice(null); setPassword('');
    callbacks.current.onBusyChange(true);
    try {
      const response = kind === 'freeze'
        ? await freezeSourceCutover(secret, submittedConfirmation, controller.signal)
        : await resumeSourceCutover(secret, submittedConfirmation, cutoffId!, controller.signal);
      const value = checkedStatus(response, status.site_id);
      if (value.frozen !== (kind === 'freeze')) throw new Error('Unexpected source cutover result.');
      if (!mounted.current || controller.signal.aborted) return;
      setStatus(value); setReadState('ready');
      setNotice({ error: false, text: kind === 'freeze'
        ? '服務端已確認建立持久維護屏障，舊站業務已暫停；帳號與自動化的原有啟停狀態不變。導出完成、失敗、取消或離開頁面都不會自動恢復舊站。這不是新站營業放行。'
        : '服務端已確認恢復舊站業務並放棄本次切站；帳號與自動化的原有啟停狀態不變。不要再使用舊切站檔案啟用新站，兩站不能同時營業。' });
    } catch {
      if (operation.current?.controller === controller) {
        markUncertain(true);
        if (mounted.current) {
          setReadState('unavailable');
          setNotice({ error: true, text: '本次操作結果未知，服務端可能已執行；不會自動重試，也不能宣稱已回滾。已鎖住再次暫停／恢復，請先按「刷新狀態」成功核對服務端結果。' });
        }
      }
    } finally {
      secret = '';
      if (operation.current?.controller === controller) {
        operation.current = null;
        if (mounted.current) { setPassword(''); setConfirmation(''); setActivity(null); }
        callbacks.current.onBusyChange(false);
      }
    }
  };

  return <section aria-labelledby={`${id}-title`} aria-busy={busy} className="min-w-0 space-y-4 rounded-xl border border-slate-600 bg-slate-900/80 p-4 text-slate-200">
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-60">
        <h2 id={`${id}-title`} className="flex items-start gap-2 font-semibold text-white"><ShieldAlert className="h-5 w-5 shrink-0 text-cyan-300" aria-hidden="true" />舊站停站切換</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">日常備份保持唯讀，不需要停站。本區只有超級管理員明確提交密碼與確認語後，才會暫停或恢復舊站業務；不改變帳號或自動化的原有啟停狀態。</p>
      </div>
      {/* A parent's busy/uncertain flag must not block the read needed to reconcile it. */}
      <button type="button" disabled={busy} onClick={() => void refreshStatus()} className={buttonClass}>
        {activity === 'refresh' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" />}刷新狀態
      </button>
    </div>

    <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2 text-sm">
      <p className="font-medium text-cyan-100">{activity === 'refresh' ? '正在查詢服務端狀態……' : activity === 'freeze' ? '正在請求暫停舊站業務，尚待服務端確認……' : activity === 'resume' ? '正在請求恢復舊站業務，尚待服務端確認……' : uncertain ? '操作結果未知，請刷新核對' : readState !== 'ready' ? '舊站目前狀態未確認' : resuming ? '舊站已暫停：持久維護屏障生效' : '舊站未套用本切站屏障（不代表沒有其他維護限制）'}</p>
      {busy && <p className="text-xs text-amber-200">請勿重複提交、重新整理或關閉頁面；中斷瀏覽器請求不等於服務端已取消或回滾。</p>}
    </div>

    <div>
      <h3 className="text-sm font-medium text-slate-300">{status && (readState !== 'ready' || busy) ? '上次確認的數量（非目前即時狀態）' : '服務端本次回報數量'}</h3>
      <dl className="mt-2 grid min-w-0 gap-3 sm:grid-cols-3">
        {countLabels.map(([key, label]) => <div key={key} className="min-w-0 rounded-lg bg-slate-950/60 p-3">
          <dt className="break-words text-xs text-slate-400">{label}</dt>
          <dd className={`mt-1 break-all text-lg font-semibold tabular-nums ${status && status.counts[key] > 0 ? 'text-amber-200' : 'text-cyan-100'}`}>{status ? status.counts[key].toLocaleString('zh-TW') : '未確認'}</dd>
        </div>)}
      </dl>
      <p className="mt-2 text-xs leading-relaxed text-slate-400">三項數量必須全部為 0 才能暫停切站。面板不會刪除佇列、失敗紀錄或代處理訂單；請先核對並處理完畢，再刷新狀態。查詢結果不是停站授權，提交時仍由服務端重新檢查。</p>
    </div>

    {status && <dl className="grid min-w-0 gap-3 rounded-lg border border-slate-700 p-3 text-xs sm:grid-cols-2">
      <div className="min-w-0"><dt className="text-slate-400">來源站</dt><dd className="mt-1 break-all font-mono text-slate-200">{status.site_id}</dd></div>
      <div className="min-w-0"><dt className="text-slate-400">{readState !== 'ready' || busy ? '上次確認的凍結時間（UTC+8）' : '凍結時間（UTC+8）'}</dt><dd className="mt-1 break-words text-slate-200">{status.cutoff ? frozenTime(status.cutoff.frozen_at) : '無切站截止點'}</dd></div>
      {status.cutoff && <>
        <div className="min-w-0"><dt className="text-slate-400">{status.frozen ? '切站截止點編號' : '歷史切站截止點（目前未生效）'}</dt><dd className="mt-1 break-all font-mono text-slate-200">{status.cutoff.cutoff_id}</dd></div>
        <div className="min-w-0"><dt className="text-slate-400">切站截止點校驗值</dt><dd className="mt-1 break-all font-mono text-slate-200">{status.cutoff.cutoff_hash}</dd></div>
      </>}
    </dl>}

    {status && status.blockers.length > 0 && <div className="rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 text-sm text-amber-100">
      <h3 className="font-semibold">{readState === 'ready' && !busy ? '服務端阻擋項目' : '上次確認的阻擋項目'}</h3>
      <ul className="mt-2 list-disc space-y-2 break-words pl-5">{status.blockers.map((code, index) => <li key={`${code}-${index}`}>{Object.prototype.hasOwnProperty.call(blockerLabels, code.toLowerCase()) ? blockerLabels[code.toLowerCase()] : '服務端回報其他阻擋項目，請先核對，不能略過後視為可以切站。'}</li>)}</ul>
    </div>}

    <div id={`${id}-boundary`} className="rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 text-sm leading-relaxed text-amber-100">
      <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>導出完成或取消都不會自動恢復舊站；持久維護屏障不會因離開頁面而解除。本階段沒有新站啟用或營業放行能力。</span></p>
      <p className="mt-2 font-semibold">恢復舊站後，不要再使用舊切站檔案啟用新站。兩站不能同時營業；若新站已開始營業，不能直接恢復舊站，須先停止並核對切站後的業務變動。</p>
    </div>

    {uncertain && <p role="alert" className="rounded-lg border border-rose-500/50 bg-rose-950/40 p-3 text-sm text-rose-100">暫停／恢復結果尚未確認，已互鎖其他切站操作。即使刷新失敗也不會解除互鎖；只有成功刷新並核對服務端狀態後才會解除。</p>}
    {notice && <p role={notice.error ? 'alert' : 'status'} className={`break-words rounded-lg border p-3 text-sm leading-relaxed ${notice.error ? 'border-rose-500/50 bg-rose-950/40 text-rose-100' : 'border-cyan-800 bg-cyan-950/40 text-cyan-100'}`}>{notice.text}</p>}

    <form onSubmit={event => void submit(event)} aria-labelledby={`${id}-form-title`} aria-describedby={`${id}-boundary`} className="min-w-0 space-y-3 rounded-lg border border-slate-700 p-3">
      <h3 id={`${id}-form-title`} className="font-semibold text-white">{resuming ? '放棄切站並恢復舊站' : '暫停舊站並準備切站導出'}</h3>
      <p className="break-words text-xs leading-relaxed text-slate-400">{resuming ? '僅針對上方目前生效的切站截止點恢復，提交時會傳送目前 cutoff_id；服務端會再次驗證，不能用過期截止點解除屏障。' : '僅在佇列、失敗紀錄與處理中訂單全部清零且沒有其他阻擋時，建立持久維護屏障與切站截止點；不會自動開始導出。'}</p>
      <fieldset disabled={!formAllowed} className="grid min-w-0 gap-3 disabled:opacity-60 sm:grid-cols-2">
        <legend className="sr-only">超級管理員密碼與精確確認語</legend>
        <label htmlFor={`${id}-password`} className="block min-w-0 text-sm">目前超級管理員密碼<input id={`${id}-password`} type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} className={inputClass} /></label>
        <label htmlFor={`${id}-confirmation`} className="block min-w-0 break-words text-sm">輸入「{confirmationText}」<input id={`${id}-confirmation`} type="text" autoComplete="off" spellCheck={false} required value={confirmation} onChange={event => setConfirmation(event.target.value)} aria-invalid={confirmation.length > 0 && confirmation !== confirmationText} aria-describedby={`${id}-confirmation-help`} className={inputClass} /></label>
      </fieldset>
      <p id={`${id}-confirmation-help`} className="text-xs text-slate-400">確認語須完全一致，含前後空白都不接受；密碼不會存入本機或紀錄，操作結束即清空。{confirmation && confirmation !== confirmationText ? '目前確認語不一致。' : ''}</p>
      <button type="submit" disabled={!ready} className={`${buttonClass} ${resuming ? 'border-amber-700 bg-amber-950/40 text-amber-100' : 'border-cyan-700 bg-cyan-950 text-cyan-100'}`}>
        {activity === 'freeze' || activity === 'resume' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" /> : resuming ? <UnlockKeyhole className="h-4 w-4 shrink-0" aria-hidden="true" /> : <LockKeyhole className="h-4 w-4 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 break-words">{resuming ? '確認恢復舊站並放棄切站' : '確認暫停舊站業務'}</span>
      </button>
      {disabled && !busy && <p className="text-xs text-amber-200">父頁其他操作或安全互鎖尚未解除，目前不可提交；仍可唯讀刷新狀態。</p>}
    </form>
  </section>;
}
