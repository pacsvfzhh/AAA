import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';

const { object, count, withSignal, checkAbort } = dispatchTransferChecks;
const failure = 'Mapped employee identity request is unconfirmed. Reconcile the original task with an explicit status request before further action. No automatic retry, account enablement, archive, replacement or maintenance release was performed.';
const TASK_KEYS = ['job_id', 'site_id', 'source_site_id', 'package_id'] as const;
const BINDING_KEYS = [...TASK_KEYS, 'source_id', 'target_id', 'source_fingerprint', 'binding_hash', 'plan_hash'] as const;
const COMMON_KEYS = [...BINDING_KEYS, 'scope', 'maintenance', 'dependencies_pending', 'can_restore',
  'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete'] as const;
const PLAN_KEYS = [...COMMON_KEYS, 'can_begin', 'conflicts', 'totals', 'order_chunks'] as const;
const STATUS_KEYS = [...COMMON_KEYS, 'counts', 'totals', 'next_chunk', 'order_chunks', 'verified'] as const;
const CONFLICTS = Object.freeze([
  'reservation_drift', 'candidate_occupied', 'source_uuid_occupied', 'username_requires_archive',
  'employee_number_conflict', 'administrator_username_conflict', 'archive_history_requires_backup',
  'unmapped_administrator', 'order_id_conflict', 'placeholder_product_active',
] as const);
export type EmployeeMappedIdentityConflict = typeof CONFLICTS[number];
interface TaskIdentity {
  readonly job_id: string; readonly site_id: string; readonly source_site_id: string; readonly package_id: string;
}
interface Common extends TaskIdentity {
  readonly scope: 'employee-mapped-identity'; readonly source_id: string; readonly target_id: string;
  readonly source_fingerprint: string; readonly binding_hash: string; readonly plan_hash: string;
  readonly maintenance: true; readonly dependencies_pending: true; readonly can_restore: false;
  readonly complete_employee_backup: false; readonly can_archive: false; readonly can_replace: false; readonly full_site_complete: false;
}
export interface EmployeeMappedIdentityCounts {
  readonly accounts: 1; readonly credentials: 0 | 1; readonly orders: number;
}
export interface EmployeeMappedIdentityPlan extends Common {
  readonly can_begin: boolean; readonly conflicts: readonly EmployeeMappedIdentityConflict[];
  readonly totals: EmployeeMappedIdentityCounts; readonly order_chunks: number;
}
/** The exact plan shape, copied and deeply frozen; no additional server authorization fields. */
export type EmployeeMappedIdentityCheckpoint = EmployeeMappedIdentityPlan;
export interface EmployeeMappedIdentityStatus extends Common {
  readonly counts: EmployeeMappedIdentityCounts; readonly totals: EmployeeMappedIdentityCounts;
  readonly next_chunk: number; readonly order_chunks: number; readonly verified: boolean;
}

