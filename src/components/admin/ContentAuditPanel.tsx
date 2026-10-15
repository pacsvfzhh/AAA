import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, ArrowLeft, CheckCircle, ChevronDown, ChevronRight, Database,
  Gift, Image as ImageIcon, Megaphone, MessageCircle, RefreshCw, Search, ShieldCheck, Star, Trash2, User, UserRoundX, X,
} from 'lucide-react';
import { getAdminFinancialSessionToken } from '../../lib/auth';
import { cancelAuditDeletionConfirmation, executeAuditedDeletion, listPendingAuditedDeletions, loadAuditedMedia, prepareAuditedConversationDeletion, prepareAuditedDeletion } from '../../lib/contentAudit';
import { sanitizeHTML } from '../../lib/sanitizeHTML';
import { formatSupabaseError, supabase } from '../../lib/supabase';
import EmployeeNotificationDetailPanel from '../employee/EmployeeNotificationDetailPanel';
import DeletedEmployeesPanel from './DeletedEmployeesPanel';

type AuditType = 'notification' | 'aaa_service' | 'ccc_service';
type AuditAction = 'edit' | 'delete' | 'conversation_delete' | 'customer_delete' | 'employee_delete' | 'admin_delete' | 'source_edit' | 'source_delete';

interface AuditEvent {
  id: string;
  card_id: string;
  operation_id: string;
  entity_type: AuditType;
  entity_id: string;
  action: AuditAction;
  owner_admin_id: string;
  owner_username: string | null;
  actor_admin_id: string | null;
  actor_username: string;
  actor_role: string;
  customer_id: string | null;
  employee_id: string | null;
  employee_account: string | null;
  employee_number: string | null;
  employee_number_source: 'event_snapshot' | 'archived_account' | 'current_account' | null;
  recipient_count: number;
  message_count: number;
  conversation_delete_number: number | null;
  cleared_count: number;
  occurred_at: string;
  summary: string;
  notification_origin?: 'manual_admin' | 'automation' | 'unverified' | null;
  cleared_at: string | null;
  clear_started_at: string | null;
}

interface AuditDetail extends Omit<AuditEvent, 'summary'> {
  before_data: unknown;
  after_data: unknown;
  media_refs: Record<string, string> | null;
  timeline: Array<Pick<AuditEvent, 'id' | 'action' | 'occurred_at' | 'cleared_at'>>;
  recipient_identities?: Array<{ account: string | null; employee_number: string | null; from_current_account: boolean; is_read: boolean }>;
}

interface ConversationMessage {
  id: string;
  created_at: string | null;
  sender_type: string | null;
  message_type: string | null;
  message_content: string | null;
  image_url: string | null;
  title: string | null;
  subtitle: string | null;
  rating_data: Record<string, unknown> | null;
  rendered_html: string | null;
  media_refs: Record<string, string>;
  cleared_at: string | null;
  clear_started_at: string | null;
  customer_name?: string | null;
  employee_name?: string | null;
}

interface ConversationDetail {
  operation_id: string;
  entity_type: AuditType;
  occurred_at: string;
  employee_account: string;
  employee_id: string;
  total: number;
  items: ConversationMessage[];
}

interface ChatIdentity {
  customerName: string | null;
  employeeNumber: string | null;
  employeeNumberSource: 'archived' | 'current' | null;
}

interface AuditFilterCounts {
  total: number;
  types: Record<AuditType, number>;
  owners: Array<{ id: string; username: string; event_count: number }>;
}

interface AuditFilters {
  type: '' | AuditType;
  owner: string;
  action: '' | AuditAction;
  contentSearch: string;
  identitySearch: string;
  from: string;
  to: string;
}

const PAGE_SIZE = 30;
const TRANSCRIPT_PAGE_SIZE = 100;
const emptyFilters: AuditFilters = { type: '', owner: '', action: '', contentSearch: '', identitySearch: '', from: '', to: '' };
const typeLabels: Record<AuditType, string> = {
  notification: '通知異動', aaa_service: '模擬客戶', ccc_service: '經理',
};
const actionLabels: Record<AuditAction, string> = {
  edit: '修改單則內容', delete: '刪除單則內容', conversation_delete: '刪除整段對話', customer_delete: '刪除客戶及對話',
  employee_delete: '刪除員工及對話', admin_delete: '刪除管理員及對話', source_edit: '修改富卡來源', source_delete: '刪除富卡來源',
};
function auditActionLabel(type: AuditType, action: AuditAction): string {
  if (type === 'notification' && action === 'edit') return '修改通知內容';
  if (type === 'notification' && action === 'delete') return '刪除已發通知';
  if (type !== 'notification' && action === 'edit') return '修改聊天訊息';
  if (type !== 'notification' && action === 'delete') return '刪除聊天訊息';
  return actionLabels[action];
}

function notificationOriginLabel(origin: AuditEvent['notification_origin']): string {
  if (origin === 'manual_admin') return '管理員手動通知';
  if (origin === 'automation') return '系統自動通知';
  return origin === 'unverified' ? '舊通知 · 來源待核實' : '通知 · 來源未留存';
}

function snapshotNotificationOrigin(snapshot: unknown): AuditEvent['notification_origin'] {
  if (!snapshot || typeof snapshot !== 'object' || !('message' in snapshot)) return null;
  const message = snapshot.message;
  if (!message || typeof message !== 'object' || !('audit_origin' in message)) return null;
  const origin = message.audit_origin;
  return origin === 'manual_admin' || origin === 'automation' || origin === 'unverified' ? origin : null;
}

function snapshotNotificationSentAt(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object' || !('message' in snapshot)) return null;
  const message = snapshot.message;
  return message && typeof message === 'object' && 'created_at' in message && typeof message.created_at === 'string'
    ? message.created_at : null;
}
const typeStyles: Record<AuditType, { row: string; badge: string }> = {
  notification: { row: 'border-violet-400/70 bg-violet-500/[0.05] hover:bg-violet-500/[0.11]', badge: 'border-violet-400/30 bg-violet-400/10 text-violet-200' },
  aaa_service: { row: 'border-amber-400/70 bg-amber-500/[0.05] hover:bg-amber-500/[0.11]', badge: 'border-amber-400/30 bg-amber-400/10 text-amber-200' },
  ccc_service: { row: 'border-teal-400/70 bg-teal-500/[0.05] hover:bg-teal-500/[0.11]', badge: 'border-teal-400/30 bg-teal-400/10 text-teal-200' },
};
const notificationOriginStyles = {
  manual_admin: typeStyles.notification.badge,
  automation: 'border-blue-400/30 bg-blue-400/10 text-blue-200',
  unverified: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
};
const actionStyles: Record<AuditAction, string> = {
  edit: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
  source_edit: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
  delete: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  conversation_delete: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  customer_delete: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  employee_delete: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  admin_delete: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  source_delete: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
};
const inputClass = 'mt-1.5 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus-visible:border-cyan-400 focus-visible:ring-2 focus-visible:ring-cyan-400/30';
const compactInputClass = 'mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-2.5 py-1.5 text-xs text-white outline-none focus-visible:border-cyan-400 focus-visible:ring-2 focus-visible:ring-cyan-400/30';
const buttonFocus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';

function formatAuditTime(value: string | null, includeZone = true): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const formatted = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date);
  return includeZone ? `${formatted} (UTC+8)` : formatted;
}

function formatChatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

function localDayStart(date: string, nextDay = false): string {
  const start = new Date(`${date}T00:00:00+08:00`);
  if (nextDay) start.setTime(start.getTime() + 24 * 60 * 60 * 1000);
  return start.toISOString();
}

async function getChatIdentity(snapshot: unknown, employeeId: string | null): Promise<ChatIdentity> {
  const archived = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown> : null;
  const customerName = typeof archived?.customer_name === 'string' ? archived.customer_name : null;
  const archivedNumber = typeof archived?.employee_number === 'string' ? archived.employee_number : null;
  if (archivedNumber) return { customerName, employeeNumber: archivedNumber, employeeNumberSource: 'archived' };
  if (!archived || !employeeId) return { customerName, employeeNumber: null, employeeNumberSource: null };

  const { data } = await supabase.from('users').select('employee_id').eq('id', employeeId).maybeSingle();
  return {
    customerName,
    employeeNumber: data?.employee_id || null,
    employeeNumberSource: data?.employee_id ? 'current' : null,
  };
}

const displayTags = [
  'p', 'br', 'div', 'span', 'strong', 'em', 'u', 'b', 'i', 's', 'h1', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr',
];

function safeDisplayHtml(value: string): string {
  return sanitizeHTML(value, { allowedTags: displayTags, allowedAttributes: [] });
}

function readableText(value: string | null): string {
  if (!value) return '';
  const document = new DOMParser().parseFromString(safeDisplayHtml(value), 'text/html');
  document.querySelectorAll('br').forEach(element => element.replaceWith('\n'));
  document.querySelectorAll('p, div, li, h1, h2, h3, h4, blockquote, tr').forEach(element => element.append('\n'));
  return (document.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function ArchivedRichContent({ html, eventId, mediaRefs }: { html: string; eventId: string; mediaRefs: Record<string, string> }) {
  const parts = html.split(/(<img\b[^>]*>|<video\b[\s\S]*?<\/video>)/gi);
  const media = Object.entries(mediaRefs);
  const inlinePaths = new Set(parts.filter(part => /^<(img|video)\b/i.test(part)).flatMap(part =>
    media.filter(([source]) => part.includes(source) || part.includes(source.replace(/&/g, '&amp;'))).map(([, path]) => path)));

  return <div className="chat-rich-content min-w-0 break-words text-sm leading-6 [&_p]:my-1 [&_ul]:ml-4 [&_ul]:list-disc [&_ol]:ml-4 [&_ol]:list-decimal" style={{ overflowWrap: 'anywhere' }}>
    {parts.map((part, index) => /^<(img|video)\b/i.test(part) ? (
      media.filter(([source]) => part.includes(source) || part.includes(source.replace(/&/g, '&amp;'))).length > 0
        ? media.filter(([source]) => part.includes(source) || part.includes(source.replace(/&/g, '&amp;'))).map(([, path]) => <EvidenceMedia key={`${eventId}:${index}:${path}`} eventId={eventId} path={path} />)
        : <p key={index} className="text-xs opacity-70">圖片檔案無法還原。</p>
    ) : part ? <div key={index} className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: safeDisplayHtml(part) }} /> : null)}
    {media.filter(([, path]) => !inlinePaths.has(path)).map(([, path]) => <EvidenceMedia key={`${eventId}:${path}`} eventId={eventId} path={path} />)}
  </div>;
}

