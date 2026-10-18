import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import {
  FINANCE_TRANSFER_LIMITS, financeCursor, financeTableKey, validateFinanceApplyReceipt, validateFinanceBind,
  validateFinanceCatalog, validateFinanceClose, validateFinancePage, validateFinancePlan, validateFinanceStage,
  validateFinanceVerification, validateFinanceVerifyReceipt,
  type FinanceApplyReceipt, type FinanceCatalog, type FinanceExportSource, type FinanceImportTarget,
  type FinancePlan, type FinanceVerifyReceipt,
} from './financeTransfer';

const { object, uuid, hash, count, checkAbort, withSignal } = dispatchTransferChecks;
const failure = 'Employee finance request outcome is unknown or unconfirmed; reconcile the task before retrying. No automatic retry, cancel, rollback, restore or close was performed.';
function invalid(): never { throw new Error(failure); }
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
export interface FinanceExportSession {
  identity(): { jobId: string; jobToken: string } | null;
  begin(signal?: AbortSignal): Promise<FinanceCatalog>;
  source: FinanceExportSource;
  close(signal?: AbortSignal): Promise<{ success: true; scope: 'employee-finance'; full_site_complete: false }>;
}
// Lazy factory. Only explicit begin consumes the password, once, including an unconfirmed/aborted attempt.
export function createFinanceExportSession(packageId: string, adminPassword: string): FinanceExportSession {
  const auth = getAdminFinancialSessionToken();
  uuid(auth); uuid(packageId);
  let attempted = false, verified = false, busy = false, closed = false;
  let job: { jobId: string; jobToken: string } | null = null;
  let catalog: FinanceCatalog | null = null;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('An employee finance request is already in progress.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  const args = () => {
    if (!job) throw new Error('Employee finance export begin has not been confirmed.');
    if (closed) throw new Error('Employee finance export is closed.');
    return { p_admin_session_token: auth, p_job_token: job.jobToken };
  };
  return {
    identity: () => job && { ...job },
    async begin(signal) {
      if (attempted) throw new Error('Employee finance export begin cannot be retried automatically; reconcile first.');
      attempted = true;
      try {
        return await exclusive(async () => {
          const result = await response(() => {
            const password = adminPassword; adminPassword = '';
            const query = supabase.rpc('employee_export_finance_begin', {
              p_admin_session_token: auth, p_admin_password: password, p_package_id: packageId,
            });
            return signal ? query.abortSignal(signal) : query;
          }, value => {
            const record = object(value, ['success', 'job_id', 'job_token', 'site_id', 'catalog', 'scope', 'full_site_complete']);
            if (record.success !== true || record.scope !== 'employee-finance' || record.full_site_complete !== false) invalid();
            const snapshot = validateFinanceCatalog(record.catalog);
            if (snapshot.package_id !== packageId || uuid(record.site_id) !== snapshot.site_id) invalid();
            return { catalog: snapshot, jobId: uuid(record.job_id), jobToken: uuid(record.job_token) };
          }, signal);
          checkAbort(signal);
          catalog = result.catalog; job = { jobId: result.jobId, jobToken: result.jobToken };
          return validateFinanceCatalog(catalog);
        }, signal);
      } finally { adminPassword = ''; }
    },
    source: {
      catalog(signal) {
        return exclusive(async () => { args(); return validateFinanceCatalog(catalog); }, signal);
      },
      page(key, after, signal) {
        return exclusive(async () => {
          financeTableKey(key);
          if (after !== null) financeCursor(key, after);
          const params = args();
          // Reading after verification invalidates local permission to close without a fresh source check.
          verified = false;
          return response(() => {
            const query = supabase.rpc('get_employee_export_finance_page', { ...params, p_table_key: key, p_after: after, p_limit: 200 });
            return signal ? query.abortSignal(signal) : query;
          }, value => validateFinancePage(value, key, after), signal);
        }, signal);
      },
      verify(signal) {
        return exclusive(async () => {
          verified = false;
          const params = args();
          const result = await response(() => {
            const query = supabase.rpc('employee_export_finance_verify', params);
            return signal ? query.abortSignal(signal) : query;
          }, validateFinanceVerification, signal);
          checkAbort(signal); verified = true;
          return result;
        }, signal);
      },
    },
    close(signal) {
      return exclusive(async () => {
        const params = args();
        if (!verified) throw new Error('Employee finance export must be explicitly verified before close.');
        const result = await response(() => {
          const query = supabase.rpc('employee_export_finance_close', params);
          return signal ? query.abortSignal(signal) : query;
        }, validateFinanceClose, signal);
        checkAbort(signal); closed = true;
        return result;
      }, signal);
    },
  };
}