function invalid(): never { throw new Error(failure); }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36) invalid();
  return dispatchTransferChecks.uuid(value);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64) invalid();
  return dispatchTransferChecks.hash(value);
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function chunks(value: unknown): number {
  const result = count(value, 2147483647);
  if (!result) invalid();
  return result;
}
function common(r: Record<string, unknown>): Common {
  if (r.scope !== 'employee-mapped-identity' || r.maintenance !== true || r.dependencies_pending !== true
    || r.can_restore !== false || r.complete_employee_backup !== false || r.can_archive !== false
    || r.can_replace !== false || r.full_site_complete !== false) invalid();
  const task = { job_id: uuid(r.job_id), site_id: uuid(r.site_id), source_site_id: uuid(r.source_site_id), package_id: uuid(r.package_id) };
  const source = uuid(r.source_id), target = uuid(r.target_id);
  if ([source, ...TASK_KEYS.map(key => task[key])].includes(target)) invalid();
  return { scope: 'employee-mapped-identity', ...task, source_id: source, target_id: target,
    source_fingerprint: hash(r.source_fingerprint), binding_hash: hash(r.binding_hash), plan_hash: hash(r.plan_hash),
    maintenance: true, dependencies_pending: true, can_restore: false, complete_employee_backup: false,
    can_archive: false, can_replace: false, full_site_complete: false };
}
function counts(input: unknown): EmployeeMappedIdentityCounts {
  const r = object(input, ['accounts', 'credentials', 'orders']);
  if (r.accounts !== 1 || (r.credentials !== 0 && r.credentials !== 1)) invalid();
  return Object.freeze({ accounts: 1, credentials: r.credentials, orders: count(r.orders) });
}
function conflicts(input: unknown): readonly EmployeeMappedIdentityConflict[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > CONFLICTS.length
    || Reflect.ownKeys(input).length !== input.length + 1) invalid();
  const result: EmployeeMappedIdentityConflict[] = [];
  for (let index = 0; index < input.length; index++) {
    const field = Object.getOwnPropertyDescriptor(input, String(index));
    if (!field?.enumerable || !('value' in field) || !CONFLICTS.includes(field.value) || result.includes(field.value)) invalid();
    result.push(field.value);
  }
  return Object.freeze(result);
}
function plan(input: unknown): EmployeeMappedIdentityPlan {
  const r = object(input, PLAN_KEYS), binding = common(r), blockers = conflicts(r.conflicts);
  const canBegin = boolean(r.can_begin);
  if (canBegin !== (blockers.length === 0)) invalid();
  return Object.freeze({ ...binding, can_begin: canBegin, conflicts: blockers, totals: counts(r.totals), order_chunks: chunks(r.order_chunks) });
}
function status(input: unknown): EmployeeMappedIdentityStatus {
  const r = object(input, STATUS_KEYS), binding = common(r), actual = counts(r.counts), totals = counts(r.totals);
  const orderChunks = chunks(r.order_chunks), next = count(r.next_chunk, orderChunks), verified = boolean(r.verified);
  if (actual.credentials !== totals.credentials || actual.orders > totals.orders
    || (next === 0 && actual.orders !== 0) || (next === orderChunks && actual.orders !== totals.orders)
    || (verified && (next !== orderChunks || actual.orders !== totals.orders))) invalid();
  return Object.freeze({ ...binding, counts: actual, totals, next_chunk: next, order_chunks: orderChunks, verified });
}
export function validateEmployeeMappedIdentityPlan(input: unknown): EmployeeMappedIdentityPlan {
  try { return plan(input); } catch { invalid(); }
}
export function validateEmployeeMappedIdentityStatus(input: unknown): EmployeeMappedIdentityStatus {
  try { return status(input); } catch { invalid(); }
}
export function employeeMappedIdentityCheckpoint(input: EmployeeMappedIdentityPlan): EmployeeMappedIdentityCheckpoint {
  try {
    const result = plan(input);
    if (!result.can_begin) invalid();
    return result;
  } catch { invalid(); }
}
function sameTask(a: TaskIdentity, b: TaskIdentity): boolean { return TASK_KEYS.every(key => a[key] === b[key]); }
function sameBinding(a: Common, b: Common): boolean { return BINDING_KEYS.every(key => a[key] === b[key]); }
function sameTotals(a: EmployeeMappedIdentityCounts, b: EmployeeMappedIdentityCounts): boolean {
  return a.accounts === b.accounts && a.credentials === b.credentials && a.orders === b.orders;
}
function samePlan(a: EmployeeMappedIdentityPlan | EmployeeMappedIdentityStatus, b: EmployeeMappedIdentityPlan | EmployeeMappedIdentityStatus): boolean {
  return sameBinding(a, b) && sameTotals(a.totals, b.totals) && a.order_chunks === b.order_chunks;
}

