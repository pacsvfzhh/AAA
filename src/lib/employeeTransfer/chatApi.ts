import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import {
  CHAT_TRANSFER_LIMITS, chatCursor, chatTableKey, validateChatBind,
  validateChatCatalog, validateChatClose, validateChatPage, validateChatPlan,
  validateChatStage, validateChatVerification,
  type ChatCatalog, type ChatExportSource, type ChatImportTarget, type ChatPlan,
} from './chatTransfer';

const { object, count, withSignal } = dispatchTransferChecks;
const failure = 'Chat request outcome is unknown or unconfirmed; server staging may exist. Reconcile the task before retrying. No automatic retry, cancel, rollback, restore or close was performed.';
function invalid(): never { throw new Error(failure); }
function cancelled(signal?: AbortSignal): boolean {
  try { return signal?.aborted === true; } catch { invalid(); }
}
function checkAbort(signal?: AbortSignal): void {
  if (cancelled(signal)) throw new DOMException(failure, 'AbortError');
}
function uuid(value: unknown): string {
  const result = dispatchTransferChecks.uuid(value);
  if (result.length !== 36) invalid();
  return result;
}
async function response<T>(
  operation: () => PromiseLike<{ data: unknown; error: unknown }>, validate: (value: unknown) => T, signal?: AbortSignal,
): Promise<T> {
  try {
    const { data, error } = await withSignal(operation, signal);
    checkAbort(signal);
    if (error) invalid();
    const result = validate(data);
    checkAbort(signal);
    return result;
  } catch {
    // Local cancellation is not evidence of server rollback. Never expose backend/abort text.
    if (cancelled(signal)) throw new DOMException(failure, 'AbortError');
    throw new Error(failure);
  }
}
export interface ChatExportSession {
  identity(): { jobId: string; jobToken: string } | null;
  begin(signal?: AbortSignal): Promise<ChatCatalog>;
  source: ChatExportSource;
  close(signal?: AbortSignal): Promise<{ success: true; scope: 'site-chat'; media_pending: true; full_site_complete: false }>;
}
// Lazy factory: explicit begin consumes the password once, even on an unconfirmed/aborted attempt.
export function createChatExportSession(packageId: string, adminPassword: string): ChatExportSession {
  uuid(packageId);
  let attempted = false, verified = false, busy = false, closed = false;
  let job: { jobId: string; jobToken: string } | null = null;
  let catalog: ChatCatalog | null = null;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('A chat request is already in progress.');
    busy = true;
    try { return await operation(); }
    catch {
      if (cancelled(signal)) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { busy = false; }
  };
  const args = () => {
    if (!job) throw new Error('Chat export begin has not been confirmed.');
    if (closed) throw new Error('Chat export is closed.');
    return { p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: job.jobToken };
  };
  return {
    identity: () => job && { ...job },
    async begin(signal) {
      if (attempted) throw new Error('Chat export begin cannot be retried automatically; reconcile first.');
      attempted = true;
      try {
        return await exclusive(async () => {
          const result = await response(() => {
            const password = adminPassword; adminPassword = '';
            const query = supabase.rpc('employee_export_chat_begin', {
              p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_admin_password: password, p_package_id: packageId,
            });
            return signal ? query.abortSignal(signal) : query;
          }, value => {
            const record = object(value, ['success', 'job_id', 'job_token', 'site_id', 'catalog', 'scope', 'media_pending', 'full_site_complete']);
            if (record.success !== true || record.scope !== 'site-chat' || record.media_pending !== true || record.full_site_complete !== false) invalid();
            const snapshot = validateChatCatalog(record.catalog);
            if (snapshot.package_id !== packageId || uuid(record.site_id) !== snapshot.site_id) invalid();
            return { catalog: snapshot, jobId: uuid(record.job_id), jobToken: uuid(record.job_token) };
          }, signal);
          checkAbort(signal);
          catalog = result.catalog; job = { jobId: result.jobId, jobToken: result.jobToken };
          return validateChatCatalog(catalog);
        }, signal);
      } finally { adminPassword = ''; }
    },
    source: {
      catalog(signal) {
        return exclusive(async () => {
          if (!job || closed) throw new Error('Chat export is unconfirmed or closed.');
          return validateChatCatalog(catalog);
        }, signal);
      },
      page(key, after, signal) {
        return exclusive(async () => {
          chatTableKey(key);
          if (after !== null) chatCursor(key, after);
          verified = false;
          return response(() => {
            const query = supabase.rpc('get_employee_export_chat_page', { ...args(), p_table_key: key, p_after: after, p_limit: 200 });
            return signal ? query.abortSignal(signal) : query;
          }, value => validateChatPage(value, key, after), signal);
        }, signal);
      },
      verify(signal) {
        return exclusive(async () => {
          verified = false;
          const result = await response(() => {
            const query = supabase.rpc('employee_export_chat_verify', args());
            return signal ? query.abortSignal(signal) : query;
          }, validateChatVerification, signal);
          checkAbort(signal); verified = true;
          return result;
        }, signal);
      },
    },
    close(signal) {
      return exclusive(async () => {
        if (!verified) throw new Error('Chat export must be explicitly verified before close.');
        const result = await response(() => {
          const query = supabase.rpc('employee_export_chat_close', args());
          return signal ? query.abortSignal(signal) : query;
        }, validateChatClose, signal);
        checkAbort(signal); closed = true;
        return result;
      }, signal);
    },
  };
}
export interface ChatImportSession {
  target: ChatImportTarget;
  plan(signal?: AbortSignal): Promise<ChatPlan>;
}
// Only immutable staging and a genuinely read-only association preflight. No apply/verify/close.
// The server owns same-package identity/finance mappings, maintenance and the dispatch task.
export function createChatImportSession(dispatchJobToken: string): ChatImportSession {
  uuid(dispatchJobToken);
  // Never capture a session token: the original owner may reauthenticate and resume the same job.
  const args = () => ({ p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: dispatchJobToken });
  let catalog: ChatCatalog | null = null, busy = false;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('A chat request is already in progress.');
    busy = true;
    try { return await operation(); }
    catch {
      if (cancelled(signal)) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { busy = false; }
  };
  const bound = () => {
    if (!catalog) throw new Error('Chat bind has not been confirmed. Server staging may exist; reconcile any unconfirmed attempt.');
    return catalog;
  };
  const plan = (signal?: AbortSignal) => exclusive(async () => {
    const expected = bound();
    return response(() => {
      const query = supabase.rpc('get_employee_import_chat_plan', args());
      return signal ? query.abortSignal(signal) : query;
    }, value => {
      const checked = validateChatPlan(value);
      if (expected.tables.some(table => checked.counts[table.key] !== table.rows)
        || checked.employees !== expected.identity_catalog.tables[0].rows) invalid();
      return checked;
    }, signal);
  }, signal);
  return {
    target: {
      bind(input, signal) {
        return exclusive(async () => {
          const snapshot = validateChatCatalog(input);
          if (catalog && JSON.stringify(snapshot) !== JSON.stringify(catalog)) throw new Error('The chat catalog binding is immutable.');
          const result = await response(() => {
            const query = supabase.rpc('employee_import_chat_bind', { ...args(), p_catalog: validateChatCatalog(snapshot) });
            return signal ? query.abortSignal(signal) : query;
          }, validateChatBind, signal);
          checkAbort(signal); catalog = snapshot;
          return result;
        }, signal);
      },
      stage(key, chunkNo, ndjson, signal) {
        return exclusive(async () => {
          const expected = bound(); chatTableKey(key); count(chunkNo, CHAT_TRANSFER_LIMITS.maxChunks - 1);
          const table = expected.tables.find(table => table.key === key)!;
          if (typeof ndjson !== 'string' || ndjson.length > CHAT_TRANSFER_LIMITS.maxPageBytes
            || (ndjson === '' && (chunkNo !== 0 || table.rows !== 0))) invalid();
          const raw = new TextEncoder().encode(ndjson), digest = new Sha256().update(raw).digestHex();
          const rows = ndjson === '' ? 0 : ndjson.split('\n').length - 1;
          validateChatPage({ table_key: key, count: rows, ndjson, next_after: null, sha256: digest }, key, null);
          if (rows > table.rows || raw.length > table.bytes) invalid();
          return response(() => {
            const query = supabase.rpc('employee_import_chat_stage', { ...args(), p_table_key: key, p_chunk_no: chunkNo, p_ndjson: ndjson });
            return signal ? query.abortSignal(signal) : query;
          }, value => validateChatStage(value, rows, raw.length, digest), signal);
        }, signal);
      },
      plan,
    },
    plan,
  };
}
