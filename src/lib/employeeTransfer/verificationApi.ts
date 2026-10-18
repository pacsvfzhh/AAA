import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import {
  VERIFICATION_TRANSFER_LIMITS, verificationCursor, verificationTableKey, validateVerificationApplyReceipt, validateVerificationBind,
  validateVerificationCatalog, validateVerificationClose, validateVerificationPage, validateVerificationPlan, validateVerificationStage,
  validateVerificationVerification, validateVerificationVerifyReceipt,
  type VerificationApplyReceipt, type VerificationCatalog, type VerificationExportSource, type VerificationImportTarget,
  type VerificationPlan, type VerificationVerifyReceipt,
} from './verificationTransfer';

const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const failure = 'Employee verification request outcome is unknown or unconfirmed; reconcile the task before retrying. No automatic retry, cancel, rollback, restore or close was performed.';
function invalid(): never { throw new Error(failure); }
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
    // A local abort cannot prove server rollback. Never expose backend/parser errors or abort reasons.
    if (signal?.aborted) throw new DOMException(failure, 'AbortError');
    throw new Error(failure);
  }
}
export interface VerificationExportSession {
  identity(): { jobId: string; jobToken: string } | null;
  begin(signal?: AbortSignal): Promise<VerificationCatalog>;
  source: VerificationExportSource;
  close(signal?: AbortSignal): Promise<{ success: true; scope: 'employee-verification'; full_site_complete: false }>;
}
// Lazy factory. Only explicit begin consumes the password, once, including an unconfirmed/aborted attempt.
export function createVerificationExportSession(packageId: string, adminPassword: string): VerificationExportSession {
  const auth = getAdminFinancialSessionToken();
  uuid(auth); uuid(packageId);
  let attempted = false, verified = false, busy = false, closed = false;
  let job: { jobId: string; jobToken: string } | null = null;
  let catalog: VerificationCatalog | null = null;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('An employee verification request is already in progress.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  const args = () => {
    if (!job) throw new Error('Employee verification export begin has not been confirmed.');
    if (closed) throw new Error('Employee verification export is closed.');
    return { p_admin_session_token: auth, p_job_token: job.jobToken };
  };
  return {
    identity: () => job && { ...job },
    async begin(signal) {
      if (attempted) throw new Error('Employee verification export begin cannot be retried automatically; reconcile first.');
      attempted = true;
      try {
        return await exclusive(async () => {
          const result = await response(() => {
            const password = adminPassword; adminPassword = '';
            const query = supabase.rpc('employee_export_verification_begin', {
              p_admin_session_token: auth, p_admin_password: password, p_package_id: packageId,
            });
            return signal ? query.abortSignal(signal) : query;
          }, value => {
            const record = object(value, ['success', 'job_id', 'job_token', 'site_id', 'catalog', 'scope', 'full_site_complete']);
            if (record.success !== true || record.scope !== 'employee-verification' || record.full_site_complete !== false) invalid();
            const snapshot = validateVerificationCatalog(record.catalog);
            if (snapshot.package_id !== packageId || uuid(record.site_id) !== snapshot.site_id) invalid();
            return { catalog: snapshot, jobId: uuid(record.job_id), jobToken: uuid(record.job_token) };
          }, signal);
          checkAbort(signal);
          catalog = result.catalog; job = { jobId: result.jobId, jobToken: result.jobToken };
          return validateVerificationCatalog(catalog);
        }, signal);
      } finally { adminPassword = ''; }
    },
    source: {
      catalog(signal) {
        return exclusive(async () => { args(); return validateVerificationCatalog(catalog); }, signal);
      },
      page(key, after, signal) {
        return exclusive(async () => {
          verificationTableKey(key);
          if (after !== null) verificationCursor(key, after);
          const params = args();
          // Reading after verification invalidates local permission to close without a fresh source check.
          verified = false;
          return response(() => {
            const query = supabase.rpc('get_employee_export_verification_page', { ...params, p_table_key: key, p_after: after, p_limit: 200 });
            return signal ? query.abortSignal(signal) : query;
          }, value => validateVerificationPage(value, key, after), signal);
        }, signal);
      },
      verify(signal) {
        return exclusive(async () => {
          verified = false;
          const params = args();
          // SQL requires actual media download and a second content check; records alone never authorize close.
          const result = await response(() => {
            const query = supabase.rpc('employee_export_verification_verify', params);
            return signal ? query.abortSignal(signal) : query;
          }, validateVerificationVerification, signal);
          checkAbort(signal); verified = true;
          return result;
        }, signal);
      },
    },
    close(signal) {
      return exclusive(async () => {
        const params = args();
        if (!verified) throw new Error('Employee verification export must be explicitly verified before close.');
        // Close rechecks the server-owned media receipts; do not substitute a local completion flag.
        const result = await response(() => {
          const query = supabase.rpc('employee_export_verification_close', params);
          return signal ? query.abortSignal(signal) : query;
        }, validateVerificationClose, signal);
        checkAbort(signal); closed = true;
        return result;
      }, signal);
    },
  };
}

