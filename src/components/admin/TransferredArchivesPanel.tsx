import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Database, LockKeyhole } from 'lucide-react';
import {
  createTransferredArchivesReader, type TransferredArchiveNamespace, type TransferredArchivePage,
  type TransferredArchiveRow, type TransferredArchivesReader,
} from '../../lib/employeeTransfer/archiveReader';
import { ARCHIVES_TABLE_KEYS, type ArchivesTableKey } from '../../lib/employeeTransfer/archiveTransfer';

const defaultReader = createTransferredArchivesReader();
const labels: Record<ArchivesTableKey, string> = {
  content_audit_events: '內容稽核事件', deleted_employee_accounts: '已刪員工帳戶',
  deleted_employee_notifications: '已刪員工通知', content_audit_recipient_versions: '通知收件版本',
  deleted_employee_summaries: '歷史員工摘要', deleted_employee_withdrawals: '歷史提款紀錄',
};
const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300';
const button = `rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40 ${focus}`;
type Navigation = { after: string | null; history: (string | null)[] };

// A failed next/previous page never replaces the last confirmed page. Unmounts,
// source/category changes and superseded requests cannot display a late response.
function useCursorPage<T extends { readonly next_after: string | null }>(load: (after: string | null, signal: AbortSignal) => Promise<T>) {
  const [navigation, setNavigation] = useState<Navigation>({ after: null, history: [] });
  const [loaded, setLoaded] = useState<{ data: T; navigation: Navigation } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false);
    void load(navigation.after, controller.signal).then(data => {
      if (!controller.signal.aborted) setLoaded({ data, navigation });
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [load, navigation, retry]);
  return {
    loaded, loading, error, retry: () => setRetry(value => value + 1),
    previous: () => {
      if (!loaded || !loaded.navigation.history.length) return;
      const history = loaded.navigation.history.slice(0, -1);
      setNavigation({ after: loaded.navigation.history[history.length], history });
    },
    next: () => {
      if (!loaded || loaded.data.next_after === null) return;
      setNavigation({ after: loaded.data.next_after, history: [...loaded.navigation.history, loaded.navigation.after] });
    },
  };
}
function Pager({ page, label }: { page: ReturnType<typeof useCursorPage>; label: string }) {
  return <div className="flex flex-wrap items-center gap-2" aria-label={`${label}分頁`}>
    <button type="button" className={button} disabled={page.loading || page.error || !page.loaded?.navigation.history.length} onClick={page.previous} aria-label={`${label}上一頁`}><ChevronLeft className="mr-1 inline h-3 w-3" aria-hidden="true" />上一頁</button>
    <span className="text-xs text-slate-400" aria-live="polite">第 {(page.loaded?.navigation.history.length ?? 0) + 1} 頁</span>
    <button type="button" className={button} disabled={page.loading || page.error || !page.loaded?.data.next_after} onClick={page.next} aria-label={`${label}下一頁`}>下一頁<ChevronRight className="ml-1 inline h-3 w-3" aria-hidden="true" /></button>
    {page.loading && <span role="status" className="text-xs text-cyan-300">正在載入…</span>}
    {page.error && <div role="alert" className="min-w-0 text-xs text-rose-300">讀取或回執核驗失敗，已保留目前確認的頁面。<button type="button" className={`ml-2 underline ${focus}`} onClick={page.retry} aria-label={`重試${label}`}>重試</button></div>}
  </div>;
}
function time(value: string): string {
  return `${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value))} (UTC+8)`;
}
function SourceIdentity({ source }: { source: TransferredArchiveNamespace }) {
  return <dl className="min-w-0 space-y-1 text-xs [overflow-wrap:anywhere]">
    <div><dt className="inline text-slate-400">來源站 </dt><dd className="inline font-mono text-cyan-200">{source.source_site_id}</dd></div>
    <div><dt className="inline text-slate-400">來源包 </dt><dd className="inline font-mono text-slate-200">{source.package_id}</dd></div>
    <div><dt className="inline text-slate-400">匯入時間 </dt><dd className="inline text-slate-300"><time dateTime={source.imported_at}>{time(source.imported_at)}</time></dd></div>
  </dl>;
}
function RowSummary({ row, tableKey }: { row: TransferredArchiveRow; tableKey: ArchivesTableKey }) {
  // Display-only string fields. Financial numbers and IDs are NOT read from a
  // rounded JSON.parse result; the immutable original line below is authoritative.
  const display: Record<string, unknown> = JSON.parse(row.sourceLine);
  const textFields = ['account_username', 'employee_number', 'employee_account', 'actor_username', 'action', 'status'];
  const texts = textFields.flatMap(key => typeof display[key] === 'string' ? [display[key].slice(0, 160)] : []);
  const historicalTime = ['occurred_at', 'deleted_at', 'created_at'].map(key => display[key]).find(value => typeof value === 'string');
  return <>
    <span className="block text-sm font-semibold text-slate-100">{labels[tableKey]}{texts.length ? ` · ${texts.join(' · ')}` : ''}</span>
    <span className="mt-1 block font-mono text-xs text-slate-400">來源記錄 ID {row.sourceId}</span>
    {typeof historicalTime === 'string' && <time className="mt-1 block text-xs text-slate-400" dateTime={historicalTime}>{time(historicalTime)}</time>}
  </>;
}
function ArchiveRow({ row, tableKey }: { row: TransferredArchiveRow; tableKey: ArchivesTableKey }) {
  return <details className="min-w-0 max-w-full rounded-xl border border-slate-700 bg-slate-900/70 p-3">
    <summary className={`min-w-0 cursor-pointer rounded text-left [overflow-wrap:anywhere] ${focus}`}><RowSummary row={row} tableKey={tableKey} /><span className="mt-2 block text-xs text-cyan-300">展開來源原文（未重序列化）</span></summary>
    <p className="my-3 text-xs text-slate-400">以下為唯讀來源原文；金額、ID、空值及歷史時間以原文為準。內容中的 HTML 與網址僅作文字顯示，不會執行或產生附件連結。</p>
    <pre aria-label="來源原始行" className="max-h-[32rem] min-w-0 max-w-full overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-200 [overflow-wrap:anywhere]">{row.sourceLine}</pre>
  </details>;
}
function ArchiveRecords({ source, tableKey, reader }: {
  source: TransferredArchiveNamespace; tableKey: ArchivesTableKey; reader: TransferredArchivesReader;
}) {
  const load = useCallback((after: string | null, signal: AbortSignal) =>
    reader.page(source.source_site_id, source.package_id, tableKey, after, 100, signal),
  [reader, source.source_site_id, source.package_id, tableKey]);
  const page = useCursorPage<TransferredArchivePage>(load);
  return <section aria-label={labels[tableKey]} className="min-w-0 space-y-3" aria-busy={page.loading}>
    <Pager page={page} label="檔案記錄" />
    {page.loaded?.data.count === 0 && <p className="text-sm text-slate-400">此類別沒有記錄。</p>}
    {page.loaded?.data.rows.map(row => <ArchiveRow key={row.sourceId} row={row} tableKey={tableKey} />)}
  </section>;
}

