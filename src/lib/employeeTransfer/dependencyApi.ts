import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';

const { object, uuid, hash, count, checkAbort, withSignal } = dispatchTransferChecks;
const TABLE_KEYS = Object.freeze(['dispatch_group_members', 'used_order_data'] as const);
const REASONS = Object.freeze(['target_members_not_empty', 'target_used_not_empty', 'unmapped_assigner'] as const);
const FLAGS = ['maintenance', 'financial_data_pending', 'dependencies_pending', 'replacement_ready', 'full_site_complete'] as const;
const MAX_ROWS = 500000, MAX_CHUNKS = 500001;
const failure = 'Dispatch dependency request outcome is unknown or unconfirmed; reconcile the task before retrying. No automatic retry or rollback was performed.';

export type DispatchDependencyTableKey = typeof TABLE_KEYS[number];
export type DispatchDependencyCounts = Readonly<Record<DispatchDependencyTableKey, number>>;
export interface DispatchDependencyPending {
  readonly maintenance: true;
  readonly financial_data_pending: true;
  readonly dependencies_pending: true;
  readonly replacement_ready: false;
  readonly full_site_complete: false;
}
export interface DispatchDependencyPlan extends DispatchDependencyPending {
  readonly scope: 'dispatch-dependencies';
  readonly can_restore: boolean;
  readonly counts: DispatchDependencyCounts;
  readonly conflicts: readonly (typeof REASONS[number])[];
  readonly plan_hash: string;
}
export interface DispatchDependencyReceipt extends DispatchDependencyPending {
  readonly success: true;
  readonly scope: 'dispatch-dependencies';
  readonly counts: DispatchDependencyCounts;
  readonly next_chunks: DispatchDependencyCounts;
  readonly chunks: DispatchDependencyCounts;
  readonly totals: DispatchDependencyCounts;
  readonly verified: boolean;
  readonly repeated: boolean;
}
export interface DispatchDependencySession {
  plan(signal?: AbortSignal): Promise<DispatchDependencyPlan>;
  begin(planHash: string, signal?: AbortSignal): Promise<DispatchDependencyReceipt>;
  chunk(key: DispatchDependencyTableKey, chunkNo: number, signal?: AbortSignal): Promise<DispatchDependencyReceipt>;
  verify(signal?: AbortSignal): Promise<DispatchDependencyReceipt>;
}
function invalid(): never { throw new Error(failure); }
function tableKey(value: unknown): DispatchDependencyTableKey {
  const key = TABLE_KEYS.find(key => key === value);
  if (!key) invalid();
  return key;
}
function pending(record: Record<string, unknown>): DispatchDependencyPending {
  if (record.maintenance !== true || record.financial_data_pending !== true || record.dependencies_pending !== true
    || record.replacement_ready !== false || record.full_site_complete !== false) invalid();
  return { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
}
function counts(value: unknown, max = MAX_ROWS): DispatchDependencyCounts {
  const record = object(value, TABLE_KEYS);
  return Object.freeze({ dispatch_group_members: count(record.dispatch_group_members, max), used_order_data: count(record.used_order_data, max) });
}
function conflicts(value: unknown): DispatchDependencyPlan['conflicts'] {
  // Descriptor snapshots only: do not execute a backend accessor, iterator or proxy get trap.
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, 200), own = Reflect.ownKeys(value);
  if (own.length !== size + 1 || own.some(key => typeof key !== 'string'
    || (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= size)))) invalid();
  const result: (typeof REASONS[number])[] = [];
  for (let index = 0; index < size; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field)) invalid();
    const reason = REASONS.find(reason => reason === field.value);
    if (!reason) invalid();
    result.push(reason);
  }
  return Object.freeze(result);
}
function validatePlan(value: unknown): DispatchDependencyPlan {
  const record = object(value, ['scope', 'can_restore', 'counts', 'conflicts', 'plan_hash', ...FLAGS]);
  if (record.scope !== 'dispatch-dependencies' || typeof record.can_restore !== 'boolean') invalid();
  const reasons = conflicts(record.conflicts);
  if (record.can_restore !== (reasons.length === 0)) invalid();
  return Object.freeze({ scope: 'dispatch-dependencies', can_restore: record.can_restore, counts: counts(record.counts),
    conflicts: reasons, plan_hash: hash(record.plan_hash), ...pending(record) });
}
function validateReceipt(value: unknown): DispatchDependencyReceipt {
  const record = object(value, ['success', 'scope', 'counts', 'next_chunks', 'chunks', 'totals', 'verified', 'repeated', ...FLAGS]);
  if (record.success !== true || record.scope !== 'dispatch-dependencies'
    || typeof record.verified !== 'boolean' || typeof record.repeated !== 'boolean') invalid();
  const restored = counts(record.counts), totals = counts(record.totals);
  const next = counts(record.next_chunks, MAX_CHUNKS), chunks = counts(record.chunks, MAX_CHUNKS);
  for (const key of TABLE_KEYS) {
    if (chunks[key] < 1 || next[key] > chunks[key] || restored[key] > totals[key]
      || (next[key] === 0 && restored[key] !== 0)
      || (next[key] === chunks[key] && restored[key] !== totals[key])
      || (record.verified && (next[key] !== chunks[key] || restored[key] !== totals[key]))) invalid();
  }
  return Object.freeze({ success: true, scope: 'dispatch-dependencies', counts: restored, next_chunks: next, chunks, totals,
    verified: record.verified, repeated: record.repeated, ...pending(record) });
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
    // Local abort is not proof of server rollback. Never propagate backend diagnostics or abort reasons.
    if (signal?.aborted) throw new DOMException(failure, 'AbortError');
    throw new Error(failure);
  }
}

