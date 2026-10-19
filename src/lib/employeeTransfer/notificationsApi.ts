import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import {
  NOTIFICATIONS_TRANSFER_LIMITS, notificationsCursor, notificationsTableKey, validateNotificationsBind,
  validateNotificationsCatalog, validateNotificationsClose, validateNotificationsPage, validateNotificationsPlan,
  validateNotificationsStage, validateNotificationsVerification,
  type NotificationsCatalog, type NotificationsExportSource, type NotificationsImportTarget, type NotificationsPlan,
} from './notificationsTransfer';

const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const failure = 'Notifications request outcome is unknown or unconfirmed; server staging may exist. Reconcile the task before retrying. No automatic retry, cancel, rollback, restore or close was performed.';
function invalid(): never { throw new Error(failure); }
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
    if (signal?.aborted) throw new DOMException(failure, 'AbortError');
    throw new Error(failure);
  }
}
export interface NotificationsExportSession {
  identity(): { jobId: string; jobToken: string } | null;
  begin(signal?: AbortSignal): Promise<NotificationsCatalog>;
  source: NotificationsExportSource;
  close(signal?: AbortSignal): Promise<{ success: true; scope: 'site-notifications'; media_pending: true; full_site_complete: false }>;
}
// Lazy factory: explicit begin consumes the password once, even on an unconfirmed/aborted attempt.
export function createNotificationsExportSession(packageId: string, adminPassword: string): NotificationsExportSession {
  const auth = getAdminFinancialSessionToken();
  uuid(auth); uuid(packageId);
  let attempted = false, verified = false, busy = false, closed = false;
  let job: { jobId: string; jobToken: string } | null = null;
  let catalog: NotificationsCatalog | null = null;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('A notifications request is already in progress.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  const args = () => {
    if (!job) throw new Error('Notifications export begin has not been confirmed.');
    if (closed) throw new Error('Notifications export is closed.');
    return { p_admin_session_token: auth, p_job_token: job.jobToken };
  };
  return {
    identity: () => job && { ...job },
    async begin(signal) {
      if (attempted) throw new Error('Notifications export begin cannot be retried automatically; reconcile first.');
      attempted = true;
      try {
        return await exclusive(async () => {
          const result = await response(() => {
            const password = adminPassword; adminPassword = '';
            const query = supabase.rpc('employee_export_notifications_begin', {
              p_admin_session_token: auth, p_admin_password: password, p_package_id: packageId,
            });
            return signal ? query.abortSignal(signal) : query;
          }, value => {
            const record = object(value, ['success', 'job_id', 'job_token', 'site_id', 'catalog', 'scope', 'full_site_complete']);
            if (record.success !== true || record.scope !== 'site-notifications' || record.full_site_complete !== false) invalid();
            const snapshot = validateNotificationsCatalog(record.catalog);
            if (snapshot.package_id !== packageId || uuid(record.site_id) !== snapshot.site_id) invalid();
            return { catalog: snapshot, jobId: uuid(record.job_id), jobToken: uuid(record.job_token) };
          }, signal);
          checkAbort(signal);
          catalog = result.catalog; job = { jobId: result.jobId, jobToken: result.jobToken };
          return validateNotificationsCatalog(catalog);
        }, signal);
      } finally { adminPassword = ''; }
    },
    source: {
      catalog(signal) {
        return exclusive(async () => { args(); return validateNotificationsCatalog(catalog); }, signal);
      },
      page(key, after, signal) {
        return exclusive(async () => {
          notificationsTableKey(key);
          if (after !== null) notificationsCursor(key, after);
          const params = args();
          verified = false;
          return response(() => {
            const query = supabase.rpc('get_employee_export_notifications_page', { ...params, p_table_key: key, p_after: after, p_limit: 200 });
            return signal ? query.abortSignal(signal) : query;
          }, value => validateNotificationsPage(value, key, after), signal);
        }, signal);
      },
      verify(signal) {
        return exclusive(async () => {
          verified = false;
          const params = args();
          const result = await response(() => {
            const query = supabase.rpc('employee_export_notifications_verify', params);
            return signal ? query.abortSignal(signal) : query;
          }, validateNotificationsVerification, signal);
          checkAbort(signal); verified = true;
          return result;
        }, signal);
      },
    },
    close(signal) {
      return exclusive(async () => {
        const params = args();
        if (!verified) throw new Error('Notifications export must be explicitly verified before close.');
        const result = await response(() => {
          const query = supabase.rpc('employee_export_notifications_close', params);
          return signal ? query.abortSignal(signal) : query;
        }, validateNotificationsClose, signal);
        checkAbort(signal); closed = true;
        return result;
      }, signal);
    },
  };
}
export interface NotificationsImportSession {
  target: NotificationsImportTarget;
  plan(signal?: AbortSignal): Promise<NotificationsPlan>;
}
// Only immutable staging and a genuinely read-only association preflight. No apply/verify/close.
// The server owns same-package identity/finance mappings, maintenance and the dispatch task.
export function createNotificationsImportSession(dispatchJobToken: string): NotificationsImportSession {
  const auth = getAdminFinancialSessionToken();
  uuid(auth); uuid(dispatchJobToken);
  const args = () => ({ p_admin_session_token: auth, p_job_token: dispatchJobToken });
  let catalog: NotificationsCatalog | null = null, busy = false;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('A notifications request is already in progress.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  const bound = () => {
    if (!catalog) throw new Error('Notifications bind has not been confirmed. Server staging may exist; reconcile any unconfirmed attempt.');
    return catalog;
  };
  const plan = (signal?: AbortSignal) => exclusive(async () => {
    const expected = bound();
    return response(() => {
      const query = supabase.rpc('get_employee_import_notifications_plan', args());
      return signal ? query.abortSignal(signal) : query;
    }, value => {
      const checked = validateNotificationsPlan(value);
      if (expected.tables.some(table => checked.counts[table.key] !== table.rows)
        || checked.employees !== expected.identity_catalog.tables[0].rows) invalid();
      return checked;
    }, signal);
  }, signal);
  return {
    target: {
      bind(input, signal) {
        return exclusive(async () => {
          const snapshot = validateNotificationsCatalog(input);
          if (catalog && JSON.stringify(snapshot) !== JSON.stringify(catalog)) throw new Error('The notifications catalog binding is immutable.');
          const result = await response(() => {
            const query = supabase.rpc('employee_import_notifications_bind', { ...args(), p_catalog: validateNotificationsCatalog(snapshot) });
            return signal ? query.abortSignal(signal) : query;
          }, validateNotificationsBind, signal);
          checkAbort(signal); catalog = snapshot;
          return result;
        }, signal);
      },
      stage(key, chunkNo, ndjson, signal) {
        return exclusive(async () => {
          const expected = bound(); notificationsTableKey(key); count(chunkNo, NOTIFICATIONS_TRANSFER_LIMITS.maxChunks - 1);
          const table = expected.tables.find(table => table.key === key)!;
          if (typeof ndjson !== 'string' || ndjson.length > NOTIFICATIONS_TRANSFER_LIMITS.maxPageBytes
            || (ndjson === '' && (chunkNo !== 0 || table.rows !== 0))) invalid();
          const raw = new TextEncoder().encode(ndjson), digest = new Sha256().update(raw).digestHex();
          const rows = ndjson === '' ? 0 : ndjson.split('\n').length - 1;
          validateNotificationsPage({ table_key: key, count: rows, ndjson, next_after: null, sha256: digest }, key, null);
          if (rows > table.rows || raw.length > table.bytes) invalid();
          if (!expected.date_runs_supported && key === 'notification_automation_date_runs' && rows !== 0) invalid();
          return response(() => {
            const query = supabase.rpc('employee_import_notifications_stage', { ...args(), p_table_key: key, p_chunk_no: chunkNo, p_ndjson: ndjson });
            return signal ? query.abortSignal(signal) : query;
          }, value => validateNotificationsStage(value, rows, raw.length, digest), signal);
        }, signal);
      },
      plan,
    },
    plan,
  };
}
