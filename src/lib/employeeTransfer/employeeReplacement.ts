import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';

const { object, count, withSignal } = dispatchTransferChecks;
const failure = 'Employee replacement read-only check was not confirmed. Reconcile the original task and obtain a fresh plan. No backup, archive, replacement, retry or maintenance release was performed.';
export const EMPLOYEE_REPLACEMENT_BLOCKERS = Object.freeze([
  'source_uuid_occupied', 'employee_no_other_username', 'administrator_username_conflict', 'ambiguous_target_history',
  'complete_employee_backup_missing', 'identity_mapping_missing', 'maintenance_blocks_existing_archive',
] as const);
type Blocker = typeof EMPLOYEE_REPLACEMENT_BLOCKERS[number];
export interface EmployeeReplacementTarget {
  target_id: string; username: string | null; employee_no: string | null;
  archived: boolean; archive_record_id: string | null; archive_evidence: boolean;
  available_balance: string | null; frozen_balance: string | null;
  pending_withdrawals: number; pending_amount: string;
  completed_orders: number; chat: number; login: number; last_login: string | null;
  fingerprint: string; username_released: boolean; employee_no_released: boolean;
}
export interface EmployeeReplacementRow {
  source_id: string; username: string; source_employee_no: string;
  targets: EmployeeReplacementTarget[]; blockers: Blocker[]; backup_required: boolean; can_archive: false;
}
export interface EmployeeReplacementPlan {
  scope: 'employee-replacement'; checked: true; job_id: string; source_site_id: string; package_id: string;
  after: string | null; limit: number; next_after: string | null; total_sources: number;
  // These are observed PAGE counts, never writes completed, backups saved or replacement progress.
  counts: { sources: number; conflicts: number; archived: number };
  rows: EmployeeReplacementRow[]; source_fingerprint: string; target_fingerprint: string;
  backup_required: boolean; username_released: boolean; employee_no_released: boolean; source_employee_no_released: boolean;
  maintenance: true; can_archive: false; can_replace: false;
  complete_employee_backup_missing: true; identity_mapping_missing: true; full_site_complete: false;
}
export interface EmployeeReplacementCheckpoint {
  after: string | null; limit: number; source_fingerprint: string; target_fingerprint: string;
}
export interface EmployeeReplacementStatus extends EmployeeReplacementPlan {
  expected_target_fingerprint: string; target_unchanged: boolean;
}
const PLAN_KEYS = [
  'scope', 'checked', 'job_id', 'source_site_id', 'package_id', 'after', 'limit', 'next_after', 'total_sources',
  'counts', 'rows', 'source_fingerprint', 'target_fingerprint', 'backup_required', 'username_released',
  'employee_no_released', 'source_employee_no_released', 'maintenance', 'can_archive', 'can_replace',
  'complete_employee_backup_missing', 'identity_mapping_missing', 'full_site_complete',
] as const;
const TARGET_KEYS = [
  'target_id', 'username', 'employee_no', 'archived', 'archive_record_id', 'archive_evidence', 'available_balance',
  'frozen_balance', 'pending_withdrawals', 'pending_amount', 'completed_orders', 'chat', 'login', 'last_login',
  'fingerprint', 'username_released', 'employee_no_released',
] as const;
function invalid(): never { throw new Error(failure); }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36) invalid();
  return dispatchTransferChecks.uuid(value);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64) invalid();
  return dispatchTransferChecks.hash(value);
}
function nullableUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 65536 || value.includes('\0')) invalid();
  // JSON transport must not silently substitute isolated surrogates in identities.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid();
  }
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function decimal(value: unknown): string {
  if (typeof value !== 'string' || value.length > 150000 || /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.exec(value)?.[0] !== value) invalid();
  return value; // Never convert money through Number/parseFloat.
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, max), keys = Reflect.ownKeys(value);
  if (keys.length !== size + 1 || keys.some(key => typeof key !== 'string'
    || (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= size)))) invalid();
  return Array.from({ length: size }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item?.enumerable || !('value' in item)) invalid();
    return item.value;
  });
}
function time(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value);
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.[0-9]{1,6})?(Z|[+-]\d\d:\d\d)$/.exec(result);
  if (!match || match[0] !== result) invalid();
  const [, y, m, d, h, min, sec, zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(h) > 23
    || Number(min) > 59 || Number(sec) > 59 || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 15 || Number(zone.slice(4)) > 59))) invalid();
  return result;
}
function target(input: unknown, username: string): EmployeeReplacementTarget {
  const r = object(input, TARGET_KEYS);
  const result: EmployeeReplacementTarget = {
    target_id: uuid(r.target_id), username: nullableText(r.username), employee_no: nullableText(r.employee_no),
    archived: bool(r.archived), archive_record_id: nullableUuid(r.archive_record_id), archive_evidence: bool(r.archive_evidence),
    available_balance: r.available_balance === null ? null : decimal(r.available_balance),
    frozen_balance: r.frozen_balance === null ? null : decimal(r.frozen_balance),
    pending_withdrawals: count(r.pending_withdrawals), pending_amount: decimal(r.pending_amount),
    completed_orders: count(r.completed_orders), chat: count(r.chat), login: count(r.login), last_login: time(r.last_login),
    fingerprint: hash(r.fingerprint), username_released: bool(r.username_released), employee_no_released: bool(r.employee_no_released),
  };
  if (result.username !== username || result.pending_amount.startsWith('-') || (result.available_balance === null) !== (result.frozen_balance === null)
    || (result.archive_evidence && (!result.archived || result.archive_record_id === null))
    || (!result.archived && (result.username_released || result.employee_no_released))) invalid();
  return result;
}
function plan(input: unknown): EmployeeReplacementPlan {
  const r = object(input, PLAN_KEYS);
  if (r.scope !== 'employee-replacement' || r.checked !== true || r.maintenance !== true || r.can_archive !== false
    || r.can_replace !== false || r.complete_employee_backup_missing !== true || r.identity_mapping_missing !== true
    || r.full_site_complete !== false) invalid();
  const after = nullableUuid(r.after), limit = count(r.limit, 200);
  if (limit < 1) invalid();
  const rows = array(r.rows, limit).map(input => {
    const row = object(input, ['source_id', 'username', 'source_employee_no', 'targets', 'blockers', 'backup_required', 'can_archive']);
    const username = text(row.username), targets = array(row.targets, 500000).map(value => target(value, username));
    const blockers = array(row.blockers, EMPLOYEE_REPLACEMENT_BLOCKERS.length).map(value => {
      const checked = EMPLOYEE_REPLACEMENT_BLOCKERS.find(code => code === value);
      if (!checked) invalid();
      return checked;
    });
    if (new Set(blockers).size !== blockers.length || row.can_archive !== false || row.backup_required !== (targets.length > 0)
      || targets.some((value, index) => index > 0 && value.target_id <= targets[index - 1].target_id)) invalid();
    for (const code of ['complete_employee_backup_missing', 'identity_mapping_missing', 'maintenance_blocks_existing_archive'] as const) {
      if (blockers.includes(code) !== (targets.length > 0)) invalid();
    }
    if (blockers.includes('ambiguous_target_history') !== (targets.length > 1)) invalid();
    return { source_id: uuid(row.source_id), username, source_employee_no: text(row.source_employee_no), targets,
      blockers, backup_required: targets.length > 0, can_archive: false as const };
  });
  if (rows.some((row, index) => row.source_id <= (index === 0 ? after ?? '' : rows[index - 1].source_id))
    || new Set(rows.map(row => row.username)).size !== rows.length) invalid();
  const counts = object(r.counts, ['sources', 'conflicts', 'archived']);
  const checkedCounts = { sources: count(counts.sources, 200), conflicts: count(counts.conflicts, 200), archived: count(counts.archived) };
  const targets = rows.flatMap(row => row.targets);
  const next = nullableUuid(r.next_after), total = count(r.total_sources, 500000);
  if (counts.sources !== rows.length || counts.conflicts !== rows.filter(row => row.blockers.length > 0).length
    || counts.archived !== targets.filter(row => row.archive_evidence).length || total < rows.length + (after === null ? 0 : 1)
    || (after === null && (rows.length !== Math.min(total, limit) || (next !== null) !== (total > limit)))
    || (next !== null && (total <= rows.length || rows.length !== limit || next !== rows[rows.length - 1].source_id))
    || r.backup_required !== (targets.length > 0)
    || r.username_released !== (targets.every(row => row.username_released)
      && !rows.some(row => row.blockers.includes('administrator_username_conflict')))
    || r.employee_no_released !== targets.every(row => row.employee_no_released)) invalid();
  return {
    scope: 'employee-replacement', checked: true, job_id: uuid(r.job_id), source_site_id: uuid(r.source_site_id), package_id: uuid(r.package_id),
    after, limit, next_after: next, total_sources: total, counts: checkedCounts, rows,
    source_fingerprint: hash(r.source_fingerprint), target_fingerprint: hash(r.target_fingerprint), backup_required: targets.length > 0,
    username_released: bool(r.username_released), employee_no_released: bool(r.employee_no_released),
    source_employee_no_released: bool(r.source_employee_no_released), maintenance: true, can_archive: false, can_replace: false,
    complete_employee_backup_missing: true, identity_mapping_missing: true, full_site_complete: false,
  };
}
export function validateEmployeeReplacementPlan(input: unknown): EmployeeReplacementPlan {
  try { return plan(input); } catch { invalid(); }
}
function checkpoint(input: unknown): EmployeeReplacementCheckpoint {
  const r = object(input, ['after', 'limit', 'source_fingerprint', 'target_fingerprint']);
  const limit = count(r.limit, 200);
  if (limit < 1) invalid();
  return { after: nullableUuid(r.after), limit, source_fingerprint: hash(r.source_fingerprint), target_fingerprint: hash(r.target_fingerprint) };
}
export function employeeReplacementCheckpoint(input: EmployeeReplacementPlan): EmployeeReplacementCheckpoint {
  const p = validateEmployeeReplacementPlan(input);
  return { after: p.after, limit: p.limit, source_fingerprint: p.source_fingerprint, target_fingerprint: p.target_fingerprint };
}
export function validateEmployeeReplacementStatus(input: unknown, expected: EmployeeReplacementCheckpoint): EmployeeReplacementStatus {
  try {
    const baseline = checkpoint(expected), r = object(input, [...PLAN_KEYS, 'expected_target_fingerprint', 'target_unchanged']);
    const fields = Object.fromEntries(PLAN_KEYS.map(key => [key, r[key]]));
    const checked = plan(fields), fingerprint = hash(r.expected_target_fingerprint);
    if (checked.after !== baseline.after || checked.limit !== baseline.limit || checked.source_fingerprint !== baseline.source_fingerprint
      || fingerprint !== baseline.target_fingerprint || r.target_unchanged !== (checked.target_fingerprint === fingerprint)) invalid();
    return { ...checked, expected_target_fingerprint: fingerprint, target_unchanged: bool(r.target_unchanged) };
  } catch { invalid(); }
}
type RpcName = 'employee_import_replacement_plan' | 'employee_import_replacement_status';
type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
// Local, two-RPC structural adapter only: the shared Database type is deliberately unchanged.
// Names deliberately do not start with get_/count_: supabase.ts retries those POSTs implicitly.
const transport = supabase as unknown as { rpc(name: RpcName, args: Record<string, unknown>): Query };
export interface EmployeeReplacementSession {
  plan(after?: string | null, limit?: number, signal?: AbortSignal): Promise<EmployeeReplacementPlan>;
  status(checkpoint: EmployeeReplacementCheckpoint, signal?: AbortSignal): Promise<EmployeeReplacementStatus>;
}
export function createEmployeeReplacementSession(dispatchJobToken: string): EmployeeReplacementSession {
  try { uuid(dispatchJobToken); } catch { invalid(); }
  let busy = false;
  const request = async <T>(name: RpcName, args: () => Record<string, unknown>, validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> => {
    if (busy) invalid();
    busy = true;
    try {
      const { data, error } = await withSignal(() => {
        const query = transport.rpc(name, { ...args(), p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: dispatchJobToken });
        return signal ? query.abortSignal(signal) : query;
      }, signal);
      if (signal?.aborted || error) invalid();
      const result = validate(data);
      if (signal?.aborted) invalid();
      return result;
    } catch {
      if (signal?.aborted) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { busy = false; }
  };
  return {
    plan(after = null, limit = 100, signal) {
      return request('employee_import_replacement_plan', () => {
        if (after !== null) uuid(after);
        if (count(limit, 200) < 1) invalid();
        return { p_after: after, p_limit: limit };
      }, value => {
        const result = validateEmployeeReplacementPlan(value);
        if (result.after !== after || result.limit !== limit) invalid();
        return result;
      }, signal);
    },
    status(input, signal) {
      let baseline: EmployeeReplacementCheckpoint;
      return request('employee_import_replacement_status', () => {
        baseline = checkpoint(input); // A detached read checkpoint, never client target IDs or backup claims.
        return { p_after: baseline.after, p_limit: baseline.limit,
          p_source_fingerprint: baseline.source_fingerprint, p_target_fingerprint: baseline.target_fingerprint };
      }, value => validateEmployeeReplacementStatus(value, baseline), signal);
    },
  };
}
