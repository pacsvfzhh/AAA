import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { DISPATCH_TRANSFER_LIMITS, dispatchTransferChecks } from './dispatchTransfer';

const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const failure = 'Mapped employee dependency request is unconfirmed. Reconcile the original task with an explicit status request before further action. No automatic retry, account enablement, archive, replacement or maintenance release was performed.';
const TABLE_KEYS = ['dispatch_group_members', 'used_order_data'] as const;
const BINDING_KEYS = ['job_id', 'site_id', 'source_site_id', 'package_id', 'plan_hash', 'mapping_hash'] as const;
const COMMON_KEYS = [...BINDING_KEYS, 'scope', 'totals', 'chunks', 'maintenance', 'dependencies_pending',
  'can_restore', 'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete'] as const;
const PLAN_KEYS = [...COMMON_KEYS, 'can_begin', 'conflicts'] as const;
const STATUS_KEYS = [...COMMON_KEYS, 'started', 'counts', 'next_chunks', 'verified'] as const;
const CONFLICTS = Object.freeze(['target_members_not_empty', 'target_used_not_empty', 'unmapped_assigner'] as const);
export type EmployeeMappedDependencyTableKey = typeof TABLE_KEYS[number];
export type EmployeeMappedDependencyConflict = typeof CONFLICTS[number];
export interface EmployeeMappedDependencyCounts {
  readonly dispatch_group_members: number; readonly used_order_data: number;
}
interface Common {
  readonly scope: 'employee-mapped-dependencies';
  readonly job_id: string; readonly site_id: string; readonly source_site_id: string; readonly package_id: string;
  readonly plan_hash: string; readonly mapping_hash: string;
  readonly totals: EmployeeMappedDependencyCounts; readonly chunks: EmployeeMappedDependencyCounts;
  readonly maintenance: true; readonly dependencies_pending: true; readonly can_restore: false;
  readonly complete_employee_backup: false; readonly can_archive: false; readonly can_replace: false; readonly full_site_complete: false;
}
export interface EmployeeMappedDependencyPlan extends Common {
  readonly can_begin: boolean; readonly conflicts: readonly EmployeeMappedDependencyConflict[];
}
export interface EmployeeMappedDependencyStatus extends Common {
  readonly started: boolean; readonly counts: EmployeeMappedDependencyCounts;
  readonly next_chunks: EmployeeMappedDependencyCounts; readonly verified: boolean;
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
function counts(value: unknown): EmployeeMappedDependencyCounts {
  const r = object(value, TABLE_KEYS);
  return Object.freeze({ dispatch_group_members: count(r.dispatch_group_members, DISPATCH_TRANSFER_LIMITS.maxRows),
    used_order_data: count(r.used_order_data, DISPATCH_TRANSFER_LIMITS.maxRows) });
}
function sameCounts(a: EmployeeMappedDependencyCounts, b: EmployeeMappedDependencyCounts): boolean {
  return TABLE_KEYS.every(key => a[key] === b[key]);
}
function common(r: Record<string, unknown>): Common {
  if (r.scope !== 'employee-mapped-dependencies' || r.maintenance !== true || r.dependencies_pending !== true
    || r.can_restore !== false || r.complete_employee_backup !== false || r.can_archive !== false
    || r.can_replace !== false || r.full_site_complete !== false) invalid();
  const totals = counts(r.totals), chunks = counts(r.chunks);
  for (const key of TABLE_KEYS) {
    // SQL50 accepts one empty chunk only for an empty table; every other chunk has 1..200 rows.
    if (totals[key] === 0 ? chunks[key] !== 1
      : chunks[key] < Math.ceil(totals[key] / DISPATCH_TRANSFER_LIMITS.maxPageRows) || chunks[key] > totals[key]) invalid();
  }
  return { scope: 'employee-mapped-dependencies', job_id: uuid(r.job_id), site_id: uuid(r.site_id),
    source_site_id: uuid(r.source_site_id), package_id: uuid(r.package_id), plan_hash: hash(r.plan_hash),
    mapping_hash: hash(r.mapping_hash), totals, chunks, maintenance: true, dependencies_pending: true,
    can_restore: false, complete_employee_backup: false, can_archive: false, can_replace: false, full_site_complete: false };
}
function conflicts(value: unknown): readonly EmployeeMappedDependencyConflict[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > CONFLICTS.length
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const result: EmployeeMappedDependencyConflict[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field) || !CONFLICTS.includes(field.value) || result.includes(field.value)) invalid();
    result.push(field.value);
  }
  return Object.freeze(result);
}
function plan(value: unknown): EmployeeMappedDependencyPlan {
  const r = object(value, PLAN_KEYS), binding = common(r), blockers = conflicts(r.conflicts), canBegin = boolean(r.can_begin);
  if (canBegin !== (blockers.length === 0)) invalid();
  return Object.freeze({ ...binding, can_begin: canBegin, conflicts: blockers });
}
function status(value: unknown): EmployeeMappedDependencyStatus {
  const r = object(value, STATUS_KEYS), binding = common(r), actual = counts(r.counts), next = counts(r.next_chunks);
  const started = boolean(r.started), verified = boolean(r.verified);
  for (const key of TABLE_KEYS) {
    const total = binding.totals[key], chunks = binding.chunks[key], cursor = next[key], rows = actual[key];
    const remaining = chunks - cursor, missing = total - rows;
    if (cursor > chunks || rows > total || (cursor === 0 && rows !== 0)
      || (cursor === chunks && rows !== total)
      || (total > 0 && (rows < cursor || rows > cursor * DISPATCH_TRANSFER_LIMITS.maxPageRows
        || missing < remaining || missing > remaining * DISPATCH_TRANSFER_LIMITS.maxPageRows))
      || (!started && (cursor !== 0 || rows !== 0))
      || (verified && (cursor !== chunks || rows !== total))) invalid();
  }
  if ((!started && verified) || (next.used_order_data > 0 && next.dispatch_group_members !== binding.chunks.dispatch_group_members)) invalid();
  return Object.freeze({ ...binding, started, counts: actual, next_chunks: next, verified });
}
export function validateEmployeeMappedDependencyPlan(value: unknown): EmployeeMappedDependencyPlan {
  try { return plan(value); } catch { invalid(); }
}
export function validateEmployeeMappedDependencyStatus(value: unknown): EmployeeMappedDependencyStatus {
  try { return status(value); } catch { invalid(); }
}
function samePlan(a: Common, b: Common): boolean {
  return BINDING_KEYS.every(key => a[key] === b[key]) && sameCounts(a.totals, b.totals) && sameCounts(a.chunks, b.chunks);
}
function checkProgress(prior: EmployeeMappedDependencyStatus, next: EmployeeMappedDependencyStatus): void {
  if ((prior.started && !next.started) || (prior.verified && !next.verified)) invalid();
  for (const key of TABLE_KEYS) {
    const chunks = next.next_chunks[key] - prior.next_chunks[key], rows = next.counts[key] - prior.counts[key];
    if (chunks < 0 || rows < 0 || (chunks === 0 && rows !== 0)
      || rows > chunks * DISPATCH_TRANSFER_LIMITS.maxPageRows || (next.totals[key] > 0 && rows < chunks)) invalid();
  }
}

