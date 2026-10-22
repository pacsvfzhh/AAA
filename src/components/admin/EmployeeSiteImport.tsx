import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, FolderOpen, Loader2, Pause, Play, ShieldAlert, Square } from 'lucide-react';
import { getSiteImportPreflight, importSiteBundleSetToMaintenance, type SiteImportPreflight } from '../../lib/employeeTransfer/siteImport';
import { createBrowserWorkspaceFactory, pickTransferDirectory, type BrowserTransferDirectory } from '../../lib/employeeTransfer/browserStorage';
import type { ChatMergeDecision } from '../../lib/employeeTransfer/chatMergeApi';
import type { ChatPlan } from '../../lib/employeeTransfer/chatTransfer';
import { SITE_DOMAINS, type SiteDomain, type SiteTransferProgress } from '../../lib/employeeTransfer/siteTransfer';

interface Inspection {
  packageId: string;
  sourceSiteId: string;
}
interface Props {
  files: File[];
  inspection: Inspection | null;
  disabled: boolean;
  supported: boolean;
  onBusyChange: (busy: boolean) => void;
  onProgress: (progress: SiteTransferProgress | null) => void;
}
type Approval = { kind: 'plan'; domain: SiteDomain; plan: unknown } | { kind: 'roles'; plan: ChatPlan };
type Outcome = Awaited<ReturnType<typeof importSiteBundleSetToMaintenance>>;
const confirmationText = '確認導入員工資料';
const button = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40';
const input = 'mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400';
const domains: Record<string, string> = {
  shared: '管理員與共享設定', products: '產品目錄', dispatch: '派單與交單', identity: '員工身份與精簡訂單', finance: '錢包與提款',
  activity: '登入與工時', verification: '實名與證件', notifications: '通知與自動化', chat: '聊天', archives: '原生檔案',
};
const blockers: Record<SiteImportPreflight['blockers'][number], string> = {
  same_site: '來源與目標是同一站點，不可導入。', active_maintenance: '目標已有維護保護，請先核對原任務，不可再次開始。',
  active_transfer_task: '目標仍有進行中的遷移任務，不能重跑代替續接。', target_has_business: '目標已有業務資料，空站模式不允許覆蓋；同名員工不會自動封存或替換。',
  missing_backend_support: '目標缺少必要的服務端接口，不能導入。',
};
const matchNames: Record<string, string> = { exact: '編號與名稱相同', name: '名稱唯一相同', ambiguous: '同名多個，必須選擇', number_conflict: '編號相同但名稱不同，必須選擇', new: '沒有候選，建立新角色', unmapped: '缺少管理員對應，不能繼續' };
const actionNames: Record<string, string> = { create: '新建', replace: '以來源替換', merge: '合併歷史', reuse: '沿用', 'map-super': '對應本站超管', 'map-existing': '對應現有', conflict: '有衝突' };
const countNames: Record<string, string> = {
  accounts: '員工帳號', credentials: '密碼校驗資料', orders: '精簡訂單', wallets: '錢包', wallet_transactions: '帳戶變動', withdrawals: '提款',
  wallet_ledger_entries: '帳本', wallet_balance_baselines: '財務基準', wallet_reconciliation_audit: '對帳稽核', employee_login_history: '登入紀錄', work_sessions: '工時',
  employee_work_stop_markers: '停工標記', verification_requests: '實名申請', simulated_customers: '聊天角色', customer_employee_conversations: '聊天訊息',
  customer_service_sessions: '聊天工單', messages: '通知', message_recipients: '通知收件', dispatch_groups: '派單分組', order_pools: '訂單池',
  dispatch_group_members: '派單成員', valid_order_data: '交單原文', used_order_data: '已用交單', notification_automation_plans: '自動化方案', notification_automation_tasks: '自動化任務',
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '—';
}
function PlanSummary({ value }: { value: unknown }) {
  const plan = record(value);
  const rows = Array.isArray(plan.admins) ? plan.admins : Array.isArray(plan.records) ? plan.records : Array.isArray(plan.roles) ? plan.roles : [];
  const counts = Object.entries(record(plan.counts)).filter(([, value]) => typeof value === 'number');
  return <div className="space-y-3 text-sm">
    {counts.length > 0 && <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">{counts.map(([key, value]) => <div key={key} className="min-w-0 rounded bg-slate-950 p-2"><dt className="break-words text-xs text-slate-400">{countNames[key] ?? key}</dt><dd>{text(value)}</dd></div>)}</dl>}
    {typeof plan.employees === 'number' && <p>涉及員工：{text(plan.employees)}</p>}
    {plan.pending_withdrawals != null && <p className="rounded border border-amber-700 bg-amber-950/40 p-3 text-amber-100">待處理提款：{text(record(plan.pending_withdrawals).count)} 筆 · 金額：{text(record(plan.pending_withdrawals).amount)}。凍結資金一併保留；之後只在一個站點處理，避免重複打款。</p>}
    {typeof plan.members_removed === 'number' && <p>依來源精確恢復，將移出原方案成員：{text(plan.members_removed)}</p>}
    {Array.isArray(plan.retire_tasks) && <p>將停用目標多餘任務：{plan.retire_tasks.length}</p>}
    {rows.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-xs text-slate-200"><caption className="mb-2 text-left text-slate-400">服務端計畫對應（{rows.length} 筆）</caption><thead><tr>{['名稱／類別', '來源編號', '目標編號', '操作'].map(label => <th key={label} className="p-2" scope="col">{label}</th>)}</tr></thead><tbody>{rows.map((raw, index) => {
      const row = record(raw);
      return <tr key={index} className="border-t border-slate-700"><td className="max-w-48 break-words p-2">{text(row.username ?? row.name ?? row.table_key ?? row.number)}</td><td className="max-w-48 break-all p-2 font-mono">{text(row.source_id)}</td><td className="max-w-48 break-all p-2 font-mono">{text(row.target_id)}</td><td className="p-2">{actionNames[text(row.action)] ?? text(row.action)}{row.multi_source_target === true && <p className="text-amber-200">多個來源合併到同一角色</p>}{Array.isArray(row.visibility_employee_ids) && <p className="text-amber-200">涉及可見性差集：{row.visibility_employee_ids.length} 名；{row.allow_visibility === true ? '允許追加' : '不追加'}</p>}</td></tr>;
    })}</tbody></table></div>}
    {['group_map', 'pool_map'].map(key => {
      const entries = Object.entries(record(plan[key]));
      return entries.length > 0 && <details key={key}><summary className="cursor-pointer py-2 focus-visible:outline-cyan-400">{key === 'group_map' ? '派單分組' : '訂單池'}對應（{entries.length} 筆）</summary><ul className="space-y-1 break-all font-mono text-xs">{entries.map(([source, target]) => <li key={source}>{source} → {text(target)}</li>)}</ul></details>;
    })}
    <p className="break-all text-xs text-slate-400">計畫摘要：{text(plan.plan_hash)}</p>
  </div>;
}
function ApprovalDialog({ approval, settle }: { approval: Approval; settle: (value: boolean | ChatMergeDecision[]) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  const roles = approval.kind === 'roles' ? approval.plan.roles : [];
  const selected = (role: ChatPlan['roles'][number]) => choices[role.source_id] ?? (role.needs_confirmation ? '' : role.target_id ?? 'new');
  const targets = roles.map(selected).filter(value => value !== '' && value !== 'new');
  const duplicate = new Set(targets).size !== targets.length;
  const valid = acknowledged && roles.every(role => role.match !== 'unmapped' && selected(role) !== '');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  return createPortal(<dialog ref={dialog} aria-labelledby="migration-approval-title" onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const fields = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')).filter(element => element.getClientRects().length > 0);
    const first = fields[0], last = fields[fields.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }} onCancel={event => { event.preventDefault(); settle(false); }} className="m-auto max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-4xl overflow-y-auto rounded-xl border border-slate-600 bg-slate-900 p-4 text-slate-100 shadow-2xl backdrop:bg-black/75 sm:p-6">
    <h2 id="migration-approval-title" className="text-lg font-bold">{approval.kind === 'roles' ? '確認聊天角色對應' : `確認${domains[approval.domain]}計畫`}</h2>
    <p className="mt-2 text-sm text-amber-200">拒絕只會停止後續操作，不撤回已寫入的資料或已封存的備份，也不解除維護。按 Escape 與拒絕相同；請先核對本階段內容。</p>
    <div className="mt-4">
      {approval.kind === 'plan' ? <PlanSummary value={approval.plan} /> : <div className="space-y-3">
        <p className="text-sm text-slate-300">合併時保留新站角色名稱、頭像與設定，並入舊站歷史；沒有候選才新建。不確定的項目不會替你選擇。</p>
        {roles.length === 0 && <p>本包沒有聊天角色，仍需確認此階段。</p>}
        {roles.map(role => <fieldset key={role.source_id} className="min-w-0 rounded-lg border border-slate-700 p-3">
          <legend className="max-w-full break-words px-1 text-sm font-semibold">{role.source_name} · {role.source_number} · {role.source_type === 'aaa_service' ? '模擬客戶' : '經理'}</legend>
          <p className="text-xs text-slate-400">{matchNames[role.match]}{role.number_occupied ? '；顯示編號已被佔用，新建時以服務端核定的新編號為準' : ''}</p>
          <label className="mt-2 block text-sm">目標角色<select className={input} value={selected(role)} disabled={role.match === 'unmapped'} onChange={event => { setAcknowledged(false); setChoices(value => ({ ...value, [role.source_id]: event.target.value })); }}>
            <option value="" disabled>請明確選擇</option><option value="new">新建角色（不合併）</option>
            {role.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>合併到 {candidate.name} · {candidate.number}</option>)}
          </select></label>
          {selected(role) !== '' && selected(role) !== 'new' && <label className="mt-3 flex items-start gap-2 text-sm text-amber-100"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 appearance-auto accent-cyan-400 focus-visible:outline-cyan-400" checked={visibility[role.source_id] ?? true} onChange={event => { setAcknowledged(false); setVisibility(value => ({ ...value, [role.source_id]: event.target.checked })); }} /><span>允許把匯入員工加入此角色的指定員工，讓他們可見。{role.visibility_employee_ids.length > 0 ? `目前建議對應涉及 ${role.visibility_employee_ids.length} 名員工；` : ''}手選目標的實際人數以下一階段服務端計畫為準。不勾選可能看不到此角色。</span></label>}
        </fieldset>)}
        {duplicate && <p className="rounded border border-amber-700 p-3 text-sm text-amber-200">多個舊角色將合併到同一新站角色，請確認這是你的選擇；下一階段還會顯示服務端合併計畫。</p>}
      </div>}
    </div>
    <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 appearance-auto accent-cyan-400 focus-visible:outline-cyan-400" /><span>我已核對上述對應與影響，了解仍不可恢復營業，並同意繼續本階段{duplicate ? '（包括多個來源合併同一角色）' : ''}。</span></label>
    <div className="mt-4 flex flex-wrap justify-end gap-3"><button type="button" className={button} onClick={() => settle(false)}>拒絕並停止後續操作</button><button type="button" className={`${button} border-cyan-600 bg-cyan-950`} disabled={!valid} onClick={() => settle(approval.kind === 'plan' ? true : roles.map(role => ({ source_id: role.source_id, target_id: selected(role) === 'new' ? null : selected(role), allow_visibility: visibility[role.source_id] ?? true, confirmed: true })))}>確認本階段並繼續</button></div>
  </dialog>, document.body);
}

