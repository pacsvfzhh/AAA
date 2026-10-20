import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import {
  ARCHIVES_TABLE_KEYS, ARCHIVES_TRANSFER_LIMITS, archivesCursor, archivesTableKey,
  validateArchivesBind, validateArchivesCatalog, validateArchivesClose, validateArchivesPage,
  validateArchivesPlan, validateArchivesStage, validateArchivesStatus, validateArchivesVerification,
  type ArchivesCatalog, type ArchivesExportSource, type ArchivesImportTarget, type ArchivesPlan,
  type ArchivesStatus, type ArchivesTableKey,
} from './archiveTransfer';

const { object, count, withSignal } = dispatchTransferChecks;
const failure = 'Archives request outcome is unknown or unconfirmed; server staging or committed records may exist. Read server status and reconcile before explicitly resuming. Cancellation does not prove rollback. No automatic write retry, cancel, private-table insertion, activation, maintenance release or close was performed. Records verification does not prove media transfer or full-site completion.';
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
function hash(value: unknown): string {
  const result = dispatchTransferChecks.hash(value);
  if (result.length !== 64) invalid();
  return result;
}
// These RPCs are being coordinated separately from database.ts. This single local transport
// boundary enumerates ONLY this protocol's names and exact arguments; no generic RPC/table API.
type JobArgs = { p_admin_session_token: string; p_job_token: string };
type ArchivesRpcArgs = {
  employee_export_archives_begin: { p_admin_session_token: string; p_admin_password: string; p_package_id: string };
  get_employee_export_archives_page: JobArgs & { p_table_key: ArchivesTableKey; p_after: string | null; p_limit: number };
  employee_export_archives_verify: JobArgs;
  employee_export_archives_close: JobArgs;
  employee_import_archives_bind: JobArgs & { p_catalog: ArchivesCatalog };
  employee_import_archives_stage: JobArgs & { p_table_key: ArchivesTableKey; p_chunk_no: number; p_ndjson: string };
  get_employee_import_archives_plan: JobArgs;
  employee_import_archives_begin: JobArgs & { p_plan_hash: string };
  employee_import_archives_chunk: JobArgs & { p_table_key: ArchivesTableKey; p_chunk_no: number };
  employee_import_archives_verify: JobArgs;
  get_employee_import_archives_status: JobArgs;
};
type ArchivesQuery = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): ArchivesQuery };
const rpc = supabase.rpc.bind(supabase) as unknown as <Name extends keyof ArchivesRpcArgs>(name: Name, args: ArchivesRpcArgs[Name]) => ArchivesQuery;
function jobArgs(jobToken: string): JobArgs {
  // Read anew for every request: a reauthenticated original owner can resume the same job.
  return { p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: jobToken };
}
async function response<T>(operation: () => ArchivesQuery, validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  try {
    const { data, error } = await withSignal(() => {
      const query = operation();
      return signal ? query.abortSignal(signal) : query;
    }, signal);
    checkAbort(signal);
    if (error) invalid();
    const result = validate(data);
    checkAbort(signal);
    return result;
  } catch {
    if (cancelled(signal)) throw new DOMException(failure, 'AbortError');
    throw new Error(failure);
  }
}
function sameCounts(status: ArchivesStatus, catalog: ArchivesCatalog): void {
  if (catalog.tables.some(table => status.counts[table.key] !== table.rows)) invalid();
}
export interface ArchivesExportSession {
  identity(): { jobId: string; jobToken: string } | null;
  begin(signal?: AbortSignal): Promise<ArchivesCatalog>;
  source: ArchivesExportSource;
  close(signal?: AbortSignal): Promise<ReturnType<typeof validateArchivesClose>>;
}
export function createArchivesExportSession(packageId: string, adminPassword: string): ArchivesExportSession {
  try { uuid(packageId); if (typeof adminPassword !== 'string') invalid(); } catch { invalid(); }
  let attempted = false, verified = false, busy = false, closed = false;
  let job: { jobId: string; jobToken: string } | null = null;
  let catalog: ArchivesCatalog | null = null;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (busy) throw new Error('An archives request is already in progress.');
    busy = true;
    try { checkAbort(signal); return await operation(); }
    catch {
      if (cancelled(signal)) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { busy = false; }
  };
  const args = () => {
    if (!job || closed) invalid();
    return jobArgs(job.jobToken);
  };
  return {
    identity: () => job && { ...job },
    async begin(signal) {
      if (attempted) throw new Error('Archives export begin cannot be retried automatically; reconcile first.');
      attempted = true;
      try {
        return await exclusive(async () => {
          const result = await response(() => {
            const password = adminPassword; adminPassword = '';
            return rpc('employee_export_archives_begin', {
              p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_admin_password: password, p_package_id: packageId,
            });
          }, value => {
            const record = object(value, ['success', 'job_id', 'job_token', 'site_id', 'catalog', 'scope', 'media_pending', 'full_site_complete']);
            if (record.success !== true || record.scope !== 'site-archives' || record.media_pending !== true || record.full_site_complete !== false) invalid();
            const snapshot = validateArchivesCatalog(record.catalog);
            if (snapshot.package_id !== packageId || uuid(record.site_id) !== snapshot.site_id) invalid();
            return { catalog: snapshot, jobId: uuid(record.job_id), jobToken: uuid(record.job_token) };
          }, signal);
          checkAbort(signal);
          catalog = result.catalog; job = { jobId: result.jobId, jobToken: result.jobToken };
          return validateArchivesCatalog(catalog);
        }, signal);
      } finally { adminPassword = ''; }
    },
    source: {
      catalog(signal) {
        return exclusive(async () => {
          if (!job || closed) invalid();
          return validateArchivesCatalog(catalog);
        }, signal);
      },
      page(key, after, signal) {
        return exclusive(async () => {
          archivesTableKey(key);
          if (after !== null) archivesCursor(key, after);
          verified = false;
          return response(() => rpc('get_employee_export_archives_page', {
            ...args(), p_table_key: key, p_after: after, p_limit: ARCHIVES_TRANSFER_LIMITS.maxPageRows,
          }), value => validateArchivesPage(value, key, after), signal);
        }, signal);
      },
      verify(signal) {
        return exclusive(async () => {
          verified = false;
          const result = await response(() => rpc('employee_export_archives_verify', args()), validateArchivesVerification, signal);
          checkAbort(signal); verified = true;
          return result;
        }, signal);
      },
    },
    close(signal) {
      return exclusive(async () => {
        if (!verified) invalid();
        // An unconfirmed close must not retain a stale verified permission.
        verified = false;
        const result = await response(() => rpc('employee_export_archives_close', args()), validateArchivesClose, signal);
        checkAbort(signal); closed = true;
        return result;
      }, signal);
    },
  };
}
export interface ArchivesImportSession {
  target: ArchivesImportTarget;
  plan(signal?: AbortSignal): Promise<ArchivesPlan>;
  status(signal?: AbortSignal): Promise<ArchivesStatus>;
}
export function createArchivesImportSession(dispatchJobToken: string): ArchivesImportSession {
  try { uuid(dispatchJobToken); } catch { invalid(); }
  let catalog: ArchivesCatalog | null = null, requested: ArchivesCatalog | null = null;
  let busy = false, requiresStatus = false;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (busy) throw new Error('An archives request is already in progress.');
    busy = true;
    try { checkAbort(signal); return await operation(); }
    catch {
      if (cancelled(signal)) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { busy = false; }
  };
  const bound = () => { if (!catalog || requiresStatus) invalid(); return catalog; };
  const plan = (signal?: AbortSignal) => exclusive(async () => {
    const expected = bound();
    return response(() => rpc('get_employee_import_archives_plan', jobArgs(dispatchJobToken)), value => {
      const checked = validateArchivesPlan(value);
      if (expected.tables.some(table => checked.counts[table.key] !== table.rows)) invalid();
      return checked;
    }, signal);
  }, signal);
  return {
    target: {
      bind(input, signal) {
        return exclusive(async () => {
          if (requiresStatus) invalid();
          const snapshot = validateArchivesCatalog(input);
          if (requested && JSON.stringify(snapshot) !== JSON.stringify(requested)) invalid();
          const result = await response(() => {
            const args = jobArgs(dispatchJobToken);
            // Set BEFORE dispatch: lost/malformed receipts must pass explicit status first.
            requested = snapshot; requiresStatus = true;
            return rpc('employee_import_archives_bind', { ...args, p_catalog: validateArchivesCatalog(snapshot) });
          }, validateArchivesBind, signal);
          checkAbort(signal); catalog = snapshot; requiresStatus = false;
          return result;
        }, signal);
      },
      stage(key, chunkNo, ndjson, signal) {
        return exclusive(async () => {
          const expected = bound(); archivesTableKey(key); count(chunkNo, ARCHIVES_TRANSFER_LIMITS.maxChunks - 1);
          const table = expected.tables.find(table => table.key === key)!;
          if (typeof ndjson !== 'string' || ndjson.length > ARCHIVES_TRANSFER_LIMITS.maxPageBytes
            || (ndjson === '' && (chunkNo !== 0 || table.rows !== 0))) invalid();
          const raw = new TextEncoder().encode(ndjson), digest = new Sha256().update(raw).digestHex();
          const rows = ndjson === '' ? 0 : ndjson.split('\n').length - 1;
          validateArchivesPage({ table_key: key, count: rows, ndjson, next_after: null, sha256: digest }, key, null);
          if (rows > table.rows || raw.length > table.bytes) invalid();
          const result = await response(() => {
            const args = jobArgs(dispatchJobToken); requiresStatus = true;
            return rpc('employee_import_archives_stage', { ...args, p_table_key: key, p_chunk_no: chunkNo, p_ndjson: ndjson });
          }, value => validateArchivesStage(value, rows, raw.length, digest), signal);
          checkAbort(signal); requiresStatus = false;
          return result;
        }, signal);
      },
      plan,
    },
    plan,
    status: signal => exclusive(async () => {
      const result = await response(() => rpc('get_employee_import_archives_status', jobArgs(dispatchJobToken)), value => {
        const status = validateArchivesStatus(value);
        if (requested) sameCounts(status, requested);
        return status;
      }, signal);
      checkAbort(signal); requiresStatus = false;
      return result;
    }, signal),
  };
}
export interface ArchivesRestoreSession {
  begin(planHash: string, signal?: AbortSignal): Promise<ArchivesStatus>;
  chunk(key: ArchivesTableKey, chunkNo: number, signal?: AbortSignal): Promise<ArchivesStatus>;
  verify(signal?: AbortSignal): Promise<ArchivesStatus>;
  status(signal?: AbortSignal): Promise<ArchivesStatus>;
}
export function createArchivesRestoreSession(dispatchJobToken: string, input: ArchivesCatalog): ArchivesRestoreSession {
  const setup = (() => {
    try { return { token: uuid(dispatchJobToken), catalog: validateArchivesCatalog(input) }; } catch { invalid(); }
  })();
  let busy = false, requiresStatus = false, beginAttempted = false;
  let confirmed: ArchivesStatus | null = null;
  let boundPlanHash: string | null = null;
  type Operation = 'begin' | 'chunk' | 'verify' | 'status';
  function validate(value: unknown, operation: Operation, key?: ArchivesTableKey, chunkNo?: number): ArchivesStatus {
    const status = validateArchivesStatus(value);
    sameCounts(status, setup.catalog);
    if (confirmed) {
      if ((confirmed.started && !status.started) || (confirmed.records_verified && !status.records_verified)) invalid();
      for (const table of ARCHIVES_TABLE_KEYS) {
        if (status.completed_chunks[table] < confirmed.completed_chunks[table]
          || (confirmed.started && status.chunks[table] !== confirmed.chunks[table])) invalid();
      }
    }
    if (operation !== 'status' && !status.started) invalid();
    if (operation === 'verify' && !status.records_verified) invalid();
    if (operation === 'chunk') {
      if (!confirmed?.started || key === undefined || chunkNo === undefined || status.completed_chunks[key] <= chunkNo) invalid();
      for (const table of ARCHIVES_TABLE_KEYS) {
        const expected = table === key && chunkNo === confirmed.completed_chunks[key]
          ? confirmed.completed_chunks[table] + 1 : confirmed.completed_chunks[table];
        if (status.completed_chunks[table] !== expected) invalid();
      }
      // Only explicit verify can establish record verification on this client.
      if (status.records_verified !== confirmed.records_verified) invalid();
    }
    return status;
  }
  async function request(operation: Operation, signal?: AbortSignal, planHash?: string, key?: ArchivesTableKey, chunkNo?: number): Promise<ArchivesStatus> {
    if (busy) throw new Error('An archives restore request is already in progress.');
    busy = true;
    let dispatched = false;
    try {
      checkAbort(signal);
      if (operation !== 'status' && requiresStatus) invalid();
      if (operation === 'begin') {
        hash(planHash);
        if (beginAttempted || confirmed?.started || (boundPlanHash !== null && boundPlanHash !== planHash)) invalid();
      }
      if (operation === 'chunk') {
        archivesTableKey(key); count(chunkNo, ARCHIVES_TRANSFER_LIMITS.maxChunks - 1);
        if (!confirmed?.started || chunkNo! >= confirmed.chunks[key!] || chunkNo! > confirmed.completed_chunks[key!]) invalid();
      }
      if (operation === 'verify' && (!confirmed?.started
        || ARCHIVES_TABLE_KEYS.some(table => confirmed!.completed_chunks[table] !== confirmed!.chunks[table]))) invalid();
      const args = jobArgs(setup.token);
      const status = await response(() => {
        dispatched = true;
        if (operation === 'begin') {
          beginAttempted = true; boundPlanHash = planHash!;
          return rpc('employee_import_archives_begin', { ...args, p_plan_hash: planHash! });
        }
        if (operation === 'chunk') return rpc('employee_import_archives_chunk', { ...args, p_table_key: key!, p_chunk_no: chunkNo! });
        if (operation === 'verify') return rpc('employee_import_archives_verify', args);
        return rpc('get_employee_import_archives_status', args);
      }, value => validate(value, operation, key, chunkNo), signal);
      checkAbort(signal); confirmed = status; requiresStatus = false;
      return status;
    } catch {
      // Unknown writes, failed reconciliation and cancellations block ALL writes until status.
      let aborted = false;
      try { aborted = cancelled(signal); } catch { /* Do not expose a signal getter. */ }
      requiresStatus = requiresStatus || dispatched || aborted;
      if (aborted) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { busy = false; }
  }
  // No driver loop, automatic status, retry, ID remapping, media copy or private table writes.
  return {
    begin: (planHash, signal) => request('begin', signal, planHash),
    chunk: (key, chunkNo, signal) => request('chunk', signal, undefined, key, chunkNo),
    verify: signal => request('verify', signal),
    status: signal => request('status', signal),
  };
}