export default function TransferredArchivesPanel({ reader = defaultReader }: { reader?: TransferredArchivesReader }) {
  const load = useCallback((after: string | null, signal: AbortSignal) => reader.namespaces(after, 30, signal), [reader]);
  const namespaces = useCursorPage(load);
  const [selected, setSelected] = useState<TransferredArchiveNamespace | null>(null);
  const [tableKey, setTableKey] = useState<ArchivesTableKey>('content_audit_events');
  return <section aria-label="遷入檔案" className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-3 sm:p-5">
    <div className="flex items-center gap-2 text-cyan-200"><LockKeyhole className="h-4 w-4 shrink-0" aria-hidden="true" /><h2 className="font-bold">遷入檔案 · 超級管理員唯讀</h2></div>
    <p className="text-xs leading-6 text-slate-400">依來源站與來源包獨立保存，只顯示已核驗的持久化記錄。歷史員工與操作者均為原站身分，不與新站在職帳戶或財務資料串聯。本頁不提供修改、刪除或還原操作。</p>
    <div role="note" className="flex min-w-0 gap-2 rounded-xl border border-amber-500/30 bg-amber-950/30 p-3 text-xs leading-6 text-amber-200"><AlertTriangle className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" /><p>附件讀取尚未接線，不產生舊站連結。附件待核驗時，記錄可讀不代表完整留證或完整遷移。</p></div>
    <Pager page={namespaces} label="來源" />
    {namespaces.loaded?.data.items.length === 0 && <p className="text-sm text-slate-400">尚無已核驗的遷入檔案。</p>}
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <div aria-label="來源命名空間清單" className="min-w-0 space-y-2">
        {namespaces.loaded?.data.items.map(source => {
          const active = selected?.source_site_id === source.source_site_id && selected.package_id === source.package_id;
          return <div key={`${source.source_site_id}:${source.package_id}`} className={`min-w-0 rounded-xl border p-3 ${active ? 'border-cyan-400 bg-cyan-950/30' : 'border-slate-700 bg-slate-900/50'}`}>
            <SourceIdentity source={source} />
            <p className={`my-2 text-xs ${source.media_pending ? 'text-amber-200' : 'text-slate-400'}`}>{source.media_pending ? '附件待核驗' : '附件已核驗（讀取尚未接線）'}</p>
            <p className="mb-2 text-xs text-slate-400">六類記錄合計 {ARCHIVES_TABLE_KEYS.reduce((sum, key) => sum + source.counts[key], 0)} 筆</p>
            <button type="button" aria-pressed={active} className={button} onClick={() => setSelected(source)}><Database className="mr-1 inline h-3 w-3" aria-hidden="true" />{active ? '目前來源' : '查看此來源'}</button>
          </div>;
        })}
      </div>
      <div className="min-w-0 space-y-4">
        {!selected ? <p className="text-sm text-slate-400">請選擇來源站與來源包。</p> : <>
          <SourceIdentity source={selected} />
          <p role="status" className={`text-xs ${selected.media_pending ? 'text-amber-200' : 'text-slate-400'}`}>{selected.media_pending ? '此來源附件待核驗；不提供舊站附件連結。' : '此來源附件已核驗；附件讀取尚未接線。'}</p>
          <label className="block text-xs text-slate-300">檔案類別
            <select className={`mt-2 block w-full min-w-0 rounded-lg border border-slate-600 bg-slate-900 p-2 text-sm ${focus}`} value={tableKey} onChange={event => setTableKey(event.target.value as ArchivesTableKey)}>
              {ARCHIVES_TABLE_KEYS.map(key => <option key={key} value={key}>{labels[key]}（{selected.counts[key]}）</option>)}
            </select>
          </label>
          <ArchiveRecords key={`${selected.source_site_id}:${selected.package_id}:${tableKey}`} source={selected} tableKey={tableKey} reader={reader} />
        </>}
      </div>
    </div>
  </section>;
}
