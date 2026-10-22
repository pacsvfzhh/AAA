import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { AlertTriangle, ArchiveRestore, Check, Download, FileCheck2, FolderOpen, History, KeyRound, Loader2, Pause, Play, RefreshCw, ShieldAlert, Square, Wand2 } from 'lucide-react';
import {
  exportSiteBundleSet,
  getSiteTransferCapabilities,
  getSiteTransferHistory,
  inspectSiteBundleSet,
  stopSiteExportTask,
} from '../../lib/employeeTransfer/siteTransfer';
import {
  createBrowserWorkspaceFactory,
  pickTransferDirectory,
  type BrowserTransferDirectory,
} from '../../lib/employeeTransfer/browserStorage';

import EmployeeSiteImport from './EmployeeSiteImport';
import SourceCutoverPanel from './SourceCutoverPanel';
import EmployeeSafetyBackupPanel from './EmployeeSafetyBackupPanel';

interface SiteTransferProgress {
  domain: string;
  phase: string;
  completedDomains: number;
  totalDomains: number;
  rows: number;
  files: number;
  bytes: number;
}

interface BundleResult {
  packageId: string;
  sourceSiteId: string;
  volumes: Array<{ domain: string; filename: string; cipherBytes: number; cipherSha256: string; rows: number; files: number }>;
  fullSiteComplete: false;
  importReady: false;
}

interface Capabilities {
  version: 1;
  site_id: string;
  export_protocol: string;
  can_export: boolean;
  can_import: false;
  import_blockers: string[];
  missing_rpcs: string[];
}

interface HistoryEntry {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

type Tab = 'export' | 'inspect' | 'history';
type RunKind = 'export' | 'inspect';
type RunStatus = 'running' | 'pause-requested' | 'paused' | 'cancelling';

const tabs = [
  { id: 'export' as const, label: '導出', icon: Download },
  { id: 'inspect' as const, label: '導入', icon: FileCheck2 },
  { id: 'history' as const, label: '紀錄', icon: History },
];
const scope = ['管理員與網站業務設定紀錄', '產品目錄', '派單設定、訂單池、成員、交單原文及已用狀態', '員工身份、密碼校驗資料及精簡訂單', '錢包、提款與財務紀錄', '登入、工時與停工標記', '實名資料與實際證件', '通知、廣播與自動化', '聊天、角色與支援格式的媒體', '本站原生唯讀檔案與附件'];
const limitations = [
  '網站圖示及管理員頭像的實際檔案尚未納入加密包；設定紀錄不等於已備份這些檔案。',
  '公告內容、分類及輪播設定不搬遷，保留新站現狀；舊格式檔案若仍包含輪播設定，會拒絕導入。',
  '遷入檔案的整組導出編排尚未接通；來源站若已有遷入檔案，會在開始導出前阻擋，不能略過後視為成功。',
  '部分舊式頭像值暫不支援，遇到不支援的值會阻擋，不能視為已備份。',
  '目前按領域分卷，單一領域的紀錄與媒體合計上限為 1 GiB、最多 3,000 個媒體檔案；不是約 150 MB 自動分卷，超限會失敗。',
  '日常備份不自動停站，資料變動會使一致性核對失敗；切站時請先使用「舊站停站切換」建立持久屏障，導出完成也不會自動恢復舊站。',
];
const stopConfirmationText = '確認停止導出任務';
const domainLabels: Record<string, string> = {
  site: '整組協調', index: '加密索引', shared: '管理員與共享設定', products: '產品目錄', dispatch: '派單與交單', identity: '員工身份',
  finance: '財務', activity: '登入與工時', verification: '實名與證件', notifications: '通知與自動化',
  chat: '聊天', archives: '原生檔案', 'imported-archives': '遷入檔案',
};
const phaseLabels: Record<string, string> = {
  preflight: '導出前檢查', begin: '建立領域快照', records: '讀取紀錄與媒體',
  'records-export': '讀取檔案紀錄', 'media-download': '下載並核對附件',
  'source-recheck': '複核來源資料', save: '加密並保存', authenticate: '解密與完整性驗證',
  validate: '核對內容與關聯', close: '核對並結束領域任務', recheck: '複核來源與已保存各卷',
  'save-index': '加密保存索引', complete: '整組檔案核驗完成（非業務恢復）',
  prepare: '準備領域恢復', stage: '暫存已認證資料', 'dry-run': '服務端計畫預檢', plan: '核對服務端計畫',
  'backup-prepare': '準備獨立配置／紀錄備份', 'backup-export': '讀取備份紀錄', 'backup-save': '加密保存獨立備份',
  'backup-authenticate': '重新認證備份', 'backup-upload': '上傳已認證備份', 'backup-seal': '服務端封存備份',
  'enter-maintenance': '建立持續維護保護', 'verify-prerequisites': '複核前置配置未漂移',
  'configuration-plan': '確認配置對應', 'configuration-apply': '恢復來源配置', apply: '恢復已批准的資料',
  'valid-begin': '開始交單資料恢復', 'valid-chunk': '分塊恢復交單', 'valid-verify': '核驗交單資料',
  'dependencies-plan': '核對派單關聯', 'dependencies-begin': '開始恢復派單關聯', 'dependencies-chunk': '恢復成員與已用交單',
  'dependencies-verify': '核驗派單關聯', chunk: '分塊恢復紀錄', verify: '核驗實際恢復內容', verified: '本領域已核驗',
  'media-upload': '上傳並核對附件', 'media-recheck': '最後回讀附件', 'choose-roles': '等待角色對應', 'merge-plan': '確認聊天合併計畫',
  'close-applied-shared': '結束已套用的共享階段', 'verify-maintenance': '確認持續維護保護', maintenance: '維護態核驗通過（不可營業）',
  'backup-snapshot': '讀取獨立備份快照', 'backup-verify': '重新讀取並認證獨立備份',
  export: '讀取已認證紀錄或媒體', upload: '上傳並核對媒體', restore: '恢復檔案紀錄', 'target-recheck': '最後複核目標附件',
};
const statusLabels: Record<string, string> = {
  pending: '待處理', queued: '已排程', running: '處理中', paused: '已暫停',
  completed: '階段已完成', finished: '階段已完成', verified: '階段已核驗', exported: '階段已導出',
  cancelled: '已取消，須核對', canceled: '已取消，須核對', failed: '已停止，須核對',
  expired: '已過期，須核對', unknown: '結果未確認',
};
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40';
const inputClass = 'mt-1 w-full rounded-lg border border-slate-600 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-50';
const retentionWarning = '請保留已產生的所有檔案（包括不完整或未確認的檔案），核對磁碟內容及服務端階段任務後再決定下一步。頁面不會自動刪除檔案，也不代表已回滾；若臨時明文清理未確認，請勿重用工作區。';

function browserSupport() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return { export: false, workspace: false };
  const workspace = window.isSecureContext && typeof navigator.storage?.getDirectory === 'function';
  const chromium = /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent) && !/(?:Firefox|OPR|CriOS|EdgiOS)\//.test(navigator.userAgent);
  return { export: workspace && chromium && 'showDirectoryPicker' in window && typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function', workspace };
}