type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
interface SourceState {
  binding: EmployeeMappedIdentityPlan | EmployeeMappedIdentityStatus;
  progress?: EmployeeMappedIdentityStatus;
  uncertain: boolean;
}
export interface EmployeeMappedIdentitySession {
  plan(sourceId: string, signal?: AbortSignal): Promise<EmployeeMappedIdentityPlan>;
  core(plan: EmployeeMappedIdentityPlan | EmployeeMappedIdentityCheckpoint, signal?: AbortSignal): Promise<EmployeeMappedIdentityStatus>;
  orders(sourceId: string, chunkNo: number, signal?: AbortSignal): Promise<EmployeeMappedIdentityStatus>;
  verify(sourceId: string, signal?: AbortSignal): Promise<EmployeeMappedIdentityStatus>;
  status(sourceId: string, signal?: AbortSignal): Promise<EmployeeMappedIdentityStatus>;
}
/** Explicit SQL49 calls only. A successful core is a stopped identity, never full restore authorization. */
export function createEmployeeMappedIdentitySession(jobToken: string): EmployeeMappedIdentitySession {
  try { uuid(jobToken); } catch { invalid(); }
  let busy = false, task: TaskIdentity | undefined;
  const sources = new Map<string, SourceState>();
  const checkTask = (value: TaskIdentity) => { if (task && !sameTask(task, value)) invalid(); };
  const checkBinding = (value: EmployeeMappedIdentityPlan | EmployeeMappedIdentityStatus) => {
    checkTask(value);
    const saved = sources.get(value.source_id);
    if (saved && !samePlan(saved.binding, value)) invalid();
    for (const [source, state] of sources) {
      if (source !== value.source_id && state.binding.target_id === value.target_id) invalid();
    }
  };
  const progress = (source: string): EmployeeMappedIdentityStatus => {
    const saved = sources.get(source);
    if (!saved?.progress || saved.uncertain) invalid(); // Explicit status reconciles an unconfirmed write.
    return saved.progress;
  };
  const request = async <T extends EmployeeMappedIdentityPlan | EmployeeMappedIdentityStatus>(prepare: () => {
    operation: (auth: { p_admin_session_token: string; p_job_token: string }) => Query;
    validate: (value: unknown) => T;
    writingSource?: string;
  }, signal?: AbortSignal): Promise<T> => {
    if (busy) invalid(); // Reject overlap rather than queuing an implicit write.
    busy = true;
    let inFlight = false, finished = false;
    try {
      checkAbort(signal);
      // Synchronous, detached snapshots precede auth and all async transport work.
      const { operation, validate, writingSource } = prepare();
      const { data, error } = await withSignal(() => {
        checkAbort(signal);
        const auth = { p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: jobToken };
        checkAbort(signal);
        if (writingSource) {
          const saved = sources.get(writingSource);
          if (saved) saved.uncertain = true;
        }
        const raw = operation(auth), query = signal ? raw.abortSignal(signal) : raw;
        inFlight = true;
        // Cancellation is prompt, but a signal-ignoring transport still holds the serialization lock.
        return Promise.resolve(query).finally(() => { inFlight = false; if (finished) busy = false; });
      }, signal);
      checkAbort(signal);
      if (error) invalid();
      const result = validate(data);
      checkBinding(result);
      const previous = sources.get(result.source_id), prior = previous?.progress;
      const isStatus = 'verified' in result;
      if (isStatus && prior && (result.next_chunk < prior.next_chunk || result.counts.orders < prior.counts.orders
        || (prior.verified && !result.verified))) invalid();
      checkAbort(signal);
      task = Object.freeze({ job_id: result.job_id, site_id: result.site_id, source_site_id: result.source_site_id, package_id: result.package_id });
      sources.set(result.source_id, { binding: result, progress: isStatus ? result : prior,
        uncertain: isStatus ? false : previous?.uncertain ?? false });
      return result;
    } catch {
      if (signal?.aborted) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { finished = true; if (!inFlight) busy = false; }
  };
  const checkedStatus = (value: unknown, source: string, baseline?: EmployeeMappedIdentityPlan | EmployeeMappedIdentityStatus) => {
    const result = status(value);
    if (result.source_id !== source || (baseline && !samePlan(result, baseline))) invalid();
    return result;
  };
  return {
    plan(sourceId, signal) {
      return request(() => {
        const source = uuid(sourceId);
        return { operation: auth => supabase.rpc('employee_import_mapped_identity_plan', { ...auth, p_source_id: source }),
          validate: value => {
            const result = plan(value);
            if (result.source_id !== source) invalid();
            return result;
          } };
      }, signal);
    },
    core(input, signal) {
      return request(() => {
        const baseline = employeeMappedIdentityCheckpoint(input);
        checkBinding(baseline);
        return { writingSource: baseline.source_id,
          operation: auth => supabase.rpc('employee_import_mapped_identity_core', { ...auth, p_source_id: baseline.source_id, p_plan_hash: baseline.plan_hash }),
          validate: value => checkedStatus(value, baseline.source_id, baseline) };
      }, signal);
    },
    orders(sourceId, chunkNo, signal) {
      return request(() => {
        const source = uuid(sourceId), chunk = count(chunkNo, 2147483647), baseline = progress(source);
        if (baseline.verified || chunk !== baseline.next_chunk || chunk >= baseline.order_chunks) invalid();
        return { writingSource: source,
          operation: auth => supabase.rpc('employee_import_mapped_identity_orders', { ...auth, p_source_id: source, p_chunk_no: chunk }),
          validate: value => {
            const result = checkedStatus(value, source, baseline);
            // Chunks scan the global orders staging, so this employee may gain zero rows.
            if (result.next_chunk !== chunk + 1 || result.counts.orders < baseline.counts.orders || result.verified) invalid();
            return result;
          } };
      }, signal);
    },
    verify(sourceId, signal) {
      return request(() => {
        const source = uuid(sourceId), baseline = progress(source);
        if (baseline.next_chunk !== baseline.order_chunks || !sameTotals(baseline.counts, baseline.totals)) invalid();
        return { writingSource: source,
          operation: auth => supabase.rpc('employee_import_mapped_identity_verify', { ...auth, p_source_id: source }),
          validate: value => {
            const result = checkedStatus(value, source, baseline);
            if (!result.verified) invalid();
            return result;
          } };
      }, signal);
    },
    status(sourceId, signal) {
      return request(() => {
        const source = uuid(sourceId);
        return { operation: auth => supabase.rpc('employee_import_mapped_identity_status', { ...auth, p_source_id: source }),
          validate: value => checkedStatus(value, source) };
      }, signal);
    },
  };
}
