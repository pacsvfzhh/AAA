import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, FolderOpen, Loader2, ShieldAlert, Square } from 'lucide-react';
import {
  createEmployeeSafetyBackupSession, exportEmployeeSafetyBackup, stopOwnedEmployeeSafetyBackup,
  EmployeeSafetyBackupError, type EmployeeSafetyBackupPhase, type EmployeeSafetyBackupResult,
} from '../../lib/employeeTransfer/employeeSafetyBackup';
import { createBrowserWorkspaceFactory, pickTransferDirectory, type BrowserTransferDirectory } from '../../lib/employeeTransfer/browserStorage';

interface Props {
  disabled: boolean;
  supported: boolean;
  onBusyChange: (busy: boolean) => void;
  onPendingChange: (pending: boolean) => void;
}
interface Progress { phase: EmployeeSafetyBackupPhase; rows: number; bytes: number }
interface Receipt {
  backupId: string; siteId: string; jobId: string; filename: string; fingerprint: string;
  cipherSha256: string; cipherBytes: number; rows: number; tables: number;
}
const button = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40';
const input = 'mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400';
const stopText = '確認停止員工備份任務';
const phases: Partial<Record<EmployeeSafetyBackupPhase, string>> = {
  begin: '驗證超管並建立員工記錄快照', 'records-export': '分頁讀取員工及關聯記錄',
  'source-recheck': '複核來源內容未變', save: '加密並保存獨立檔案', authenticate: '重新開啟並認證全部密文',
  validate: '核對全部表與逐行摘要', 'target-recheck': '最後複核來源及清理臨時明文', close: '請求結束已核驗的技術任務',
  stop: '確認本人未結束的員工備份任務',
};
const retention = '請保留整個輸出目錄，包括不完整或未確認的檔案；不會自動重試、刪檔、停止服務端任務或回滾業務。若臨時明文清理未確認，請勿重用該工作區。';
const count = (value: number) => value.toLocaleString('zh-TW');
function receipt(result: EmployeeSafetyBackupResult, filename: string): Receipt {
  return { backupId: result.backupId, siteId: result.catalog.site_id, jobId: result.catalog.job_id, filename,
    fingerprint: result.catalog.fingerprint, cipherSha256: result.cipherSha256, cipherBytes: result.cipherBytes,
    rows: result.rows, tables: result.catalog.tables.length };
}

