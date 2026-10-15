import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowLeft, Bell, ChevronRight, Megaphone, MessageCircle, Search, Trash2, UserRoundX, X } from 'lucide-react';
import { getAdminFinancialSessionToken } from '../../lib/auth';
import { cancelAuditDeletionConfirmation, executeEmployeeArchiveDeletion, listPendingEmployeeArchiveDeletions, loadAuditedMedia } from '../../lib/contentAudit';
import { sanitizeHTML } from '../../lib/sanitizeHTML';
import { formatSupabaseError, supabase } from '../../lib/supabase';
import EmployeeNotificationDetailPanel from '../employee/EmployeeNotificationDetailPanel';

type DeletedEmployee = {
  id: string;
  operation_id: string;
  employee_id: string;
  account_username: string | null;
  employee_number: string | null;
  account_real_name: string | null;
  account_created_at: string | null;
  account_remarks: string | null;
  owner_admin_id: string;
  owner_username: string | null;
  actor_admin_id: string;
  actor_username: string;
  actor_role: string;
  deletion_source: 'employee_delete' | 'admin_delete';
  deleted_at: string;
  cleared_at: string | null;
};
type RelatedEvidence = { id: string; operation_id: string; entity_type: 'aaa_service' | 'ccc_service'; action: 'edit' | 'delete' | 'conversation_delete' | 'customer_delete' | 'employee_delete' | 'admin_delete' | 'source_edit' | 'source_delete'; occurred_at: string; cleared_at: string | null; before_data: Record<string, unknown> | null; after_data: Record<string, unknown> | null; media_refs: Record<string, string> | null };
type EmployeeDetail = DeletedEmployee & { account_summary: { is_verified: boolean; total_income: number; available_balance: number | null; frozen_balance: number | null; total_orders: number } | null; related_total: number; related_counts: { aaa_service: number; ccc_service: number }; related_items: RelatedEvidence[] };
type WithdrawalRow = { id: string; amount: number; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; created_at: string | null };
type NotificationRow = { id: string; title: string | null; sender_username: string | null; sent_at: string | null; is_read: string | null; audit_origin: string | null; cleared_at: string | null };
type NotificationDetail = { id: string; message_data: Record<string, unknown> | null; recipient_data: Record<string, unknown> | null; cleared_at: string | null };
type Filters = { owner: string; search: string };
type Section = 'profile' | 'notifications' | 'aaa_service' | 'ccc_service';

const emptyFilters: Filters = { owner: '', search: '' };
const PAGE_SIZE = 30;
const RELATED_PAGE_SIZE = 20;
const inputClass = 'mt-1.5 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus-visible:border-cyan-400 focus-visible:ring-2 focus-visible:ring-cyan-400/30';
const focusClass = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';
const sections: Array<[Section, string]> = [['profile', '帳戶資料'], ['notifications', '通知檔案'], ['aaa_service', '模擬客戶'], ['ccc_service', '經理']];

function displayTime(value: string | null): string {
  if (!value) return '—';
  return `${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value))} (UTC+8)`;
}

function DetailField({ label, value }: { label: string; value: string | null }) {
  return <div className="min-w-0 border-b border-white/[0.07] py-2.5 last:border-0"><dt className="text-[10px] font-semibold tracking-wide text-slate-400">{label}</dt><dd className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-100">{value || '—'}</dd></div>;
}

function ArchiveField({ label, value }: { label: string; value: string | null }) {
  return <div className="min-w-0 rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 py-2.5"><dt className="text-[10px] font-semibold text-slate-400">{label}</dt><dd className="mt-1 break-words text-xs font-medium leading-5 text-slate-100">{value || '—'}</dd></div>;
}

