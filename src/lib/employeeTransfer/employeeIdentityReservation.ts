import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { validateEmployeeReplacementPlan, type EmployeeReplacementPlan } from './employeeReplacement';

const { object, withSignal, checkAbort } = dispatchTransferChecks;
const failure = 'Employee identity candidate reservation is unconfirmed. Reconcile the original task with a fresh status before further action. No automatic retry, restore, archive, replacement or maintenance release was performed.';
const IDENTITY_KEYS = ['job_id', 'site_id', 'source_site_id', 'package_id'] as const;
const CHECKPOINT_KEYS = [...IDENTITY_KEYS, 'source_id', 'source_fingerprint', 'target_fingerprint'] as const;
const RESERVATION_KEYS = [...CHECKPOINT_KEYS, 'version', 'target_id', 'binding_hash'] as const;
const STATUS_KEYS = [
  'scope', 'checked', ...IDENTITY_KEYS, 'source_id', 'observed', 'reservation',
  'source_unchanged', 'target_unchanged', 'candidate_available', 'can_restore',
  'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete',
] as const;

interface TaskIdentity {
  readonly job_id: string; readonly site_id: string; readonly source_site_id: string; readonly package_id: string;
}
export interface EmployeeIdentityReservationCheckpoint extends TaskIdentity {
  readonly source_id: string; readonly source_fingerprint: string; readonly target_fingerprint: string;
}
/** A frozen technical candidate only, NOT a public.users lock or permission to restore. */
export interface EmployeeIdentityReservation extends EmployeeIdentityReservationCheckpoint {
  readonly version: 1; readonly target_id: string; readonly binding_hash: string;
}
export interface EmployeeIdentityReservationStatus extends TaskIdentity {
  scope: 'employee-identity-reservation'; checked: true; source_id: string;
  observed: EmployeeReplacementPlan; reservation: EmployeeIdentityReservation | null;
  source_unchanged: boolean; target_unchanged: boolean; candidate_available: boolean;
  can_restore: false; complete_employee_backup: false; can_archive: false; can_replace: false; full_site_complete: false;
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
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function identity(r: Record<string, unknown>): TaskIdentity {
  return { job_id: uuid(r.job_id), site_id: uuid(r.site_id), source_site_id: uuid(r.source_site_id), package_id: uuid(r.package_id) };
}
function sameTask(a: TaskIdentity, b: TaskIdentity): boolean {
  return IDENTITY_KEYS.every(key => a[key] === b[key]);
}
function checkpoint(input: unknown): EmployeeIdentityReservationCheckpoint {
  const r = object(input, CHECKPOINT_KEYS);
  return Object.freeze({ ...identity(r), source_id: uuid(r.source_id),
    source_fingerprint: hash(r.source_fingerprint), target_fingerprint: hash(r.target_fingerprint) });
}
function status(input: unknown): EmployeeIdentityReservationStatus {
  const r = object(input, STATUS_KEYS);
  if (r.scope !== 'employee-identity-reservation' || r.checked !== true || r.can_restore !== false
    || r.complete_employee_backup !== false || r.can_archive !== false || r.can_replace !== false
    || r.full_site_complete !== false) invalid();
  const task = identity(r), sourceId = uuid(r.source_id);
  // SQL37 uses the previous staged source as `after` (null for the first source).
  // Only the server knows that predecessor; its value must precede this single row.
  const observed = validateEmployeeReplacementPlan(r.observed);
  if (observed.job_id !== task.job_id || observed.source_site_id !== task.source_site_id || observed.package_id !== task.package_id
    || observed.limit !== 1 || observed.rows.length !== 1 || observed.rows[0].source_id !== sourceId) invalid();
  const sourceUnchanged = bool(r.source_unchanged), targetUnchanged = bool(r.target_unchanged), available = bool(r.candidate_available);
  let reservation: EmployeeIdentityReservation | null = null;
  if (r.reservation !== null) {
    const saved = object(r.reservation, RESERVATION_KEYS);
    const binding = { ...identity(saved), source_id: uuid(saved.source_id),
      source_fingerprint: hash(saved.source_fingerprint), target_fingerprint: hash(saved.target_fingerprint) };
    const targetId = uuid(saved.target_id);
    if (saved.version !== 1 || !sameTask(binding, task) || binding.source_id !== sourceId
      || [sourceId, task.site_id, task.source_site_id, task.job_id, task.package_id].includes(targetId)
      || sourceUnchanged !== (binding.source_fingerprint === observed.source_fingerprint)
      || targetUnchanged !== (binding.target_fingerprint === observed.target_fingerprint)) invalid();
    // binding_hash is an opaque server binding, not client-derived restore authorization.
    reservation = Object.freeze({ ...binding, version: 1, target_id: targetId, binding_hash: hash(saved.binding_hash) });
  } else if (sourceUnchanged || targetUnchanged || available) invalid();
  return { scope: 'employee-identity-reservation', checked: true, ...task, source_id: sourceId, observed, reservation,
    source_unchanged: sourceUnchanged, target_unchanged: targetUnchanged, candidate_available: available,
    can_restore: false, complete_employee_backup: false, can_archive: false, can_replace: false, full_site_complete: false };
}
export function validateEmployeeIdentityReservationStatus(input: unknown): EmployeeIdentityReservationStatus {
  try { return status(input); } catch { invalid(); }
}
/** Copies current observed hashes, never the possibly stale saved reservation hashes. */
export function employeeIdentityReservationCheckpoint(input: EmployeeIdentityReservationStatus): EmployeeIdentityReservationCheckpoint {
  try {
    const checked = status(input);
    return checkpoint({ job_id: checked.job_id, site_id: checked.site_id,
      source_site_id: checked.source_site_id, package_id: checked.package_id, source_id: checked.source_id,
      source_fingerprint: checked.observed.source_fingerprint, target_fingerprint: checked.observed.target_fingerprint });
  } catch { invalid(); }
}

type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
export interface EmployeeIdentityReservationSession {
  status(sourceId: string, signal?: AbortSignal): Promise<EmployeeIdentityReservationStatus>;
  reserve(checkpoint: EmployeeIdentityReservationCheckpoint, signal?: AbortSignal): Promise<EmployeeIdentityReservationStatus>;
}
export function createEmployeeIdentityReservationSession(jobToken: string): EmployeeIdentityReservationSession {
  try { uuid(jobToken); } catch { invalid(); }
  let busy = false, task: TaskIdentity | undefined;
  const params = () => ({ p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: jobToken });
  const checkTask = (value: TaskIdentity) => { if (task && !sameTask(task, value)) invalid(); };
  const request = async (prepare: () => { operation: () => Query; validate: (value: unknown) => EmployeeIdentityReservationStatus },
    signal?: AbortSignal): Promise<EmployeeIdentityReservationStatus> => {
    if (busy) invalid(); // Reject overlap; never queue an implicit write or retry.
    busy = true;
    try {
      checkAbort(signal);
      // Snapshot caller-controlled checkpoint values synchronously, before auth/async transport.
      const { operation, validate } = prepare();
      const { data, error } = await withSignal(() => {
        checkAbort(signal);
        const query = operation();
        return signal ? query.abortSignal(signal) : query;
      }, signal);
      checkAbort(signal);
      if (error) invalid();
      const result = validate(data);
      checkTask(result);
      checkAbort(signal);
      // Pin only fully validated, non-cancelled replies, never a caller's checkpoint.
      task = Object.freeze({ job_id: result.job_id, site_id: result.site_id,
        source_site_id: result.source_site_id, package_id: result.package_id });
      return result;
    } catch {
      if (signal?.aborted) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { busy = false; }
  };
  return {
    status(sourceId, signal) {
      return request(() => {
        const source = uuid(sourceId);
        return { operation: () => {
          const auth = params(); checkAbort(signal);
          return supabase.rpc('employee_import_identity_reservation_status', { ...auth, p_source_id: source });
        }, validate: value => {
          const result = status(value);
          if (result.source_id !== source) invalid();
          return result;
        } };
      }, signal);
    },
    reserve(input, signal) {
      return request(() => {
        const baseline = checkpoint(input);
        checkTask(baseline);
        return { operation: () => {
          const auth = params(); checkAbort(signal);
          return supabase.rpc('employee_import_identity_reserve', { ...auth, p_source_id: baseline.source_id,
            p_source_fingerprint: baseline.source_fingerprint, p_target_fingerprint: baseline.target_fingerprint });
        }, validate: value => {
          const result = status(value), saved = result.reservation;
          if (!sameTask(result, baseline) || result.source_id !== baseline.source_id || !saved
            || saved.source_fingerprint !== baseline.source_fingerprint || saved.target_fingerprint !== baseline.target_fingerprint
            || !result.source_unchanged || !result.target_unchanged || !result.candidate_available) invalid();
          return result;
        } };
      }, signal);
    },
  };
}
