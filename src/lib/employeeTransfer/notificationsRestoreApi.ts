import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { NOTIFICATIONS_TABLE_KEYS, validateNotificationsCatalog, type NotificationsCatalog, type NotificationsCounts } from './notificationsTransfer';

const { object, count, withSignal } = dispatchTransferChecks;
const keys = NOTIFICATIONS_TABLE_KEYS;
const initialKeys = ['notification_automation_plans', 'notification_automation_tasks', 'message_templates',
  'notification_automation_plan_members', 'notification_automation_task_recipients'] as const;
const stages = ['notification_automation_executions', 'messages', 'execution_links', 'message_recipients',
  'broadcast_messages', 'broadcast_recipients', 'notification_automation_progress', 'notification_automation_date_runs',
  'notification_automation_failures'] as const;
type Operation = 'begin' | 'chunk' | 'verify' | 'status';
type RpcName = 'employee_import_notifications_begin' | 'employee_import_notifications_chunk'
  | 'employee_import_notifications_verify' | 'get_employee_import_notifications_restore_status';
type RpcArgs = { p_admin_session_token: string; p_job_token: string; p_plan_hash?: string; p_chunk_no?: number };
const rpc = (name: RpcName, args: RpcArgs) => {
  if (name === 'employee_import_notifications_begin') return supabase.rpc(name, { ...args, p_plan_hash: args.p_plan_hash! });
  if (name === 'employee_import_notifications_chunk') return supabase.rpc(name, { ...args, p_chunk_no: args.p_chunk_no! });
  return supabase.rpc(name, args);
};
const failure = 'Notification restore outcome is unknown or unconfirmed; committed records or media may exist. Read server status and reconcile before explicitly retrying. Cancellation does not prove rollback. No automatic write retry, sending, bonus credit, activation, maintenance release or close was performed.';
function invalid(): never { throw new Error(failure); }
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException(failure, 'AbortError');
}
function uuid(value: unknown): string {
  const result = dispatchTransferChecks.uuid(value);
  if (result.length !== 36) invalid();
  return result;
}
function hash(value: unknown): string {
  const result = dispatchTransferChecks.hash(value);
  if (result.length !== 64) invalid();
  return result;
}
function totalsFromCatalog(input: NotificationsCatalog): { totals: NotificationsCounts; siteId: string; packageId: string } {
  // Validate and snapshot the entire same-package identity/finance dependency chain, not just table totals.
  const catalog = validateNotificationsCatalog(input);
  const totals = Object.fromEntries(catalog.tables.map(table => [table.key, table.rows])) as NotificationsCounts;
  return { totals, siteId: catalog.site_id, packageId: catalog.package_id };
}
export interface NotificationsRestoreReceipt {
  readonly success: true;
  readonly scope: 'site-notifications';
  readonly operation: Operation;
  readonly plan_hash: string;
  readonly source_site_id: string;
  readonly package_id: string;
  readonly stage: 'restoring' | 'ready_to_verify' | 'done';
  readonly counts: Readonly<NotificationsCounts>;
  readonly totals: Readonly<NotificationsCounts>;
  readonly next_chunk: number;
  readonly total_chunks: number;
  readonly linked_executions: number;
  /** Decimal string; never a JavaScript bigint/numeric data payload. */
  readonly generation: string;
  readonly verified: boolean;
  readonly repeated: boolean;
  readonly chunk_no: number | null;
  readonly rows: number;
  readonly automation_pending: true;
  readonly maintenance: true;
  readonly replacement_ready: false;
  readonly full_site_complete: false;
}
export interface NotificationsRestoreSession {
  begin(planHash: string, signal?: AbortSignal): Promise<NotificationsRestoreReceipt>;
  chunk(chunkNo: number, signal?: AbortSignal): Promise<NotificationsRestoreReceipt>;
  verify(signal?: AbortSignal): Promise<NotificationsRestoreReceipt>;
  /** STABLE server reconciliation, including a new client after a lost response. */
  status(signal?: AbortSignal): Promise<NotificationsRestoreReceipt>;
}
export function createNotificationsRestoreSession(jobToken: string, catalog: NotificationsCatalog): NotificationsRestoreSession {
  const setup = (() => {
    try { return { token: uuid(jobToken), ...totalsFromCatalog(catalog) }; } catch { invalid(); }
  })();
  const totals = Object.freeze(setup.totals);
  const work = stages.flatMap(key => {
    const rows = totals[key === 'execution_links' ? 'notification_automation_executions' : key];
    return Array.from({ length: Math.max(1, Math.ceil(rows / 200)) }, (_, n) => ({ key, rows: Math.min(200, rows - n * 200) }));
  });
  let busy = false, reconciled = false, requiresStatus = false;
  let confirmed: NotificationsRestoreReceipt | null = null;
  function validate(value: unknown, operation: Operation, planHash?: string, chunkNo?: number): NotificationsRestoreReceipt {
    const result = object(value, ['success', 'scope', 'operation', 'plan_hash', 'source_site_id', 'package_id', 'stage', 'counts', 'totals', 'next_chunk',
      'total_chunks', 'linked_executions', 'generation', 'verified', 'repeated', 'chunk_no', 'rows', 'automation_pending',
      'maintenance', 'replacement_ready', 'full_site_complete']);
    const digest = hash(result.plan_hash), next = count(result.next_chunk, work.length);
    if (result.success !== true || result.scope !== 'site-notifications' || result.operation !== operation
      || result.source_site_id !== setup.siteId || result.package_id !== setup.packageId
      || result.automation_pending !== true || result.maintenance !== true || result.replacement_ready !== false
      || result.full_site_complete !== false || result.total_chunks !== work.length || typeof result.verified !== 'boolean'
      || typeof result.repeated !== 'boolean' || result.generation !== String(next)
      || (planHash !== undefined && digest !== planHash) || (confirmed && (digest !== confirmed.plan_hash || next < confirmed.next_chunk
        || (confirmed.verified && !result.verified)))) invalid();
    const expected = Object.fromEntries(keys.map(key => [key, initialKeys.some(k => k === key) ? totals[key] : 0])) as NotificationsCounts;
    let linked = 0;
    for (const item of work.slice(0, next)) {
      if (item.key === 'execution_links') linked += item.rows;
      else expected[item.key] += item.rows;
    }
    const counts = object(result.counts, keys), actualTotals = object(result.totals, keys);
    for (const key of keys) if (counts[key] !== expected[key] || actualTotals[key] !== totals[key]) invalid();
    const stage = result.verified ? 'done' : next === work.length ? 'ready_to_verify' : 'restoring';
    if (result.stage !== stage || result.linked_executions !== linked || (result.verified && next !== work.length)) invalid();
    if (operation === 'chunk') {
      if (chunkNo === undefined || result.chunk_no !== chunkNo || result.rows !== work[chunkNo]?.rows
        || next <= chunkNo || (!result.repeated && next !== chunkNo + 1)
        || (confirmed && chunkNo < confirmed.next_chunk && !result.repeated)) invalid();
    } else if (result.chunk_no !== null || result.rows !== 0) invalid();
    if (operation === 'begin' && !result.repeated && (confirmed !== null || next !== 0 || result.verified)) invalid();
    if (operation === 'status' && !result.repeated) invalid();
    if (operation === 'verify' && (!result.verified || next !== work.length || linked !== totals.notification_automation_executions
      || (confirmed?.verified && !result.repeated))) invalid();
    return Object.freeze({ success: true, scope: 'site-notifications', operation, plan_hash: digest,
      source_site_id: setup.siteId, package_id: setup.packageId, stage,
      counts: Object.freeze({ ...expected }), totals: Object.freeze({ ...totals }), next_chunk: next, total_chunks: work.length,
      linked_executions: linked, generation: String(next), verified: result.verified, repeated: result.repeated,
      chunk_no: operation === 'chunk' ? chunkNo! : null, rows: operation === 'chunk' ? work[chunkNo!].rows : 0,
      automation_pending: true, maintenance: true, replacement_ready: false, full_site_complete: false });
  }
  async function request(operation: Operation, signal?: AbortSignal, planHash?: string, chunkNo?: number): Promise<NotificationsRestoreReceipt> {
    if (busy) throw new Error('A notification restore request is already in progress.');
    busy = true;
    let dispatched = false;
    try {
      aborted(signal);
      if (operation !== 'status' && requiresStatus) invalid();
      if (operation === 'begin') hash(planHash);
      if (operation === 'chunk') {
        count(chunkNo, work.length - 1);
        if (!reconciled || !confirmed || chunkNo! > confirmed.next_chunk) invalid();
      }
      if (operation === 'verify' && (!reconciled || !confirmed || confirmed.next_chunk !== work.length)) invalid();
      // Obtain the current authenticated session per request, supporting owner re-login.
      const args: RpcArgs = { p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: setup.token };
      if (operation === 'begin') args.p_plan_hash = planHash;
      if (operation === 'chunk') args.p_chunk_no = chunkNo;
      const name: RpcName = operation === 'status' ? 'get_employee_import_notifications_restore_status' : `employee_import_notifications_${operation}`;
      const { data, error } = await withSignal(() => {
        dispatched = true;
        const query = rpc(name, args);
        return signal ? query.abortSignal(signal) : query;
      }, signal);
      aborted(signal);
      if (error) invalid();
      const receipt = validate(data, operation, planHash, chunkNo);
      aborted(signal);
      confirmed = receipt;
      reconciled = true;
      requiresStatus = false;
      return receipt;
    } catch {
      // Even inspecting an untrusted signal can throw. Never expose its getter, reason or backend error.
      let cancelled = false;
      try { cancelled = signal?.aborted === true; } catch { /* Keep the failure redacted. */ }
      reconciled = false;
      requiresStatus = requiresStatus || dispatched || cancelled || confirmed !== null;
      if (cancelled) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { busy = false; }
  }
  // Every write is explicit. No loops drive writes and no automatic retry/verify/close.
  return {
    begin: (planHash, signal) => request('begin', signal, planHash),
    chunk: (chunkNo, signal) => request('chunk', signal, undefined, chunkNo),
    verify: signal => request('verify', signal),
    status: signal => request('status', signal),
  };
}