function ConversationTranscript({ message, senderName, workspace }: {
  message: ConversationMessage;
  senderName: string;
  workspace: AuditType;
}) {
  const [cardOpen, setCardOpen] = useState(false);
  const isCustomer = message.sender_type === 'customer';
  const rating = message.rating_data;
  const cardHtml = message.rendered_html || (message.message_content && /<[a-z][\s\S]*>/i.test(message.message_content) ? message.message_content : null);
  const accent = workspace === 'aaa_service' ? 'border-orange-300/35' : 'border-emerald-300/35';
  const attachments = Object.fromEntries(Object.entries(message.media_refs || {}).filter(([source]) =>
    [message.image_url, message.message_content, message.rendered_html].some(value =>
      value?.includes(source) || value?.includes(source.replace(/&/g, '&amp;')))));
  const imagePath = (message.image_url && attachments[message.image_url]) || Object.values(attachments)[0];

  useEffect(() => {
    if (!cardOpen) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setCardOpen(false); };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [cardOpen]);

  return (
    <>
      <div className={`flex min-w-0 ${isCustomer ? 'justify-end' : 'justify-start'}`}>
        <div className={`min-w-0 ${message.message_type === 'rich_card' ? 'w-[240px] max-w-[85%]' : 'max-w-[85%] sm:max-w-[75%]'}`}>
          {message.message_type === 'rich_card' && !message.cleared_at ? (
            <button type="button" onClick={() => setCardOpen(true)} className={`w-full overflow-hidden rounded-2xl text-left shadow-[0_2px_12px_rgba(37,99,246,0.15)] transition hover:scale-[1.015] hover:shadow-[0_8px_24px_rgba(37,99,246,0.22)] ${buttonFocus}`}>
              <span className="flex items-start gap-2.5 bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 px-4 pb-3.5 pt-4 text-white"><Megaphone className="mt-0.5 h-5 w-5 shrink-0" /><span className="min-w-0"><strong className="block break-words text-[13px] leading-snug">{message.title ? readableText(message.title) : '查看詳情'}</strong>{message.subtitle && <span className="mt-1 block break-words text-[11px] text-blue-100/80">{readableText(message.subtitle)}</span>}</span></span>
              <span className="flex items-center justify-between border-t border-blue-100 bg-white px-4 py-2 text-[11px] font-medium text-blue-600">查看詳情<ChevronRight className="h-4 w-4 text-blue-400" /></span>
            </button>
          ) : (
            <div className={`rounded-[20px] border-2 px-4 py-3 shadow-lg ${isCustomer ? 'rounded-tr-md border-slate-200 bg-white text-slate-800' : `rounded-tl-md bg-gradient-to-br from-slate-800 via-slate-800 to-slate-900 text-slate-100 ${accent}`}`}>
              <div className={`mb-2 border-b pb-1.5 text-xs font-semibold ${isCustomer ? 'border-slate-200 text-blue-700' : 'border-white/15 text-white'}`}>{senderName}</div>
              {message.cleared_at ? <p className="text-xs opacity-70">此則內容已正式清除。</p> : (
                <>
                  {message.message_type === 'rating_request' && <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-blue-700"><Star className="mr-1 inline h-4 w-4" />評分請求</div>}
                  {message.message_type === 'rating_result' && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800"><strong>服務評分</strong><div className="my-1 flex gap-0.5">{[1, 2, 3, 4, 5].map(star => <Star key={star} className={`h-4 w-4 ${star <= Number(rating?.rating || 0) ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} />)}</div>{typeof rating?.comment === 'string' && <p className="whitespace-pre-wrap break-words text-xs">{rating.comment}</p>}</div>}
                  {message.message_type === 'tip' && <div className="rounded-xl border border-amber-300 bg-gradient-to-br from-amber-950 to-orange-900 px-4 py-3 text-amber-100"><Gift className="mr-2 inline h-4 w-4" />已送出打賞 <strong className="ml-2 text-lg text-white">${typeof rating?.tip_amount === 'number' ? rating.tip_amount.toFixed(2) : '—'}</strong></div>}
                  {message.message_type === 'image' ? (imagePath ? <EvidenceMedia key={`${message.id}:${imagePath}`} eventId={message.id} path={imagePath} /> : <p className="text-xs opacity-70">圖片檔案無法還原。</p>) : !['rating_request', 'rating_result', 'tip'].includes(message.message_type || '') && <ArchivedRichContent html={message.message_content || ''} eventId={message.id} mediaRefs={attachments} />}
                </>
              )}
            </div>
          )}
          {message.created_at && <time className={`mt-1 block text-[10px] ${isCustomer ? 'text-right text-slate-400' : 'text-slate-500'}`}>{formatChatTime(message.created_at)}</time>}
        </div>
      </div>
      {cardOpen && createPortal(
        <div data-audit-nested-preview className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm xl:p-6" onClick={() => setCardOpen(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby={`audit-card-${message.id}`} className="flex h-full w-full flex-col overflow-hidden bg-white shadow-2xl xl:h-auto xl:max-h-[85vh] xl:w-[680px] xl:rounded-2xl" onClick={event => event.stopPropagation()}>
            <div className="relative shrink-0 bg-gradient-to-br from-blue-800 via-blue-600 to-blue-700 px-5 pb-5 pt-6 text-white">
              <button type="button" autoFocus onClick={() => setCardOpen(false)} aria-label="關閉卡片詳情" className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-white/15 hover:bg-white/25"><X className="h-4 w-4" /></button>
              {message.created_at && <p className="mb-3 text-xs text-blue-100">{formatAuditTime(message.created_at)}</p>}
              <div className="flex items-start gap-3 pr-10"><span className="rounded-xl border border-white/20 bg-white/15 p-2.5"><Megaphone className="h-6 w-6" /></span><div className="min-w-0"><h2 id={`audit-card-${message.id}`} className="break-words text-lg font-bold">{message.title ? readableText(message.title) : '訊息卡片'}</h2>{message.subtitle && <p className="mt-1 break-words text-sm text-blue-100">{readableText(message.subtitle)}</p>}</div></div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5 text-slate-700 sm:p-6">
              {cardHtml ? <ArchivedRichContent html={cardHtml} eventId={message.id} mediaRefs={attachments} /> : <p className="text-sm text-slate-500">此卡片的內容無法還原。</p>}
            </div>
            <div className="shrink-0 border-t border-slate-100 bg-slate-50 px-5 py-3"><button type="button" onClick={() => setCardOpen(false)} className="w-full rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 px-5 py-3 text-sm font-semibold text-white hover:from-blue-700 hover:to-blue-600">關閉</button></div>
          </div>
        </div>, document.body,
      )}
    </>
  );
}

function Snapshot({ title, data, cleared, type, eventId, mediaRefs, employeeAccount }: {
  title: string;
  data: unknown;
  cleared: boolean;
  type: AuditType;
  eventId: string;
  mediaRefs: Record<string, string> | null;
  employeeAccount: string | null;
}) {
  const snapshot = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown> : null;
  const message = snapshot?.message && typeof snapshot.message === 'object' && !Array.isArray(snapshot.message)
    ? snapshot.message as Record<string, unknown> : null;
  const snapshotText = JSON.stringify(data) ?? '';
  const refs = Object.fromEntries(Object.entries(mediaRefs || {}).filter(([source, path]) =>
    typeof path === 'string' && (snapshotText.includes(source) || snapshotText.includes(source.replace(/&/g, '&amp;')))));

  if (cleared || !message) return <p className="px-5 py-8 text-sm text-slate-300">{cleared ? '此內容已正式清除。' : '沒有可顯示的內容。'}</p>;

  if (type === 'notification') {
    const priority = String(message.priority);
    return (
      <section className="flex min-h-[480px] min-w-0 flex-1 flex-col bg-[#f0f5ff]">
        {title.startsWith('修改') && <h4 className="shrink-0 border-b border-blue-100 bg-white px-5 py-3 text-xs font-bold text-blue-700">{title}</h4>}
        <div className="min-h-0 flex-1 overflow-hidden">
          <EmployeeNotificationDetailPanel embedded readOnlyPreview onClose={() => {}} message={{
            title: String(message.title || ''), content: safeDisplayHtml(String(message.content || '')),
            message_type: message.message_type === 'login_popup' ? 'login_popup' : 'realtime',
            priority: priority === 'low' || priority === 'high' || priority === 'urgent' ? priority : 'normal',
            notification_category: typeof message.notification_category === 'string' ? message.notification_category : null,
            reward_amount: typeof message.reward_amount === 'number' ? message.reward_amount : null,
            reward_currency: typeof message.reward_currency === 'string' ? message.reward_currency : null,
            created_at: typeof message.created_at === 'string' ? message.created_at : null,
            is_read: false,
          }} />
        </div>
        {Object.keys(refs).length > 0 && <div className="space-y-2 border-t border-blue-100 bg-white p-3 text-xs text-slate-600">
          {Object.entries(refs).map(([, path]) => <EvidenceMedia key={`${eventId}:${path}`} eventId={eventId} path={path} />)}
        </div>}
      </section>
    );
  }

  const chat: ConversationMessage = {
    id: eventId,
    created_at: typeof message.created_at === 'string' ? message.created_at : null,
    sender_type: typeof message.sender_type === 'string' ? message.sender_type : null,
    message_type: typeof message.message_type === 'string' ? message.message_type : null,
    message_content: typeof message.message_content === 'string' ? message.message_content : null,
    image_url: typeof message.image_url === 'string' ? message.image_url : null,
    title: typeof message.title === 'string' ? message.title : null,
    subtitle: typeof message.subtitle === 'string' ? message.subtitle : null,
    rating_data: message.rating_data && typeof message.rating_data === 'object' && !Array.isArray(message.rating_data) ? message.rating_data as Record<string, unknown> : null,
    rendered_html: typeof snapshot?.rendered_html === 'string' ? snapshot.rendered_html : null,
    media_refs: refs,
    cleared_at: null,
    clear_started_at: null,
  };

  return <section className="min-w-0 px-4 py-4 sm:px-6"><h4 className="mb-3 border-b border-white/10 pb-2 text-xs font-bold text-cyan-200">{title}</h4><ConversationTranscript message={chat} senderName={chat.sender_type === 'customer' ? String(snapshot?.customer_name || '客戶') : String(snapshot?.employee_name || employeeAccount || '員工')} workspace={type} /></section>;
}

function EvidenceMedia({ eventId, path }: { eventId: string; path: string }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const activeRef = useRef(true);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    activeRef.current = true;
    requestVersionRef.current += 1;
    return () => {
      activeRef.current = false;
      requestVersionRef.current += 1;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    };
  }, [eventId, path]);

  const load = useCallback(async () => {
    if (loadingRef.current || objectUrlRef.current) return;
    const requestVersion = requestVersionRef.current;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const media = await loadAuditedMedia(eventId, path);
      if (!activeRef.current || requestVersion !== requestVersionRef.current) {
        URL.revokeObjectURL(media.url);
        return;
      }
      objectUrlRef.current = media.url;
      setMediaType(media.type);
      setObjectUrl(media.url);
    } catch (err) {
      if (activeRef.current && requestVersion === requestVersionRef.current) setError(`載入圖片失敗：${formatSupabaseError(err)}`);
    } finally {
      if (requestVersion === requestVersionRef.current) {
        loadingRef.current = false;
        if (activeRef.current) setLoading(false);
      }
    }
  }, [eventId, path]);

  useEffect(() => {
    if (!expanded) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [expanded]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        void load();
        observer.disconnect();
      }
    }, { rootMargin: '160px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [load]);

  return (
    <div ref={containerRef} className="min-w-0">
      {objectUrl && mediaType === 'video/mp4' ? <video src={objectUrl} controls preload="none" className="max-h-64 max-w-full rounded-lg" /> : objectUrl ? <button type="button" onClick={() => setExpanded(true)} aria-label="放大圖片" className={`block max-w-full rounded-lg ${buttonFocus}`}><img src={objectUrl} alt="封存圖片，點擊放大" className="max-h-64 max-w-full rounded-lg object-contain" /></button> : (
        <button type="button" onClick={() => void load()} disabled={loading} className={`inline-flex items-center gap-2 rounded-lg border border-cyan-400/35 bg-cyan-500/10 px-3 py-2 text-xs font-bold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50 ${buttonFocus}`}>
          <ImageIcon className="h-4 w-4" aria-hidden="true" />{loading ? '圖片載入中…' : error ? '重試載入圖片' : '查看圖片'}
        </button>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
      {expanded && objectUrl && createPortal(<div data-audit-nested-preview className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/90 p-4" onClick={() => setExpanded(false)}><div role="dialog" aria-modal="true" aria-label="圖片預覽" className="relative flex max-h-full max-w-full items-center" onClick={event => event.stopPropagation()}><button type="button" autoFocus onClick={() => setExpanded(false)} aria-label="關閉圖片預覽" className="absolute -right-2 -top-11 rounded-full bg-white/15 p-2 text-white hover:bg-white/30"><X className="h-5 w-5" /></button><img src={objectUrl} alt="封存圖片預覽" className="max-h-[85vh] max-w-[95vw] object-contain" /></div></div>, document.body)}
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: string | null }) {
  return <div className="min-w-0 rounded-xl border border-white/[0.08] bg-white/[0.035] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"><dt className="text-[10px] font-semibold tracking-wide text-slate-400">{label}</dt><dd className="mt-1 break-all text-xs font-medium leading-5 text-slate-100">{value || '—'}</dd></div>;
}

function OwnerPicker({ selected, owners, total, loading, error, onRetry, onSelect, wide = false }: {
  selected: string;
  owners: Array<{ id: string; username: string; event_count: number | null }>;
  total: number | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelect: (owner: string) => void;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedOwner = owners.find(owner => owner.id === selected);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return <div ref={containerRef} className={`relative shrink-0 ${wide ? 'w-full' : ''}`}>
    <button ref={triggerRef} type="button" aria-label={`所屬管理員：${selected ? selectedOwner?.username || '已選管理員' : '全部管理員'}`} aria-expanded={open} onClick={() => setOpen(value => !value)} className={`flex h-9 ${wide ? 'w-full' : 'w-[148px]'} items-center gap-1.5 rounded-xl border border-cyan-300/25 bg-slate-800/80 px-2.5 text-left text-xs font-semibold text-white shadow-[0_3px_12px_rgba(2,6,23,0.28)] transition hover:border-cyan-300/55 hover:bg-slate-800 ${buttonFocus}`}>
      <User className="h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden="true" /><span className="min-w-0 flex-1 truncate" title={selectedOwner?.username || '全部管理員'}>{selectedOwner?.username || (selected ? '已選管理員' : '全部管理員')}</span><ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
    </button>
    {open && <div className={`absolute right-0 top-[calc(100%+7px)] z-50 ${wide ? 'w-full' : 'w-[246px]'} max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-cyan-300/25 bg-slate-900 shadow-[0_16px_40px_rgba(2,6,23,0.55)]`}>
      <div className="flex items-center justify-between border-b border-white/10 bg-gradient-to-r from-cyan-950/65 to-slate-900 px-3 py-2"><span className="text-[11px] font-bold text-cyan-100">所屬管理員</span><span className="text-[10px] text-slate-400">{owners.length} 位</span></div>
      <div className="max-h-56 overflow-y-auto p-1.5 scrollbar-dark" aria-label="選擇所屬管理員">
        {[{ id: '', username: '全部管理員', event_count: total }, ...owners].map(owner => <button key={owner.id} type="button" aria-pressed={selected === owner.id} onClick={() => { onSelect(owner.id); setOpen(false); }} className={`flex h-9 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left text-xs transition-colors ${selected === owner.id ? 'bg-cyan-500/15 font-bold text-cyan-100' : 'text-slate-200 hover:bg-slate-800 hover:text-white'} ${buttonFocus}`}><span className="min-w-0 truncate">{owner.username}</span><span className={`inline-flex min-w-6 shrink-0 justify-center rounded-md px-1.5 py-0.5 text-xs font-extrabold tabular-nums ring-1 ring-inset ${selected === owner.id ? 'bg-cyan-400/25 text-cyan-50 ring-cyan-300/40' : 'bg-slate-700 text-white ring-slate-500/50'}`}>{owner.event_count === null ? '—' : owner.event_count.toLocaleString()}</span></button>)}
        {owners.length === 0 && <p className="px-2.5 py-2 text-[11px] text-slate-400">{loading ? '正在載入管理員…' : '管理員名單暫不可用'}</p>}
      </div>
      {error && <div className="flex items-center justify-between gap-2 border-t border-rose-400/20 bg-rose-950/20 px-3 py-2 text-[11px] text-rose-200"><span>數量暫不可用</span><button type="button" onClick={onRetry} className={`font-bold text-cyan-200 underline ${buttonFocus}`}>重試載入</button></div>}
    </div>}
  </div>;
}

export default function ContentAuditPanel({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<'content' | 'employees'>('content');
  const [archiveEmployeeId, setArchiveEmployeeId] = useState<string | null>(null);
  const [archiveSection, setArchiveSection] = useState<'profile' | 'notifications' | 'aaa_service' | 'ccc_service'>('profile');
  const [draft, setDraft] = useState<AuditFilters>(emptyFilters);
  const [filters, setFilters] = useState<AuditFilters>(emptyFilters);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [filterCounts, setFilterCounts] = useState<AuditFilterCounts | null>(null);
  const [availableAdmins, setAvailableAdmins] = useState<Array<{ id: string; username: string }>>([]);
  const [filterCountsLoading, setFilterCountsLoading] = useState(true);
  const [filterCountsError, setFilterCountsError] = useState<string | null>(null);
  const [filterCountsRetryKey, setFilterCountsRetryKey] = useState(0);
  const [ownerTypeCounts, setOwnerTypeCounts] = useState<{ owner: string; types: Record<AuditType, number> } | null>(null);
  const [ownerCountsError, setOwnerCountsError] = useState<{ owner: string; message: string } | null>(null);
  const [ownerCountsRetryKey, setOwnerCountsRetryKey] = useState(0);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [listRetryKey, setListRetryKey] = useState(0);
  const [listLoadError, setListLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCard, setSelectedCard] = useState<AuditEvent | null>(null);
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [chatIdentity, setChatIdentity] = useState<ChatIdentity | null>(null);
  const [conversationPage, setConversationPage] = useState(0);
  const [loadedConversationPage, setLoadedConversationPage] = useState(0);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [conversationRetryKey, setConversationRetryKey] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailKey, setDetailKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [deleteFeedback, setDeleteFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const deletionContext = useMemo(() => ({ draft, filters, selectedId, view }), [draft, filters, selectedId, view]);
  const [deletePreview, setDeletePreview] = useState<{ job_id: string; card_count: number; event_count: number; scope: 'bulk' | 'single' | 'conversation'; finished_at?: string | null; context: typeof deletionContext } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingDeletes, setPendingDeletes] = useState<Array<{ job_id: string; card_count: number; event_count: number; finished_at: string | null }>>([]);
  const detailRef = useRef<HTMLDivElement>(null);
  const conversationContentRef = useRef<HTMLDivElement>(null);
  const conversationIdentityRef = useRef<ChatIdentity | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const deletionContextRef = useRef(deletionContext);
  const mountedRef = useRef(false);
  const deletePreviewRef = useRef(deletePreview);
  const executingJobRef = useRef<string | null>(null);
  const prepareRequestRef = useRef<object | null>(null);
  deletionContextRef.current = deletionContext;

  const cancelConfirmation = useCallback(async (jobId: string) => {
    try {
      const result = await cancelAuditDeletionConfirmation('content', jobId);
      if (!result.success) throw new Error('確認暫存回收未獲確認。');
      if (mountedRef.current && result.cancelled) {
        setPendingDeletes(previous => previous.filter(job => job.job_id !== jobId));
      } else if (mountedRef.current && !result.cancelled) {
        // 已進入附件清理的任務不取消，保留pending重試入口。
        try {
          const jobs = await listPendingAuditedDeletions();
          if (mountedRef.current) setPendingDeletes(jobs);
        } catch (pendingError) {
          if (mountedRef.current) setError(`確認已關閉，任務未被取消；待清理任務查詢失敗：${formatSupabaseError(pendingError)}。請重新整理核對，這不是實際內容刪除的結果。`);
        }
      }
    } catch (err) {
      if (mountedRef.current) {
        const message = `刪除確認已關閉，但確認暫存尚未回收，將由到期回收：${formatSupabaseError(err)}。這不是實際內容刪除的結果。`;
        setError(message);
        setDeleteFeedback({ type: 'error', message });
      }
    }
  }, []);

  const dismissDeletePreview = useCallback(() => {
    const preview = deletePreviewRef.current;
    if (preview && executingJobRef.current === preview.job_id) return;
    deletePreviewRef.current = null;
    if (mountedRef.current) setDeletePreview(null);
    if (preview && !preview.finished_at) void cancelConfirmation(preview.job_id);
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
  }, [draft, filters, selectedId, view, invalidateDeletionPreview]);

  useEffect(() => {
    if (!deletePreview) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !executingJobRef.current) {
        setError(null);
        invalidateDeletionPreview();
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [deletePreview, invalidateDeletionPreview]);

  useEffect(() => {
    if (!deleteFeedback) return;
    const timer = window.setTimeout(() => setDeleteFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [deleteFeedback]);

  useEffect(() => {
    let cancelled = false;
    void listPendingAuditedDeletions().then(jobs => {
      if (!cancelled) setPendingDeletes(jobs);
    }).catch(err => {
      if (!cancelled) setError(`無法查詢未完成的附件清理：${formatSupabaseError(err)}`);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFilterCountsLoading(true);
    setFilterCountsError(null);
    const load = async () => {
      try {
        const { data, error: rpcError } = await supabase.rpc('get_content_audit_filter_counts', {
          p_admin_session_token: getAdminFinancialSessionToken(),
        });
        if (rpcError) throw rpcError;
        if (!data || !Array.isArray(data.owners) || !data.types) throw new Error('篩選選項格式不正確。');
        if (!cancelled) {
          setFilterCounts(data);
          setAvailableAdmins(data.owners.filter(owner => owner.username?.trim().toLowerCase() !== 'emergency_admin').map(owner => ({ id: owner.id, username: owner.username })));
        }
      } catch (err) {
        if (cancelled) return;
        setFilterCountsError(formatSupabaseError(err));
        const { data: admins, error: adminsError } = await supabase.from('admins')
          .select('id, username').order('username');
        if (!cancelled && !adminsError && admins) setAvailableAdmins(admins.filter(admin => admin.username?.trim().toLowerCase() !== 'emergency_admin'));
      } finally {
        if (!cancelled) setFilterCountsLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [refreshKey, filterCountsRetryKey]);

  useEffect(() => {
    if (!filters.owner) {
      setOwnerTypeCounts(null);
      setOwnerCountsError(null);
      return;
    }
    let cancelled = false;
    setOwnerTypeCounts(null);
    setOwnerCountsError(null);
    const load = async () => {
      try {
        const owner = filters.owner;
        const types = {} as Record<AuditType, number>;
        await Promise.all((Object.keys(typeLabels) as AuditType[]).map(async type => {
          const { data, error: rpcError } = await supabase.rpc('list_content_audit_cards', {
            p_admin_session_token: getAdminFinancialSessionToken(),
            p_owner: owner, p_type: type, p_page: 0, p_page_size: 1,
          });
          if (rpcError) throw rpcError;
          if (!data || typeof data.total !== 'number') throw new Error('分類數量格式不正確。');
          types[type] = data.total;
        }));
        if (!cancelled) setOwnerTypeCounts({ owner, types });
      } catch (err) {
        if (!cancelled) setOwnerCountsError({ owner: filters.owner, message: formatSupabaseError(err) });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [filters.owner, refreshKey, ownerCountsRetryKey]);

  useEffect(() => {
    if (view === 'employees') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setListLoadError(false);
    if (page === 0) {
      setEvents([]);
      setTotal(0);
    }
    const load = async () => {
      try {
        const { data, error: rpcError } = await supabase.rpc('list_content_audit_cards_filtered', {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_type: filters.type || null,
          p_owner: filters.owner || null,
          p_action: filters.action || null,
          p_content_search: filters.contentSearch || null,
          p_identity_search: filters.identitySearch || null,
          p_from: filters.from ? localDayStart(filters.from) : null,
          p_to: filters.to ? localDayStart(filters.to, true) : null,
          p_page: page, p_page_size: PAGE_SIZE,
        });
        if (rpcError) throw rpcError;
        if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items) || !('total' in data)) {
          throw new Error('稽核清單格式不正確。');
        }
        if (!cancelled) {
          const nextItems = data.items as unknown as AuditEvent[];
          setEvents(previous => {
            if (page === 0) return nextItems;
            const known = new Set(previous.map(item => item.card_id));
            return [...previous, ...nextItems.filter(item => !known.has(item.card_id))];
          });
          setTotal(Number(data.total) || 0);
        }
      } catch (err) {
        if (!cancelled) {
          setListLoadError(true);
          setError(`載入稽核紀錄失敗：${formatSupabaseError(err)}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [filters, page, refreshKey, listRetryKey, view]);

  useEffect(() => {
    if (loading || listLoadError || events.length === 0 || events.length >= total) return;
    const node = loadMoreRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        setPage(current => current + 1);
      }
    }, { rootMargin: '120px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [events.length, total, loading, listLoadError]);

  useEffect(() => {
    setDetail(null);
    setConversation(null);
    setChatIdentity(null);
    conversationIdentityRef.current = null;
    setLoadedConversationPage(0);
    setConversationError(null);
    setDetailLoading(Boolean(selectedCard));
  }, [selectedCard, detailKey]);

  useEffect(() => {
    if (!selectedCard) return;
    let cancelled = false;
    const conversationTarget = selectedCard.card_id.startsWith('conversation:') && selectedCard.customer_id && selectedCard.employee_id
      ? { customerId: selectedCard.customer_id, employeeId: selectedCard.employee_id } : null;
    if (conversationTarget) {
      setConversationLoading(true);
      setConversationError(null);
    }
    const load = async () => {
      try {
        if (conversationTarget) {
          const { data, error: rpcError } = await supabase.rpc('get_content_audit_conversation', {
            p_admin_session_token: getAdminFinancialSessionToken(),
            p_operation_id: selectedCard.operation_id,
            p_type: selectedCard.entity_type,
            p_customer_id: conversationTarget.customerId,
            p_employee_id: conversationTarget.employeeId,
            p_page: conversationPage,
            p_page_size: TRANSCRIPT_PAGE_SIZE,
          });
          if (rpcError) throw rpcError;
          if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) throw new Error('找不到此對話。');
          const record = data as unknown as ConversationDetail;
          let identity = conversationIdentityRef.current;
          if (!identity) {
            identity = { customerName: null, employeeNumber: null, employeeNumberSource: null };
            const evidenceId = record.items.find(item => !item.cleared_at)?.id;
            if (evidenceId) {
              const { data: eventData, error: eventError } = await supabase.rpc('get_content_audit_event', {
                p_admin_session_token: getAdminFinancialSessionToken(), p_event_id: evidenceId,
              });
              if (eventError) throw eventError;
              identity = await getChatIdentity((eventData as AuditDetail | null)?.before_data, conversationTarget.employeeId);
            }
          }
          if (!cancelled) {
            conversationIdentityRef.current = identity;
            setChatIdentity(identity);
            setConversation(record);
            setLoadedConversationPage(conversationPage);
          }
        } else {
          const { data, error: rpcError } = await supabase.rpc('get_content_audit_event', {
            p_admin_session_token: getAdminFinancialSessionToken(), p_event_id: selectedCard.id,
          });
          if (rpcError) throw rpcError;
          if (!data || typeof data !== 'object' || !('id' in data)) throw new Error('找不到此稽核事件。');
          const record = data as unknown as AuditDetail;
          const identity = record.entity_type === 'notification'
            ? null : await getChatIdentity(record.before_data, record.employee_id);
          if (!cancelled) {
            setChatIdentity(identity);
            setDetail(record);
          }
        }
      } catch (err) {
        if (!cancelled) {
          if (conversationTarget) setConversationError(formatSupabaseError(err));
          else setError(`載入稽核詳情失敗：${formatSupabaseError(err)}`);
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
          setConversationLoading(false);
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [selectedCard, conversationPage, detailKey, conversationRetryKey]);

  useEffect(() => {
    if (conversation) conversationContentRef.current?.scrollTo({ top: 0 });
  }, [conversation]);

  const switchView = (next: 'content' | 'employees') => {
    if (view === next) return false;
    invalidateDeletionPreview();
    setError(null);
    setDraft(emptyFilters);
    setFilters({ ...emptyFilters });
    setPage(0);
    setSelectedId(null);
    setSelectedCard(null);
    setDetail(null);
    setConversation(null);
    setView(next);
    return true;
  };

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = { ...draft, contentSearch: draft.contentSearch.trim(), identitySearch: draft.identitySearch.trim() };
    if (next.from && next.to && next.from > next.to) {
      setFilterError('結束日期不能早於開始日期。');
      return;
    }
    setFilterError(null);
    setFilters(next);
    setPage(0);
    setSelectedId(null);
    setSelectedCard(null);
    setDetail(null);
    setConversation(null);
    setConversationPage(0);
    setRefreshKey(key => key + 1);
  };

  const resetFilters = () => {
    setDraft(emptyFilters);
    setFilters(emptyFilters);
    setFilterError(null);
    setPage(0);
    setSelectedId(null);
    setSelectedCard(null);
    setDetail(null);
    setConversation(null);
    setConversationPage(0);
    setRefreshKey(key => key + 1);
  };

  const selectQuickFilter = (change: Partial<Pick<AuditFilters, 'type' | 'owner'>>) => {
    const next = { ...filters, ...change };
    setDraft(next);
    setFilters(next);
    setPage(0);
    setSelectedId(null);
    setSelectedCard(null);
    setDetail(null);
    setConversation(null);
    setConversationPage(0);
  };

  const closeEvent = useCallback(() => {
    invalidateDeletionPreview();
    setSelectedId(null);
    setSelectedCard(null);
    setDetail(null);
    setConversation(null);
  }, [invalidateDeletionPreview]);

  const selectEvent = (id: string) => {
    const version = detail?.timeline.find(item => item.id === id);
    const card = events.find(item => item.card_id === id || item.id === id)
      ?? (detail && version ? {
        ...detail, ...version, card_id: `event:${id}`, summary: '', message_count: 1,
        cleared_count: version.cleared_at ? 1 : 0,
      } : null);
    if (!card) return;
    setSelectedCard(card);
    setSelectedId(card.card_id);
    setConversationPage(0);
  };

  useEffect(() => {
    if (!selectedId || view !== 'content' || deletePreview) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[data-audit-nested-preview]')) closeEvent(); };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [selectedId, view, deletePreview, closeEvent]);

  const prepareDeletion = async (eventId?: string) => {
    if (!mountedRef.current || view !== 'content' || prepareRequestRef.current || executingJobRef.current || deletePreviewRef.current
      || (!pendingDeletes.length && !eventId && (!total || loading || listLoadError))) return;
    if (pendingDeletes.length) {
      const preview = { ...pendingDeletes[0], scope: 'bulk' as const, context: deletionContextRef.current };
      deletePreviewRef.current = preview;
      setDeletePreview(preview);
      return;
    }
    const request = {};
    const requestedContext = deletionContextRef.current;
    prepareRequestRef.current = request;
    const entireConversation = Boolean(eventId && selectedCard?.id === eventId && selectedCard.card_id.startsWith('conversation:'));
    setDeleting(true);
    setError(null);
    try {
      const prepared = entireConversation && eventId ? await prepareAuditedConversationDeletion(eventId) : await prepareAuditedDeletion({
        type: eventId ? null : filters.type || null,
        owner: eventId ? null : filters.owner || null,
        action: eventId ? null : filters.action || null,
        contentSearch: eventId ? null : filters.contentSearch || null,
        identitySearch: eventId ? null : filters.identitySearch || null,
        from: eventId || !filters.from ? null : localDayStart(filters.from),
        to: eventId || !filters.to ? null : localDayStart(filters.to, true),
      }, eventId);
      if (!mountedRef.current || prepareRequestRef.current !== request || deletionContextRef.current !== requestedContext) {
        void cancelConfirmation(prepared.job_id);
        return;
      }
      const preview = { ...prepared, scope: entireConversation ? 'conversation' as const : eventId ? 'single' as const : 'bulk' as const, context: requestedContext };
      deletePreviewRef.current = preview;
      setDeletePreview(preview);
    } catch (err) {
      if (mountedRef.current && prepareRequestRef.current === request && deletionContextRef.current === requestedContext) {
        setError(`無法準備刪除：${formatSupabaseError(err)}`);
      }
    } finally {
      if (prepareRequestRef.current === request) {
        prepareRequestRef.current = null;
        if (mountedRef.current) setDeleting(false);
      }
    }
  };

  const confirmDeletion = async () => {
    const preview = deletePreviewRef.current;
    if (!mountedRef.current || !preview || prepareRequestRef.current || executingJobRef.current) return;
    if (preview.context !== deletionContextRef.current) {
      invalidateDeletionPreview();
      setError('篩選或選取紀錄已變更，請重新預覽刪除範圍。');
      return;
    }
    executingJobRef.current = preview.job_id;
    setDeleting(true);
    setError(null);
    try {
      const result = await executeAuditedDeletion(preview.job_id);
      deletePreviewRef.current = null;
      if (!mountedRef.current) return;
      const completion = preview.finished_at
        ? '附件及原圖清理已完成。'
        : `已永久清除 ${preview.event_count} 筆內容稽核證據及不再使用的附件。`;
      setDeleteFeedback({ type: 'success', message: completion + (result.retained_shared_images > 0
        ? ` 有 ${result.retained_shared_images} 個素材仍被範本或其他內容引用，已保留。` : '') });
      setPendingDeletes(previous => previous.filter(job => job.job_id !== preview.job_id));
      setDeletePreview(null);
      setSelectedId(null);
      setSelectedCard(null);
      setDetail(null);
      setConversation(null);
      setPage(0);
      setRefreshKey(key => key + 1);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(`刪除未完成：${formatSupabaseError(err)}。可重試本次確認；若已過期，取消後重新預覽。`);
      setDeleteFeedback({ type: 'error', message: `內容稽核證據清理未完成：${formatSupabaseError(err)}。請重試本次確認。` });
      try {
        const jobs = await listPendingAuditedDeletions();
        if (!mountedRef.current) return;
        setPendingDeletes(jobs);
        const pending = jobs.find(job => job.job_id === preview.job_id);
        if (pending && deletePreviewRef.current?.job_id === preview.job_id) {
          const updatedPreview = { ...preview, ...pending };
          deletePreviewRef.current = updatedPreview;
          setDeletePreview(updatedPreview);
        }
        setPage(0);
        setRefreshKey(key => key + 1);
        setDetailKey(key => key + 1);
      } catch (pendingError) {
        if (mountedRef.current) setError(`刪除未完成：${formatSupabaseError(err)}。待清理任務查詢失敗：${formatSupabaseError(pendingError)}。請重試本次確認或重新整理核對。`);
      }
    } finally {
      executingJobRef.current = null;
      if (!mountedRef.current || preview.context !== deletionContextRef.current) dismissDeletePreview();
      if (mountedRef.current) setDeleting(false);
    }
  };

  const viewSwitch = <div role="group" aria-label="稽核面板" className="grid w-full grid-cols-2 gap-1 rounded-xl border border-white/10 bg-slate-950/80 p-1 shadow-inner">
    {([['content', '內容稽核'], ['employees', '刪除員工']] as const).map(([mode, label]) => <button key={mode} type="button" aria-pressed={view === mode} onClick={() => switchView(mode)} className={`flex min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-0.5 py-1.5 text-[10px] font-bold transition-colors ${view === mode ? 'bg-gradient-to-br from-cyan-500 to-blue-700 text-white shadow-[0_4px_16px_rgba(8,145,178,0.35)]' : 'text-slate-400 hover:bg-white/[0.07] hover:text-white'} ${buttonFocus}`}>{mode === 'content' ? <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <UserRoundX className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}{label}</button>)}
  </div>;

  const ownerOptions = filterCounts
    ? filterCounts.owners.filter(owner => owner.username?.trim().toLowerCase() !== 'emergency_admin')
    : availableAdmins.map(admin => ({ ...admin, event_count: null }));
  const scopedTypes = filters.owner
    ? ownerTypeCounts?.owner === filters.owner ? ownerTypeCounts.types : null
    : filterCounts?.types ?? null;
  const scopedTotal = filters.owner
    ? filterCounts?.owners.find(owner => owner.id === filters.owner)?.event_count
      ?? (scopedTypes ? Object.values(scopedTypes).reduce((sum, count) => sum + count, 0) : null)
    : filterCounts?.total ?? null;

  const filterForm = (showType: boolean, compact = false) => (
    <form onSubmit={applyFilters} className={compact ? 'space-y-2' : 'space-y-3'}>
      {showType && <label className="block text-xs font-semibold text-slate-300">資料類型
        <select className={inputClass} value={draft.type} onChange={event => setDraft(previous => ({ ...previous, type: event.target.value as AuditFilters['type'] }))}>
          <option value="">全部類型{scopedTotal !== null ? `（${scopedTotal.toLocaleString()}）` : ''}</option>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}{scopedTypes ? `（${scopedTypes[value as AuditType].toLocaleString()}）` : ''}</option>)}
        </select>
      </label>}
      {filterCountsError && <div role="alert" className="flex items-center justify-between gap-2 text-xs text-rose-300"><span className="min-w-0 break-words">稽核數量載入失敗：{filterCountsError}{availableAdmins.length > 0 ? '；管理員清單仍可選擇。' : ''}</span><button type="button" onClick={() => setFilterCountsRetryKey(key => key + 1)} className={`shrink-0 font-bold underline ${buttonFocus}`}>重試</button></div>}
      {ownerCountsError?.owner === filters.owner && <div role="alert" className="flex items-center justify-between gap-2 text-xs text-rose-300"><span className="min-w-0 break-words">管理員分類數量載入失敗：{ownerCountsError.message}</span><button type="button" onClick={() => setOwnerCountsRetryKey(key => key + 1)} className={`shrink-0 font-bold underline ${buttonFocus}`}>重試</button></div>}
      <label className="block text-xs font-semibold text-slate-300">操作類型
        <select className={compact ? compactInputClass : inputClass} value={draft.action} onChange={event => setDraft(previous => ({ ...previous, action: event.target.value as AuditFilters['action'] }))}>
          <option value="">全部操作</option>{Object.entries(actionLabels).filter(([value]) => value !== 'employee_delete' && value !== 'admin_delete').map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="block text-xs font-semibold text-slate-300">{draft.type === 'notification' ? '通知內容搜尋' : draft.type ? '聊天內容搜尋' : '內容搜尋（聊天／通知）'}
        <span className="relative block"><Search className={`pointer-events-none absolute left-3 h-4 w-4 text-slate-500 ${compact ? 'top-2.5' : 'top-4'}`} aria-hidden="true" /><input className={`${compact ? compactInputClass : inputClass} pl-9`} value={draft.contentSearch} onChange={event => setDraft(previous => ({ ...previous, contentSearch: event.target.value }))} placeholder={draft.type === 'notification' ? '通知標題或內文' : '訊息文字或卡片內容'} /></span>
      </label>
      <label className="block text-xs font-semibold text-slate-300">角色／員工／收件人搜尋
        <span className="relative block"><User className={`pointer-events-none absolute left-3 h-4 w-4 text-slate-500 ${compact ? 'top-2.5' : 'top-4'}`} aria-hidden="true" /><input className={`${compact ? compactInputClass : inputClass} pl-9`} value={draft.identitySearch} onChange={event => setDraft(previous => ({ ...previous, identitySearch: event.target.value }))} placeholder="角色名稱、員工帳號或員工 ID" /></span>
        <span className="mt-1 block text-[11px] font-normal text-slate-400">{compact ? '員工名稱為帳號；員工 ID 非系統 UID。' : '員工名稱為帳號；員工 ID 為建號時設定的編號，非系統 UID。'}</span>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="min-w-0 text-xs font-semibold text-slate-300">開始日期（UTC+8）<input type="date" className={`${compact ? compactInputClass : inputClass} min-w-0 [color-scheme:dark]`} value={draft.from} onChange={event => setDraft(previous => ({ ...previous, from: event.target.value }))} /></label>
        <label className="min-w-0 text-xs font-semibold text-slate-300">結束日期（UTC+8）<input type="date" className={`${compact ? compactInputClass : inputClass} min-w-0 [color-scheme:dark]`} value={draft.to} onChange={event => setDraft(previous => ({ ...previous, to: event.target.value }))} /></label>
      </div>
      {filterError && <p role="alert" className="text-xs text-rose-300">{filterError}</p>}
      <div className={`flex gap-2 ${compact ? '' : 'pt-1'}`}>
        <button type="submit" className={`flex-1 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-700 px-3 py-1.5 text-xs font-bold text-white hover:from-cyan-500 hover:to-blue-600 ${buttonFocus}`}>套用篩選</button>
        <button type="button" onClick={resetFilters} className={`rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800 ${buttonFocus}`}>重設</button>
      </div>
    </form>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-950 text-slate-100">
      <header className="shrink-0 border-b border-cyan-300/20 bg-[radial-gradient(circle_at_82%_0%,rgba(6,182,212,0.18),transparent_34%),linear-gradient(90deg,#020617_0%,#0f172a_55%,#083344_100%)] px-3 py-3 shadow-[0_8px_24px_rgba(2,6,23,0.32)] sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" onClick={() => { invalidateDeletionPreview(); onBack(); }} aria-label="返回歷史資料管理" className={`flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-rose-400/40 bg-rose-500/15 px-2.5 text-xs font-bold text-rose-200 hover:bg-rose-500/25 disabled:opacity-50 ${buttonFocus}`}><ArrowLeft className="h-4 w-4" aria-hidden="true" />返回</button>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-500/10 text-cyan-300"><ShieldCheck className="h-5 w-5" aria-hidden="true" /></span>
            <div className="min-w-0"><h1 className="text-lg font-black text-white sm:text-xl">{view === 'content' ? '內容稽核總覽' : '已刪員工紀錄'}</h1><p className="text-[11px] text-slate-400">{view === 'content' ? '單獨操作的通知、模擬客戶與經理對話異動' : '員工帳戶刪除及連帶內容留證'} · 時間均為 UTC+8</p></div>
          </div>
          <button type="button" onClick={() => { setPage(0); setRefreshKey(key => key + 1); setDetailKey(key => key + 1); }} disabled={view !== 'employees' && loading} className={`inline-flex h-9 items-center gap-2 rounded-xl border border-cyan-300/35 bg-cyan-500/10 px-3 text-xs font-bold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50 ${buttonFocus}`}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />刷新清單</button>
        </div>
      </header>

      {error && <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-rose-500/30 bg-rose-950/50 px-4 py-2.5 text-xs text-rose-200"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{error}</span><button type="button" onClick={() => setError(null)} className="ml-auto shrink-0 underline">關閉</button></div>}

      {view !== 'employees' && <div className="relative z-30 shrink-0 border-b border-slate-700 bg-slate-900 px-3 py-2 lg:hidden">{viewSwitch}</div>}
      {view === 'employees' && <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><DeletedEmployeesPanel switcher={viewSwitch} isActive refreshKey={refreshKey} onDeleted={() => setRefreshKey(key => key + 1)} onDeleteResult={setDeleteFeedback} initialSelectedId={archiveEmployeeId} initialSection={archiveSection} availableAdmins={availableAdmins} onSelectSection={setArchiveSection} onSelectEmployee={setArchiveEmployeeId} /></div>}
      {view !== 'employees' && <>
      <div className="relative z-20 shrink-0 border-b border-slate-700 bg-slate-900 px-3 py-2 lg:hidden">
        <div className="mb-2 flex items-center justify-between gap-2"><div className="flex items-center gap-2"><Database className="h-4 w-4 text-cyan-300" aria-hidden="true" /><h2 className="text-xs font-black text-white">內容篩選</h2></div><OwnerPicker selected={filters.owner} owners={ownerOptions} total={filterCounts?.total ?? null} loading={filterCountsLoading} error={filterCountsError} onRetry={() => setFilterCountsRetryKey(key => key + 1)} onSelect={owner => selectQuickFilter({ owner })} /></div>
        <details className="group max-h-[65vh] overflow-y-auto rounded-xl border border-slate-700 bg-slate-950/60 p-3">
          <summary className="cursor-pointer text-xs font-bold text-cyan-200">篩選條件 · 類型／搜尋／日期</summary>
          <div className="mt-3">{filterForm(view === 'content')}</div>
        </details>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[270px_minmax(0,1fr)]">
        <aside className="relative z-20 hidden min-h-0 flex-col border-r border-cyan-300/10 bg-[radial-gradient(circle_at_0%_0%,rgba(34,211,238,0.08),transparent_45%),linear-gradient(180deg,#0a1526,#090f1d_72%,#0d1627)] p-3 lg:flex lg:overflow-visible [@media(max-height:760px)]:overflow-y-auto scrollbar-dark">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-cyan-100"><ShieldCheck className="h-4 w-4" aria-hidden="true" />監察工作台</div>
            {viewSwitch}
            <section className="relative mt-3 border-t border-white/10 pt-2.5"><p className="mb-1 text-[11px] font-semibold text-slate-300">所屬管理員</p><OwnerPicker wide selected={filters.owner} owners={ownerOptions} total={filterCounts?.total ?? null} loading={filterCountsLoading} error={filterCountsError} onRetry={() => setFilterCountsRetryKey(key => key + 1)} onSelect={owner => selectQuickFilter({ owner })} /></section>
            {view === 'content' && <section className="mt-3 border-t border-white/10 pt-2.5"><h3 className="mb-1 text-[11px] font-bold text-slate-300">資料分類</h3><div className="space-y-0.5">{([['', '全部事件'], ...Object.entries(typeLabels)] as Array<[AuditFilters['type'], string]>).map(([type, label]) => (
            <button key={type} type="button" onClick={() => selectQuickFilter({ type })} aria-pressed={filters.type === type} className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1 text-left text-xs font-bold transition-colors ${filters.type === type ? 'border-cyan-300/30 bg-gradient-to-r from-cyan-500/25 to-blue-500/15 text-white shadow-[inset_3px_0_0_#67e8f9]' : 'border-transparent text-slate-400 hover:border-white/10 hover:bg-white/[0.05] hover:text-white'} ${buttonFocus}`}><span className="flex min-w-0 items-center gap-2">{type === 'notification' ? <Megaphone className="h-3.5 w-3.5 shrink-0 text-violet-300" /> : type ? <MessageCircle className={`h-3.5 w-3.5 shrink-0 ${type === 'aaa_service' ? 'text-amber-300' : 'text-teal-300'}`} /> : <Database className="h-3.5 w-3.5 shrink-0 text-cyan-300" />}<span className="truncate">{label}</span></span><span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums ${filters.type === type ? 'bg-cyan-300/15 text-cyan-100' : 'bg-slate-800 text-slate-400'}`}>{type ? scopedTypes?.[type]?.toLocaleString() ?? '…' : scopedTotal?.toLocaleString() ?? '…'}</span></button>
          ))}</div></section>}
            <section className="mt-3 border-t border-white/10 pt-2.5"><div className="mb-2 flex items-center gap-2"><Search className="h-3.5 w-3.5 text-cyan-300" aria-hidden="true" /><h3 className="text-[11px] font-bold text-slate-300">進階篩選</h3></div>{filterForm(false, true)}</section>
        </aside>

        <main className="audit-detail-scroll flex min-h-0 min-w-0 flex-col overflow-y-auto bg-slate-900 xl:overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col">
            <section aria-label="稽核事件清單" className="audit-detail-scroll flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
              <div className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-cyan-400/20 bg-[radial-gradient(circle_at_78%_-70%,rgba(34,211,238,0.2),transparent_48%),linear-gradient(100deg,#111d34,#0b162a)] px-4 py-3 shadow-[0_8px_24px_rgba(2,6,23,0.2)] sm:px-5"><div className="flex min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-300/10 text-cyan-200"><Database className="h-5 w-5" /></span><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-black tracking-wide text-white">異動紀錄</h2><span className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-2 py-0.5 text-[11px] font-bold tabular-nums text-cyan-100">{total.toLocaleString()} 筆</span></div><p className="mt-0.5 text-[11px] text-slate-400">僅顯示單獨內容操作；員工刪除請見「刪除員工」 · 刪除涵蓋未載入的紀錄</p></div></div><button type="button" onClick={() => void prepareDeletion()} disabled={deleting || (!pendingDeletes.length && (loading || listLoadError || total === 0))} className={`inline-flex items-center justify-center gap-2 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-2.5 text-xs font-bold text-rose-100 transition hover:border-rose-300/70 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40 ${buttonFocus}`}><Trash2 className="h-4 w-4" />{deleting ? '處理中…' : pendingDeletes.length ? `完成上次刪除（${pendingDeletes.length}）` : '全部刪除'}</button></div>
              <div className="hidden grid-cols-[36px_124px_134px_minmax(130px,1.1fr)_100px_100px_minmax(120px,1.4fr)_148px] items-center gap-2 border-b border-white/10 bg-[linear-gradient(90deg,#1e3050,#14243c)] px-4 py-3 text-[10px] font-black uppercase tracking-[0.08em] text-cyan-100/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] min-[1440px]:grid"><span>序號</span><span>資料類型</span><span>操作</span><span>員工帳號／ID</span><span>所屬管理員</span><span>實際操作者</span><span>內容摘要</span><span>異動時間（UTC+8）</span></div>
              <div className="flex items-center justify-between border-b border-white/10 bg-[linear-gradient(90deg,#1e3050,#14243c)] px-4 py-2.5 text-[10px] font-black tracking-wide text-cyan-100/80 min-[1440px]:hidden"><span>資料類型 · 操作 · 員工</span><span>異動紀錄 / 時間</span></div>
              <ol className="min-w-0 divide-y divide-slate-700/50">
                {events.length === 0 && !loading && !listLoadError && <li className="px-3 py-10 text-center text-xs text-slate-400">沒有符合條件的紀錄。</li>}
                {events.map((item, index) => (
                  <li key={item.card_id}>
                    <button type="button" onClick={() => selectEvent(item.card_id)} className={`grid w-full min-w-0 grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-l-[3px] px-3 py-2 text-left transition-colors min-[1440px]:min-h-11 min-[1440px]:grid-cols-[36px_124px_134px_minmax(130px,1.1fr)_100px_100px_minmax(120px,1.4fr)_148px] min-[1440px]:gap-y-0 ${selectedId === item.card_id ? 'border-cyan-300 bg-cyan-400/15 shadow-[inset_0_0_0_1px_rgba(103,232,249,0.14)]' : item.cleared_count > 0 ? 'border-slate-500 bg-slate-800/35 hover:bg-slate-800/60' : typeStyles[item.entity_type].row} ${buttonFocus}`}>
                      <span className="row-span-5 self-start pt-1 text-[11px] font-bold tabular-nums text-slate-400 min-[1440px]:row-span-1 min-[1440px]:self-center min-[1440px]:pt-0">{index + 1}.</span>
                      <span title={item.entity_type === 'notification' ? notificationOriginLabel(item.notification_origin) : typeLabels[item.entity_type]} className={`col-start-2 row-start-1 min-w-0 truncate rounded-md border px-1.5 py-1 text-[11px] font-bold leading-none min-[1440px]:col-auto min-[1440px]:row-auto min-[1440px]:py-1.5 ${item.entity_type === 'notification' ? notificationOriginStyles[item.notification_origin || 'unverified'] : typeStyles[item.entity_type].badge}`}>{item.entity_type === 'notification' ? notificationOriginLabel(item.notification_origin) : typeLabels[item.entity_type]}</span>
                      <span className={`col-start-3 row-start-1 justify-self-end whitespace-nowrap rounded-md border px-1.5 py-1 text-[11px] font-bold leading-none min-[1440px]:col-auto min-[1440px]:row-auto min-[1440px]:justify-self-start min-[1440px]:py-1.5 ${actionStyles[item.action]}`}>{auditActionLabel(item.entity_type, item.action)}</span>
                      <span className="col-span-2 col-start-2 row-start-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] min-[1440px]:col-auto min-[1440px]:row-auto min-[1440px]:block">
                        <span className="block max-w-full min-w-0 truncate font-bold text-white" title={item.employee_account || undefined}>{item.cleared_at ? '員工資料已清除' : item.employee_account || (item.entity_type === 'notification' ? '收件員工未留存' : '員工帳號未留存')}</span>
                        <span className="block max-w-full min-w-0 truncate whitespace-nowrap text-[10px] text-cyan-200" title={item.employee_number ? `${item.employee_number}${item.employee_number_source === 'current_account' ? '（目前帳戶，非事件時快照）' : ''}` : undefined}>ID {item.entity_type === 'notification' && item.recipient_count > 1 ? '多位' : item.employee_number || '—'}</span>
                      </span>
                      <span className="hidden min-w-0 truncate text-[11px] font-medium text-slate-300 min-[1440px]:block" title={item.owner_username || item.owner_admin_id}>{item.owner_username || item.owner_admin_id}</span>
                      <span className="hidden min-w-0 truncate text-[11px] text-sky-200 min-[1440px]:block" title={item.actor_username}>{item.actor_username}</span>
                      <span className="col-span-2 col-start-2 row-start-3 flex min-w-0 items-center gap-1.5 text-xs font-medium text-slate-100 min-[1440px]:col-auto min-[1440px]:row-auto" title={readableText(item.summary)}>{item.action === 'conversation_delete' && item.conversation_delete_number && <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${item.conversation_delete_number > 1 ? 'border-amber-300/40 bg-amber-400/15 text-amber-200' : 'border-cyan-300/30 bg-cyan-400/10 text-cyan-200'}`}>第 {item.conversation_delete_number} 次刪除</span>}<span className="min-w-0 truncate">{item.action === 'conversation_delete' ? `對話 ${item.message_count} 則` : readableText(item.summary) || '（無摘要）'}</span>{item.cleared_count > 0 ? <span className="shrink-0 text-slate-400">· 已清除</span> : item.clear_started_at ? <span className="shrink-0 text-amber-300">· 清除未完成</span> : null}</span>
                      <time className="hidden whitespace-nowrap text-[11px] tabular-nums text-slate-400 min-[1440px]:block" dateTime={item.occurred_at}>{formatAuditTime(item.occurred_at, false)}</time>
                      <span className="col-span-2 col-start-2 row-start-4 flex min-w-0 gap-1.5 text-[11px] min-[1440px]:hidden"><span className="min-w-0 truncate text-slate-400" title={item.owner_username || item.owner_admin_id}>所屬 {item.owner_username || item.owner_admin_id}</span><span className="text-slate-600">/</span><span className="min-w-0 truncate text-sky-200" title={item.actor_username}>操作者 {item.actor_username}</span></span>
                      <time className="col-span-2 col-start-2 row-start-5 text-[11px] tabular-nums text-slate-400 min-[1440px]:hidden" dateTime={item.occurred_at}>{formatAuditTime(item.occurred_at)}</time>
                    </button>
                  </li>
                ))}
              </ol>
              <div ref={loadMoreRef} className="shrink-0 py-2 text-center text-xs text-slate-400" role="status">{loading ? '載入中…' : listLoadError ? <button type="button" onClick={() => setListRetryKey(key => key + 1)} className={`text-cyan-200 underline ${buttonFocus}`}>載入失敗，點此重試</button> : events.length < total ? '往下捲動載入更多' : null}</div>
            </section>

            {selectedId && createPortal(<div className="fixed inset-0 z-[9000] flex items-center justify-center bg-[radial-gradient(circle_at_50%_20%,rgba(30,64,175,0.22),rgba(2,6,23,0.88)_60%)] p-0 backdrop-blur-md sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget && !deletePreview) closeEvent(); }}>
              <section ref={detailRef} role="dialog" aria-modal="true" aria-labelledby="audit-detail-title" className="audit-detail-modal flex h-full min-h-0 w-full max-w-[1240px] flex-col overflow-hidden border border-white/15 bg-slate-950 shadow-[0_32px_110px_rgba(2,6,23,0.75)] sm:h-[94vh] sm:rounded-[24px]">
              <div className="h-0.5 shrink-0 bg-gradient-to-r from-cyan-400 via-blue-500 to-violet-500" />
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[radial-gradient(circle_at_85%_-50%,rgba(34,211,238,0.18),transparent_45%),linear-gradient(100deg,#0b172a,#101c34)] px-4 py-3 sm:px-6 sm:py-4"><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300/80">Evidence archive / 內容稽核</p><h2 id="audit-detail-title" className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-black text-white sm:text-lg">內容查看{selectedCard && <span className="rounded-md border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-100">{auditActionLabel(selectedCard.entity_type, selectedCard.action)}</span>}</h2></div><button type="button" autoFocus onClick={closeEvent} aria-label="關閉稽核詳情" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-200 transition hover:border-cyan-300/30 hover:bg-cyan-300/10 hover:text-white ${buttonFocus}`}><X className="h-4 w-4" /></button></div>
              <div className="min-h-0 flex-1 overflow-hidden">
              {!selectedId ? <p className="px-4 py-12 text-center text-sm text-slate-400">點選左側卡片查看內容。</p> : detailLoading || (conversationLoading && !conversation) ? <p role="status" className="px-4 py-12 text-center text-sm text-slate-400">載入詳情中…</p> : conversation ? (
                <div className="audit-detail-scroll grid h-full min-h-0 min-w-0 overflow-y-auto lg:grid-cols-[310px_minmax(0,1fr)] lg:overflow-hidden">
                  <aside className="audit-detail-scroll min-w-0 space-y-5 border-b border-white/10 bg-[radial-gradient(circle_at_0%_0%,rgba(56,189,248,0.11),transparent_44%),linear-gradient(180deg,#101d31,#0a1222)] p-4 sm:p-5 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:border-r-white/10">
                    <div className="flex items-start gap-3"><span className={`rounded-xl border p-2 ${conversation.entity_type === 'aaa_service' ? 'border-orange-400/30 bg-orange-400/10 text-orange-200' : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'}`}><MessageCircle className="h-5 w-5" /></span><div><h3 className="text-base font-black text-white">{typeLabels[conversation.entity_type]} · 對話紀錄</h3><p className="mt-1 text-xs text-slate-400">共 {conversation.total} 則訊息 · 私人稽核檔案</p></div></div>
                    <div className="flex flex-wrap items-center gap-2"><span className={`inline-flex rounded-md border px-2 py-1 text-[11px] font-bold ${actionStyles[selectedCard?.action || 'conversation_delete']}`}>{auditActionLabel(conversation.entity_type, selectedCard?.action || 'conversation_delete')}</span>{selectedCard?.conversation_delete_number && <span className={`rounded-md border px-2 py-1 text-[11px] font-bold tabular-nums ${selectedCard.conversation_delete_number > 1 ? 'border-amber-300/40 bg-amber-400/15 text-amber-200' : 'border-cyan-300/30 bg-cyan-400/10 text-cyan-200'}`}>第 {selectedCard.conversation_delete_number} 次刪除</span>}</div>
                    <dl className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                      <MetadataRow label="異動時間 (UTC+8)" value={formatAuditTime(conversation.occurred_at)} />
                      <MetadataRow label="實際操作者" value={selectedCard?.actor_username || null} />
                      <MetadataRow label="所屬管理員" value={selectedCard?.owner_username || selectedCard?.owner_admin_id || null} />
                      <MetadataRow label="角色名稱" value={chatIdentity?.customerName || '名稱未留存'} />
                      <MetadataRow label="員工帳號" value={conversation.employee_account} />
                      <MetadataRow label={chatIdentity?.employeeNumberSource === 'current' ? '員工 ID（目前帳戶）' : '員工 ID'} value={chatIdentity?.employeeNumber || '無法查得'} />
                    </dl>
                    <button type="button" onClick={() => selectedCard && void prepareDeletion(selectedCard.id)} disabled={deleting || !selectedCard} className={`inline-flex w-full items-center justify-center gap-2 rounded-xl border border-rose-400/40 bg-rose-500/15 px-3 py-2.5 text-xs font-bold text-rose-200 transition hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-40 ${buttonFocus}`}><Trash2 className="h-4 w-4" aria-hidden="true" />{deleting ? '準備刪除範圍…' : '刪除整段對話紀錄'}</button>
                    {error?.startsWith('無法準備刪除：') && <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-950/50 px-3 py-2 text-xs text-rose-100">{error}</p>}
                  </aside>
                  <section className="flex min-h-[520px] min-w-0 flex-col lg:min-h-0">
                    <div className={`flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3 ${conversation.entity_type === 'aaa_service' ? 'bg-gradient-to-r from-slate-950 to-orange-950/70' : 'bg-gradient-to-r from-slate-950 to-emerald-950/70'}`}><MessageCircle className="h-5 w-5 text-white" /><h3 className="text-sm font-bold text-white">原聊天內容 · {conversation.total} 則</h3></div>
                    {conversationError && <div role="alert" className="shrink-0 border-b border-rose-400/30 bg-rose-950/80 px-4 py-3 text-xs text-rose-100">此頁載入失敗，仍顯示第 {loadedConversationPage + 1} 頁：{conversationError} <button type="button" onClick={() => setConversationRetryKey(key => key + 1)} className={`ml-2 font-bold text-cyan-200 underline ${buttonFocus}`}>重試載入</button></div>}
                    <div className="relative min-h-0 flex-1">
                      <div ref={conversationContentRef} aria-busy={conversationLoading} className={`audit-detail-scroll h-full space-y-3 overflow-y-auto p-4 transition-opacity motion-reduce:transition-none sm:p-6 ${conversationLoading ? 'pointer-events-none opacity-40' : ''} ${conversation.entity_type === 'aaa_service' ? 'bg-[linear-gradient(180deg,#24170f_0%,#1b1513_40%,#24170f_100%)]' : 'bg-[linear-gradient(180deg,#0b2118_0%,#101c19_40%,#0b2118_100%)]'}`}>
                        {conversation.items.map(message => (
                          <ConversationTranscript key={message.id} message={message} senderName={message.sender_type === 'employee' ? conversation.employee_account : chatIdentity?.customerName || '客戶'} workspace={conversation.entity_type} />
                        ))}
                      </div>
                      {conversationLoading && <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 bg-slate-950/45 text-sm text-slate-200"><RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />載入第 {conversationPage + 1} 頁聊天內容…</div>}
                    </div>
                    {conversation.total > TRANSCRIPT_PAGE_SIZE && <div className="flex shrink-0 items-center justify-between border-t border-white/10 bg-slate-900 px-4 py-2 text-xs text-slate-300">
                      <span>第 {loadedConversationPage + 1} / {Math.ceil(conversation.total / TRANSCRIPT_PAGE_SIZE)} 頁</span>
                      <span className="flex gap-2"><button type="button" disabled={conversationLoading || loadedConversationPage === 0} onClick={() => { setConversationLoading(true); setConversationPage(loadedConversationPage - 1); setConversationRetryKey(key => key + 1); }} className={`rounded-lg border border-slate-600 px-2 py-1.5 disabled:opacity-40 ${buttonFocus}`}>上一頁</button><button type="button" disabled={conversationLoading || (loadedConversationPage + 1) * TRANSCRIPT_PAGE_SIZE >= conversation.total} onClick={() => { setConversationLoading(true); setConversationPage(loadedConversationPage + 1); setConversationRetryKey(key => key + 1); }} className={`rounded-lg border border-slate-600 px-2 py-1.5 disabled:opacity-40 ${buttonFocus}`}>下一頁</button></span>
                    </div>}
                  </section>
                </div>
              ) : conversationError ? <div role="alert" className="px-4 py-12 text-center text-sm text-rose-200">載入對話失敗：{conversationError} <button type="button" disabled={conversationLoading} onClick={() => setConversationRetryKey(key => key + 1)} className={`ml-2 text-cyan-200 underline disabled:opacity-40 ${buttonFocus}`}>{conversationLoading ? '載入中…' : '重試載入'}</button></div> : !detail ? <p className="px-4 py-12 text-center text-sm text-slate-400">無法顯示此事件。請重新選取或刷新。</p> : detail.entity_type === 'notification' ? (
                <div className="audit-detail-scroll grid h-full min-h-0 min-w-0 overflow-y-auto lg:grid-cols-[310px_minmax(0,1fr)] lg:overflow-hidden">
                  <aside className="audit-detail-scroll min-w-0 space-y-5 border-b border-white/10 bg-[radial-gradient(circle_at_0%_0%,rgba(56,189,248,0.11),transparent_44%),linear-gradient(180deg,#101d31,#0a1222)] p-4 sm:p-5 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:border-r-white/10">
                    <div className="flex items-start gap-3"><span className="rounded-xl border border-violet-400/25 bg-violet-400/10 p-2 text-violet-200"><Megaphone className="h-5 w-5" /></span><div className="min-w-0"><h3 className="text-base font-black text-white">通知異動詳情</h3><p className="mt-1 text-xs text-slate-400">通知原文 · 私人稽核檔案</p></div></div>
                    <div className="flex flex-wrap items-center gap-2"><span className="rounded-md border border-violet-400/30 bg-violet-400/10 px-2 py-1 text-[11px] font-bold text-violet-200">{notificationOriginLabel(snapshotNotificationOrigin(detail.before_data))}</span><span className={`rounded-md border px-2 py-1 text-[11px] font-bold ${actionStyles[detail.action]}`}>{auditActionLabel(detail.entity_type, detail.action)}</span></div>
                    <dl className="grid grid-cols-2 gap-2 lg:grid-cols-1"><MetadataRow label="通知發送時間 (UTC+8)" value={formatAuditTime(snapshotNotificationSentAt(detail.before_data))} /><MetadataRow label="異動時間 (UTC+8)" value={formatAuditTime(detail.occurred_at)} /><MetadataRow label="實際操作者" value={detail.actor_username} /><MetadataRow label="所屬管理員" value={detail.owner_username ?? detail.owner_admin_id} />{detail.clear_started_at && !detail.cleared_at && <MetadataRow label="證據清除狀態" value="清除尚未完成" />}</dl>
                    {snapshotNotificationOrigin(detail.before_data) === 'unverified' && <p className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-200">此舊通知沒有可驗證的發送來源紀錄，不能確認是否由管理員手動發出；封存的是清理前仍可查到的內容。</p>}
                    {!detail.cleared_at && <section className="rounded-xl border border-slate-700 bg-slate-950/50 text-xs"><h4 className="border-b border-slate-700 px-3 py-2 font-bold text-cyan-200">收件員工 · {detail.recipient_identities?.length ?? 0} 位</h4>{detail.recipient_identities?.length ? <><p className="px-3 pt-2 text-[11px] text-slate-400">已讀 {detail.recipient_identities.filter(recipient => recipient.is_read).length} 位</p><ol className="audit-detail-scroll max-h-48 divide-y divide-slate-700 overflow-y-auto px-3">{detail.recipient_identities.map((recipient, index) => <li key={index} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2"><span className="min-w-0 break-all font-semibold text-white">{recipient.account || '帳號未留存'}</span><span className="text-cyan-200" title={recipient.from_current_account ? '目前帳戶，非事件時快照' : undefined}>ID {recipient.employee_number || '—'}</span><span className="ml-auto text-slate-400">{recipient.is_read ? '已讀' : '未讀'}</span></li>)}</ol></> : <p className="px-3 py-3 text-slate-400">未留存收件員工資料。</p>}</section>}
                    <section><h4 className="mb-2 text-xs font-bold text-white">同一通知的版本歷程</h4><div className="space-y-1.5">{(detail.timeline ?? []).filter(version => version.action !== 'employee_delete' && version.action !== 'admin_delete').map(version => <button key={version.id} type="button" onClick={() => selectEvent(version.id)} aria-pressed={version.id === detail.id} className={`flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left text-xs ${version.id === detail.id ? 'border-cyan-400/50 bg-cyan-500/15 text-white' : 'border-slate-700 bg-slate-950/50 text-slate-300 hover:bg-slate-800'} ${buttonFocus}`}><span>{auditActionLabel(detail.entity_type, version.action)}{version.cleared_at ? ' · 已清除' : ''}</span><time dateTime={version.occurred_at} className="tabular-nums text-slate-400">{formatAuditTime(version.occurred_at)}</time></button>)}</div></section>

                    {detail.cleared_at ? <p className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">此筆通知證據已正式清除。</p> : <button type="button" onClick={() => void prepareDeletion(detail.id)} disabled={deleting} className={`inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-rose-400/40 bg-rose-500/15 px-3 py-2.5 text-xs font-bold text-rose-200 transition hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-40 ${buttonFocus}`}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />清除此筆證據</button>}
                  </aside>
                  <div className="audit-detail-scroll-light flex h-full min-h-0 min-w-0 flex-col overflow-y-auto bg-[#f0f5ff]">
                    {detail.cleared_at ? <div className="m-5 rounded-xl bg-white px-6 py-12 text-center text-sm text-slate-500">此通知內容已正式清除。</div> : <Snapshot title={detail.action === 'edit' ? '修改前通知' : '從原頁移除前的通知'} data={detail.before_data} cleared={false} type={detail.entity_type} eventId={detail.id} mediaRefs={detail.media_refs} employeeAccount={detail.employee_account} />}{!detail.cleared_at && detail.after_data != null && <Snapshot title="修改後通知" data={detail.after_data} cleared={false} type={detail.entity_type} eventId={detail.id} mediaRefs={detail.media_refs} employeeAccount={detail.employee_account} />}
                  </div>
                </div>
              ) : (
                <div className="audit-detail-scroll grid h-full min-h-0 min-w-0 overflow-y-auto lg:grid-cols-[310px_minmax(0,1fr)] lg:overflow-hidden">
                  <aside className="audit-detail-scroll min-w-0 space-y-5 border-b border-white/10 bg-[radial-gradient(circle_at_0%_0%,rgba(56,189,248,0.11),transparent_44%),linear-gradient(180deg,#101d31,#0a1222)] p-4 sm:p-5 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:border-r-white/10">
                    <div className="flex items-start gap-3"><span className={`rounded-xl border p-2 ${detail.entity_type === 'aaa_service' ? 'border-orange-400/30 bg-orange-400/10 text-orange-200' : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'}`}><MessageCircle className="h-5 w-5" /></span><div><h3 className="text-base font-black text-white">{typeLabels[detail.entity_type]} · 異動詳情</h3><p className="mt-1 text-xs text-slate-400">聊天訊息 · 私人稽核檔案</p></div></div>
                    <span className={`inline-flex rounded-md border px-2 py-1 text-[11px] font-bold ${actionStyles[detail.action]}`}>{auditActionLabel(detail.entity_type, detail.action)}</span>
                    <dl className="grid grid-cols-2 gap-2 lg:grid-cols-1"><MetadataRow label="異動時間 (UTC+8)" value={formatAuditTime(detail.occurred_at)} /><MetadataRow label="實際操作者" value={detail.actor_username} /><MetadataRow label="所屬管理員" value={detail.owner_username ?? detail.owner_admin_id} /><MetadataRow label="角色名稱" value={detail.cleared_at ? '已清除' : chatIdentity?.customerName || '名稱未留存'} /><MetadataRow label="員工帳號" value={detail.cleared_at ? '已清除' : detail.employee_account} /><MetadataRow label={chatIdentity?.employeeNumberSource === 'current' ? '員工 ID（目前帳戶）' : '員工 ID'} value={detail.cleared_at ? '已清除' : chatIdentity?.employeeNumber || '無法查得'} />{detail.clear_started_at && !detail.cleared_at && <MetadataRow label="證據清除狀態" value="清除尚未完成" />}</dl>
                    <section><h4 className="mb-2 text-xs font-bold text-white">同一對象的版本歷程</h4><div className="space-y-1.5">{(detail.timeline ?? []).filter(version => version.action !== 'employee_delete' && version.action !== 'admin_delete').map(version => <button key={version.id} type="button" onClick={() => selectEvent(version.id)} aria-pressed={version.id === detail.id} className={`flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left text-xs ${version.id === detail.id ? 'border-cyan-400/50 bg-cyan-500/15 text-white' : 'border-slate-700 bg-slate-950/50 text-slate-300 hover:bg-slate-800'} ${buttonFocus}`}><span>{auditActionLabel(detail.entity_type, version.action)}{version.cleared_at ? ' · 已清除' : ''}</span><time dateTime={version.occurred_at} className="tabular-nums text-slate-400">{formatAuditTime(version.occurred_at)}</time></button>)}</div></section>

                    {(detail.action === 'edit' || detail.action === 'source_edit') && !detail.cleared_at && <p className="rounded-lg border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-xs leading-5 text-sky-100">此處顯示修改前與修改後的封存版本；清除這筆稽核證據不會刪除或還原管理員與員工頁面正在顯示的聊天訊息。</p>}
                    {detail.cleared_at ? <p className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">此筆聊天證據已正式清除。</p> : detail.action === 'employee_delete' || detail.action === 'admin_delete' ? <p className="rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">這筆紀錄屬於員工整體刪除，請在「刪除員工」檔案管理相關內容。</p> : <button type="button" onClick={() => void prepareDeletion(detail.id)} disabled={deleting} className={`inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-rose-400/40 bg-rose-500/15 px-3 py-2.5 text-xs font-bold text-rose-200 transition hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-40 ${buttonFocus}`}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />清除此筆證據</button>}
                  </aside>
                  <div className={`audit-detail-scroll min-h-[480px] min-w-0 overflow-y-auto lg:min-h-0 ${detail.entity_type === 'aaa_service' ? 'bg-[linear-gradient(180deg,#24170f_0%,#1b1513_40%,#24170f_100%)]' : 'bg-[linear-gradient(180deg,#0b2118_0%,#101c19_40%,#0b2118_100%)]'}`}>
                    <div className={`flex items-center gap-2 border-b border-white/10 px-4 py-3 text-xs font-bold text-white ${detail.entity_type === 'aaa_service' ? 'bg-gradient-to-r from-slate-950 to-orange-950/70' : 'bg-gradient-to-r from-slate-950 to-emerald-950/70'}`}><MessageCircle className="h-4 w-4" />原聊天內容 · {detail.cleared_at ? '已清除' : detail.after_data != null ? '版本對照' : '刪除前'}</div>
                    <div className={`grid min-w-0 gap-3 p-3 ${!detail.cleared_at && detail.after_data != null ? 'xl:grid-cols-2' : ''}`}>
                      <div className="min-w-0 rounded-xl border border-white/10 bg-slate-950/30"><Snapshot title={detail.action === 'edit' || detail.action === 'source_edit' ? '修改前' : '從原頁移除前'} data={detail.before_data} cleared={Boolean(detail.cleared_at)} type={detail.entity_type} eventId={detail.id} mediaRefs={detail.media_refs} employeeAccount={detail.employee_account} /></div>
                      {!detail.cleared_at && detail.after_data != null && <div className="min-w-0 rounded-xl border border-cyan-300/20 bg-cyan-500/[0.04]"><Snapshot title="修改後" data={detail.after_data} cleared={false} type={detail.entity_type} eventId={detail.id} mediaRefs={detail.media_refs} employeeAccount={detail.employee_account} /></div>}
                    </div>
                  </div>
                </div>
              )}
              </div>
            </section></div>, document.body)}
          </div>
        </main>
      </div></>}

      {deleteFeedback && createPortal(
        <div role={deleteFeedback.type === 'error' ? 'alert' : 'status'} className={`fixed right-4 top-4 z-[10010] flex max-w-[calc(100vw-2rem)] items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl sm:max-w-md ${deleteFeedback.type === 'success' ? 'border-emerald-400/60 bg-emerald-950 text-emerald-50' : 'border-rose-400/60 bg-rose-950 text-rose-50'}`}>
          {deleteFeedback.type === 'success' ? <CheckCircle className="mt-0.5 h-5 w-5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />}
          <span className="min-w-0 flex-1 break-words">{deleteFeedback.message}</span>
          <button type="button" onClick={() => setDeleteFeedback(null)} aria-label="關閉刪除結果提示" className="rounded p-0.5 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>, document.body,
      )}

      {deletePreview && deletePreview.context === deletionContext && createPortal(<div role="presentation" className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/90 p-3 backdrop-blur-md sm:p-5"><section role="dialog" aria-modal="true" aria-labelledby="audit-delete-title" className="w-full max-w-lg overflow-hidden rounded-2xl border border-rose-300/30 bg-slate-900 shadow-[0_28px_90px_rgba(2,6,23,0.8)]"><div className="h-1 bg-gradient-to-r from-rose-500 via-orange-400 to-rose-500" /><div className="p-5 sm:p-6"><div className="flex items-center gap-3 text-rose-200"><span className="rounded-xl bg-rose-400/10 p-2.5"><AlertTriangle className="h-5 w-5" /></span><div><p className="text-[10px] font-bold uppercase tracking-widest text-rose-300/70">永久刪除確認</p><p className="mt-1 text-xs text-slate-300">清除完成後不保留封存內容或清理憑證，無法還原。</p><h2 id="audit-delete-title" className="mt-1 text-lg font-black text-white">{deletePreview.finished_at ? '完成上次刪除的附件清理？' : deletePreview.scope === 'bulk' ? '刪除目前篩選的全部紀錄？' : deletePreview.scope === 'conversation' ? '刪除整段對話紀錄？' : '刪除此筆異動紀錄？'}</h2></div></div><div className="mt-5 rounded-xl border border-rose-400/25 bg-rose-500/10 p-4"><p className="text-2xl font-black tabular-nums text-white">{deletePreview.card_count.toLocaleString()} <span className="text-sm font-semibold text-rose-200">列 · {deletePreview.event_count.toLocaleString()} 筆證據</span></p><p className="mt-2 text-xs leading-5 text-slate-300">{deletePreview.finished_at ? '紀錄已刪除，但私有附件尚未確認清理完成。請完成清理，無法還原原紀錄。' : deletePreview.scope === 'bulk' ? '包含符合篩選但尚未載入的頁面；整段對話列會刪除該段所有封存訊息。' : deletePreview.scope === 'conversation' ? '將刪除這段對話的全部封存訊息，包括其他尚未載入的訊息頁面；不影響其他對話。' : '只刪除目前選取的這一筆事件；不會自動刪除其他紀錄。'}</p></div><p className="mt-4 text-xs leading-6 text-rose-100">將永久移除這些稽核事件、原文與私有附件，不另保留清除記錄，無法還原。資料庫備份、外部複本及「已刪員工」獨立檔案不在本次刪除範圍。</p><p className="mt-2 text-xs leading-5 text-cyan-100">這裡只清除私人稽核留證；修改後仍在使用的通知與聊天內容不會被刪除或還原。</p>{error && <p role="alert" className="mt-3 rounded-lg border border-rose-400/30 bg-rose-950/50 px-3 py-2 text-xs text-rose-100">{error}</p>}<div className="mt-6 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => { setError(null); invalidateDeletionPreview(); }} disabled={deleting} className={`rounded-xl border border-slate-600 px-4 py-2.5 text-xs font-bold text-slate-200 hover:bg-slate-800 disabled:opacity-50 ${buttonFocus}`}>取消</button><button type="button" onClick={() => void confirmDeletion()} disabled={deleting} className={`inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-black text-white hover:bg-rose-500 disabled:opacity-50 ${buttonFocus}`}><Trash2 className="h-4 w-4" />{deleting ? '處理中…' : deletePreview.finished_at ? '完成附件清理' : '確認永久刪除'}</button></div></div></section></div>, document.body)}
    </div>
  );
}