// The server owns same-package mappings and backup/maintenance checks; the client sends no rows.
export function createDispatchDependencySession(dispatchJobToken: string): DispatchDependencySession {
  const auth = getAdminFinancialSessionToken();
  uuid(auth); uuid(dispatchJobToken);
  const args = () => ({ p_admin_session_token: auth, p_job_token: dispatchJobToken });
  let savedPlan: DispatchDependencyPlan | null = null, begunPlan: DispatchDependencyPlan | null = null;
  let busy = false;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('A dispatch dependency request is already in progress.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  const begun = () => {
    if (!begunPlan) throw new Error('Dispatch dependency restore begin has not been confirmed.');
    return begunPlan;
  };
  const matchedReceipt = (value: unknown, expected: DispatchDependencyPlan) => {
    const receipt = validateReceipt(value);
    if (TABLE_KEYS.some(key => receipt.totals[key] !== expected.counts[key])) invalid();
    return receipt;
  };
  return {
    plan(signal) {
      return exclusive(async () => {
        savedPlan = null;
        const result = await response(() => {
          const query = supabase.rpc('get_employee_import_dispatch_dependency_plan', args());
          return signal ? query.abortSignal(signal) : query;
        }, validatePlan, signal);
        checkAbort(signal);
        // Detached, deeply frozen snapshot, also valid when a new factory resumes a started server phase.
        savedPlan = result;
        return result;
      }, signal);
    },
    begin(planHash, signal) {
      return exclusive(async () => {
        hash(planHash);
        const expected = savedPlan;
        if (!expected?.can_restore || expected.plan_hash !== planHash) {
          throw new Error('A matching conflict-free dispatch dependency plan must be explicitly obtained first.');
        }
        const result = await response(() => {
          const query = supabase.rpc('employee_import_dispatch_dependency_begin', { ...args(), p_plan_hash: planHash });
          return signal ? query.abortSignal(signal) : query;
        }, value => matchedReceipt(value, expected), signal);
        checkAbort(signal); begunPlan = expected;
        return result;
      }, signal);
    },
    chunk(key, chunkNo, signal) {
      return exclusive(async () => {
        tableKey(key); count(chunkNo, MAX_CHUNKS - 1);
        const expected = begun();
        return response(() => {
          const query = supabase.rpc('employee_import_dispatch_dependency_chunk', { ...args(), p_table_key: key, p_chunk_no: chunkNo });
          return signal ? query.abortSignal(signal) : query;
        }, value => {
          const receipt = matchedReceipt(value, expected);
          if (receipt.next_chunks[key] < chunkNo + 1) invalid();
          return receipt;
        }, signal);
      }, signal);
    },
    verify(signal) {
      return exclusive(async () => {
        const expected = begun();
        return response(() => {
          const query = supabase.rpc('employee_import_dispatch_dependency_verify', args());
          return signal ? query.abortSignal(signal) : query;
        }, value => {
          const receipt = matchedReceipt(value, expected);
          if (!receipt.verified) invalid();
          return receipt;
        }, signal);
      }, signal);
    },
  };
}