export interface VerificationImportSession {
  target: VerificationImportTarget;
  plan(signal?: AbortSignal): Promise<VerificationPlan>;
  apply(employeeId: string, planHash: string, signal?: AbortSignal): Promise<VerificationApplyReceipt>;
  verify(signal?: AbortSignal): Promise<VerificationVerifyReceipt>;
}
// The server owns same-package mappings, media/backup/maintenance checks and the existing dispatch task.
export function createVerificationImportSession(dispatchJobToken: string): VerificationImportSession {
  const auth = getAdminFinancialSessionToken();
  uuid(auth); uuid(dispatchJobToken);
  const args = () => ({ p_admin_session_token: auth, p_job_token: dispatchJobToken });
  let catalog: VerificationCatalog | null = null, savedPlan: VerificationPlan | null = null;
  let busy = false, restoreAttempted = false;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('An employee verification request is already in progress.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  const bound = () => {
    if (!catalog) throw new Error('Employee verification bind has not been confirmed.');
    return catalog;
  };
  const approved = () => {
    bound();
    if (!savedPlan?.can_restore) throw new Error('A matching conflict-free employee verification plan must be explicitly obtained first.');
    return savedPlan;
  };
  const matchedReceipt = (value: unknown, employeeId?: string) => {
    const expected = approved();
    const receipt = employeeId === undefined ? validateVerificationVerifyReceipt(value) : validateVerificationApplyReceipt(value);
    if (receipt.total_employees !== expected.employees || bound().tables.some(table => receipt.counts[table.key] > table.rows)
      || (employeeId !== undefined && (!('employee_id' in receipt) || receipt.employee_id !== employeeId))
      || (employeeId === undefined && bound().tables.some(table => receipt.counts[table.key] !== table.rows))) invalid();
    return receipt;
  };
  const plan = (signal?: AbortSignal) => exclusive(async () => {
    const expected = bound(); savedPlan = null;
    const result = await response(() => {
      const query = supabase.rpc('get_employee_import_verification_plan', args());
      return signal ? query.abortSignal(signal) : query;
    }, value => {
      const checked = validateVerificationPlan(value);
      if (expected.tables.some(table => checked.counts[table.key] !== table.rows)
        || checked.employees !== expected.identity_catalog.tables[0].rows) invalid();
      return checked;
    }, signal);
    checkAbort(signal);
    savedPlan = validateVerificationPlan(result); // Never retain any public/nested response object.
    return result;
  }, signal);
  return {
    target: {
      bind(input, signal) {
        return exclusive(async () => {
          savedPlan = null;
          const snapshot = validateVerificationCatalog(input);
          if (catalog && JSON.stringify(snapshot) !== JSON.stringify(catalog)) throw new Error('The verification catalog binding is immutable.');
          const result = await response(() => {
            const query = supabase.rpc('employee_import_verification_bind', { ...args(), p_catalog: { ...validateVerificationCatalog(snapshot) } });
            return signal ? query.abortSignal(signal) : query;
          }, validateVerificationBind, signal);
          checkAbort(signal); catalog = snapshot;
          return result;
        }, signal);
      },
      stage(key, chunkNo, ndjson, signal) {
        return exclusive(async () => {
          bound(); verificationTableKey(key); count(chunkNo, VERIFICATION_TRANSFER_LIMITS.maxChunks - 1);
          if (restoreAttempted) throw new Error('Employee verification restore was attempted; new staging is not allowed.');
          savedPlan = null;
          if (typeof ndjson !== 'string' || ndjson.length > VERIFICATION_TRANSFER_LIMITS.maxPageBytes
            || (ndjson === '' && (chunkNo !== 0 || bound().tables.find(table => table.key === key)?.rows !== 0))) invalid();
          const raw = new TextEncoder().encode(ndjson), digest = new Sha256().update(raw).digestHex();
          const rows = ndjson === '' ? 0 : ndjson.split('\n').length - 1;
          validateVerificationPage({ table_key: key, count: rows, ndjson, next_after: null, sha256: digest }, key, null);
          return response(() => {
            const query = supabase.rpc('employee_import_verification_stage', { ...args(), p_table_key: key, p_chunk_no: chunkNo, p_ndjson: ndjson });
            return signal ? query.abortSignal(signal) : query;
          }, value => validateVerificationStage(value, rows, raw.length, digest), signal);
        }, signal);
      },
      plan,
    },
    plan,
    apply(employeeId, planHash, signal) {
      return exclusive(async () => {
        uuid(employeeId); hash(planHash);
        const expected = approved();
        if (expected.plan_hash !== planHash) throw new Error('A matching conflict-free employee verification plan must be explicitly obtained first.');
        return response(() => {
          restoreAttempted = true;
          const query = supabase.rpc('employee_import_verification_apply', { ...args(), p_employee_id: employeeId, p_plan_hash: planHash });
          return signal ? query.abortSignal(signal) : query;
        }, value => matchedReceipt(value, employeeId) as VerificationApplyReceipt, signal);
      }, signal);
    },
    verify(signal) {
      return exclusive(async () => {
        approved();
        return response(() => {
          restoreAttempted = true;
          const query = supabase.rpc('employee_import_verification_verify', args());
          return signal ? query.abortSignal(signal) : query;
        }, value => matchedReceipt(value) as VerificationVerifyReceipt, signal);
      }, signal);
    },
  };
}
