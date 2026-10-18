import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import {
  IDENTITY_TRANSFER_LIMITS, identityTableKey, validateIdentityBind, validateIdentityCatalog,
  validateIdentityClose, validateIdentityPage, validateIdentityPlan, validateIdentityReceipt, validateIdentityStage,
  validateIdentityVerification,
  type IdentityCatalog, type IdentityExportSource, type IdentityImportTarget, type IdentityPlan, type IdentityReceipt,
  type IdentityTableKey,
} from './identityTransfer';

const { object, uuid, hash, count, checkAbort, withSignal } = dispatchTransferChecks;
const failure = 'Employee identity request was not confirmed; reconcile the task before retrying.';
async function response<T>(
  operation: () => PromiseLike<{ data: unknown; error: unknown }>, validate: (value: unknown) => T, signal?: AbortSignal,
): Promise<T> {
  try {
    const { data, error } = await withSignal(operation, signal);
    checkAbort(signal);
    if (error) throw new Error(failure);
    const result = validate(data);
    checkAbort(signal);
    return result;
  } catch {
    checkAbort(signal);
    // Never expose backend errors, parser diagnostics, passwords, tokens or NDJSON values.
    throw new Error(failure);
  }
}
export interface IdentityExportSession {
  identity(): { jobId: string; jobToken: string } | null;
  begin(signal?: AbortSignal): Promise<IdentityCatalog>;
  source: IdentityExportSource;
  close(signal?: AbortSignal): Promise<{ success: true; scope: 'employee-identity'; full_site_complete: false }>;
}
// Lazy factory: the password is used once by explicit begin, never retained after that attempt.
export function createIdentityExportSession(packageId: string, adminPassword: string): IdentityExportSession {
  const auth = getAdminFinancialSessionToken();
  uuid(auth); uuid(packageId);
  let attempted = false, verified = false;
  let job: { jobId: string; jobToken: string } | null = null;
  let catalog: IdentityCatalog | null = null;
  const args = () => {
    if (!job) throw new Error('Employee identity export begin has not been confirmed.');
    return { p_admin_session_token: auth, p_job_token: job.jobToken };
  };
  return {
    identity: () => job && { ...job },
    async begin(signal) {
      if (attempted) throw new Error('Employee identity export begin cannot be retried automatically; reconcile first.');
      try {
        checkAbort(signal);
        attempted = true;
        const result = await response(() => {
          const query = supabase.rpc('employee_export_identity_begin', {
            p_admin_session_token: auth, p_admin_password: adminPassword, p_package_id: packageId,
          });
          return signal ? query.abortSignal(signal) : query;
        }, value => {
          const record = object(value, ['success', 'job_id', 'job_token', 'site_id', 'catalog', 'scope', 'full_site_complete']);
          if (record.success !== true || record.scope !== 'employee-identity' || record.full_site_complete !== false) throw new Error(failure);
          const snapshot = validateIdentityCatalog(record.catalog);
          if (snapshot.package_id !== packageId || uuid(record.site_id) !== snapshot.site_id) throw new Error(failure);
          return { catalog: snapshot, jobId: uuid(record.job_id), jobToken: uuid(record.job_token) };
        }, signal);
        checkAbort(signal);
        catalog = result.catalog; job = { jobId: result.jobId, jobToken: result.jobToken };
        return validateIdentityCatalog(catalog);
      } finally { adminPassword = ''; attempted = true; }
    },
    source: {
      async catalog(signal) {
        checkAbort(signal); args();
        return validateIdentityCatalog(catalog);
      },
      async page(key, after, signal) {
        checkAbort(signal); identityTableKey(key);
        if (after !== null) uuid(after);
        const params = args();
        return response(() => {
          const query = supabase.rpc('get_employee_export_identity_page', { ...params, p_table_key: key, p_after: after, p_limit: 200 });
          return signal ? query.abortSignal(signal) : query;
        }, value => validateIdentityPage(value, key, after), signal);
      },
      async verify(signal) {
        verified = false;
        const params = args();
        const result = await response(() => {
          const query = supabase.rpc('employee_export_identity_verify', params);
          return signal ? query.abortSignal(signal) : query;
        }, validateIdentityVerification, signal);
        checkAbort(signal); verified = true;
        return result;
      },
    },
    async close(signal) {
      checkAbort(signal);
      const params = args();
      if (!verified) throw new Error('Employee identity export must be explicitly verified before close.');
      return response(() => {
        const query = supabase.rpc('employee_export_identity_close', params);
        return signal ? query.abortSignal(signal) : query;
      }, validateIdentityClose, signal);
    },
  };
}