export default function EmployeeSiteImport({ files, inspection, disabled, supported, onBusyChange, onProgress }: Props) {
  const [preflight, setPreflight] = useState<SiteImportPreflight | null>(null);
  const [directory, setDirectory] = useState<BrowserTransferDirectory | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState<'idle' | 'preflight' | 'selecting' | 'running' | 'pause-requested' | 'paused' | 'stopping'>('idle');
  const [approval, setApproval] = useState<Approval | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedDirectory, setSavedDirectory] = useState<string | null>(null);
  const [reportStatus, setReportStatus] = useState<'saved' | 'failed' | null>(null);
  const operation = useRef<AbortController | null>(null);
  const pending = useRef<((value: boolean | ChatMergeDecision[]) => void) | null>(null);
  const pauseRequested = useRef(false);
  const resume = useRef<(() => void) | null>(null);
  const mounted = useRef(false);
  const currentProgress = useRef<SiteTransferProgress | null>(null);
  const [stoppedAt, setStoppedAt] = useState<SiteTransferProgress | null>(null);
  const busy = status !== 'idle';
  const running = ['running', 'pause-requested', 'paused', 'stopping'].includes(status);
  const ready = !disabled && !busy && !attempted && supported && inspection !== null && preflight?.can_restore_to_maintenance === true && directory !== null
    && Array.from(passphrase).length >= 14 && password.length > 0 && confirmation === confirmationText && acknowledged;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      pending.current?.(false);
      resume.current?.();
    };
  }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    setPreflight(null); setAcknowledged(false); setPassword(''); setPassphrase(''); setConfirmation('');
  }, [inspection]);
  const settle = (value: boolean | ChatMergeDecision[]) => {
    const resolve = pending.current;
    pending.current = null;
    setApproval(null);
    resolve?.(value);
  };
  const ask = (value: Approval, signal: AbortSignal): Promise<boolean | ChatMergeDecision[]> => {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.current = null;
        if (mounted.current) setApproval(null);
        reject(new DOMException('Import approval cancelled.', 'AbortError'));
      };
      pending.current = result => { signal.removeEventListener('abort', abort); resolve(result); };
      signal.addEventListener('abort', abort, { once: true });
      setApproval(value);
    });
  };
  const pauseGate = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!pauseRequested.current) return;
    setStatus('paused');
    await new Promise<void>((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', abort); resume.current = null; resolve(); };
      const abort = () => { signal.removeEventListener('abort', abort); resume.current = null; reject(new DOMException('Import paused operation stopped.', 'AbortError')); };
      resume.current = finish;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
  };
  const checkTarget = async () => {
    if (!inspection || disabled || operation.current || attempted) return;
    const controller = new AbortController(); operation.current = controller;
    setStatus('preflight'); setPreflight(null); setNotice(null);
    try {
      const value = await getSiteImportPreflight(inspection.sourceSiteId, controller.signal);
      if (mounted.current && !controller.signal.aborted) setPreflight(value);
    } catch {
      if (mounted.current) setNotice('無法確認目標是否支援維護態導入第 3 版協議，可能是尚未部署、登入已過期或連線問題。未開始導入；不會自動重試。');
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setStatus('idle');
    }
  };
  const chooseDirectory = async () => {
    if (disabled || operation.current || attempted || !supported) return;
    const controller = new AbortController(); operation.current = controller;
    setStatus('selecting'); setDirectory(null); setNotice(null);
    try {
      const value = await pickTransferDirectory();
      if (mounted.current && !controller.signal.aborted) setDirectory(value);
    } catch {
      if (mounted.current) setNotice('未取得備份目錄寫入權限。尚未開始導入，可能建立的空目錄請自行保留核對。');
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setStatus('idle');
    }
  };
  const start = async () => {
    if (!ready || operation.current || !directory) return;
    const controller = new AbortController(); operation.current = controller;
    const selectedDirectory = directory;
    const startedAt = new Date().toISOString();
    const saveReport = async (result: Outcome | null) => {
      try {
        await selectedDirectory.writeText('site-import-report.json', JSON.stringify({
          version: 1, packageId: inspection!.packageId, sourceSiteId: inspection!.sourceSiteId, targetSiteId: preflight!.site_id,
          startedAtUTC: startedAt, finishedAtUTC: new Date().toISOString(),
          status: result ? 'verified-to-maintenance-only' : 'unconfirmed', jobId: result?.jobId ?? null,
          verifiedDomains: result?.verifiedDomains ?? [], serverVerification: result?.serverVerification ?? null,
          lastProgress: currentProgress.current,
          fullSiteComplete: false, canRelease: false, rollbackConfirmed: false,
          maintenance: result ? true : 'unconfirmed', accountActivationPerformed: false, automationResumed: false,
          note: 'Keep all input and backup files. Unknown requests may have committed. Do not rerun as resumption.',
        }, null, 2));
        if (mounted.current) setReportStatus('saved');
      } catch {
        if (mounted.current) setReportStatus('failed');
      }
    };
    setReportStatus(null);
    setStatus('running'); setAttempted(true); setNotice(null); setOutcome(null); setStoppedAt(null);
    setSavedDirectory(selectedDirectory.name); setDirectory(null); currentProgress.current = null; onProgress(null);
    pauseRequested.current = false;
    try {
      const createWorkspace = await createBrowserWorkspaceFactory();
      controller.signal.throwIfAborted();
      const result = await importSiteBundleSetToMaintenance({
        files, passphrase, adminPassword: password, confirmation, directory: selectedDirectory, createWorkspace, signal: controller.signal,
        beforeDomain: () => pauseGate(controller.signal),
        onProgress: value => {
          if (mounted.current && !controller.signal.aborted) { currentProgress.current = { ...value }; onProgress({ ...value }); }
        },
        approvePlan: async (domain, plan) => await ask({ kind: 'plan', domain, plan }, controller.signal) === true,
        chooseChatRoles: async plan => {
          const result = await ask({ kind: 'roles', plan }, controller.signal);
          if (!Array.isArray(result)) throw new Error('Chat role decisions were not approved.');
          return result;
        },
      });
      controller.signal.throwIfAborted();
      if (mounted.current) setOutcome(result);
      await saveReport(result);
    } catch {
      if (mounted.current) {
        setStoppedAt(currentProgress.current);
        setNotice('本次導入未能確認完成（包括拒絕計畫、取消、登入過期或連線中斷）。服務端可能已寫入部分資料或封存備份；沒有自動重試、撤回、回滾、封存員工、啟用帳號或解除維護。不要重新開始代替續接，請先核對任務與已保存檔案；臨時明文清理若未確認，也不可重用工作區。');
      }
      await saveReport(null);
    } finally {
      pending.current?.(false); pending.current = null; resume.current = null; pauseRequested.current = false;
      if (operation.current === controller) operation.current = null;
      if (mounted.current) { setApproval(null); setStatus('idle'); setPassword(''); setPassphrase(''); setConfirmation(''); setAcknowledged(false); }
    }
  };
  const stop = () => {
    setStatus('stopping'); operation.current?.abort(); pauseRequested.current = false; resume.current?.();
  };
  const togglePause = () => {
    if (pauseRequested.current) { pauseRequested.current = false; resume.current?.(); setStatus('running'); }
    else { pauseRequested.current = true; setStatus('pause-requested'); }
  };
  return <section aria-label="維護態資料庫導入" className="space-y-4 rounded-xl border border-amber-700/60 bg-slate-900/80 p-4">
    <h2 className="flex items-center gap-2 font-semibold text-amber-100"><ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />空站演練：實際導入至維護狀態</h2>
    <p className="text-sm text-amber-100">此操作會寫入目標資料庫及檔案、以來源替換部分配置，並建立持續維護保護。只供隔離新站演練，不可在正式營業資料上使用；沒有安全恢復營業入口，完成後帳號仍停用、自動化仍暫停，維護不會解除。</p>
    <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-300"><li>先在上方完成本機 11 檔配套核驗，再查詢目標。</li><li>選獨立備份目錄、重新輸入口令、超管密碼及確認語。</li><li>開始後逐階段核對服務端計畫；五份配置／紀錄備份保存、回讀並封存後才繼續。</li><li>聊天歧義需手選；同名員工／身份衝突一律阻擋，不會自動封存替換。</li></ol>
    {!inspection && <p className="text-sm text-slate-400">尚未取得本機整組核驗結果，目標查詢及實際導入均鎖定。</p>}
    <button type="button" className={button} disabled={disabled || busy || !inspection || attempted} onClick={() => void checkTarget()}>{status === 'preflight' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}查詢目標准入（只讀）</button>
    {preflight && <div role="status" className="space-y-2 rounded-lg border border-slate-700 p-3 text-sm"><p className="break-all">目標站：{preflight.site_id}</p><p className="break-all">來源站：{preflight.source_site_id}</p><p>{preflight.can_restore_to_maintenance ? '本次只讀預檢允許空站維護態演練；開始前仍會重新認證檔案並重查目標。' : '目標未通過，不允許開始。'}</p>{preflight.blockers.map(code => <p key={code} className="text-amber-200">{blockers[code]}</p>)}{preflight.missing_rpcs.length > 0 && <p>缺少接口：{preflight.missing_rpcs.length} 項。</p>}</div>}
    <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <fieldset disabled={disabled || busy || attempted || !supported || !inspection || !preflight?.can_restore_to_maintenance} className="space-y-4 disabled:opacity-50">
        <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm" htmlFor="migration-import-passphrase">重新輸入原導出口令<input id="migration-import-passphrase" type="password" autoComplete="off" value={passphrase} onChange={event => setPassphrase(event.target.value)} required className={input} /></label><label className="block text-sm" htmlFor="migration-import-password">目前超級管理員密碼<input id="migration-import-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required className={input} /></label></div>
        <button type="button" className={button} onClick={() => void chooseDirectory()}><FolderOpen className="h-4 w-4" aria-hidden="true" />選擇獨立備份保存目錄</button>
        <p className="break-all text-xs text-slate-400">{directory ? `本次新子目錄：${directory.name}` : '每次建立新子目錄，不覆寫舊檔。五份配置／紀錄備份沿用原導出口令；不是完整員工備份，也不包含目標全部舊媒體。'}</p>
        <label className="block text-sm" htmlFor="migration-import-confirmation">輸入「{confirmationText}」<input id="migration-import-confirmation" type="text" autoComplete="off" spellCheck={false} value={confirmation} onChange={event => setConfirmation(event.target.value)} required aria-invalid={confirmation.length > 0 && confirmation !== confirmationText} className={input} /></label>
        <label className="flex items-start gap-2 text-sm text-amber-100"><input type="checkbox" required checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 appearance-auto accent-cyan-400 focus-visible:outline-cyan-400" /><span>我確認這是隔離、未營業的目標站，已另存來源檔及口令；了解會實際寫入且目前沒有完整回滾、同名員工替換或恢復營業功能。待處理提款之後只在單一站點處理。</span></label>
      </fieldset>
      <button type="submit" disabled={!ready} className={`${button} mt-4 border-amber-600 bg-amber-950 text-amber-100`}><AlertTriangle className="h-4 w-4" aria-hidden="true" />開始實際導入（保持維護）</button>
    </form>
    {!supported && <p className="text-sm text-amber-200">實際導入需桌面 Chrome／Edge、安全連線、目錄選擇與瀏覽器私有暫存；目前瀏覽器不支援。</p>}
    {running && <div role="status" className="rounded-lg border border-cyan-800 p-3 text-sm"><p>{status === 'paused' ? '已在領域邊界暫停' : status === 'pause-requested' ? '等待下一個領域邊界暫停' : status === 'stopping' ? '停止請求已提出，仍在等待當前操作與清理' : approval ? '等待你核對並確認計畫' : '實際導入處理中'}</p><p className="mt-2 text-xs text-amber-200">暫停只在下一個領域開始時生效；資料庫維護仍持續。停止不保證當前請求未提交，不取消服務端任務或回滾。</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={status === 'stopping'} onClick={togglePause}>{pauseRequested.current ? <Play className="h-4 w-4" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}{status === 'paused' ? '繼續' : pauseRequested.current ? '撤回暫停' : '請求邊界暫停'}</button><button type="button" className={button} disabled={status === 'stopping'} onClick={stop}><Square className="h-4 w-4" aria-hidden="true" />停止後續操作</button></div></div>}
    {notice && <p role="alert" className="rounded-lg border border-rose-700 bg-rose-950/40 p-3 text-sm text-rose-100">{notice}</p>}
    {stoppedAt && <p className="text-sm text-amber-200">停止前最後確認的領域：{domains[stoppedAt.domain] ?? '整組核驗'} · 已核驗領域 {stoppedAt.completedDomains} / {stoppedAt.totalDomains}。此為最後回報，不保證後續請求未提交。</p>}
    {savedDirectory && <p className="break-all text-sm text-slate-300">請保留本次備份子目錄：{savedDirectory}（失敗時可能只有部分檔案，不能視為完整備份）。</p>}
    {reportStatus && <p className={`text-sm ${reportStatus === 'failed' ? 'text-amber-200' : 'text-slate-300'}`}>{reportStatus === 'saved' ? '已將不含密碼或明文資料的 site-import-report.json 保存至本次目錄，列出包、站點、任務與維護態核驗結果；成功時包含綁定本次任務的完整服務端總核對回執。報告不是完整備份，也不是營業放行憑據。' : '本機報告未能確認保存；不影響既有服務端寫入，也不表示已回滾。請保留本頁任務資訊及全部檔案，不要因報告失敗重跑導入。'}</p>}
    {outcome && <div role="status" className="min-w-0 space-y-3 rounded-lg border-2 border-amber-500 bg-amber-950/40 p-4">
      <h3 className="font-bold text-amber-100">十領域維護態核驗已通過，仍不可恢復營業</h3>
      <p className="break-all text-sm">任務：{outcome.jobId}</p>
      <section aria-label="服務端總核對摘要" className="min-w-0 space-y-2 rounded-lg border border-amber-700 p-3 text-sm text-amber-100">
        <h4 className="font-semibold">服務端總核對已通過</h4>
        <p>十領域完成後，服務端已在同一次原子核對中重新驗證實際資料；此回執不是營業放行。</p>
        <dl className="grid gap-3 sm:grid-cols-3">
          <div className="min-w-0"><dt className="text-xs text-amber-200">員工數</dt><dd>{outcome.serverVerification.counts.employees}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-amber-200">待處理提款筆數</dt><dd>{outcome.serverVerification.counts.pending_withdrawals}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-amber-200">待處理提款金額</dt><dd className="break-all font-mono">{outcome.serverVerification.counts.pending_withdrawal_amount}</dd></div>
        </dl>
        <p className="break-all text-xs">核對摘要：<span className="font-mono">{outcome.serverVerification.verification_hash}</span></p>
        <p>待處理提款與凍結資金仍保留；之後只在單一站點處理，避免重複打款。</p>
      </section>
      <ul className="grid gap-1 text-sm sm:grid-cols-2">{SITE_DOMAINS.map(domain => <li key={domain}>{domains[domain]}：{outcome.verifiedDomains.includes(domain) ? '已核驗' : '未核驗'}</li>)}</ul>
      <p className="text-sm text-amber-100">帳號仍停用、自動化仍暫停、維護保護仍持續，尚未放行。這不是完整整站遷移成功；請保留來源、口令、五份備份及任務資訊，等候完整終驗與安全放行流程。</p>
    </div>}
    {attempted && !busy && <p className="text-sm text-amber-200">本頁已鎖定再次開始，避免把重跑當續接。請先核對服務端任務與檔案；重新整理不代表已回滾，也不會解除服務端維護。</p>}
    {approval && <ApprovalDialog key={approval.kind === 'plan' ? `${approval.domain}-${text(record(approval.plan).plan_hash)}` : 'chat-roles'} approval={approval} settle={settle} />}
  </section>;
}