function readableSnapshot(value: unknown): string {
  if (typeof value !== 'string') return '';
  const document = new DOMParser().parseFromString(sanitizeHTML(value, {
    allowedTags: ['p', 'br', 'div', 'span', 'strong', 'em', 'u', 's', 'b', 'i', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4'],
    allowedAttributes: [],
  }), 'text/html');
  document.querySelectorAll('br').forEach(element => element.replaceWith('\n'));
  document.querySelectorAll('p, div, li, h1, h2, h3, h4, blockquote').forEach(element => element.append('\n'));
  return (document.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function ArchivedChatMedia({ eventId, path }: { eventId: string; path: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [media, setMedia] = useState<{ url: string; type: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    let currentUrl: string | null = null;
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void loadAuditedMedia(eventId, path).then(result => {
        if (!active) { URL.revokeObjectURL(result.url); return; }
        currentUrl = result.url;
        setMedia(result);
      }).catch(cause => { if (active) setError(formatSupabaseError(cause)); });
    }, { rootMargin: '120px' });
    observer.observe(node);
    return () => {
      active = false;
      observer.disconnect();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [eventId, path, retryKey]);

  useEffect(() => {
    if (!expanded) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [expanded]);

  return <div ref={containerRef} className="mt-2">{media?.type === 'video/mp4' ? <video src={media.url} controls preload="none" className="max-h-64 max-w-full rounded-lg" /> : media ? <button type="button" onClick={() => setExpanded(true)} aria-label="放大封存圖片" className={focusClass}><img src={media.url} alt="封存的聊天圖片" className="max-h-52 max-w-full rounded-lg object-contain" /></button> : error ? <button type="button" onClick={() => { setError(null); setRetryKey(value => value + 1); }} className={`text-xs text-cyan-200 underline ${focusClass}`}>圖片載入失敗，點此重試：{error}</button> : <span className="text-xs text-slate-400">圖片載入中…</span>}{expanded && media && createPortal(<div data-archive-media-preview className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/90 p-4" onClick={() => setExpanded(false)}><div role="dialog" aria-modal="true" aria-label="封存圖片預覽" className="relative" onClick={event => event.stopPropagation()}><button type="button" autoFocus onClick={() => setExpanded(false)} aria-label="關閉圖片預覽" className="absolute -right-2 -top-11 rounded-full bg-white/15 p-2 text-white"><X className="h-5 w-5" /></button><img src={media.url} alt="封存圖片預覽" className="max-h-[85vh] max-w-[95vw] object-contain" /></div></div>, document.body)}</div>;
}

function ArchivedRichContent({ html, eventId, attachments }: { html: string; eventId: string; attachments: Array<[string, string]> }) {
  const parts = html.split(/(<img\b[^>]*>|<video\b[\s\S]*?<\/video>)/gi);
  const inlinePaths = new Set(parts.filter(part => /^<(img|video)\b/i.test(part)).flatMap(part =>
    attachments.filter(([source]) => part.includes(source) || part.includes(source.replace(/&/g, '&amp;'))).map(([, path]) => path)));
  return <div className="min-w-0 break-words text-sm leading-6 [&_p]:my-1 [&_ul]:ml-4 [&_ul]:list-disc [&_ol]:ml-4 [&_ol]:list-decimal" style={{ overflowWrap: 'anywhere' }}>
    {parts.map((part, index) => /^<(img|video)\b/i.test(part) ? (
      attachments.filter(([source]) => part.includes(source) || part.includes(source.replace(/&/g, '&amp;'))).length
        ? attachments.filter(([source]) => part.includes(source) || part.includes(source.replace(/&/g, '&amp;'))).map(([, path]) => <ArchivedChatMedia key={`${eventId}:${index}:${path}`} eventId={eventId} path={path} />)
        : <p key={index} className="text-xs text-slate-400">原圖無法還原。</p>
    ) : part ? <div key={index} className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: sanitizeHTML(part, { allowedTags: ['p', 'br', 'div', 'span', 'strong', 'em', 'u', 's', 'b', 'i', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4'], allowedAttributes: [] }) }} /> : null)}
    {attachments.filter(([, path]) => !inlinePaths.has(path)).map(([, path]) => <ArchivedChatMedia key={`${eventId}:${path}`} eventId={eventId} path={path} />)}
  </div>;
}

function ArchivedChatCard({ event, workspace }: { event: RelatedEvidence; workspace: 'aaa_service' | 'ccc_service' }) {
  const [cardOpen, setCardOpen] = useState(false);
  const snapshot = event.after_data?.message ? event.after_data : event.before_data;
  const message = snapshot?.message && typeof snapshot.message === 'object' ? snapshot.message as Record<string, unknown> : null;
  const content = typeof message?.message_content === 'string' ? message.message_content : '';
  const cardHtml = typeof snapshot?.rendered_html === 'string' ? snapshot.rendered_html : content;
  const imageUrl = typeof message?.image_url === 'string' ? message.image_url : '';
  const sourceText = JSON.stringify(snapshot || {});
  const attachments = Object.entries(event.media_refs || {}).filter(([source]) => sourceText.includes(source) || sourceText.includes(source.replace(/&/g, '&amp;')));
  const imagePath = attachments.find(([source]) => source === imageUrl)?.[1] || attachments[0]?.[1];
  const rating = message?.rating_data && typeof message.rating_data === 'object' ? message.rating_data as Record<string, unknown> : null;
  const sender = message?.sender_type === 'customer' ? readableSnapshot(snapshot?.customer_name) || '客戶' : readableSnapshot(snapshot?.employee_name) || '員工';
  const title = readableSnapshot(message?.title);
  const subtitle = readableSnapshot(message?.subtitle);

  const isCustomer = message?.sender_type === 'customer';
  useEffect(() => {
    if (!cardOpen) return;
    const onEscape = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === 'Escape' && !document.querySelector('[data-archive-media-preview]')) setCardOpen(false);
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [cardOpen]);
  return <><article className={`flex min-w-0 ${isCustomer ? 'justify-end' : 'justify-start'}`}>
    <div className={`max-w-[88%] min-w-0 sm:max-w-[74%] ${isCustomer ? 'text-right' : ''}`}>
      <div className={`mb-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-400 ${isCustomer ? 'justify-end' : ''}`}><strong className="text-slate-200">{sender}</strong></div>
      {message?.message_type === 'rich_card' && !event.cleared_at ? <button type="button" onClick={() => setCardOpen(true)} className={`block w-[240px] max-w-full overflow-hidden rounded-2xl text-left shadow-[0_2px_12px_rgba(37,99,246,0.15)] transition hover:shadow-[0_8px_24px_rgba(37,99,246,0.22)] ${focusClass}`}><span className="flex items-start gap-2.5 bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 px-4 pb-3.5 pt-4 text-white"><Megaphone className="mt-0.5 h-5 w-5 shrink-0" /><span className="min-w-0"><strong className="block break-words text-[13px] leading-snug">{title || '查看詳情'}</strong>{subtitle && <span className="mt-1 block break-words text-[11px] text-blue-100/80">{subtitle}</span>}</span></span><span className="flex items-center justify-between border-t border-blue-100 bg-white px-4 py-2 text-[11px] font-medium text-blue-600">查看詳情<ChevronRight className="h-4 w-4 text-blue-400" /></span></button> : <div className={`min-w-0 rounded-[20px] border-2 px-4 py-3 text-left text-sm leading-6 shadow-lg ${isCustomer ? workspace === 'aaa_service' ? 'rounded-tr-md border-orange-200/80 bg-white text-slate-800' : 'rounded-tr-md border-emerald-200/80 bg-white text-slate-800' : workspace === 'aaa_service' ? 'rounded-tl-md border-orange-300/35 bg-gradient-to-br from-slate-800 to-orange-950/70 text-slate-100' : 'rounded-tl-md border-emerald-300/35 bg-gradient-to-br from-slate-800 to-emerald-950/70 text-slate-100'}`}>
        {event.cleared_at ? <p className="text-rose-600">此則內容已正式清除。</p> : message?.message_type === 'image' ? imagePath ? <ArchivedChatMedia eventId={event.id} path={imagePath} /> : <p className="text-slate-400">原圖無法還原。</p> : <>{message?.message_type === 'rating_request' ? <p>評分請求</p> : message?.message_type === 'rating_result' ? <p>服務評分：{String(rating?.rating ?? '—')} · {readableSnapshot(rating?.comment)}</p> : message?.message_type === 'tip' ? <p>打賞：{String(rating?.tip_amount ?? '—')}</p> : content ? <ArchivedRichContent html={content} eventId={event.id} attachments={attachments} /> : <p className="text-slate-400">沒有可顯示的文字內容。</p>}</>}
      </div>}
      <time className={`mt-1 block text-[10px] tabular-nums text-slate-400 ${isCustomer ? 'text-right' : ''}`}>{displayTime(typeof message?.created_at === 'string' ? message.created_at : event.occurred_at)}</time>
    </div>
  </article>
  {cardOpen && createPortal(<div data-archive-card-preview className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm xl:p-6" onClick={() => setCardOpen(false)}><section role="dialog" aria-modal="true" aria-labelledby={`archive-card-${event.id}`} className="flex h-full w-full flex-col overflow-hidden bg-white shadow-2xl xl:h-auto xl:max-h-[85vh] xl:w-[680px] xl:rounded-2xl" onClick={clickEvent => clickEvent.stopPropagation()}><header className="relative shrink-0 bg-gradient-to-br from-blue-800 via-blue-600 to-blue-700 px-5 pb-5 pt-6 text-white"><button type="button" autoFocus onClick={() => setCardOpen(false)} aria-label="關閉卡片詳情" className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-white/15 hover:bg-white/25"><X className="h-4 w-4" /></button><p className="mb-3 text-xs text-blue-100">{displayTime(typeof message?.created_at === 'string' ? message.created_at : event.occurred_at)}</p><div className="flex items-start gap-3 pr-10"><span className="rounded-xl border border-white/20 bg-white/15 p-2.5"><Megaphone className="h-6 w-6" /></span><div className="min-w-0"><h2 id={`archive-card-${event.id}`} className="break-words text-lg font-bold">{title || '訊息卡片'}</h2>{subtitle && <p className="mt-1 break-words text-sm text-blue-100">{subtitle}</p>}</div></div></header><div className="min-h-0 flex-1 overflow-y-auto p-5 text-slate-700 sm:p-6">{cardHtml ? <ArchivedRichContent html={cardHtml} eventId={event.id} attachments={attachments} /> : <p className="text-sm text-slate-500">此卡片的內容無法還原。</p>}</div><footer className="shrink-0 border-t border-slate-100 bg-slate-50 px-5 py-3"><button type="button" onClick={() => setCardOpen(false)} className="w-full rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 px-5 py-3 text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-600">關閉</button></footer></section></div>, document.body)}
  </>;
}

function groupRelatedEvents(items: RelatedEvidence[]) {
  const groups = new Map<string, { id: string; name: string; events: RelatedEvidence[] }>();
  for (const event of items) {
    const snapshot = event.before_data?.message ? event.before_data : event.after_data;
    const message = snapshot?.message && typeof snapshot.message === 'object' ? snapshot.message as Record<string, unknown> : null;
    const otherMessage = event.after_data?.message && typeof event.after_data.message === 'object' ? event.after_data.message as Record<string, unknown> : null;
    const customerId = typeof message?.customer_id === 'string' ? message.customer_id : typeof otherMessage?.customer_id === 'string' ? otherMessage.customer_id : null;
    const id = customerId || `event:${event.id}`;
    const name = readableSnapshot(snapshot?.customer_name || event.after_data?.customer_name) || (customerId ? `客戶 ${customerId.slice(0, 8)}` : '客戶身分未留存');
    const group = groups.get(id);
    if (group) {
      group.events.push(event);
      if (group.name.startsWith('客戶 ') || group.name === '客戶身分未留存') group.name = name;
    } else {
      groups.set(id, { id, name, events: [event] });
    }
  }
  return Array.from(groups.values()).map(group => {
    const ids = new Set<string>();
    const events = group.events.filter(event => {
      const snapshot = event.after_data?.message ? event.after_data : event.before_data;
      const message = snapshot?.message && typeof snapshot.message === 'object' ? snapshot.message as Record<string, unknown> : null;
      const id = typeof message?.id === 'string' ? message.id : `event:${event.id}`;
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    }).sort((a, b) => {
      const aMessage = (a.after_data?.message || a.before_data?.message) as Record<string, unknown> | undefined;
      const bMessage = (b.after_data?.message || b.before_data?.message) as Record<string, unknown> | undefined;
      return String(aMessage?.created_at || a.occurred_at).localeCompare(String(bMessage?.created_at || b.occurred_at));
    });
    return { ...group, events };
  });
}

export default function DeletedEmployeesPanel({ switcher, isActive, refreshKey, onDeleted, onDeleteResult, initialSelectedId, initialSection, availableAdmins, onSelectSection, onSelectEmployee }: {
  switcher: ReactNode;
  isActive: boolean;
  refreshKey: number;
  onDeleted: () => void;
  onDeleteResult: (result: { type: 'success' | 'error'; message: string }) => void;
  initialSelectedId: string | null;
  initialSection: Section;
  availableAdmins: Array<{ id: string; username: string }>;
  onSelectSection: (section: Section) => void;
  onSelectEmployee: (id: string | null) => void;
}) {
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [items, setItems] = useState<DeletedEmployee[]>([]);
  const [owners, setOwners] = useState<Array<{ id: string; username: string; event_count: number }>>([]);
  const [ownersLoaded, setOwnersLoaded] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [lastPageLoaded, setLastPageLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [section, setSection] = useState<Section>(initialSection);
  const [detail, setDetail] = useState<EmployeeDetail | null>(null);
  const [related, setRelated] = useState<Record<'aaa_service' | 'ccc_service', { items: RelatedEvidence[]; total: number }>>({ aaa_service: { items: [], total: 0 }, ccc_service: { items: [], total: 0 } });
  const [relatedLoaded, setRelatedLoaded] = useState({ aaa_service: false, ccc_service: false });
  const [relatedRetryKey, setRelatedRetryKey] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRow[]>([]);
  const [withdrawalTotal, setWithdrawalTotal] = useState(0);
  const [withdrawalPage, setWithdrawalPage] = useState(0);
  const [withdrawalsLoaded, setWithdrawalsLoaded] = useState(false);
  const [withdrawalLoading, setWithdrawalLoading] = useState(false);
  const [withdrawalError, setWithdrawalError] = useState<string | null>(null);
  const [withdrawalRetryKey, setWithdrawalRetryKey] = useState(0);
  const [relatedLoading, setRelatedLoading] = useState({ aaa_service: false, ccc_service: false });
  const [relatedError, setRelatedError] = useState<{ aaa_service: string | null; ccc_service: string | null }>({ aaa_service: null, ccc_service: null });
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [notificationTotal, setNotificationTotal] = useState(0);
  const [notificationPage, setNotificationPage] = useState(0);
  const [notificationRetryKey, setNotificationRetryKey] = useState(0);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [notificationId, setNotificationId] = useState<string | null>(null);
  const [openConversation, setOpenConversation] = useState<{ type: 'aaa_service' | 'ccc_service'; id: string } | null>(null);
  const [notificationDetail, setNotificationDetail] = useState<NotificationDetail | null>(null);
  const [notificationDetailError, setNotificationDetailError] = useState<string | null>(null);
  const deletionContext = useMemo(() => ({ draft, filters, selectedId, notificationId, section, isActive }), [draft, filters, selectedId, notificationId, section, isActive]);
  const [deletePreview, setDeletePreview] = useState<{ job_id: string; account_count: number; notification_count: number; scope: 'bulk' | 'account' | 'notification'; filters: Filters; recordId: string | null; notificationId: string | null; context: typeof deletionContext } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingCleanup, setPendingCleanup] = useState<Array<{ job_id: string; file_count: number }>>([]);
  const [retainedSharedImages, setRetainedSharedImages] = useState<number | null>(null);
  const deletionContextRef = useRef(deletionContext);
  const mountedRef = useRef(false);
  const deletePreviewRef = useRef(deletePreview);
  const executingJobRef = useRef<string | null>(null);
  const prepareRequestRef = useRef<object | null>(null);
  const onDeleteResultRef = useRef(onDeleteResult);
  onDeleteResultRef.current = onDeleteResult;
  const notificationCacheRef = useRef(new Map<string, NotificationDetail>());
  const notificationRequestsRef = useRef(new Map<string, Promise<NotificationDetail>>());
  deletionContextRef.current = deletionContext;
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const notificationLoadMoreRef = useRef<HTMLDivElement>(null);
  const withdrawalListRef = useRef<HTMLDivElement>(null);
  const withdrawalLoadMoreRef = useRef<HTMLDivElement>(null);
  const deleteDialogRef = useRef<HTMLElement>(null);
  const detailPaneRef = useRef<HTMLDivElement>(null);

  const cancelConfirmation = useCallback(async (jobId: string) => {
    try {
      const result = await cancelAuditDeletionConfirmation('employee', jobId);
      if (!result.success) throw new Error('確認暫存回收未獲確認。');
      if (mountedRef.current && result.cancelled) {
        setPendingCleanup(previous => previous.filter(job => job.job_id !== jobId));
      } else if (mountedRef.current && !result.cancelled) {
        try {
          const jobs = await listPendingEmployeeArchiveDeletions();
          if (mountedRef.current) setPendingCleanup(jobs);
        } catch (pendingError) {
          if (mountedRef.current) setDeleteError(`確認已關閉，任務未被取消；待清理任務查詢失敗：${formatSupabaseError(pendingError)}。請重新整理核對，這不是實際員工資料刪除的結果。`);
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        const message = `刪除確認已關閉，但確認暫存尚未回收，將由到期回收：${formatSupabaseError(error)}。這不是實際員工資料刪除的結果。`;
        setDeleteError(message);
        onDeleteResultRef.current({ type: 'error', message });
      }
    }
  }, []);

  const dismissDeletePreview = useCallback(() => {
    const preview = deletePreviewRef.current;
    if (preview && executingJobRef.current === preview.job_id) return;
    deletePreviewRef.current = null;
    if (mountedRef.current) setDeletePreview(null);
    if (preview) void cancelConfirmation(preview.job_id);
  }, [cancelConfirmation]);

  const invalidateDeletionPreview = useCallback(() => {
    prepareRequestRef.current = null;
    if (mountedRef.current && !executingJobRef.current) setDeleting(false);
    dismissDeletePreview();
  }, [dismissDeletePreview]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateDeletionPreview();
    };
  }, [invalidateDeletionPreview]);

  useEffect(() => {
    invalidateDeletionPreview();
  }, [draft, filters, selectedId, notificationId, section, isActive, invalidateDeletionPreview]);

  const adminGroups = [
    ...owners,
    ...availableAdmins.filter(admin => !owners.some(owner => owner.id === admin.id))
      .map(admin => ({ ...admin, event_count: 0 })),
  ].filter(owner => owner.username?.trim().toLowerCase() !== 'emergency_admin')
    .sort((a, b) => a.username.localeCompare(b.username, 'zh-TW'));
  const allOwnerTotal = owners.reduce((sum, owner) => sum + owner.event_count, 0);
  const aaaGroups = useMemo(() => groupRelatedEvents(related.aaa_service.items), [related.aaa_service.items]);
  const cccGroups = useMemo(() => groupRelatedEvents(related.ccc_service.items), [related.ccc_service.items]);
  const selectedConversation = openConversation
    ? (openConversation.type === 'aaa_service' ? aaaGroups : cccGroups).find(group => group.id === openConversation.id)
    : null;

  const fetchNotification = useCallback((id: string): Promise<NotificationDetail> => {
    const cached = notificationCacheRef.current.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = notificationRequestsRef.current.get(id);
    if (pending) return pending;
    const request = (async () => {
      const { data, error } = await supabase.rpc('get_deleted_employee_notification', {
        p_admin_session_token: getAdminFinancialSessionToken(), p_notification_id: id,
      });
      if (error || !data) throw error || new Error('找不到通知檔案。');
      notificationCacheRef.current.set(id, data as NotificationDetail);
      return data as NotificationDetail;
    })();
    notificationRequestsRef.current.set(id, request);
    void request.finally(() => notificationRequestsRef.current.delete(id)).catch(() => {});
    return request;
  }, []);

  useEffect(() => { setPage(0); setNotificationPage(0); }, [refreshKey]);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    void listPendingEmployeeArchiveDeletions().then(jobs => {
      if (!cancelled) setPendingCleanup(jobs);
    }).catch(error => {
      if (!cancelled) setDeleteError(`無法檢查待清理附件：${formatSupabaseError(error)}`);
    });
    return () => { cancelled = true; };
  }, [isActive, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    if (page === 0) { setItems([]); setTotal(0); setLastPageLoaded(false); }
    const load = async () => {
      try {
        const { data, error } = await supabase.rpc('list_deleted_employee_accounts', {
          p_admin_session_token: getAdminFinancialSessionToken(), p_owner: filters.owner || null,
          p_search: filters.search || null, p_page: page, p_page_size: PAGE_SIZE,
        });
        if (error) throw error;
        if (!data || !Array.isArray(data.items) || !Array.isArray(data.owners) || typeof data.total !== 'number') throw new Error('已刪員工清單格式不正確。');
        if (!cancelled) {
          const next = data.items as DeletedEmployee[];
          setItems(previous => page === 0 ? next : [...previous, ...next.filter(item => !previous.some(entry => entry.id === item.id))]);
          setTotal(data.total);
          setLastPageLoaded(next.length < PAGE_SIZE);
          if (page === 0) { setOwners(data.owners); setOwnersLoaded(true); }
        }
      } catch (error) {
        if (!cancelled) setLoadError(formatSupabaseError(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [filters, page, refreshKey, retryKey]);

  useEffect(() => {
    if (loading || loadError || lastPageLoaded || items.length === 0 || items.length >= total || !loadMoreRef.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); setPage(current => current + 1); }
    }, { rootMargin: '120px' });
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [loading, loadError, lastPageLoaded, items.length, total]);

  useEffect(() => {
    notificationCacheRef.current.clear();
    notificationRequestsRef.current.clear();
    setDetail(null);
    setWithdrawals([]);
    setWithdrawalTotal(0);
    setWithdrawalPage(0);
    setWithdrawalsLoaded(false);
    setWithdrawalError(null);
    setRelated({ aaa_service: { items: [], total: 0 }, ccc_service: { items: [], total: 0 } });
    setRelatedLoaded({ aaa_service: false, ccc_service: false });
  }, [selectedId, refreshKey]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    const load = async () => {
      try {
        const { data, error } = await supabase.rpc('get_deleted_employee_account', {
          p_admin_session_token: getAdminFinancialSessionToken(), p_record_id: selectedId,
          p_related_page: 0, p_related_page_size: 1, p_type: 'aaa_service',
        });
        if (error) throw error;
        if (!data || !('id' in data)) throw new Error('找不到此員工檔案。');
        if (!cancelled) {
          const record = data as EmployeeDetail;
          setDetail(record);
        }
      } catch (error) {
        if (!cancelled) {
          setDetailError(formatSupabaseError(error));
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [selectedId, refreshKey]);

  useEffect(() => {
    if (!selectedId || detail?.id !== selectedId || detail.cleared_at) return;
    let cancelled = false;
    setWithdrawalLoading(true);
    setWithdrawalError(null);
    const load = async () => {
      try {
        const { data, error } = await supabase.rpc('list_deleted_employee_withdrawals', {
          p_admin_session_token: getAdminFinancialSessionToken(), p_record_id: selectedId,
          p_page: withdrawalPage, p_page_size: RELATED_PAGE_SIZE,
        });
        if (error) throw error;
        if (!data || !Array.isArray(data.items) || typeof data.total !== 'number') throw new Error('提現紀錄格式不正確。');
        if (!cancelled) {
          setWithdrawals(previous => withdrawalPage === 0 ? data.items : [
            ...previous, ...data.items.filter(row => !previous.some(item => item.id === row.id)),
          ]);
          setWithdrawalTotal(data.total);
          setWithdrawalsLoaded(true);
        }
      } catch (error) {
        if (!cancelled) setWithdrawalError(formatSupabaseError(error));
      } finally {
        if (!cancelled) setWithdrawalLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [selectedId, detail?.id, detail?.cleared_at, withdrawalPage, withdrawalRetryKey, refreshKey]);

  useEffect(() => {
    if (section !== 'profile' || !withdrawalsLoaded || withdrawalLoading || withdrawalError
      || withdrawals.length >= withdrawalTotal || !withdrawalLoadMoreRef.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        setWithdrawalPage(current => current + 1);
      }
    }, { root: withdrawalListRef.current, rootMargin: '80px' });
    observer.observe(withdrawalLoadMoreRef.current);
    return () => observer.disconnect();
  }, [section, withdrawalsLoaded, withdrawalLoading, withdrawalError, withdrawals.length, withdrawalTotal]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    const load = async (type: 'aaa_service' | 'ccc_service') => {
      setRelatedLoading(previous => ({ ...previous, [type]: true }));
      setRelatedError(previous => ({ ...previous, [type]: null }));
      try {
        const fetchPage = async (page: number) => {
          const { data, error } = await supabase.rpc('get_deleted_employee_account', {
            p_admin_session_token: getAdminFinancialSessionToken(), p_record_id: selectedId,
            p_related_page: page, p_related_page_size: 100, p_type: type,
          });
          if (error) throw error;
          if (!data || !Array.isArray(data.related_items) || typeof data.related_total !== 'number') throw new Error('聊天紀錄格式不正確。');
          return data as { related_items: RelatedEvidence[]; related_total: number };
        };
        const firstPage = await fetchPage(0);
        if (cancelled) return;
        setRelated(previous => ({ ...previous, [type]: { items: firstPage.related_items, total: firstPage.related_total } }));
        const pages = [firstPage];
        for (let page = 1; page < Math.ceil(firstPage.related_total / 100); page += 4) {
          pages.push(...await Promise.all(Array.from({ length: Math.min(4, Math.ceil(firstPage.related_total / 100) - page) }, (_, index) => fetchPage(page + index))));
          if (cancelled) return;
        }
        if (!cancelled) {
          setRelated(previous => ({ ...previous, [type]: { items: pages.flatMap(result => result.related_items), total: firstPage.related_total } }));
          setRelatedLoaded(previous => ({ ...previous, [type]: true }));
        }
      } catch (error) {
        if (!cancelled) setRelatedError(previous => ({ ...previous, [type]: formatSupabaseError(error) }));
      } finally {
        if (!cancelled) setRelatedLoading(previous => ({ ...previous, [type]: false }));
      }
    };
    void load('aaa_service');
    void load('ccc_service');
    return () => { cancelled = true; };
  }, [selectedId, refreshKey, relatedRetryKey]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setNotificationLoading(true);
    setNotificationError(null);
    const load = async () => {
      try {
        const { data, error } = await supabase.rpc('list_deleted_employee_notifications', {
          p_admin_session_token: getAdminFinancialSessionToken(), p_record_id: selectedId,
          p_page: notificationPage, p_page_size: RELATED_PAGE_SIZE,
        });
        if (error) throw error;
        if (!data || !Array.isArray(data.items) || typeof data.total !== 'number') throw new Error('手動通知清單格式不正確。');
        if (!cancelled) {
          const rows = data.items as NotificationRow[];
          setNotifications(previous => notificationPage === 0 ? rows : [
            ...previous, ...rows.filter(row => !previous.some(item => item.id === row.id)),
          ]);
          setNotificationTotal(data.total);
          const prefetch = async () => {
            for (let index = 0; index < rows.length && !cancelled; index += 4) {
              await Promise.all(rows.slice(index, index + 4).map(row => fetchNotification(row.id).catch(() => null)));
            }
          };
          void prefetch();
        }
      } catch (error) {
        if (!cancelled) setNotificationError(formatSupabaseError(error));
      } finally {
        if (!cancelled) setNotificationLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [selectedId, notificationPage, notificationRetryKey, refreshKey, fetchNotification]);

  useEffect(() => {
    if (section !== 'notifications' || notificationLoading || notificationError || notificationId || !notifications.length || notifications.length >= notificationTotal || !notificationLoadMoreRef.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        setNotificationPage(current => current + 1);
      }
    }, { root: detailPaneRef.current, rootMargin: '120px' });
    observer.observe(notificationLoadMoreRef.current);
    return () => observer.disconnect();
  }, [section, notificationLoading, notificationError, notificationId, notifications.length, notificationTotal]);

  useEffect(() => {
    if (!notificationId) return;
    let cancelled = false;
    setNotificationDetail(notificationCacheRef.current.get(notificationId) ?? null);
    setNotificationDetailError(null);
    void fetchNotification(notificationId).then(data => {
      if (!cancelled) setNotificationDetail(data);
    }).catch(error => {
      if (!cancelled) setNotificationDetailError(formatSupabaseError(error));
    });
    return () => { cancelled = true; };
  }, [notificationId, refreshKey, fetchNotification]);

  useEffect(() => {
    if (!isActive || deletePreview || (!selectedId && !notificationId)) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[data-archive-media-preview], [data-archive-card-preview]')) return;
      if (notificationId) setNotificationId(null);
      else if (openConversation) setOpenConversation(null);
      else { setSelectedId(null); onSelectEmployee(null); }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [isActive, deletePreview, selectedId, notificationId, openConversation, onSelectEmployee]);

  const selectOwner = (owner: string) => {
    setDraft(previous => ({ ...previous, owner }));
    setFilters(previous => ({ ...previous, owner }));
    setPage(0);
    setSelectedId(null);
    setNotificationId(null);
    setOpenConversation(null);
    onSelectEmployee(null);
  };

  const applySearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters(previous => ({ ...previous, search: draft.search.trim() }));
    setPage(0);
    setSelectedId(null);
    setNotificationId(null);
    setOpenConversation(null);
    onSelectEmployee(null);
  };

  const clearSearch = () => {
    setDraft(previous => ({ ...previous, search: '' }));
    setFilters(previous => ({ ...previous, search: '' }));
    setPage(0);
    setSelectedId(null);
    setNotificationId(null);
    setOpenConversation(null);
    onSelectEmployee(null);
  };

  const selectEmployee = (id: string) => {
    if (selectedId === id) return;
    setDetail(null);
    setRelated({ aaa_service: { items: [], total: 0 }, ccc_service: { items: [], total: 0 } });
    setNotifications([]);
    setNotificationTotal(0);
    setNotificationId(null);
    setOpenConversation(null);
    setSelectedId(id);
    onSelectEmployee(id);
    setSection('profile');
    onSelectSection('profile');
    setRelatedLoaded({ aaa_service: false, ccc_service: false });
    setNotificationPage(0);
    detailPaneRef.current?.scrollTo(0, 0);
  };

  const showSection = (target: Section) => {
    setOpenConversation(null);
    setNotificationId(null);
    setSection(target);
    onSelectSection(target);
    detailPaneRef.current?.scrollTo(0, 0);
  };

  const prepareDeletion = async (recordId?: string, archivedNotificationId?: string) => {
    if (!mountedRef.current || !isActive || prepareRequestRef.current || executingJobRef.current || deletePreviewRef.current
      || (!recordId && !archivedNotificationId && (loading || loadError || total === 0))) return;
    const request = {};
    const requestedContext = deletionContextRef.current;
    prepareRequestRef.current = request;
    setDeleting(true);
    setDeleteError(null);
    setRetainedSharedImages(null);
    try {
      const { data, error } = await supabase.rpc('prepare_deleted_employee_archive_delete', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_owner: recordId || archivedNotificationId ? null : filters.owner || null,
        p_search: recordId || archivedNotificationId ? null : filters.search || null,
        p_record_id: recordId || null,
        p_notification_id: archivedNotificationId || null,
      });
      if (error) throw error;
      if (!data || typeof data.job_id !== 'string' || typeof data.account_count !== 'number' || typeof data.notification_count !== 'number') {
        if (typeof data?.job_id === 'string') void cancelConfirmation(data.job_id);
        throw new Error('刪除範圍格式不正確。');
      }
      if (!mountedRef.current || prepareRequestRef.current !== request || deletionContextRef.current !== requestedContext) {
        void cancelConfirmation(data.job_id);
        return;
      }
      const preview = { ...data, scope: archivedNotificationId ? 'notification' as const : recordId ? 'account' as const : 'bulk' as const, filters, recordId: recordId || null, notificationId: archivedNotificationId || null, context: requestedContext };
      deletePreviewRef.current = preview;
      setDeletePreview(preview);
    } catch (error) {
      if (mountedRef.current && prepareRequestRef.current === request && deletionContextRef.current === requestedContext) {
        setDeleteError(`無法準備刪除：${formatSupabaseError(error)}`);
      }
    } finally {
      if (prepareRequestRef.current === request) {
        prepareRequestRef.current = null;
        if (mountedRef.current) setDeleting(false);
      }
    }
  };

  useEffect(() => {
    if (!deletePreview) return;
    const keepFocusInside = (event: FocusEvent) => {
      const dialog = deleteDialogRef.current;
      if (dialog && !dialog.contains(event.target as Node)) {
        (dialog.querySelector<HTMLButtonElement>('button:not(:disabled)') || dialog).focus();
      }
    };
    document.addEventListener('focusin', keepFocusInside);
    return () => document.removeEventListener('focusin', keepFocusInside);
  }, [deletePreview]);

  const confirmDeletion = async () => {
    const preview = deletePreviewRef.current;
    if (!mountedRef.current || !preview || prepareRequestRef.current || executingJobRef.current) return;
    const context = deletionContextRef.current;
    if (!context.isActive || context !== preview.context || context.filters !== preview.filters
      || (preview.recordId && context.selectedId !== preview.recordId)
      || (preview.notificationId && context.notificationId !== preview.notificationId)) {
      invalidateDeletionPreview();
      setDeleteError('篩選或選取檔案已變更，請重新預覽刪除範圍。');
      return;
    }
    executingJobRef.current = preview.job_id;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await executeEmployeeArchiveDeletion(preview.job_id);
      deletePreviewRef.current = null;
      if (!mountedRef.current) return;
      setRetainedSharedImages(result.retained_shared_images);
      if (preview.scope !== 'notification') {
        setSelectedId(null);
        onSelectEmployee(null);
      }
      setNotificationId(null);
      setNotificationPage(0);
      setDeletePreview(null);
      setPendingCleanup(previous => previous.filter(job => job.job_id !== preview.job_id));
      onDeleteResult({ type: 'success', message: preview.scope === 'notification'
        ? '已永久清除此筆員工通知檔案。'
        : preview.scope === 'account' ? '已永久刪除此筆員工檔案及相關資料。' : `已永久刪除 ${preview.account_count} 筆員工檔案及相關資料。` });
      onDeleted();
    } catch (error) {
      if (!mountedRef.current) return;
      onDeleted();
      try {
        const jobs = await listPendingEmployeeArchiveDeletions();
        if (!mountedRef.current) return;
        setPendingCleanup(jobs);
        const mediaPending = jobs.some(job => job.job_id === preview.job_id);
        if (mediaPending) {
          // 正文已移除，轉交pending附件重試，不再當成未執行的確認暫存。
          deletePreviewRef.current = null;
          setDeletePreview(null);
        }
        setDeleteError(mediaPending
          ? `員工資料已從資料庫移除，但附件或原圖清理未完成：${formatSupabaseError(error)}。請點選上方的清理重試。`
          : `刪除未能確認：${formatSupabaseError(error)}。請重新整理並核對員工是否仍在列表中。`);
        onDeleteResult({ type: 'error', message: mediaPending ? '員工資料已移除，但附件或原圖清理未完成，請重試。' : '刪除結果無法確認，請核對員工檔案。' });
      } catch (pendingError) {
        if (!mountedRef.current) return;
        setDeleteError(`無法核對刪除結果：${formatSupabaseError(error)}。待清理任務查詢失敗：${formatSupabaseError(pendingError)}。請重新整理後核對員工資料與待清理檔案，或重試本次確認。`);
        onDeleteResult({ type: 'error', message: '無法核對刪除結果，請重新整理員工檔案。' });
      }
    } finally {
      executingJobRef.current = null;
      if (!mountedRef.current || preview.context !== deletionContextRef.current) dismissDeletePreview();
      if (mountedRef.current) setDeleting(false);
    }
  };

  const retryPendingCleanup = async (jobId: string) => {
    if (!mountedRef.current || !isActive || prepareRequestRef.current || executingJobRef.current) return;
    if (deletePreviewRef.current && deletePreviewRef.current.job_id !== jobId) dismissDeletePreview();
    const preview = deletePreviewRef.current;
    executingJobRef.current = jobId;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await executeEmployeeArchiveDeletion(jobId);
      if (deletePreviewRef.current?.job_id === jobId) deletePreviewRef.current = null;
      if (!mountedRef.current) return;
      setRetainedSharedImages(result.retained_shared_images);
      setPendingCleanup(previous => previous.filter(job => job.job_id !== jobId));
      if (preview?.scope !== 'notification') {
        setSelectedId(null);
        onSelectEmployee(null);
      }
      setDeletePreview(null);
      onDeleteResult({ type: 'success', message: '員工檔案的附件及原圖清理已完成。' });
      onDeleted();
    } catch (error) {
      if (!mountedRef.current) return;
      setDeleteError(`附件或原圖清理未完成：${formatSupabaseError(error)}`);
      onDeleteResult({ type: 'error', message: '員工檔案的附件或原圖清理未完成，請重試。' });
      try {
        const jobs = await listPendingEmployeeArchiveDeletions();
        if (mountedRef.current) setPendingCleanup(jobs);
      } catch (pendingError) {
        if (mountedRef.current) setDeleteError(`附件或原圖清理未完成：${formatSupabaseError(error)}。待清理任務查詢失敗：${formatSupabaseError(pendingError)}。請重新整理或重試清理。`);
      }
      return;
    } finally {
      executingJobRef.current = null;
      if (mountedRef.current) setDeleting(false);
    }
    // 清理已成功；後續列表讀取失敗不能改成刪除失敗。
    try {
      const jobs = await listPendingEmployeeArchiveDeletions();
      if (mountedRef.current) setPendingCleanup(jobs);
    } catch (error) {
      if (mountedRef.current) setDeleteError(`附件及原圖清理已完成，但待清理任務查詢失敗：${formatSupabaseError(error)}。請重新整理清單。`);
    }
  };

  const ownerGroupsView = (compact = false) => <div aria-label="所屬管理員分組">
    <div className="mb-1.5 flex items-center justify-between px-1"><p className="text-[11px] font-bold tracking-wide text-slate-200">所屬管理員</p><span className="text-[10px] text-slate-500">{adminGroups.length} 位</span></div>
    <div className={compact ? 'space-y-0.5' : 'space-y-1'}>{[{ id: '', username: '全部管理員', event_count: allOwnerTotal }, ...adminGroups].map(owner => <button key={owner.id} type="button" aria-pressed={filters.owner === owner.id} onClick={() => selectOwner(owner.id)} className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2 text-left text-xs font-semibold transition-colors ${compact ? 'py-0.5' : 'py-2'} ${filters.owner === owner.id ? 'border-cyan-300/30 bg-gradient-to-r from-cyan-500/25 to-blue-500/15 text-white shadow-[inset_3px_0_0_#67e8f9]' : 'border-transparent text-slate-400 hover:border-white/10 hover:bg-white/[0.05] hover:text-white'} ${focusClass}`}><span className="min-w-0 truncate">{owner.username}</span><span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums ${filters.owner === owner.id ? 'bg-cyan-300/15 text-cyan-100' : 'bg-slate-800 text-slate-400'}`}>{ownersLoaded ? owner.event_count.toLocaleString() : '…'}</span></button>)}</div>
  </div>;

  const searchView = (inputId: string, compact = false) => <form onSubmit={applySearch} role="search" className={compact ? 'space-y-1.5' : 'space-y-2.5'}>
    <label htmlFor={inputId} className="block text-[11px] font-bold tracking-wide text-slate-200">員工姓名／帳號／員工 ID</label>
    <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
      <span className="relative min-w-0 flex-1"><Search className={`pointer-events-none absolute left-3 h-4 w-4 text-cyan-300/65 ${compact ? 'top-2' : 'top-4'}`} aria-hidden="true" /><input id={inputId} type="search" className={`${compact ? 'w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-1.5 text-xs text-white outline-none focus-visible:border-cyan-400 focus-visible:ring-2 focus-visible:ring-cyan-400/30' : inputClass} border-white/10 bg-slate-950/70 pl-9 placeholder:text-slate-500`} value={draft.search} maxLength={100} onChange={event => setDraft(previous => ({ ...previous, search: event.target.value }))} placeholder="搜尋姓名、帳號或員工 ID" /></span>
      <button type="submit" className={`rounded-lg bg-gradient-to-r from-cyan-600 to-blue-700 px-3 ${compact ? 'py-1.5' : 'py-2.5'} text-xs font-bold text-white shadow-[0_4px_12px_rgba(8,145,178,0.2)] hover:from-cyan-500 hover:to-blue-600 lg:w-full ${focusClass}`}>搜尋員工</button>
    </div>
    {filters.search && <button type="button" onClick={clearSearch} className={`text-[11px] text-cyan-200 underline ${focusClass}`}>清除搜尋條件</button>}
  </form>;

  const message = notificationDetail?.message_data;
  const selectedNotification = notifications.find(item => item.id === notificationId);
  return <>
    <div className="shrink-0 space-y-2.5 border-b border-cyan-300/10 bg-[linear-gradient(125deg,#0c1b2c,#0f172a)] px-3 py-3 lg:hidden"><div>{switcher}</div><div className="rounded-xl border border-white/10 bg-slate-900/60 p-3">{searchView('deleted-employee-search-mobile')}</div><details className="max-h-[55vh] overflow-y-auto rounded-xl border border-white/10 bg-slate-900/60 p-3 scrollbar-dark"><summary className="cursor-pointer text-xs font-bold text-cyan-100">按管理員篩選</summary><div className="mt-3 border-t border-white/10 pt-3">{ownerGroupsView()}</div></details></div>
    <div className="grid min-h-0 flex-1 lg:grid-cols-[250px_minmax(0,1fr)]">
      <aside className="hidden min-h-0 flex-col overflow-y-auto border-r border-cyan-300/10 bg-[radial-gradient(circle_at_0%_0%,rgba(34,211,238,0.08),transparent_45%),linear-gradient(180deg,#0a1526,#090f1d_72%,#0d1627)] p-3 scrollbar-dark lg:flex">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-cyan-100"><UserRoundX className="h-4 w-4" aria-hidden="true" />監察工作台</div>
        {switcher}
        <section className="mt-3 border-t border-white/10 pt-2.5">{searchView('deleted-employee-search-desktop', true)}</section>
        <section className="mt-3 border-t border-white/10 pt-2.5">{ownerGroupsView(true)}</section>
      </aside>
      <div className="grid min-h-0 min-w-0 flex-1 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section aria-label="已刪員工帳戶列表" className={`${selectedId ? 'hidden lg:flex' : 'flex'} min-h-0 min-w-0 flex-col overflow-y-auto border-r border-slate-700 bg-slate-900`}>
          <div className="sticky top-0 z-10 border-b border-cyan-300/15 bg-[linear-gradient(90deg,#111b2e,#14243a)] px-3 pt-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5"><h2 className="shrink-0 whitespace-nowrap text-sm font-black leading-6 text-white">已刪員工帳戶</h2><span className="shrink-0 rounded-md bg-cyan-400/10 px-1.5 text-[10px] font-bold leading-5 tabular-nums text-cyan-200">{total.toLocaleString()} 位</span></div>
              <button type="button" onClick={() => void prepareDeletion()} disabled={deleting || loading || Boolean(loadError) || total === 0} className={`inline-flex h-6 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-rose-400/40 bg-rose-500/10 px-1.5 text-[11px] font-bold leading-none text-rose-100 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40 ${focusClass}`}><Trash2 className="h-3 w-3" aria-hidden="true" />{deleting ? '準備中…' : '全部刪除'}</button>
            </div>
            <p className="mt-1 text-[10px] text-slate-400">確認後直接永久清除，不另存歸檔或清理憑證</p>
            {deleteError && !selectedId && <p role="alert" className="mt-2 text-xs text-rose-300">{deleteError}</p>}
            {pendingCleanup.map(job => <button key={job.job_id} type="button" disabled={deleting} onClick={() => void retryPendingCleanup(job.job_id)} className={`mt-2 block text-left text-xs text-amber-200 underline disabled:opacity-50 ${focusClass}`}>上次刪除的附件或原圖尚有 {job.file_count} 個待核對，點此重試清理</button>)}
            {retainedSharedImages !== null && retainedSharedImages > 0 && <p role="status" className="mt-2 text-xs text-amber-200">有 {retainedSharedImages} 個素材仍被範本或其他內容引用，為避免影響共用內容已保留。</p>}
            <div className="-mx-3 mt-2 grid grid-cols-[28px_minmax(0,1fr)_auto] gap-2 border-t border-cyan-300/20 bg-sky-900/40 px-3 py-1.5 text-[10px] font-bold"><span className="text-slate-300">序號</span><span className="text-cyan-200">員工帳戶</span><span className="text-rose-200">操作</span></div>
          </div>
          <ol className="min-w-0 divide-y divide-slate-700/50">
            {items.length === 0 && !loading && !loadError && <li className="px-4 py-10 text-center text-xs text-slate-400">沒有符合條件的員工檔案。</li>}
            {items.map((item, index) => <li key={item.id}>
              <button type="button" aria-pressed={selectedId === item.id} onClick={() => selectEmployee(item.id)} className={`grid w-full min-w-0 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 border-l-[3px] px-3 py-1.5 text-left transition-colors ${selectedId === item.id ? 'border-cyan-300 bg-cyan-400/15' : item.cleared_at ? 'border-slate-500 bg-slate-800/40 hover:bg-slate-800/70' : item.deletion_source === 'admin_delete' ? 'border-rose-400/70 bg-rose-500/[0.05] hover:bg-rose-500/[0.11]' : 'border-teal-400/70 bg-teal-500/[0.05] hover:bg-teal-500/[0.11]'} ${focusClass}`}>
                <span className="row-span-5 self-start pt-0.5 text-[11px] font-bold tabular-nums text-slate-400">{index + 1}.</span>
                <span className="flex min-w-0 items-center gap-1 text-xs font-bold text-white"><span className="min-w-0 truncate" title={item.account_username || undefined}>{item.account_username || '帳戶資料已清除'}</span>{item.cleared_at && <span className="shrink-0 rounded border border-slate-500/40 bg-slate-500/15 px-1 text-[9px] text-slate-300">已清除</span>}</span>
                <span className={`justify-self-end whitespace-nowrap rounded-md border px-1.5 py-1 text-[10px] font-bold leading-none ${item.deletion_source === 'admin_delete' ? 'border-rose-400/30 bg-rose-400/10 text-rose-200' : 'border-teal-400/30 bg-teal-400/10 text-teal-200'}`}>{item.deletion_source === 'admin_delete' ? '隨管理員一併刪除' : '單獨刪除員工'}</span>
                <span className="col-span-2 col-start-2 flex min-w-0 items-center gap-1 text-[11px] text-slate-300">{item.account_real_name && <><span className="min-w-0 truncate" title={item.account_real_name}>{item.account_real_name}</span><span className="text-slate-600">·</span></>}<span className="shrink-0" title={item.employee_number || undefined}>ID {item.employee_number || '—'}</span></span>
                <span className="col-span-2 col-start-2 min-w-0 truncate text-[11px] text-amber-200" title={item.owner_username || item.owner_admin_id}>所屬 {item.owner_username || item.owner_admin_id}</span>
                <span className="col-span-2 col-start-2 min-w-0 truncate text-[11px] text-sky-200" title={item.actor_username}>操作者 {item.actor_username}</span>
                <time dateTime={item.deleted_at} className="col-span-2 col-start-2 min-w-0 whitespace-nowrap text-[10px] tabular-nums text-slate-400">{displayTime(item.deleted_at)}</time>
              </button>
            </li>)}
          </ol>
          <div ref={loadMoreRef} role="status" className="py-3 text-center text-xs text-slate-400">{loading ? '載入中…' : loadError ? <button type="button" onClick={() => setRetryKey(key => key + 1)} className="text-cyan-200 underline">載入失敗，點此重試</button> : items.length < total && !lastPageLoaded ? '往下捲動載入更多' : null}</div>
          {loadError && <p role="alert" className="px-4 pb-3 text-xs text-rose-300"><AlertTriangle className="mr-1 inline h-4 w-4" />{loadError}</p>}
        </section>
        <section aria-label="員工檔案與歷史內容" className={`${selectedId ? 'flex' : 'hidden lg:flex'} min-h-0 min-w-0 flex-col bg-slate-900`}>
          {!selectedId ? <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-slate-400">從左側選擇員工，查看帳戶、手動通知及兩個工作區的完整聊天紀錄。</div> : <>
            <div className="flex shrink-0 items-center gap-3 border-b border-slate-700 bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 px-4 py-3"><button type="button" onClick={() => { invalidateDeletionPreview(); setSelectedId(null); setNotificationId(null); setOpenConversation(null); onSelectEmployee(null); }} aria-label="返回員工列表" className={`rounded-lg border border-slate-600 p-2 text-slate-200 lg:hidden ${focusClass}`}><ArrowLeft className="h-4 w-4" /></button><div className="min-w-0"><h2 className="truncate text-base font-black text-white">{detail?.account_username || items.find(item => item.id === selectedId)?.account_username || '已刪員工檔案'}</h2><p className="truncate text-xs text-cyan-200">員工 ID：{detail?.employee_number || items.find(item => item.id === selectedId)?.employee_number || '已清除'} · 所屬管理員：{detail?.owner_username || items.find(item => item.id === selectedId)?.owner_username || '—'}</p></div></div>
            <nav aria-label="員工檔案分類" className="grid shrink-0 grid-cols-4 border-b border-slate-700 bg-slate-950/75">{sections.map(([tab, label]) => <button key={tab} type="button" onClick={() => showSection(tab)} className={`min-w-0 border-b-2 px-1 py-3 text-[11px] font-bold sm:text-xs ${section === tab ? 'border-cyan-300 bg-cyan-500/15 text-white' : 'border-transparent text-slate-400 hover:bg-slate-800 hover:text-white'} ${focusClass}`}>{label}</button>)}</nav>
            <div ref={detailPaneRef} className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_85%_0%,rgba(34,211,238,0.06),transparent_42%)] p-4 scrollbar-dark sm:p-5">
              {detailLoading && !detail && <p role="status" className="py-10 text-center text-sm text-slate-400">載入員工檔案中…</p>}
              {detailError && <p role="alert" className="text-sm text-rose-300">{detailError}</p>}
              {detail && <>
                <section data-archive-section="profile" className={`${section === 'profile' ? 'space-y-4' : 'hidden'}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-300/15 pb-4">
                    <div className="flex min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-400/10 text-base font-black text-cyan-100 ring-1 ring-cyan-300/20">{(detail.account_real_name || detail.account_username || '員').slice(0, 1)}</span><div className="min-w-0"><h3 className="truncate text-base font-black text-white">{detail.account_real_name || detail.account_username || '已刪員工'}</h3><p className="truncate text-xs text-slate-400">員工 ID <span className="font-semibold text-cyan-200">{detail.employee_number || '—'}</span></p></div></div>
                    <span className="rounded-full border border-cyan-400/25 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-bold text-cyan-100">{detail.deletion_source === 'admin_delete' ? '隨管理員封存' : '已停用並封存'}</span>
                  </div>
                  {detail.account_summary && <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 sm:grid-cols-4">{[
                    ['驗證狀態', detail.account_summary.is_verified ? '已驗證' : '未驗證'],
                    ['歷史總收入', `$${detail.account_summary.total_income}`],
                    ['可用／凍結', `$${detail.account_summary.available_balance ?? 0} / $${detail.account_summary.frozen_balance ?? 0}`],
                    ['歷史訂單', detail.account_summary.total_orders.toLocaleString()],
                  ].map(([label, value]) => <div key={label} className="min-w-0 bg-slate-900/95 px-3 py-2.5"><p className="text-[10px] text-slate-400">{label}</p><p className="mt-1 truncate text-xs font-bold text-white" title={value}>{value}</p></div>)}</div>}
                  <div><h4 className="text-xs font-bold text-cyan-100">帳戶與操作資訊</h4><dl className="mt-1 grid grid-cols-1 gap-x-5 sm:grid-cols-2 xl:grid-cols-3"><DetailField label="員工帳號" value={detail.account_username} /><DetailField label="員工姓名" value={detail.account_real_name} /><DetailField label="員工 ID" value={detail.employee_number} /><DetailField label="所屬管理員" value={detail.owner_username || detail.owner_admin_id} /><DetailField label="實際操作者" value={detail.actor_username} /><DetailField label="封存時間" value={displayTime(detail.deleted_at)} /><DetailField label="建立時間" value={displayTime(detail.account_created_at)} /><DetailField label="備註" value={detail.account_remarks} /></dl></div>
                  {!detail.cleared_at && <section className="overflow-hidden rounded-xl border border-cyan-300/15 bg-slate-950/35" aria-label="提現紀錄">
                    <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3"><h4 className="text-xs font-bold text-cyan-100">提現紀錄 <span className="ml-1 font-medium text-slate-400">{withdrawalsLoaded ? `${withdrawalTotal} 筆` : '載入中…'}</span></h4><span className="text-[10px] text-slate-500">按申請時間排序</span></div>
                    <div ref={withdrawalListRef} className="max-h-60 overflow-y-auto scrollbar-dark">
                      {withdrawals.length > 0 && <div className="grid grid-cols-[28px_minmax(0,1fr)_auto] gap-2 border-b border-white/10 px-4 py-2 text-[10px] font-semibold text-slate-400 sm:grid-cols-[28px_minmax(0,1fr)_minmax(90px,auto)_auto]"><span>序號</span><span>申請時間 (UTC+8)</span><span>提現金額</span><span className="hidden sm:block">狀態</span></div>}
                      <ol className="divide-y divide-white/[0.07]">{withdrawals.map((withdrawal, index) => <li key={withdrawal.id} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 px-4 py-2.5 text-xs sm:grid-cols-[28px_minmax(0,1fr)_minmax(90px,auto)_auto]"><span className="tabular-nums text-slate-500">{index + 1}.</span><time dateTime={withdrawal.created_at || undefined} className="min-w-0 text-[11px] tabular-nums text-slate-300">{displayTime(withdrawal.created_at)}</time><span className="text-right font-bold tabular-nums text-cyan-100">${Number(withdrawal.amount).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 8 })}</span><span className="col-start-2 text-[10px] text-slate-400 sm:col-start-auto sm:text-right">{{ pending: '待審核', approved: '已批准', rejected: '已拒絕', cancelled: '已取消' }[withdrawal.status]}</span></li>)}</ol>
                      <div ref={withdrawalLoadMoreRef} role="status" className="px-4 py-2 text-center text-[11px] text-slate-400">{withdrawalLoading || !withdrawalsLoaded && !withdrawalError ? '載入提現紀錄中…' : withdrawalError ? <span role="alert">載入失敗：{withdrawalError} <button type="button" onClick={() => setWithdrawalRetryKey(key => key + 1)} className={`text-cyan-200 underline ${focusClass}`}>重試</button></span> : withdrawalsLoaded && withdrawalTotal === 0 ? '沒有提現紀錄' : withdrawals.length < withdrawalTotal ? `已顯示 ${withdrawals.length} / ${withdrawalTotal} 筆 · 向下捲動載入更多` : null}</div>
                    </div>
                  </section>}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-3"><p className="max-w-lg text-[11px] leading-5 text-slate-400">永久刪除會清除此員工的封存資料、聊天留證、訂單與財務紀錄，不保留清理憑證；共用的富媒體設定與素材不受影響。</p><button type="button" disabled={deleting} onClick={() => void prepareDeletion(detail.id)} className={`shrink-0 rounded-lg border border-rose-400/35 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-200 hover:bg-rose-500/20 disabled:opacity-40 ${focusClass}`}><Trash2 className="mr-1 inline h-3.5 w-3.5" />永久刪除檔案</button></div>{deleteError && <p role="alert" className="text-xs text-rose-300">{deleteError}</p>}</section>
                <section data-archive-section="notifications" className={section === 'notifications' ? '' : 'hidden'}>
                  <div className="flex items-end justify-between gap-3 border-b border-white/10 pb-3"><div><h3 className="text-sm font-bold text-white">通知檔案 <span className="ml-1 text-xs font-medium text-cyan-200">{notificationTotal} 筆</span></h3><p className="mt-1 text-[11px] text-slate-400">點選一列查看通知內容與收件狀態</p></div></div>
                  {notifications.length ? <ol className="divide-y divide-white/[0.08]">{notifications.map((item, index) => <li key={item.id}><button type="button" onClick={() => { setDeleteError(null); setNotificationDetail(notificationCacheRef.current.get(item.id) ?? null); setNotificationId(item.id); }} onPointerEnter={() => { void fetchNotification(item.id).catch(() => {}); }} onFocus={() => { void fetchNotification(item.id).catch(() => {}); }} className={`group flex w-full min-w-0 items-center gap-3 py-3 text-left transition-colors hover:bg-cyan-400/[0.06] sm:px-2 ${focusClass}`}><span className="w-7 shrink-0 text-center text-[11px] font-bold tabular-nums text-slate-500">{index + 1}.</span><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-400/10 text-sky-200"><Bell className="h-4 w-4" /></span><span className="min-w-0 flex-1"><strong className="block truncate text-xs text-slate-100 group-hover:text-cyan-100">{item.title || '已清除通知內容'}</strong><span className="mt-1 block truncate text-[11px] text-slate-400">{item.sender_username || '發送者未留存'} · {item.audit_origin === 'manual_admin' ? '手動發送' : item.audit_origin === 'automation' ? '系統發送' : item.audit_origin === 'unverified' ? '舊版手動發送' : '來源未留存'}</span></span><span className="shrink-0 text-right"><span className={`block text-[11px] font-semibold ${item.is_read === 'true' ? 'text-emerald-300' : 'text-amber-200'}`}>{item.is_read === 'true' ? '已讀' : '未讀'}</span><time className="mt-1 block text-[10px] tabular-nums text-slate-500">{displayTime(item.sent_at)}</time></span><ChevronRight className="h-4 w-4 shrink-0 text-slate-500 group-hover:text-cyan-200" /></button></li>)}</ol> : !notificationLoading && !notificationError ? <p className="py-6 text-center text-xs text-slate-400">沒有可查看的通知檔案。</p> : null}
                  <div ref={notificationLoadMoreRef} className="py-3 text-center text-xs text-slate-400" role="status">{notificationLoading ? '載入通知檔案中…' : notificationError ? <span role="alert">載入失敗：{notificationError} <button type="button" onClick={() => setNotificationRetryKey(key => key + 1)} className={`text-cyan-200 underline ${focusClass}`}>重試</button></span> : notifications.length < notificationTotal ? '往下捲動載入更多' : null}</div>
                </section>
                {(['aaa_service', 'ccc_service'] as const).map(type => <section key={type} data-archive-section={type} className={section === type ? '' : 'hidden'}>
                  <div className="border-b border-white/10 pb-3"><h3 className="text-sm font-bold text-white">{type === 'aaa_service' ? '模擬客戶' : '經理'}對話 <span className="ml-1 text-xs font-medium text-cyan-200">{relatedLoaded[type] ? `${(type === 'aaa_service' ? aaaGroups : cccGroups).length} 段 · ${(type === 'aaa_service' ? aaaGroups : cccGroups).reduce((count, group) => count + group.events.length, 0)} 則訊息` : `${detail.related_counts?.[type] ?? 0} 則留證`}</span></h3><p className="mt-1 text-[11px] text-slate-400">一人一列，點選查看聊天內容{relatedLoading[type] && related[type].items.length ? ' · 正在補齊其餘訊息' : ''}</p></div>{relatedError[type] && related[type].items.length > 0 && <p role="alert" className="border-b border-rose-400/20 py-2 text-xs text-rose-300">部分訊息載入失敗：{relatedError[type]} <button type="button" onClick={() => setRelatedRetryKey(key => key + 1)} className={`ml-2 text-cyan-200 underline ${focusClass}`}>重試</button></p>}
                  {!related[type].items.length && (relatedLoading[type] || (!relatedLoaded[type] && !relatedError[type])) ? <p role="status" className="py-4 text-xs text-slate-400">整理對話清單中…</p> : relatedError[type] && !related[type].items.length ? <p role="alert" className="py-4 text-xs text-rose-300">{relatedError[type]} <button type="button" onClick={() => setRelatedRetryKey(key => key + 1)} className={`ml-2 text-cyan-200 underline ${focusClass}`}>重試</button></p> : related[type].items.length ? <ol className="divide-y divide-white/[0.08]">{(type === 'aaa_service' ? aaaGroups : cccGroups).map((group, index) => <li key={group.id}><button type="button" onClick={() => setOpenConversation({ type, id: group.id })} className={`group flex w-full min-w-0 items-center gap-3 py-3 text-left transition-colors hover:bg-cyan-400/[0.06] sm:px-2 ${focusClass}`}><span className="w-7 shrink-0 text-center text-[11px] font-bold tabular-nums text-slate-500">{index + 1}.</span><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-xs font-bold text-cyan-200">{group.name.slice(0, 1)}</span><span className="min-w-0 flex-1"><strong className="block truncate text-xs text-white group-hover:text-cyan-100">{group.name}</strong><span className="mt-1 block truncate text-[11px] text-slate-400">與 {detail.account_real_name || detail.account_username || '此員工'} 的對話 · {group.events.length} 則訊息</span></span><time className="hidden shrink-0 text-[10px] tabular-nums text-slate-500 sm:block">{displayTime(group.events[0].occurred_at)}</time><ChevronRight className="h-4 w-4 shrink-0 text-slate-500 group-hover:text-cyan-200" /></button></li>)}</ol> : <p className="py-6 text-center text-xs text-slate-400">沒有可查看的聊天紀錄。</p>}
                </section>)}
              </>}
            </div>
          </>}
        </section>
      </div>
    </div>
    {deletePreview && deletePreview.context === deletionContext && createPortal(<div role="presentation" className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/90 p-3 backdrop-blur-md sm:p-5"><section ref={deleteDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="employee-delete-title" onKeyDown={event => { if (event.key === 'Escape' && !executingJobRef.current) { event.stopPropagation(); setDeleteError(null); invalidateDeletionPreview(); } if (event.key !== 'Tab') return; const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')); if (!buttons.length) { event.preventDefault(); event.currentTarget.focus(); return; } if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[buttons.length - 1].focus(); } else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) { event.preventDefault(); buttons[0].focus(); } }} className="w-full max-w-lg overflow-hidden rounded-2xl border border-rose-300/30 bg-slate-900 shadow-[0_28px_90px_rgba(2,6,23,0.8)]"><div className="h-1 bg-gradient-to-r from-rose-500 via-orange-400 to-rose-500" /><div className="p-5 sm:p-6"><div className="flex items-center gap-3 text-rose-200"><span className="rounded-xl bg-rose-400/10 p-2.5"><AlertTriangle className="h-5 w-5" /></span><div><p className="text-[10px] font-bold uppercase tracking-widest text-rose-300/70">永久刪除確認</p><p className="mt-1 text-xs text-slate-300">清除完成後不保留封存內容或清理憑證，無法還原。</p><h2 id="employee-delete-title" className="mt-1 text-lg font-black text-white">{deletePreview.scope === 'bulk' ? '刪除目前篩選的全部員工檔案？' : deletePreview.scope === 'account' ? '刪除此員工檔案？': '刪除此筆私人通知？'}</h2></div></div><div className="mt-5 rounded-xl border border-rose-400/25 bg-rose-500/10 p-4"><p className="text-2xl font-black tabular-nums text-white">{deletePreview.account_count.toLocaleString()} <span className="text-sm font-semibold text-rose-200">位員工 · {deletePreview.notification_count.toLocaleString()} 筆私人通知</span></p><p className="mt-2 text-xs leading-5 text-slate-300">{deletePreview.scope === 'bulk' ? '包含目前篩選條件下尚未載入的員工檔案，以及各員工的聊天留證、歷史訂單與財務資料。' : deletePreview.scope === 'account' ? '同時移除此員工的聊天留證、歷史訂單與財務資料；共用素材不受影響。': '只移除此筆私人通知；員工檔案和其他通知仍保留。'}</p></div><p className="mt-4 text-xs leading-6 text-rose-100">{deletePreview.scope === 'notification' ? '只永久移除此筆私人通知；員工檔案及其他資料不受影響。' : '將永久清除此範圍內員工的封存檔案、私人通知、聊天留證副本、訂單、錢包與財務資料，無法還原；共用富媒體範本與原始素材不受影響。'}</p>{deleteError && <p role="alert" className="mt-3 rounded-lg border border-rose-400/30 bg-rose-950/50 px-3 py-2 text-xs text-rose-100">{deleteError}</p>}<div className="mt-6 flex flex-wrap justify-end gap-2"><button type="button" autoFocus onClick={() => { setDeleteError(null); invalidateDeletionPreview(); }} disabled={deleting} className={`rounded-xl border border-slate-600 px-4 py-2.5 text-xs font-bold text-slate-200 hover:bg-slate-800 disabled:opacity-50 ${focusClass}`}>取消</button><button type="button" onClick={() => void confirmDeletion()} disabled={deleting} className={`inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-black text-white hover:bg-rose-500 disabled:opacity-50 ${focusClass}`}><Trash2 className="h-4 w-4" />{deleting ? '處理中…' : '確認永久刪除'}</button></div></div></section></div>, document.body)}
    {openConversation && selectedId && selectedConversation && detail?.id === selectedId && createPortal(
      <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-[radial-gradient(circle_at_50%_20%,rgba(30,64,175,0.22),rgba(2,6,23,0.88)_60%)] p-0 backdrop-blur-md sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) setOpenConversation(null); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="archived-conversation-title" className="audit-detail-modal flex h-full min-h-0 w-full max-w-[1240px] flex-col overflow-hidden border border-white/15 bg-slate-950 shadow-[0_32px_110px_rgba(2,6,23,0.75)] sm:h-[94vh] sm:rounded-2xl">
          <div className="h-0.5 shrink-0 bg-gradient-to-r from-cyan-400 via-blue-500 to-violet-500" />
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[radial-gradient(circle_at_85%_-50%,rgba(34,211,238,0.18),transparent_45%),linear-gradient(100deg,#0b172a,#101c34)] px-4 py-3 sm:px-6 sm:py-4"><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-widest text-cyan-300">已刪員工檔案 · 私人封存對話</p><h2 id="archived-conversation-title" className="truncate text-lg font-black text-white">{selectedConversation.name} <span className="text-sm font-medium text-slate-400">與 {detail.account_real_name || detail.account_username || '員工'}</span></h2></div><button type="button" autoFocus onClick={() => setOpenConversation(null)} aria-label="關閉對話" className={`rounded-xl border border-white/10 bg-white/5 p-2 text-slate-200 hover:bg-white/10 ${focusClass}`}><X className="h-5 w-5" /></button></header>
          <div className="audit-detail-scroll grid min-h-0 min-w-0 flex-1 overflow-y-auto lg:grid-cols-[310px_minmax(0,1fr)] lg:overflow-hidden">
            <aside className="audit-detail-scroll min-w-0 space-y-4 border-b border-white/10 bg-[radial-gradient(circle_at_0%_0%,rgba(56,189,248,0.11),transparent_44%),linear-gradient(180deg,#101d31,#0a1222)] p-4 sm:p-5 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:border-r-white/10">
              <div className="flex items-start gap-3"><span className={`rounded-xl border p-2 ${openConversation.type === 'aaa_service' ? 'border-orange-400/30 bg-orange-400/10 text-orange-200' : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'}`}><MessageCircle className="h-5 w-5" /></span><div><h3 className="text-base font-black text-white">{openConversation.type === 'aaa_service' ? '模擬客戶' : '經理'} · 聊天會話</h3><p className="mt-1 text-xs text-slate-400">此員工刪除前的聊天內容</p></div></div>
              <dl className="grid grid-cols-2 gap-2 lg:grid-cols-1"><ArchiveField label="角色名稱" value={selectedConversation.name} /><ArchiveField label="員工帳號" value={detail.account_username} /><ArchiveField label="員工 ID" value={detail.employee_number} /><ArchiveField label="所屬管理員" value={detail.owner_username || detail.owner_admin_id} /><ArchiveField label="刪除操作者" value={detail.actor_username} /><ArchiveField label="封存時間 (UTC+8)" value={displayTime(detail.deleted_at)} /></dl>
              <p className="text-xs leading-5 text-slate-400">封存對話僅供查閱，不會在原聊天頁重新顯示。</p>
            </aside>
            <section className="flex min-h-[440px] min-w-0 flex-col lg:min-h-0">
              <div className={`flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3 ${openConversation.type === 'aaa_service' ? 'bg-gradient-to-r from-slate-950 to-orange-950/70' : 'bg-gradient-to-r from-slate-950 to-emerald-950/70'}`}><MessageCircle className="h-5 w-5 text-white" /><h3 className="text-sm font-bold text-white">原聊天內容 · {selectedConversation.events.length} 則</h3></div>
              <div className={`audit-detail-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-4 sm:p-6 ${openConversation.type === 'aaa_service' ? 'bg-[linear-gradient(180deg,#24170f_0%,#1b1513_40%,#24170f_100%)]' : 'bg-[linear-gradient(180deg,#0b2118_0%,#101c19_40%,#0b2118_100%)]'}`}>
                {selectedConversation.events.map(event => <ArchivedChatCard key={event.id} event={event} workspace={openConversation.type} />)}
              </div>
            </section>
          </div>
        </section>
      </div>, document.body,
    )}
    {notificationId && createPortal(<div className="fixed inset-0 z-[9000] flex items-center justify-center bg-[radial-gradient(circle_at_50%_20%,rgba(30,64,175,0.22),rgba(2,6,23,0.88)_60%)] p-0 backdrop-blur-md sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) setNotificationId(null); }}><section role="dialog" aria-modal="true" aria-labelledby="archived-notification-title" className="audit-detail-modal flex h-full min-h-0 w-full max-w-[1240px] flex-col overflow-hidden border border-white/15 bg-slate-950 shadow-[0_32px_110px_rgba(2,6,23,0.75)] sm:h-[94vh] sm:rounded-2xl"><div className="h-0.5 shrink-0 bg-gradient-to-r from-cyan-400 via-blue-500 to-violet-500" /><header className="flex items-center gap-3 border-b border-white/10 bg-[radial-gradient(circle_at_85%_-50%,rgba(34,211,238,0.18),transparent_45%),linear-gradient(100deg,#0b172a,#101c34)] px-4 py-3 sm:px-6 sm:py-4"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-400/15 text-sky-200"><Bell className="h-5 w-5" /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-bold uppercase tracking-widest text-cyan-300">已刪員工檔案 · 私人封存通知</p><h2 id="archived-notification-title" className="truncate text-lg font-black text-white">{selectedNotification?.title || '通知詳情'}</h2><p className="text-[11px] text-slate-400">{selectedNotification?.sender_username || '發送者未留存'} · {displayTime(selectedNotification?.sent_at || null)}{notificationDetail?.cleared_at ? ' · 內容已清除' : ''}</p></div><button type="button" autoFocus onClick={() => setNotificationId(null)} aria-label="關閉通知詳情" className={`rounded-lg border border-white/10 bg-white/5 p-2 text-slate-200 hover:bg-white/10 ${focusClass}`}><X className="h-4 w-4" /></button></header>{deleteError && <p role="alert" className="border-b border-rose-400/30 bg-rose-950/50 px-4 py-2 text-xs text-rose-100">{deleteError}</p>}<div className="audit-detail-scroll grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[310px_minmax(0,1fr)] lg:overflow-hidden"><aside className="audit-detail-scroll min-w-0 space-y-4 border-b border-white/10 bg-[radial-gradient(circle_at_0%_0%,rgba(56,189,248,0.11),transparent_44%),linear-gradient(180deg,#101d31,#0a1222)] p-4 sm:p-5 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:border-r-white/10"><div className="flex items-start gap-3"><span className="rounded-xl border border-violet-400/25 bg-violet-400/10 p-2 text-violet-200"><Bell className="h-5 w-5" /></span><div><h3 className="text-base font-black text-white">通知檔案詳情</h3><p className="mt-1 text-xs text-slate-400">員工收到的通知 · 私人封存</p></div></div><dl className="grid grid-cols-2 gap-2 lg:grid-cols-1"><ArchiveField label="通知發送時間 (UTC+8)" value={displayTime(selectedNotification?.sent_at || null)} /><ArchiveField label="發送者" value={selectedNotification?.sender_username || null} /><ArchiveField label="通知來源" value={selectedNotification?.audit_origin === 'manual_admin' ? '管理員手動發送' : selectedNotification?.audit_origin === 'automation' ? '系統自動發送' : selectedNotification?.audit_origin === 'unverified' ? '舊版手動發送' : '來源未留存'} /><ArchiveField label="收件狀態" value={selectedNotification?.is_read === 'true' ? '已讀' : '未讀'} /><ArchiveField label="收件員工" value={detail?.account_username || null} /><ArchiveField label="所屬管理員" value={detail?.owner_username || null} /></dl><p className="text-xs leading-5 text-slate-400">永久刪除僅清除此筆私人通知檔案，不影響內容稽核中的獨立事件。</p></aside><div className="flex min-h-[440px] min-w-0 flex-col lg:min-h-0">{notificationDetailError ? <p role="alert" className="p-5 text-rose-300">{notificationDetailError}</p> : !notificationDetail ? <p role="status" className="p-5 text-slate-300">載入內容中…</p> : <>{message ? <div className="min-h-0 flex-1 overflow-y-auto bg-[#f0f5ff]">{/<(?:img|video|source)\b/i.test(String(message.content || '')) && <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">此通知含媒體；未建立私人附件副本的圖片或影片無法在檔案中還原。</p>}<EmployeeNotificationDetailPanel embedded readOnlyPreview onClose={() => setNotificationId(null)} message={{ title: String(message.title || ''), content: sanitizeHTML(String(message.content || ''), { allowedTags: ['p','br','span','div','strong','em','u','s','b','i','ul','ol','li','blockquote','h1','h2','h3','h4'], allowedAttributes: [] }), message_type: message.message_type === 'login_popup' ? 'login_popup' : 'realtime', priority: ['low', 'normal', 'high', 'urgent'].includes(String(message.priority)) ? message.priority as 'low'|'normal'|'high'|'urgent' : 'normal', notification_category: typeof message.notification_category === 'string' ? message.notification_category : null, reward_amount: typeof message.reward_amount === 'number' ? message.reward_amount : null, reward_currency: typeof message.reward_currency === 'string' ? message.reward_currency : null, created_at: typeof message.created_at === 'string' ? message.created_at : null, is_read: notificationDetail.recipient_data?.is_read === true }} /></div> : <p className="min-h-0 flex-1 p-5 text-sm text-slate-400">此筆通知內容已正式清除。</p>}<footer className="flex shrink-0 items-center justify-between gap-3 border-t border-white/10 bg-slate-950/70 px-4 py-3 sm:px-6"><span className="text-[11px] text-slate-400">清除僅影響此筆私人通知檔案</span><button type="button" disabled={deleting} onClick={() => void prepareDeletion(undefined, notificationId)} className={`shrink-0 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-200 hover:bg-rose-500/20 disabled:opacity-40 ${focusClass}`}><Trash2 className="mr-1 inline h-3.5 w-3.5" />永久刪除</button></footer></>}</div></div></section></div>, document.body)}
  </>;
}