type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
export interface EmployeeMappedDependencySession {
  plan(signal?: AbortSignal): Promise<EmployeeMappedDependencyPlan>;
  begin(plan: EmployeeMappedDependencyPlan, signal?: AbortSignal): Promise<EmployeeMappedDependencyStatus>;
  chunk(tableKey: EmployeeMappedDependencyTableKey, chunkNo: number, signal?: AbortSignal): Promise<EmployeeMappedDependencyStatus>;
  verify(signal?: AbortSignal): Promise<EmployeeMappedDependencyStatus>;
  status(signal?: AbortSignal): Promise<EmployeeMappedDependencyStatus>;
}
export function createEmployeeMappedDependencySession(jobToken: string): EmployeeMappedDependencySession {
  try { uuid(jobToken); } catch { invalid(); }
  let busy = false, uncertain = false;
  let binding: Common | undefined, progress: EmployeeMappedDependencyStatus | undefined;
  const checkBinding = (value: Common) => { if (binding && !samePlan(binding, value)) invalid(); };
  const confirmed = (): EmployeeMappedDependencyStatus => {
    if (uncertain || !progress?.started) invalid();
    return progress;
  };
  const request = async <T extends EmployeeMappedDependencyPlan | EmployeeMappedDependencyStatus>(prepare: () => {
    operation: (auth: { p_admin_session_token: string; p_job_token: string }) => Query;
    validate: (value: unknown) => T;
    writing?: Common;
  }, signal?: AbortSignal): Promise<T> => {
    if (busy) invalid();
    busy = true;
    let inFlight = false, finished = false;
    try {
      checkAbort(signal);
      // Snapshot caller-owned plans before auth callbacks or asynchronous transport work.
      const { operation, validate, writing } = prepare();
      const { data, error } = await withSignal(() => {
        checkAbort(signal);
        const auth = { p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: jobToken };
        checkAbort(signal);
        if (writing) {
          // Pin even the first begin before dispatch: a lost response must not adopt a different task/plan.
          binding ??= writing;
          uncertain = true;
        }
        const raw = operation(auth), query = signal ? raw.abortSignal(signal) : raw;
        inFlight = true;
        // Prompt cancellation never releases the mutex while a signal-ignoring request is still running.
        return Promise.resolve(query).finally(() => { inFlight = false; if (finished) busy = false; });
      }, signal);
      checkAbort(signal);
      if (error) invalid();
      const result = validate(data);
      checkBinding(result);
      if ('started' in result && progress) checkProgress(progress, result);
      if (!('started' in result) && progress?.started && !result.can_begin) invalid();
      checkAbort(signal);
      binding = result;
      if ('started' in result) { progress = result; uncertain = false; }
      // Plan reads do not establish progress or reconcile an unknown write.
      return result;
    } catch {
      if (signal?.aborted) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { finished = true; if (!inFlight) busy = false; }
  };
  return {
    plan(signal) {
      return request(() => ({ operation: auth => supabase.rpc('employee_import_mapped_dependency_plan', auth), validate: plan }), signal);
    },
    begin(input, signal) {
      return request(() => {
        if (uncertain) invalid();
        const baseline = plan(input);
        if (!baseline.can_begin) invalid();
        checkBinding(baseline);
        return { writing: baseline,
          operation: auth => supabase.rpc('employee_import_mapped_dependency_begin', { ...auth, p_plan_hash: baseline.plan_hash }),
          validate: value => {
            const result = status(value);
            if (!result.started || !samePlan(baseline, result)) invalid();
            return result;
          } };
      }, signal);
    },
    chunk(tableKey, chunkNo, signal) {
      return request(() => {
        if (!TABLE_KEYS.includes(tableKey)) invalid();
        const chunk = count(chunkNo, 2147483647), baseline = confirmed();
        if (baseline.verified || chunk !== baseline.next_chunks[tableKey] || chunk >= baseline.chunks[tableKey]
          || (tableKey === 'used_order_data' && baseline.next_chunks.dispatch_group_members !== baseline.chunks.dispatch_group_members)) invalid();
        return { writing: baseline,
          operation: auth => supabase.rpc('employee_import_mapped_dependency_chunk', { ...auth, p_table_key: tableKey, p_chunk_no: chunk }),
          validate: value => {
            const result = status(value), other = tableKey === 'dispatch_group_members' ? 'used_order_data' : 'dispatch_group_members';
            if (!result.started || result.verified || result.next_chunks[tableKey] !== chunk + 1
              || result.next_chunks[other] !== baseline.next_chunks[other] || result.counts[other] !== baseline.counts[other]) invalid();
            return result;
          } };
      }, signal);
    },
    verify(signal) {
      return request(() => {
        const baseline = confirmed();
        if (!sameCounts(baseline.counts, baseline.totals) || !sameCounts(baseline.next_chunks, baseline.chunks)) invalid();
        return { writing: baseline, operation: auth => supabase.rpc('employee_import_mapped_dependency_verify', auth),
          validate: value => {
            const result = status(value);
            if (!result.started || !result.verified) invalid();
            return result;
          } };
      }, signal);
    },
    status(signal) {
      return request(() => ({ operation: auth => supabase.rpc('employee_import_mapped_dependency_status', auth), validate: status }), signal);
    },
  };
}
