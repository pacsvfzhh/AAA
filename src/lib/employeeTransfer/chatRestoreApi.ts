import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { CHAT_TABLE_KEYS, validateChatCatalog, type ChatCatalog, type ChatCounts } from './chatTransfer';

const { object, count, withSignal } = dispatchTransferChecks;
// SQL32's dependency order differs from the export catalog: sessions precede messages.
const workKeys = ['simulated_customers', 'cs_message_templates', 'customer_auto_messages', 'rich_card_contents',
  'customer_service_sessions', 'customer_employee_conversations', 'ccc_conversation_annotations',
  'customer_auto_message_logs', 'rating_requests', 'service_ratings'] as const;
type Operation = 'begin' | 'chunk' | 'verify' | 'status';
type RpcName = 'employee_import_chat_begin' | 'employee_import_chat_chunk'
  | 'employee_import_chat_verify' | 'get_employee_import_chat_restore_status';
type RpcArgs = { p_admin_session_token: string; p_job_token: string; p_plan_hash?: string; p_chunk_no?: number };
const rpc = (name: RpcName, args: RpcArgs) => {
  if (name === 'employee_import_chat_begin') return supabase.rpc(name, { ...args, p_plan_hash: args.p_plan_hash! });
  if (name === 'employee_import_chat_chunk') return supabase.rpc(name, { ...args, p_chunk_no: args.p_chunk_no! });
  return supabase.rpc(name, args);
};
const failure = 'Chat restore outcome is unknown or unconfirmed; committed records or media may exist. Read server status and reconcile before explicitly retrying. Cancellation does not prove rollback. No automatic write retry, ID mapping, activation, maintenance release or close was performed. Done means only the chat substage, not a completed full-site restore.';
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
// Only traverse the validated, detached plain-data catalog, never caller-owned getters.
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export interface ChatRestoreReceipt {
  readonly success: true;
  readonly scope: 'site-chat';
  readonly operation: Operation;
  readonly plan_hash: string;
  readonly source_site_id: string;
  readonly package_id: string;
  readonly stage: 'restoring' | 'ready_to_verify' | 'done';
  readonly counts: Readonly<ChatCounts>;
  readonly totals: Readonly<ChatCounts>;
  readonly next_chunk: number;
  readonly total_chunks: number;
  /** Decimal string, exactly String(next_chunk); never parse a JSON number as generation. */
  readonly generation: string;
  readonly verified: boolean;
  readonly repeated: boolean;
  readonly chunk_no: number | null;
  readonly rows: number;
  readonly media_pending: boolean;
  readonly maintenance: true;
  readonly replacement_ready: false;
  readonly full_site_complete: false;
}
export interface ChatRestoreSession {
  begin(planHash: string, signal?: AbortSignal): Promise<ChatRestoreReceipt>;
  chunk(chunkNo: number, signal?: AbortSignal): Promise<ChatRestoreReceipt>;
  verify(signal?: AbortSignal): Promise<ChatRestoreReceipt>;
  /** Explicit read-only reconciliation, including a new client after a lost response. */
  status(signal?: AbortSignal): Promise<ChatRestoreReceipt>;
}
export function createChatRestoreSession(jobToken: string, input: ChatCatalog): ChatRestoreSession {
  const setup = (() => {
    try { return { token: uuid(jobToken), catalog: freeze(validateChatCatalog(input)) }; }
    catch { invalid(); }
  })();
  const totals = Object.freeze(Object.fromEntries(setup.catalog.tables.map(table => [table.key, table.rows])) as ChatCounts);
  const work = workKeys.flatMap(key => Array.from({ length: Math.max(1, Math.ceil(totals[key] / 200)) },
    (_, n) => ({ key, rows: Math.min(200, totals[key] - n * 200) })));
  let busy = false, reconciled = false, requiresStatus = false;
  let confirmed: ChatRestoreReceipt | null = null, boundPlanHash: string | null = null;
  function validate(value: unknown, operation: Operation, planHash?: string, chunkNo?: number): ChatRestoreReceipt {
    const result = object(value, ['success', 'scope', 'operation', 'plan_hash', 'source_site_id', 'package_id', 'stage',
      'counts', 'totals', 'next_chunk', 'total_chunks', 'generation', 'verified', 'repeated', 'chunk_no', 'rows',
      'media_pending', 'maintenance', 'replacement_ready', 'full_site_complete']);
    const digest = hash(result.plan_hash), next = count(result.next_chunk, work.length);
    if (result.success !== true || result.scope !== 'site-chat' || result.operation !== operation
      || result.source_site_id !== setup.catalog.site_id || result.package_id !== setup.catalog.package_id
      || result.maintenance !== true || result.replacement_ready !== false || result.full_site_complete !== false
      || result.total_chunks !== work.length || typeof result.verified !== 'boolean' || typeof result.repeated !== 'boolean'
      || result.generation !== String(next) || result.media_pending !== !result.verified
      || (planHash !== undefined && digest !== planHash) || (boundPlanHash !== null && digest !== boundPlanHash)
      || (confirmed && (next < confirmed.next_chunk || (confirmed.verified && !result.verified)))) invalid();
    // Counts track all consumed source rows, including reuse/merge/deduplication, not INSERT totals.
    const expected = Object.fromEntries(CHAT_TABLE_KEYS.map(key => [key, 0])) as ChatCounts;
    for (const item of work.slice(0, next)) expected[item.key] += item.rows;
    const counts = object(result.counts, CHAT_TABLE_KEYS), actualTotals = object(result.totals, CHAT_TABLE_KEYS);
    for (const key of CHAT_TABLE_KEYS) if (counts[key] !== expected[key] || actualTotals[key] !== totals[key]) invalid();
    const stage = result.verified ? 'done' : next === work.length ? 'ready_to_verify' : 'restoring';
    if (result.stage !== stage || (result.verified && next !== work.length)) invalid();
    if (operation === 'chunk') {
      if (chunkNo === undefined || result.chunk_no !== chunkNo || result.rows !== work[chunkNo]?.rows
        || next <= chunkNo || (!result.repeated && (next !== chunkNo + 1 || result.verified))
        || (confirmed && chunkNo < confirmed.next_chunk && !result.repeated)) invalid();
    } else if (result.chunk_no !== null || result.rows !== 0) invalid();
    if (operation === 'begin' && !result.repeated && (confirmed !== null || next !== 0 || result.verified)) invalid();
    if (operation === 'status' && !result.repeated) invalid();
    if (operation === 'verify' && (!result.verified || next !== work.length || (confirmed?.verified && !result.repeated))) invalid();
    return Object.freeze({ success: true, scope: 'site-chat', operation, plan_hash: digest,
      source_site_id: setup.catalog.site_id, package_id: setup.catalog.package_id, stage,
      counts: Object.freeze({ ...expected }), totals: Object.freeze({ ...totals }), next_chunk: next, total_chunks: work.length,
      generation: String(next), verified: result.verified, repeated: result.repeated,
      chunk_no: operation === 'chunk' ? chunkNo! : null, rows: operation === 'chunk' ? work[chunkNo!].rows : 0,
      media_pending: !result.verified, maintenance: true, replacement_ready: false, full_site_complete: false });
  }
  async function request(operation: Operation, signal?: AbortSignal, planHash?: string, chunkNo?: number): Promise<ChatRestoreReceipt> {
    // A concurrent rejected call must not revoke the active request's confirmation.
    if (busy) throw new Error('A chat restore request is already in progress.');
    busy = true;
    let dispatched = false;
    try {
      aborted(signal);
      if (operation !== 'status' && requiresStatus) invalid();
      if (operation === 'begin') {
        const digest = hash(planHash);
        if (boundPlanHash !== null && digest !== boundPlanHash) invalid();
      }
      if (operation === 'chunk') {
        count(chunkNo, work.length - 1);
        if (!reconciled || !confirmed || chunkNo! > confirmed.next_chunk) invalid();
      }
      if (operation === 'verify' && (!reconciled || !confirmed || confirmed.next_chunk !== work.length)) invalid();
      const args: RpcArgs = { p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: setup.token };
      if (operation === 'begin') args.p_plan_hash = planHash;
      if (operation === 'chunk') args.p_chunk_no = chunkNo;
      const name: RpcName = operation === 'status' ? 'get_employee_import_chat_restore_status' : `employee_import_chat_${operation}`;
      const { data, error } = await withSignal(() => {
        dispatched = true;
        // Bind even an unacknowledged begin, so a subsequent status cannot silently adopt another plan.
        if (operation === 'begin') boundPlanHash = planHash!;
        const query = rpc(name, args);
        return signal ? query.abortSignal(signal) : query;
      }, signal);
      aborted(signal);
      if (error) invalid();
      const receipt = validate(data, operation, planHash, chunkNo);
      aborted(signal);
      confirmed = receipt;
      boundPlanHash = receipt.plan_hash;
      reconciled = true;
      requiresStatus = false;
      return receipt;
    } catch {
      // Cancellation, malformed envelopes, proxy getters and backend failures must never leak details.
      let cancelled = false;
      try { cancelled = signal?.aborted === true; } catch { /* Keep signal inspection failures private. */ }
      reconciled = false;
      requiresStatus = requiresStatus || dispatched || cancelled || confirmed !== null;
      if (cancelled) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { busy = false; }
  }
  // No loop drives writes. Each begin/chunk/verify/status is an explicit caller decision.
  return {
    begin: (planHash, signal) => request('begin', signal, planHash),
    chunk: (chunkNo, signal) => request('chunk', signal, undefined, chunkNo),
    verify: signal => request('verify', signal),
    status: signal => request('status', signal),
  };
}