function translatedLabel(labels: Record<string, string>, value: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : fallback;
}
function phaseName(value: string): string {
  if (value.startsWith('input-')) return `輸入檔案：${translatedLabel(phaseLabels, value.slice(6), '核驗中')}`;
  return translatedLabel(phaseLabels, value, '尚未識別的服務階段');
}
function domainName(value: string): string {
  return translatedLabel(domainLabels, value, '未識別領域');
}
function count(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-TW') : '未確認';
}
function byteSize(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return '未確認';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}
function timestamp(value: string | null): string {
  if (value === null) return '尚未結束／未確認';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '時間未確認' : new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}
function randomPassphrase(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => alphabet[byte & 63]).join('');
}

export default function EmployeeDataMigration() {
  const [tab, setTab] = useState<Tab>('export');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilityStatus, setCapabilityStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [directory, setDirectory] = useState<BrowserTransferDirectory | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [inspectFiles, setInspectFiles] = useState<File[]>([]);
  const [inspectPassphrase, setInspectPassphrase] = useState('');
  const [run, setRun] = useState<{ kind: RunKind; status: RunStatus } | null>(null);
  const [progress, setProgress] = useState<SiteTransferProgress | null>(null);
  const [result, setResult] = useState<{ kind: RunKind; data: BundleResult } | null>(null);
  const [outputDirectory, setOutputDirectory] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyStatus, setHistoryStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [stopPassword, setStopPassword] = useState('');
  const [stopConfirmation, setStopConfirmation] = useState('');
  const [stopping, setStopping] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [employeeBackupBusy, setEmployeeBackupBusy] = useState(false);
  const [employeeBackupPending, setEmployeeBackupPending] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceUncertain, setSourceUncertain] = useState(false);
  const [wakeStatus, setWakeStatus] = useState<'idle' | 'requesting' | 'active' | 'unavailable'>('idle');
  const mounted = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const capabilitiesRequest = useRef<AbortController | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const selectingRef = useRef(false);
  const pauseRequested = useRef(false);
  const resumeGate = useRef<(() => void) | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const support = browserSupport();
  const otherBusy = run !== null || stopping || importBusy || employeeBackupBusy || employeeBackupPending;
  const busy = otherBusy || sourceBusy || sourceUncertain;
  const exportAvailable = capabilityStatus === 'ready' && capabilities?.version === 1
    && capabilities.can_export === true && capabilities.missing_rpcs.length === 0;
  const passphraseValid = Array.from(passphrase).length >= 14 && passphrase === confirmation;
  const exportReady = exportAvailable && support.export && directory !== null && adminPassword.length > 0
    && passphraseValid && acknowledged && !busy && !selecting;

  const refreshCapabilities = useCallback(async () => {
    capabilitiesRequest.current?.abort();
    const controller = new AbortController();
    capabilitiesRequest.current = controller;
    setCapabilityStatus('loading');
    setCapabilities(null);
    try {
      const value: Capabilities = await getSiteTransferCapabilities(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (value.version !== 1 || !Array.isArray(value.missing_rpcs) || !Array.isArray(value.import_blockers)) {
        setCapabilityStatus('unavailable');
        return;
      }
      setCapabilities(value);
      setCapabilityStatus('ready');
    } catch {
      if (mounted.current && !controller.signal.aborted) setCapabilityStatus('unavailable');
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryStatus('loading');
    setHistory(null);
    try {
      const entries: HistoryEntry[] = await getSiteTransferHistory(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (!Array.isArray(entries)) { setHistoryStatus('unavailable'); return; }
      setHistory(entries);
      setHistoryStatus('ready');
    } catch {
      if (mounted.current && !controller.signal.aborted) setHistoryStatus('unavailable');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refreshCapabilities();
    return () => {
      mounted.current = false;
      capabilitiesRequest.current?.abort();
      historyRequest.current?.abort();
      operation.current?.abort();
      resumeGate.current?.();
    };
  }, [refreshCapabilities]);

  useEffect(() => {
    if (tab === 'history') void refreshHistory();
    return () => { historyRequest.current?.abort(); };
  }, [tab, refreshHistory]);

  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  useEffect(() => {
    if (!busy) { setWakeStatus('idle'); return; }
    let disposed = false;
    let pending = false;
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      if (disposed || pending || (lock && !lock.released) || document.visibilityState !== 'visible') return;
      if (!navigator.wakeLock?.request) { setWakeStatus('unavailable'); return; }
      pending = true;
      setWakeStatus('requesting');
      try {
        const requested = await navigator.wakeLock.request('screen');
        if (disposed) { void requested.release().catch(() => undefined); return; }
        lock = requested;
        setWakeStatus(requested.released ? 'unavailable' : 'active');
        requested.addEventListener('release', () => { if (!disposed) setWakeStatus('unavailable'); }, { once: true });
      } catch {
        if (!disposed) setWakeStatus('unavailable');
      } finally { pending = false; }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', acquire);
      if (lock) void lock.release().catch(() => undefined);
    };
  }, [busy]);

  const chooseDirectory = async () => {
    if (busy || !support.export || !exportAvailable || operation.current || selectingRef.current) return;
    selectingRef.current = true;
    setSelecting(true);
    setNotice(null);
    setDirectory(null);
    try {
      // Must be the first asynchronous action: the picker requires this click's user activation.
      const selected = await pickTransferDirectory();
      if (mounted.current) setDirectory(selected);
    } catch {
      if (mounted.current) setNotice({ error: false, text: '目錄未選取或未獲寫入權限，尚未開始導出。若已建立空目錄，請自行核對；頁面不會自動刪除。' });
    } finally {
      selectingRef.current = false;
      if (mounted.current) setSelecting(false);
    }
  };

  const pauseGate = async (controller: AbortController) => {
    controller.signal.throwIfAborted();
    if (!pauseRequested.current) return;
    setRun({ kind: 'export', status: 'paused' });
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        controller.signal.removeEventListener('abort', abort);
        resumeGate.current = null;
        resolve();
      };
      const abort = () => {
        controller.signal.removeEventListener('abort', abort);
        resumeGate.current = null;
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      resumeGate.current = finish;
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
    });
    controller.signal.throwIfAborted();
  };

  const startRun = async (kind: RunKind) => {
    if (busy || operation.current || selectingRef.current) return;
    if (kind === 'export' && !exportReady) return;
    if (kind === 'inspect' && (!support.workspace || !inspectFiles.length || Array.from(inspectPassphrase).length < 14)) return;
    const selectedDirectory = directory;
    const controller = new AbortController();
    operation.current = controller;
    pauseRequested.current = false;
    setRun({ kind, status: 'running' });
    setProgress(null);
    setResult(null);
    setNotice(null);
    if (kind === 'export') {
      setOutputDirectory(selectedDirectory!.name);
      // Every attempt needs a fresh output directory; never reuse or overwrite a prior attempt.
      setDirectory(null);
    } else setOutputDirectory(null);
    try {
      const createWorkspace = await createBrowserWorkspaceFactory();
      controller.signal.throwIfAborted();
      const onProgress = (value: SiteTransferProgress) => {
        if (mounted.current && operation.current === controller && !controller.signal.aborted) setProgress({ ...value });
      };
      const data: BundleResult = kind === 'export'
        ? await exportSiteBundleSet({ adminPassword, passphrase, directory: selectedDirectory!, createWorkspace, onProgress,
          signal: controller.signal, beforeDomain: () => pauseGate(controller) })
        : await inspectSiteBundleSet(inspectFiles, inspectPassphrase, createWorkspace, { signal: controller.signal, onProgress });
      controller.signal.throwIfAborted();
      if (!mounted.current) return;
      setResult({ kind, data });
      setNotice({ error: false, text: kind === 'export'
        ? '導出流程已回傳各卷結果。請保留所有檔案與口令；這不是正式整站遷移完成，也不代表可導入。'
        : '十個領域卷及索引已在本機配套核驗，本次檢查未寫資料庫。這不是完整站點備份或業務恢復通過；若要在隔離空站演練，請繼續下方目標准入檢查。' });
    } catch {
      if (mounted.current) setNotice({ error: true, text: `${controller.signal.aborted ? '已提出取消，任務已停止回報。' : '本次操作未能確認完成，可能是驗證、口令、權限、檔案、空間或連線問題。'}${retentionWarning}` });
    } finally {
      if (operation.current === controller) operation.current = null;
      pauseRequested.current = false;
      resumeGate.current = null;
      if (mounted.current) {
        setRun(null);
        setAdminPassword('');
        setPassphrase('');
        setConfirmation('');
        setInspectPassphrase('');
        setShowPassphrase(false);
        setAcknowledged(false);
      }
    }
  };

  const togglePause = () => {
    if (run?.kind !== 'export' || run.status === 'cancelling') return;
    if (pauseRequested.current) {
      pauseRequested.current = false;
      resumeGate.current?.();
      setRun({ kind: 'export', status: 'running' });
    } else {
      pauseRequested.current = true;
      setRun({ kind: 'export', status: 'pause-requested' });
    }
  };
  const cancel = () => {
    if (!operation.current || !run) return;
    setRun({ ...run, status: 'cancelling' });
    setNotice({ error: false, text: `已提出取消，正在等待當前操作停止及清理確認；不保證已中斷所有請求。${retentionWarning}` });
    operation.current.abort();
    pauseRequested.current = false;
    resumeGate.current?.();
  };
  const submitStop = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || operation.current || selectingRef.current || capabilityStatus !== 'ready'
      || !stopPassword || stopConfirmation !== stopConfirmationText) return;
    const controller = new AbortController();
    operation.current = controller;
    setStopping(true);
    setNotice(null);
    try {
      // This write is deliberately available only from this explicit, authenticated form submission.
      const response = await stopSiteExportTask(stopPassword, stopConfirmation, controller.signal);
      controller.signal.throwIfAborted();
      if (!mounted.current) return;
      if (response.cancelled === true) {
        setNotice({ error: false, text: '後端已確認停止本人的未結束導出任務並清除其技術暫存。已保存檔案不會刪除，業務不會回滾，維護不會解除；正在重新讀取階段紀錄，請保留檔案另行核對。' });
        await refreshHistory();
      } else {
        setNotice({ error: true, text: '後端未確認有導出任務被停止。請按「刷新紀錄」重新查核本人任務狀態，不要直接重試停止。已保存檔案請繼續保留；這不代表已回滾或已解除維護。' });
      }
    } catch {
      if (mounted.current) setNotice({ error: true, text: '無法確認停止結果，可能是接口未部署、驗證或連線問題；請按「刷新紀錄」重新查核，不會自動重試。請保留已保存檔案，不要假定任務已停止、業務已回滾或維護已解除。' });
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) {
        setStopping(false);
        setStopPassword('');
        setStopConfirmation('');
      }
    }
  };
  const submitExport = (event: FormEvent) => { event.preventDefault(); void startRun('export'); };
  const submitInspect = (event: FormEvent) => { event.preventDefault(); void startRun('inspect'); };
  const navigateTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target: number;
    if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') target = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[target].id);
    tabRefs.current[target]?.focus();
  };

  return (
    <section aria-label="資料遷移" className="min-h-0 flex-1 overflow-y-auto p-3 text-slate-200 sm:p-5">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="flex items-start gap-3">
          <ArchiveRestore className="mt-1 h-7 w-7 shrink-0 text-cyan-300" aria-hidden="true" />
          <div>
            <h1 className="text-xl font-bold text-white">資料遷移</h1>
            <p className="mt-1 text-sm text-slate-400">目前十個領域 · 按領域加密分卷 · 僅超級管理員</p>
          </div>
        </header>
        <div role="note" className="rounded-xl border-2 border-amber-400/70 bg-amber-950/50 p-4 text-amber-100">
          <p className="flex items-start gap-2 text-base font-bold"><ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />本地驗證版，尚不可用於正式整站遷移</p>
          <p className="mt-2 text-sm">員工替換、完整員工備份及最終核對放行尚未完成。不要在正式營業資料上演練；本頁可在相容的隔離空站實際導入至維護狀態，但不啟用帳號、不恢復自動化，也不解除維護。</p>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <p className="font-semibold text-white">後端能力</p>
              <p className={`mt-1 ${exportAvailable ? 'text-cyan-200' : 'text-amber-200'}`} role="status">
                {capabilityStatus === 'loading' ? '正在查詢遷移專用接口，尚不可操作。'
                  : capabilityStatus === 'unavailable' ? '後端遷移接口未部署或無法確認支援，導出不可操作。'
                  : exportAvailable ? '後端回報可導出；僅代表階段能力，不是整站遷移許可。'
                  : '後端尚未具備導出能力（可能未部署完整接口），導出不可操作。'}
              </p>
              {capabilities && <p className="mt-1 text-xs text-slate-400">導出協定：分領域加密卷組（第 1 版） · 缺少接口：{count(capabilities.missing_rpcs.length)} · 導入阻斷項：{count(capabilities.import_blockers.length)} · 完整營業放行：已阻擋（維護態導入另作目標檢查）</p>}
            </div>
            <button type="button" className={buttonClass} disabled={busy || selecting || capabilityStatus === 'loading'} onClick={() => void refreshCapabilities()}><RefreshCw className="h-4 w-4" aria-hidden="true" />重新檢查能力</button>
          </div>
          {!support.export && <p className="mt-3 text-sm text-amber-200">導出僅支援安全連線下的 Chromium 瀏覽器，且必須支援本機目錄選擇與瀏覽器私有暫存。請使用桌面版 Chrome 或 Edge；本瀏覽器不可導出。</p>}
        </div>

        <div role="tablist" aria-label="資料遷移功能" className="flex gap-1 rounded-xl border border-slate-700 bg-slate-900/80 p-1">
          {tabs.map((item, index) => {
            const Icon = item.icon;
            return <button key={item.id} ref={element => { tabRefs.current[index] = element; }} type="button" role="tab" id={`migration-tab-${item.id}`} aria-controls={`migration-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onKeyDown={event => navigateTab(event, index)} onClick={() => setTab(item.id)} className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${tab === item.id ? 'bg-cyan-900/70 text-cyan-100' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}><Icon className="h-4 w-4" aria-hidden="true" />{item.label}</button>;
          })}
        </div>

        {(employeeBackupBusy || employeeBackupPending) && <div role="status" className="rounded-xl border border-amber-700 bg-amber-950/30 p-3 text-sm text-amber-100">
          <p>{employeeBackupBusy ? '獨立員工記錄備份正在處理，其他導出與導入暫不可操作。' : '獨立員工備份任務結果尚未確認，其他導出與導入仍鎖定；請先核對紀錄及本人任務停止入口。'}</p>
          {tab !== 'inspect' && <button type="button" className={`${buttonClass} mt-2`} onClick={() => setTab('inspect')}>查看員工備份狀態</button>}
        </div>}
        {notice && <div role={notice.error ? 'alert' : 'status'} className={`break-words rounded-xl border p-4 text-sm leading-relaxed ${notice.error ? 'border-rose-500/50 bg-rose-950/40 text-rose-100' : 'border-cyan-800 bg-cyan-950/40 text-cyan-100'}`}>{notice.text}</div>}

        {run && <section aria-label="執行中的任務" className="rounded-xl border border-cyan-700 bg-slate-900/90 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="status">
              <h2 className="flex items-center gap-2 font-semibold text-cyan-100"><Loader2 className={`h-4 w-4 ${run.status !== 'paused' ? 'animate-spin' : ''}`} aria-hidden="true" />{run.kind === 'export' ? '導出任務' : '本機解密核驗'} · {run.status === 'paused' ? '已在請求邊界暫停' : run.status === 'pause-requested' ? '等待下一個請求邊界暫停' : run.status === 'cancelling' ? '取消處理中，尚待確認' : '執行中'}</h2>
              <p className="mt-1 text-xs text-slate-400">切換其他後台頁籤不會中斷任務。請勿重新整理、登出、關閉或讓裝置休眠。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {run.kind === 'export' && <button type="button" className={buttonClass} disabled={run.status === 'cancelling'} onClick={togglePause}>{pauseRequested.current ? <Play className="h-4 w-4" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}{run.status === 'paused' ? '繼續' : run.status === 'pause-requested' ? '撤回暫停' : '請求暫停'}</button>}
              <button type="button" className={buttonClass} disabled={run.status === 'cancelling'} onClick={cancel}><Square className="h-4 w-4" aria-hidden="true" />取消</button>
            </div>
          </div>
          <p className="mt-3 text-xs text-amber-200">{run.kind === 'export' ? '暫停只在下一個領域開始向服務端請求資料前生效，不會中斷正在進行的請求、加密或檔案寫入；整個最後領域可能先完成。' : '解密核驗不支援邊界暫停，可提出取消；不會呼叫資料庫寫入。'}</p>
          <p className="mt-2 text-xs text-slate-400">{wakeStatus === 'active' ? '已取得螢幕喚醒鎖，系統仍可能解除，不能保證背景執行。' : wakeStatus === 'requesting' ? '正在申請保持螢幕喚醒。' : '未取得或已失去喚醒鎖；請自行保持螢幕開啟，背景分頁可能被系統暫停。'}</p>
        </section>}

        {(run || progress) && <section aria-label="真實進度" className="rounded-xl border border-slate-700 bg-slate-900/80 p-4">
          <h2 className="font-semibold text-white">實際進度回報</h2>
          <p className="mt-1 text-xs text-slate-400">只顯示服務回報的階段計數，不推算百分比或完成時間；紀錄數、檔案數與資料量可能隨領域或階段重新計數。</p>
          {progress ? <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            {[
              ['領域', domainName(progress.domain)], ['階段', phaseName(progress.phase)],
              ['已完成領域／領域總數', `${count(progress.completedDomains)} / ${count(progress.totalDomains)}`],
              ['紀錄數', count(progress.rows)], ['檔案數', count(progress.files)], ['資料量', `${byteSize(progress.bytes)}（${count(progress.bytes)} 位元組）`],
            ].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg bg-slate-950/60 p-3"><dt className="text-xs text-slate-400">{label}</dt><dd className="mt-1 break-words font-medium text-cyan-100">{value}</dd></div>)}
          </dl> : <p className="mt-3 text-sm text-slate-400">正在準備本機工作區，尚未收到進度回報。</p>}
        </section>}
        {outputDirectory && <p className="break-all text-sm text-slate-300">本次輸出子目錄：<span className="font-mono text-cyan-200">{outputDirectory}</span>。請保留整個目錄，不要只保留最後一卷。</p>}

        <div role="tabpanel" id="migration-panel-export" aria-labelledby="migration-tab-export" hidden={tab !== 'export'} tabIndex={0} className="space-y-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
          <SourceCutoverPanel disabled={otherBusy} onBusyChange={setSourceBusy} onUncertainChange={setSourceUncertain} />
          <section className="rounded-xl border border-slate-700 bg-slate-900/80 p-4">
            <h2 className="font-semibold text-white">目前可驗證的領域</h2>
            <p className="mt-1 text-sm text-slate-400">預設導出目前協定的十個領域，不需逐個選擇員工。這不是完整站點覆蓋清單；原生檔案已接通，遷入檔案整組編排與下列缺項仍未完成。實際以各卷及索引的配套核驗為準。</p>
            <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">{scope.map(label => <li key={label} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true" />{label}</li>)}</ul>
            <div className="mt-4 rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 text-sm text-amber-100">
              <h3 className="font-semibold">目前缺項與限制</h3>
              <ul className="mt-2 list-disc space-y-2 pl-5">{limitations.map(text => <li key={text}>{text}</li>)}</ul>
            </div>
            <p className="mt-3 text-xs text-slate-400">不含公告、公告分類與僅供公告使用的素材；不搬登入會話、技術密鑰及詳細歷史訂單內容。保留新站超管，舊站超管憑據不覆蓋新站。</p>
          </section>
          <form onSubmit={submitExport} className="rounded-xl border border-slate-700 bg-slate-900/80 p-4">
            <h2 className="flex items-center gap-2 font-semibold text-white"><KeyRound className="h-4 w-4 text-cyan-300" aria-hidden="true" />驗證與加密</h2>
            <div className="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-sm text-amber-100">
              <p>日常備份不自動停站，來源變動會使核對失敗。切站時先在上方清零待發通知與處理中訂單，再明確暫停舊站；截止憑據會寫入加密索引。待處理提款仍會一起搬遷，之後只在新站處理，不能重複付款。</p>
              <p className="mt-2">檔案可能包含舊密碼校驗資料、財務、聊天及實名證件，並非只有文字或網址。請將加密檔與口令分開保管；口令遺失無法還原，服務端校驗超管目前密碼不等於搬遷超管密碼。</p>
            </div>
            <fieldset disabled={busy || selecting || !exportAvailable || !support.export} className="mt-4 space-y-4 disabled:opacity-60">
              <label className="block text-sm" htmlFor="migration-admin-password">目前超級管理員密碼（服務端驗證）<input id="migration-admin-password" type="password" autoComplete="current-password" value={adminPassword} onChange={event => setAdminPassword(event.target.value)} required className={inputClass} /></label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm" htmlFor="migration-passphrase">加密口令（至少 14 個字元）<input id="migration-passphrase" type={showPassphrase ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={14} required aria-describedby="migration-passphrase-help" className={inputClass} /></label>
                <label className="block text-sm" htmlFor="migration-confirmation">再次輸入加密口令<input id="migration-confirmation" type={showPassphrase ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={confirmation} onChange={event => setConfirmation(event.target.value)} minLength={14} required aria-invalid={confirmation.length > 0 && confirmation !== passphrase} aria-describedby="migration-passphrase-help" className={inputClass} /></label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className={buttonClass} onClick={() => {
                  try {
                    setPassphrase(randomPassphrase()); setConfirmation('');
                    setNotice({ error: false, text: '已產生隨機 24 字元口令。請顯示並安全另存，再親自輸入確認欄；頁面不會替你保存口令。' });
                  } catch { setNotice({ error: true, text: '瀏覽器無法安全產生口令，請自行設定至少 14 個字元的獨立口令。' }); }
                }}><Wand2 className="h-4 w-4" aria-hidden="true" />產生隨機 24 字元口令</button>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showPassphrase} onChange={event => setShowPassphrase(event.target.checked)} className="h-4 w-4 appearance-auto accent-cyan-400 focus-visible:outline-cyan-400" />顯示加密口令</label>
              </div>
              <p id="migration-passphrase-help" className="text-xs text-slate-400">口令不會存入本機儲存空間或紀錄；請使用與登入密碼不同的強口令。{confirmation && confirmation !== passphrase ? '兩次口令不一致。' : ''}</p>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className={buttonClass} onClick={() => void chooseDirectory()}><FolderOpen className="h-4 w-4" aria-hidden="true" />{selecting ? '正在選擇目錄' : '選擇保存目錄'}</button>
                <span className="break-all text-xs text-slate-400">{directory ? `將保存至新子目錄 ${directory.name}` : '每次導出須直接點擊選擇目錄，建立獨立子目錄；不覆寫舊檔。'}</span>
              </div>
              <label className="flex items-start gap-2 text-sm text-amber-100"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} required className="mt-1 h-4 w-4 shrink-0 appearance-auto accent-cyan-400 focus-visible:outline-cyan-400" /><span>我了解這是本地驗證版，已妥善另存口令並確認敏感資料保存位置；導出不代表可恢復或完成整站遷移。</span></label>
            </fieldset>
            <button type="submit" disabled={!exportReady} className={`${buttonClass} mt-4 border-cyan-700 bg-cyan-900/70 text-cyan-100 hover:bg-cyan-800`}><Download className="h-4 w-4" aria-hidden="true" />開始目前十個領域加密導出</button>
          </form>
        </div>

        <div role="tabpanel" id="migration-panel-inspect" aria-labelledby="migration-tab-inspect" hidden={tab !== 'inspect'} tabIndex={0} className="space-y-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
          <div className="rounded-xl border border-amber-700/60 bg-amber-950/30 p-4 text-sm text-amber-100">
            <h2 className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />先檢查檔案，再確認是否進行空站演練</h2>
            <p className="mt-2">上方本機核驗不會上傳、不暫存到服務端、不寫資料庫。下方維護態導入是獨立的實際寫入操作，需要目標准入、超管密碼、備份目錄及逐階段確認；目前不能用於正式切站或恢復營業。</p>
            <p className="mt-2">請一次選擇同一包的十個領域卷與一個加密索引（共 11 個 .edx 檔案）；缺卷或不配套會阻擋。配套核驗通過僅證明目前協定的檔案組一致，不代表完整站點覆蓋、目標相容或業務恢復通過。</p>
          </div>
          <form onSubmit={submitInspect} className="rounded-xl border border-slate-700 bg-slate-900/80 p-4">
            <fieldset disabled={busy || selecting || !support.workspace} className="space-y-4 disabled:opacity-60">
              <label className="block text-sm" htmlFor="migration-files">選擇加密卷（可多選 .edx）<input id="migration-files" type="file" accept=".edx" multiple required className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-slate-700 file:px-3 file:py-1 file:text-slate-100`} onChange={event => {
                const files = Array.from(event.target.files ?? []);
                setResult(null);
                if (files.some(file => !file.name.toLowerCase().endsWith('.edx'))) {
                  event.target.value = ''; setInspectFiles([]);
                  setNotice({ error: true, text: '僅接受 .edx 加密卷，請重新選擇；未讀取檔案內容。' });
                } else { setInspectFiles(files); setNotice(null); }
              }} /></label>
              <p className="text-xs text-slate-400">已選 {count(inspectFiles.length)} 卷，合計 {byteSize(inspectFiles.reduce((sum, file) => sum + file.size, 0))}。不在頁面顯示解密原文。</p>
              <label className="block text-sm" htmlFor="migration-inspect-passphrase">原導出口令（至少 14 個字元）<input id="migration-inspect-passphrase" type="password" autoComplete="off" spellCheck={false} value={inspectPassphrase} onChange={event => setInspectPassphrase(event.target.value)} minLength={14} required className={inputClass} /></label>
            </fieldset>
            {!support.workspace && <p className="mt-3 text-sm text-amber-200">本機核驗需要安全連線及瀏覽器私有臨時工作區，本瀏覽器不支援，無法開始。</p>}
            <button type="submit" disabled={busy || selecting || !support.workspace || !inspectFiles.length || Array.from(inspectPassphrase).length < 14} className={`${buttonClass} mt-4`}><FileCheck2 className="h-4 w-4" aria-hidden="true" />僅解密與核驗，不導入</button>
          </form>
          <EmployeeSafetyBackupPanel disabled={run !== null || stopping || selecting || importBusy} supported={support.export}
            onBusyChange={setEmployeeBackupBusy} onPendingChange={setEmployeeBackupPending} />
          <EmployeeSiteImport files={inspectFiles} inspection={result?.kind === 'inspect' ? result.data : null}
            disabled={run !== null || stopping || selecting || employeeBackupBusy || employeeBackupPending} supported={support.export} onBusyChange={setImportBusy} onProgress={setProgress} />
        </div>

        <div role="tabpanel" id="migration-panel-history" aria-labelledby="migration-tab-history" hidden={tab !== 'history'} tabIndex={0} className="rounded-xl border border-slate-700 bg-slate-900/80 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold text-white">服務端階段任務紀錄</h2><button type="button" className={buttonClass} disabled={stopping || historyStatus === 'loading'} onClick={() => void refreshHistory()}><RefreshCw className="h-4 w-4" aria-hidden="true" />刷新紀錄</button></div>
          <p className="mt-2 text-sm text-amber-200">歷史項目都是階段任務，不是整站遷移完成證明，也不是磁碟檔案清單。本機解密檢查不會新增服務端紀錄。時間統一 UTC+8。</p>
          <form onSubmit={event => void submitStop(event)} className="mt-4 rounded-lg border border-amber-700/60 bg-amber-950/20 p-4">
            <h3 className="font-semibold text-amber-100">停止本人未結束的導出任務</h3>
            <p id="migration-stop-help" className="mt-2 text-sm text-slate-300">只結束目前登入管理員本人未結束的導出任務，並清除該任務的技術暫存；不取消導入任務、不清理業務資料、不刪除已保存檔案、不回滾業務，也不解除維護。只在你明確提交本表單後執行，不會自動停止。</p>
            <fieldset disabled={busy || selecting || capabilityStatus !== 'ready'} className="mt-3 grid gap-3 disabled:opacity-60 sm:grid-cols-2">
              <label htmlFor="migration-stop-password" className="block text-sm">目前超級管理員密碼<input id="migration-stop-password" type="password" autoComplete="current-password" required value={stopPassword} onChange={event => setStopPassword(event.target.value)} aria-describedby="migration-stop-help" className={inputClass} /></label>
              <label htmlFor="migration-stop-confirmation" className="block text-sm">輸入「{stopConfirmationText}」<input id="migration-stop-confirmation" type="text" autoComplete="off" spellCheck={false} required value={stopConfirmation} onChange={event => setStopConfirmation(event.target.value)} aria-invalid={stopConfirmation.length > 0 && stopConfirmation !== stopConfirmationText} aria-describedby="migration-stop-help" className={inputClass} /></label>
            </fieldset>
            <button type="submit" className={`${buttonClass} mt-3 border-amber-700 text-amber-100`} disabled={busy || selecting || capabilityStatus !== 'ready' || !stopPassword || stopConfirmation !== stopConfirmationText}><Square className="h-4 w-4" aria-hidden="true" />{stopping ? '正在確認停止結果……' : '確認停止本人導出任務'}</button>
            {stopping && <p role="status" className="mt-2 text-sm text-amber-200">停止請求處理中，請勿重複提交或關閉頁面；尚不能判定服務端結果。</p>}
            {capabilityStatus !== 'ready' && <p className="mt-2 text-sm text-amber-200">後端能力尚未確認，停止入口不可操作；不能據此判定沒有未結束任務。</p>}
          </form>
          {historyStatus === 'loading' && <p role="status" className="mt-4 text-sm text-slate-400">正在查詢紀錄……</p>}
          {historyStatus === 'unavailable' && <p role="alert" className="mt-4 rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-100">後端尚未提供紀錄接口、未部署或無法讀取，無法確認任務紀錄。這不代表沒有任務；請保留已有檔案，勿據此重試或判定已回滾。</p>}
          {historyStatus === 'ready' && history?.length === 0 && <p className="mt-4 text-sm text-slate-400">後端本次未回傳階段紀錄；不代表磁碟上沒有既有檔案。</p>}
          {historyStatus === 'ready' && history && history.length > 0 && <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm text-slate-200"><caption className="sr-only">服務端階段任務，非整站完成紀錄，時間 UTC+8</caption><thead className="border-b border-slate-700 text-xs text-slate-400"><tr>{['任務編號', '類型', '階段狀態', '開始（UTC+8）', '結束（UTC+8）'].map(label => <th key={label} scope="col" className="px-3 py-2">{label}</th>)}</tr></thead><tbody>{history.map((entry, index) => <tr key={`${entry.id}-${index}`} className="border-b border-slate-800"><td className="max-w-[16rem] break-all px-3 py-3 font-mono text-xs">{entry.id}</td><td className="px-3 py-3">{entry.kind === 'export' || entry.kind.startsWith('export:') ? '導出階段' : entry.kind === 'import' || entry.kind.startsWith('import:') ? '導入階段' : '其他階段'}</td><td className="px-3 py-3">{translatedLabel(statusLabels, entry.status, '未識別狀態，須核對')}</td><td className="whitespace-nowrap px-3 py-3">{timestamp(entry.startedAt)}</td><td className="whitespace-nowrap px-3 py-3">{timestamp(entry.finishedAt)}</td></tr>)}</tbody></table></div>}
        </div>

        {result && <section aria-label="各卷核驗結果" className="rounded-xl border border-cyan-800 bg-slate-900/90 p-4">
          <h2 className="font-semibold text-cyan-100">{result.kind === 'export' ? '本次導出各卷結果' : '輸入檔案各卷解密核驗結果'}</h2>
          <p className="mt-2 break-all text-xs text-slate-400">包：{result.data.packageId} · 來源站：{result.data.sourceSiteId}</p>
          <p className="mt-2 text-sm font-semibold text-amber-200">此為檔案層核驗，不代表資料庫已完成導入；完整站點與業務恢復仍未放行。</p>
          <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm text-slate-200"><caption className="sr-only">實際回傳的卷清單及密文 SHA-256，不代表完整整站備份</caption><thead className="border-b border-slate-700 text-xs text-slate-400"><tr>{['領域', '檔名 / 密文 SHA-256', '紀錄', '檔案', '密文大小'].map(label => <th key={label} scope="col" className="px-3 py-2">{label}</th>)}</tr></thead><tbody>{result.data.volumes.map((volume, index) => <tr key={`${volume.filename}-${index}`} className="border-b border-slate-800"><td className="px-3 py-3">{domainName(volume.domain)}</td><td className="min-w-[15rem] max-w-xs break-all px-3 py-3"><p>{volume.filename}</p><p className="mt-1 font-mono text-xs text-slate-400">{volume.cipherSha256}</p></td><td className="px-3 py-3">{count(volume.rows)}</td><td className="px-3 py-3">{count(volume.files)}</td><td className="whitespace-nowrap px-3 py-3">{byteSize(volume.cipherBytes)}</td></tr>)}</tbody></table></div>
        </section>}
      </div>
    </section>
  );
}