export interface IdentityImportSession {
  target: IdentityImportTarget;
  plan(signal?: AbortSignal): Promise<IdentityPlan>;
  begin(planHash: string, signal?: AbortSignal): Promise<IdentityReceipt>;
  chunk(key: IdentityTableKey, chunkNo: number, signal?: AbortSignal): Promise<IdentityReceipt>;
  verify(signal?: AbortSignal): Promise<IdentityReceipt>;
}
// This token MUST belong to an already authenticated dispatch-import task. No new task/password here.
// Server checks dispatch ownership, same site/package, sealed backup, restored configuration and dirty maintenance.
export function createIdentityImportSession(dispatchJobToken: string): IdentityImportSession {
  const auth = getAdminFinancialSessionToken();
  uuid(auth); uuid(dispatchJobToken);
  const args = () => ({ p_admin_session_token: auth, p_job_token: dispatchJobToken });
  let catalog: IdentityCatalog | null = null, savedPlan: IdentityPlan | null = null;
  let begun = false, busy = false;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('An employee identity request is already in progress.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  const bound = () => {
    if (!catalog) throw new Error('Employee identity bind has not been confirmed.');
    return catalog;
  };
  const matchedReceipt = (value: unknown): IdentityReceipt => {
    const receipt = validateIdentityReceipt(value);
    if (bound().tables.some(table => receipt.totals[table.key] !== table.rows)) throw new Error(failure);
    return receipt;
  };
  const plan = (signal?: AbortSignal) => exclusive(async () => {
    const expected = bound(); savedPlan = null;
    const result = await response(() => {
      const query = supabase.rpc('get_employee_import_identity_plan', args());
      return signal ? query.abortSignal(signal) : query;
    }, value => {
      const checked = validateIdentityPlan(value);
      if (expected.tables.some(table => checked.counts[table.key] !== table.rows)) throw new Error(failure);
      return checked;
    }, signal);
    checkAbort(signal);
    // Private snapshot: returned objects (including nested counts/conflicts) cannot rewrite authorization.
    savedPlan = validateIdentityPlan(result);
    return result;
  }, signal);
  return {
    target: {
      bind(input, signal) {
        return exclusive(async () => {
          savedPlan = null; begun = false;
          const snapshot = validateIdentityCatalog(input);
          if (catalog && JSON.stringify(snapshot) !== JSON.stringify(catalog)) throw new Error('The identity catalog binding is immutable.');
          const result = await response(() => {
            const query = supabase.rpc('employee_import_identity_bind', { ...args(), p_catalog: { ...validateIdentityCatalog(snapshot) } });
            return signal ? query.abortSignal(signal) : query;
          }, validateIdentityBind, signal);
          checkAbort(signal); catalog = snapshot;
          return result;
        }, signal);
      },
      stage(key, chunkNo, ndjson, signal) {
        return exclusive(async () => {
          bound(); identityTableKey(key); count(chunkNo, IDENTITY_TRANSFER_LIMITS.maxChunks - 1);
          if (begun) throw new Error('Employee identity restore has begun; new staging is not allowed.');
          savedPlan = null;
          // Validate without ever serializing parsed numeric values back into the outgoing request.
          if (typeof ndjson !== 'string' || ndjson.length > IDENTITY_TRANSFER_LIMITS.maxPageBytes
            || (ndjson === '' && (chunkNo !== 0 || bound().tables.find(table => table.key === key)?.rows !== 0))) throw new Error(failure);
          const raw = new TextEncoder().encode(ndjson), digest = new Sha256().update(raw).digestHex();
          const rows = ndjson === '' ? 0 : ndjson.split('\n').length - 1;
          validateIdentityPage({ table_key: key, count: rows, ndjson, next_after: null, sha256: digest }, key, null);
          return response(() => {
            const query = supabase.rpc('employee_import_identity_stage', { ...args(), p_table_key: key, p_chunk_no: chunkNo, p_ndjson: ndjson });
            return signal ? query.abortSignal(signal) : query;
          }, value => validateIdentityStage(value, rows, raw.length, digest), signal);
        }, signal);
      },
      plan,
    },
    plan,
    begin(planHash, signal) {
      return exclusive(async () => {
        hash(planHash);
        if (!savedPlan?.can_restore || savedPlan.plan_hash !== planHash) {
          throw new Error('A matching conflict-free employee identity plan must be explicitly obtained first.');
        }
        const result = await response(() => {
          const query = supabase.rpc('employee_import_identity_begin', { ...args(), p_plan_hash: planHash });
          return signal ? query.abortSignal(signal) : query;
        }, matchedReceipt, signal);
        checkAbort(signal); begun = true;
        return result;
      }, signal);
    },
    chunk(key, chunkNo, signal) {
      return exclusive(async () => {
        identityTableKey(key); count(chunkNo, IDENTITY_TRANSFER_LIMITS.maxChunks - 1);
        if (!begun) throw new Error('Employee identity restore begin has not been confirmed.');
        return response(() => {
          const query = supabase.rpc('employee_import_identity_chunk', { ...args(), p_table_key: key, p_chunk_no: chunkNo });
          return signal ? query.abortSignal(signal) : query;
        }, value => {
          const receipt = matchedReceipt(value);
          if (receipt.next_chunks[key] < chunkNo + 1) throw new Error(failure);
          return receipt;
        }, signal);
      }, signal);
    },
    verify(signal) {
      return exclusive(async () => {
        if (!begun) throw new Error('Employee identity restore begin has not been confirmed.');
        return response(() => {
          const query = supabase.rpc('employee_import_identity_verify', args());
          return signal ? query.abortSignal(signal) : query;
        }, value => {
          const receipt = matchedReceipt(value);
          if (!receipt.verified) throw new Error(failure);
          return receipt;
        }, signal);
      }, signal);
    },
  };
}