export default function EmployeeSafetyBackupPanel({ disabled, supported, onBusyChange, onPendingChange }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [directory, setDirectory] = useState<BrowserTransferDirectory | null>(null);
  const [outputDirectory, setOutputDirectory] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'selecting' | 'running' | 'cancelling' | 'stopping'>('idle');
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<Receipt | null>(null);
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [report, setReport] = useState<'saved' | 'failed' | null>(null);
  const [stopPassword, setStopPassword] = useState('');
  const [stopConfirmation, setStopConfirmation] = useState('');
  const mounted = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const busy = status !== 'idle';
  const validName = username.length > 0 && username === username.trim() && Array.from(username).length <= 256;
  const ready = !disabled && supported && !busy && !attempted && directory !== null && validName && password.length > 0
    && Array.from(passphrase).length >= 14 && passphrase === confirmation && acknowledged;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.abort(); };
  }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);

  const chooseDirectory = async () => {
    if (disabled || !supported || operation.current || attempted) return;
    const controller = new AbortController(); operation.current = controller;
    setStatus('selecting'); setDirectory(null); setNotice(null);
    try {
      const selected = await pickTransferDirectory();
      if (mounted.current && !controller.signal.aborted) setDirectory(selected);
    } catch {
      if (mounted.current) setNotice('未取得員工備份目錄，尚未開始任務；可能建立的空目錄請保留核對。');
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setStatus('idle');
    }
  };
  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || operation.current || !directory) return;
    const controller = new AbortController(); operation.current = controller;
    const selected = directory, name = username, startedAt = new Date().toISOString();
    let secret = password, key = passphrase;
    let saved: Receipt | null = null, knownJob: string | null = null, closed = false;
    let fileState: EmployeeSafetyBackupError['encryptedFileState'] = 'not-written';
    let cleanupRequired = false;
    let lastProgress: Progress = { phase: 'begin', rows: 0, bytes: 0 };
    const update = (value: Progress) => {
      lastProgress = { phase: value.phase, rows: value.rows, bytes: value.bytes };
      if (mounted.current && !controller.signal.aborted) setProgress(lastProgress);
    };
    setStatus('running'); setAttempted(true); setPending(true); setNotice(null); setResult(null); setReport(null);
    setJobId(null); setCloseConfirmed(false); setOutputDirectory(selected.name); setDirectory(null);
    setPassword(''); setPassphrase(''); setConfirmation(''); setAcknowledged(false);
    update(lastProgress);
    try {
      const factory = await createBrowserWorkspaceFactory();
      controller.signal.throwIfAborted();
      const backupId = crypto.randomUUID(), volumeId = crypto.randomUUID();
      const session = createEmployeeSafetyBackupSession(name, secret); secret = '';
      const begin = await session.begin(controller.signal);
      knownJob = begin.job_id;
      if (mounted.current) setJobId(knownJob);
      const filename = `employee-records-${backupId}.edx`;
      const exported = await exportEmployeeSafetyBackup(session, selected.createFile(filename), factory, key, {
        exportId: backupId, volumeId, sourceSiteId: begin.site_id, createdAt: startedAt,
        scope: 'replacement-backup', volumeIndex: 1, volumeCount: 1,
      }, { signal: controller.signal, onProgress: update });
      key = ''; saved = receipt(exported, filename); fileState = 'verified';
      if (mounted.current) setResult(saved);
      update({ ...lastProgress, phase: 'close' });
      await session.close(exported.catalog, controller.signal);
      closed = true;
      if (mounted.current) {
        setCloseConfirmed(true); setPending(false);
        setNotice('48 類記錄已加密保存、完整回讀核驗，服務端也已確認結束本次備份任務。這不包含附件，不授權封存、替換員工或恢復營業。');
      }
    } catch (error) {
      if (error instanceof EmployeeSafetyBackupError) {
        if (!saved) fileState = error.encryptedFileState;
        cleanupRequired = error.cleanupRequired;
      }
      if (mounted.current) setNotice(`本次員工記錄備份未能確認全部完成${saved ? '；加密記錄已核驗，但結束任務的結果未確認' : ''}。可能是接口尚未部署、驗證失敗、來源變動、檔案或連線問題。請先核對「紀錄」及下方本人停止入口，不要重跑代替續接。${retention}`);
    } finally {
      secret = ''; key = '';
      try {
        await selected.writeText('employee-records-report.json', JSON.stringify({
          version: 1, protocol: 'employee-safety-records-v1', startedAtUTC: startedAt, finishedAtUTC: new Date().toISOString(),
          status: closed ? 'verified-records-and-task-closed' : 'unconfirmed', jobId: knownJob,
          receipt: saved, lastProgress, encryptedFileState: fileState, temporaryPlaintextCleanupUnconfirmed: cleanupRequired,
          taskCloseConfirmed: closed, recordsOnly: true, mediaIncluded: false, completeEmployeeBackup: false,
          canArchive: false, canReplace: false, fullSiteComplete: false, rollbackConfirmed: false,
        }, null, 2));
        if (mounted.current) setReport('saved');
      } catch { if (mounted.current) setReport('failed'); }
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setStatus('idle');
    }
  };
  const stop = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || operation.current || !stopPassword || stopConfirmation !== stopText) return;
    const controller = new AbortController(); operation.current = controller;
    const secret = stopPassword;
    setStatus('stopping'); setNotice(null); setStopPassword(''); setStopConfirmation('');
    setPending(true);
    try {
      const response = await stopOwnedEmployeeSafetyBackup(secret, stopText, jobId, controller.signal);
      controller.signal.throwIfAborted();
      if (mounted.current) {
        setPending(false);
        setNotice(response.cancelled
          ? '服務端已確認停止本人的員工記錄備份技術任務。這不是備份成功或業務回滾，不刪除已保存檔案、不封存員工，也不解除維護。核對原檔案後才可明確準備新備份。'
          : '服務端本次未找到符合範圍的本人進行中員工備份任務。這不證明檔案完整，也不表示其他遷移任務不存在；請核對原檔案及「紀錄」，不要把新備份當續接。');
      }
    } catch {
      if (mounted.current) setNotice(`無法確認停止結果，不會自動重試或開始新任務；登入或連線恢復後，先核對「紀錄」再決定是否重新確認停止。${retention}`);
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setStatus('idle');
    }
  };
  const reset = () => {
    if (disabled || operation.current || pending) return;
    setAttempted(false); setDirectory(null); setUsername(''); setPassword(''); setPassphrase(''); setConfirmation('');
    setAcknowledged(false); setJobId(null); setResult(null); setCloseConfirmed(false); setProgress(null); setReport(null); setOutputDirectory(null);
    setNotice('已準備另一份全新備份；不是續接或重試原任務。請重新核對員工、選擇新目錄並另存口令，原檔案仍須保留。');
  };
  return <section aria-label="獨立員工記錄備份" className="space-y-4 rounded-xl border border-slate-600 bg-slate-900/80 p-4">
    <div>
      <h2 className="flex items-start gap-2 font-semibold text-white"><ShieldAlert className="h-5 w-5 shrink-0 text-cyan-300" aria-hidden="true" />導入前：獨立員工記錄備份</h2>
      <p className="mt-2 text-sm text-slate-300">此處只備份新站指定員工的 48 類記錄及關聯快照，不是全站導出的員工篩選。可在選擇來源包之前獨立執行；需部署 SQL46，由服務端驗證超管、員工及資料穩定性。</p>
      <p id="employee-safety-boundary" className="mt-2 rounded-lg border border-amber-700 bg-amber-950/30 p-3 text-sm text-amber-100">不含聊天圖片、證件或私有留證等實際附件；尚不能完整還原。成功也不會解鎖同名員工覆蓋、封存、帳號啟用或解除維護。有遷移任務、維護或處理中訂單時會阻擋，不會替你清除或停止它們。</p>
      {!supported && <p className="mt-2 text-sm text-amber-200">加密保存及回讀需要安全連線、目錄選擇與瀏覽器私有暫存，請使用桌面版 Chrome 或 Edge。</p>}
    </div>
    <form onSubmit={event => void start(event)}>
      <fieldset disabled={disabled || busy || attempted || !supported} className="space-y-3 disabled:opacity-60">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm" htmlFor="employee-safety-username">新站員工完整用戶名<input id="employee-safety-username" value={username} autoComplete="off" spellCheck={false} onChange={event => { setUsername(event.target.value); setAcknowledged(false); }} required aria-describedby="employee-safety-name-help" aria-invalid={username.length > 0 && !validName} className={input} /></label>
          <label className="block text-sm" htmlFor="employee-safety-password">目前超級管理員密碼<input id="employee-safety-password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} className={input} /></label>
        </div>
        <p id="employee-safety-name-help" className="text-xs text-slate-400">區分大小寫，不能有首尾空白，不自動修剪或選擇近似同名員工。每份備份只綁定一名員工。</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm" htmlFor="employee-safety-passphrase">獨立備份加密口令（至少 14 個字元）<input id="employee-safety-passphrase" type="password" autoComplete="new-password" spellCheck={false} required value={passphrase} onChange={event => setPassphrase(event.target.value)} className={input} /></label>
          <label className="block text-sm" htmlFor="employee-safety-confirmation">再次輸入獨立備份口令<input id="employee-safety-confirmation" type="password" autoComplete="new-password" spellCheck={false} required value={confirmation} onChange={event => setConfirmation(event.target.value)} aria-invalid={confirmation.length > 0 && confirmation !== passphrase} className={input} /></label>
        </div>
        <p className="text-xs text-slate-400">記錄含密碼校驗、財務及聊天等敏感內容；口令遺失無法恢復，請與檔案分開保存，不要使用登入密碼。密碼與口令不寫入報告或本機儲存。</p>
        <div className="flex flex-wrap items-center gap-3"><button type="button" className={button} onClick={() => void chooseDirectory()}><FolderOpen className="h-4 w-4" aria-hidden="true" />選擇員工備份保存目錄</button><span className="break-all text-xs text-slate-400">{directory ? `新子目錄：${directory.name}` : '每次建立獨立子目錄，不覆寫舊檔。'}</span></div>
        <label className="flex items-start gap-2 text-sm text-amber-100"><input type="checkbox" required checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 appearance-auto accent-cyan-400 focus-visible:outline-cyan-400" /><span>我已核對新站員工用戶名、另存口令，了解只有記錄、不含附件，也不能據此封存或覆蓋員工。</span></label>
      </fieldset>
      <button type="submit" disabled={!ready} className={`${button} mt-4 border-cyan-700 bg-cyan-950`}><Download className="h-4 w-4" aria-hidden="true" />開始獨立員工記錄備份</button>
    </form>
    {busy && <div role="status" className="rounded-lg border border-cyan-800 p-3 text-sm text-cyan-100">
      <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{status === 'selecting' ? '正在選擇保存目錄' : status === 'stopping' ? '正在確認本人任務停止結果' : status === 'cancelling' ? '正在停止本機處理，結果尚待核對' : '員工記錄備份執行中'}</p>
      <p className="mt-2 text-xs">切換後台頁籤不會中斷任務；請勿重新整理、登出、關閉或讓裝置休眠。不估算百分比或完成時間。</p>
      {status === 'running' && <button type="button" className={`${button} mt-3`} onClick={() => { setStatus('cancelling'); operation.current?.abort(); }}><Square className="h-4 w-4" aria-hidden="true" />停止本機備份處理</button>}
    </div>}
    {progress && <dl aria-label="員工備份實際進度" className="grid gap-3 text-sm sm:grid-cols-3">{[['目前階段', phases[progress.phase] ?? '核對記錄'], ['已確認記錄', count(progress.rows)], ['已處理位元組', count(progress.bytes)]].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg bg-slate-950 p-3"><dt className="text-xs text-slate-400">{label}</dt><dd className="mt-1 break-words text-cyan-100">{value}</dd></div>)}</dl>}
    {notice && <p role={pending && !busy ? 'alert' : 'status'} className="break-words rounded-lg border border-amber-700 bg-amber-950/20 p-3 text-sm text-amber-100">{notice}</p>}
    {outputDirectory && <p className="break-all text-sm text-slate-300">員工備份輸出子目錄：{outputDirectory}。請保留整個目錄與原檔案。</p>}
    {jobId && <p className="break-all font-mono text-xs text-slate-400">員工備份任務：{jobId}</p>}
    {result && <div aria-label="員工記錄備份核驗結果" className="space-y-2 rounded-lg border border-cyan-800 p-3 text-sm text-cyan-100">
      <h3 className="font-semibold">{closeConfirmed ? '獨立記錄檔案已核驗，任務結束已確認' : '獨立記錄檔案已核驗，任務結束尚未確認'}</h3>
      <p>固定 {count(result.tables)} 類記錄 · {count(result.rows)} 筆 · 密文 {count(result.cipherBytes)} 位元組</p>
      <p className="break-all font-mono text-xs">{result.filename}</p><p className="break-all font-mono text-xs">SHA-256：{result.cipherSha256}</p>
      <p className="text-amber-200">附件未備份 · 完整恢復未驗證 · 封存與覆蓋保持阻擋</p>
    </div>}
    {report && <p role={report === 'failed' ? 'alert' : 'status'} className={`text-sm ${report === 'failed' ? 'text-amber-200' : 'text-slate-300'}`}>{report === 'saved' ? '白名單結果報告已保存：employee-records-report.json（時間為 UTC）。不含用戶名、密碼、口令、任務令牌或記錄原文。' : '結果報告保存失敗；不代表已保存的加密檔案失效、任務未結束或業務回滾。請記下頁面任務編號與檔案摘要並核對磁碟，不要因此重新備份。'}</p>}
    {pending && !busy && <p className="text-sm font-semibold text-amber-200">員工備份任務結果尚未確認，其他導出與導入已鎖定；請先查核紀錄，必要時使用下方本人停止入口。</p>}
    {attempted && !pending && !busy && <button type="button" className={button} disabled={disabled} onClick={reset}>核對原檔案後，準備另一份新備份</button>}
    <details className="rounded-lg border border-slate-700 p-3">
      <summary className="cursor-pointer text-sm font-semibold text-amber-100 focus-visible:outline-cyan-400">本人員工備份任務未結束／開始回執遺失</summary>
      <p id="employee-safety-stop-help" className="mt-2 text-sm text-slate-300">先查看「紀錄」，確認要停止的是本人的獨立員工備份。需再次驗證密碼；已知任務編號時只核對該任務，開始回執遺失時只找目前登入超管本人的員工備份任務。不停止其他協定或其他管理員任務，不刪檔、不封存員工、不解除維護，也不會自動重新開始。</p>
      <form onSubmit={event => void stop(event)} className="mt-3">
        <fieldset disabled={disabled || busy} className="grid gap-3 disabled:opacity-60 sm:grid-cols-2">
          <label className="block text-sm" htmlFor="employee-safety-stop-password">停止員工備份：目前超管密碼<input id="employee-safety-stop-password" type="password" autoComplete="current-password" required value={stopPassword} onChange={event => setStopPassword(event.target.value)} className={input} /></label>
          <label className="block text-sm" htmlFor="employee-safety-stop-confirmation">輸入「{stopText}」<input id="employee-safety-stop-confirmation" autoComplete="off" spellCheck={false} required value={stopConfirmation} onChange={event => setStopConfirmation(event.target.value)} aria-describedby="employee-safety-stop-help" className={input} /></label>
        </fieldset>
        <button type="submit" disabled={disabled || busy || !stopPassword || stopConfirmation !== stopText} className={`${button} mt-3 border-amber-700`}><Square className="h-4 w-4" aria-hidden="true" />確認停止本人的員工備份任務</button>
      </form>
    </details>
  </section>;
}