export interface FinanceImportSession {
  target: FinanceImportTarget;
  plan(signal?: AbortSignal): Promise<FinancePlan>;
  apply(employeeId: string, planHash: string, signal?: AbortSignal): Promise<FinanceApplyReceipt>;
  verify(signal?: AbortSignal): Promise<FinanceVerifyReceipt>;
}
// The server owns same-package mappings, backup/maintenance checks and the existing dispatch task.
export function createFinanceImportSession(dispatchJobToken: string): FinanceImportSession {
  const auth = getAdminFinancialSessionToken();
  uuid(auth); uuid(dispatchJobToken);
  const args = () => ({ p_admin_session_token: auth, p_job_token: dispatchJobToken });
  let catalog: FinanceCatalog | null = null, savedPlan: FinancePlan | null = null;
  let busy = false, restoreAttempted = false;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('An employee finance request is already in progress.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  const bound = () => {
    if (!catalog) throw new Error('Employee finance bind has not been confirmed.');
    return catalog;
  };
  const approved = () => {
    bound();
    if (!savedPlan?.can_restore) throw new Error('A matching conflict-free employee finance plan must be explicitly obtained first.');
    return savedPlan;
  };
  const matchedReceipt = (value: unknown, employeeId?: string) => {
    const expected = approved();
    const receipt = employeeId === undefined ? validateFinanceVerifyReceipt(value) : validateFinanceApplyReceipt(value);
    if (receipt.total_employees !== expected.employees || bound().tables.some(table => receipt.counts[table.key] > table.rows)
      || (employeeId !== undefined && (!('employee_id' in receipt) || receipt.employee_id !== employeeId))
      || (employeeId === undefined && bound().tables.some(table => receipt.counts[table.key] !== table.rows))) invalid();
    return receipt;
  };
  const plan = (signal?: AbortSignal) => exclusive(async () => {
    const expected = bound(); savedPlan = null;
    const result = await response(() => {
      const query = supabase.rpc('get_employee_import_finance_plan', args());
      return signal ? query.abortSignal(signal) : query;
    }, value => {
      const checked = validateFinancePlan(value);
      if (expected.tables.some(table => checked.counts[table.key] !== table.rows)) invalid();
      return checked;
    }, signal);
    checkAbort(signal);
    savedPlan = validateFinancePlan(result); // Never retain any public/nested response object.
    return result;
  }, signal);
  return {
    target: {
      bind(input, signal) {
        return exclusive(async () => {
          savedPlan = null;
          const snapshot = validateFinanceCatalog(input);
          if (catalog && JSON.stringify(snapshot) !== JSON.stringify(catalog)) throw new Error('The finance catalog binding is immutable.');
          const result = await response(() => {
            const query = supabase.rpc('employee_import_finance_bind', { ...args(), p_catalog: { ...validateFinanceCatalog(snapshot) } });
            return signal ? query.abortSignal(signal) : query;
          }, validateFinanceBind, signal);
          checkAbort(signal); catalog = snapshot;
          return result;
        }, signal);
      },
      stage(key, chunkNo, ndjson, signal) {
        return exclusive(async () => {
          bound(); financeTableKey(key); count(chunkNo, FINANCE_TRANSFER_LIMITS.maxChunks - 1);
          if (restoreAttempted) throw new Error('Employee finance restore was attempted; new staging is not allowed.');
          savedPlan = null;
          if (typeof ndjson !== 'string' || ndjson.length > FINANCE_TRANSFER_LIMITS.maxPageBytes
            || (ndjson === '' && (chunkNo !== 0 || bound().tables.find(table => table.key === key)?.rows !== 0))) invalid();
          const raw = new TextEncoder().encode(ndjson), digest = new Sha256().update(raw).digestHex();
          const rows = ndjson === '' ? 0 : ndjson.split('\n').length - 1;
          validateFinancePage({ table_key: key, count: rows, ndjson, next_after: null, sha256: digest }, key, null);
          return response(() => {
            const query = supabase.rpc('employee_import_finance_stage', { ...args(), p_table_key: key, p_chunk_no: chunkNo, p_ndjson: ndjson });
            return signal ? query.abortSignal(signal) : query;
          }, value => validateFinanceStage(value, rows, raw.length, digest), signal);
        }, signal);
      },
      plan,
    },
    plan,
    apply(employeeId, planHash, signal) {
      return exclusive(async () => {
        uuid(employeeId); hash(planHash);
        const expected = approved();
        if (expected.plan_hash !== planHash) throw new Error('A matching conflict-free employee finance plan must be explicitly obtained first.');
        return response(() => {
          restoreAttempted = true;
          const query = supabase.rpc('employee_import_finance_apply', { ...args(), p_employee_id: employeeId, p_plan_hash: planHash });
          return signal ? query.abortSignal(signal) : query;
        }, value => matchedReceipt(value, employeeId) as FinanceApplyReceipt, signal);
      }, signal);
    },
    verify(signal) {
      return exclusive(async () => {
        approved();
        return response(() => {
          restoreAttempted = true;
          const query = supabase.rpc('employee_import_finance_verify', args());
          return signal ? query.abortSignal(signal) : query;
        }, value => matchedReceipt(value) as FinanceVerifyReceipt, signal);
      }, signal);
    },
  };
}
