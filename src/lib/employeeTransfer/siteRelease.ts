import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { validateSourceCutoff, type SourceCutoff } from './sourceCutover';

interface Binding {
  readonly version: 1; readonly success: true;
  readonly job_id: string; readonly source_site_id: string; readonly package_id: string;
  readonly full_site_complete: false;
}
export interface SiteReleaseCutoffReceipt extends Binding {
  readonly scope: 'site-cutover-binding'; readonly cutoff: Readonly<SourceCutoff>;
}
export interface SiteReleaseReceipt extends Binding {
  readonly scope: 'site-release'; readonly cutoff_id: string; readonly cutoff_hash: string;
  readonly verification_hash: string; readonly released_at: string;
  readonly counts: Readonly<{ employees: number; active_employees: number; active_admins: number;
    active_plans: number; active_tasks: number; queued_employees: number }>;
  readonly released: true; readonly maintenance: false; readonly accounts_restored: true;
  readonly automation_resumed: true; readonly source_shutdown: 'operator-managed';
}
const BLOCKERS = ['missing_cutoff', 'cutoff_expired', 'not_verified', 'task_not_running', 'maintenance_mismatch'] as const;
export type SiteReleaseBlocker = typeof BLOCKERS[number];
export interface SiteReleaseStatus extends Binding {
  readonly scope: 'site-release-status'; readonly cutoff: Readonly<SourceCutoff> | null;
  readonly verification_hash: string | null; readonly released: boolean;
  readonly receipt: SiteReleaseReceipt | null; readonly maintenance: boolean;
  readonly blockers: readonly SiteReleaseBlocker[]; readonly can_release: boolean;
}
export interface SiteReleaseContext {
  readonly jobId: string; readonly jobToken: string; readonly sourceSiteId: string;
  readonly packageId: string; readonly verificationHash: string; readonly cutoff: Readonly<SourceCutoff> | null;
}
export interface SiteReleaseSession {
  status(signal?: AbortSignal): Promise<SiteReleaseStatus>;
  release(password: string, confirmation: string, signal?: AbortSignal): Promise<SiteReleaseReceipt>;
}

const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const COMMON = ['version', 'success', 'scope', 'job_id', 'source_site_id', 'package_id', 'full_site_complete'];
const CUTOFF_KEYS = ['version', 'policy', 'site_id', 'cutoff_id', 'frozen_at', 'cutoff_hash'] as const;
const COUNT_KEYS = ['employees', 'active_employees', 'active_admins', 'active_plans', 'active_tasks', 'queued_employees'] as const;
const failure = 'Site release outcome is unconfirmed. Obtain a fresh explicit status for the original task before further writes. Status is not a new physical-data verification. No automatic retry, rollback or recovery was performed.';
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
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 27
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value.slice(0, 23) + 'Z') invalid();
  return value;
}
// Traverse only newly constructed validator-owned objects, never input getters/iterators.
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function cutoff(value: unknown, source: string): Readonly<SourceCutoff> {
  const result = validateSourceCutoff(value);
  uuid(result.site_id); uuid(result.cutoff_id); hash(result.cutoff_hash); timestamp(result.frozen_at);
  if (result.site_id !== source) invalid();
  return freeze(result);
}
function sameCutoff(a: Readonly<SourceCutoff> | null, b: Readonly<SourceCutoff> | null): boolean {
  return a === null || b === null ? a === b : CUTOFF_KEYS.every(key => a[key] === b[key]);
}
interface Identity { readonly jobId: string; readonly sourceSiteId: string; readonly packageId: string }
interface JobState extends Identity {
  activeWrite: boolean; writeGeneration: number;
  pending?: { kind: 'bind' } | { kind: 'release'; verificationHash: string };
  cutoff?: Readonly<SourceCutoff>; cutoffConfirmed: boolean; receipt?: SiteReleaseReceipt;
}
// No session/job tokens or passwords are retained in this module-level gate.
const jobs = new Map<string, JobState>();
function jobState(binding: Identity): JobState {
  const prior = jobs.get(binding.jobId);
  if (prior) {
    if (prior.sourceSiteId !== binding.sourceSiteId || prior.packageId !== binding.packageId) invalid();
    return prior;
  }
  const state = { ...binding, activeWrite: false, writeGeneration: 0, cutoffConfirmed: false };
  jobs.set(binding.jobId, state);
  return state;
}
function common(r: Record<string, unknown>, binding: Identity, scope: string): Binding {
  if (r.version !== 1 || r.success !== true || r.scope !== scope || r.full_site_complete !== false
    || uuid(r.job_id) !== binding.jobId || uuid(r.source_site_id) !== binding.sourceSiteId
    || uuid(r.package_id) !== binding.packageId) invalid();
  return { version: 1, success: true, job_id: binding.jobId, source_site_id: binding.sourceSiteId,
    package_id: binding.packageId, full_site_complete: false };
}
function receipt(value: unknown, context: SiteReleaseContext): SiteReleaseReceipt {
  const r = object(value, [...COMMON, 'cutoff_id', 'cutoff_hash', 'verification_hash', 'released_at', 'counts',
    'released', 'maintenance', 'accounts_restored', 'automation_resumed', 'source_shutdown']);
  const binding = common(r, context, 'site-release'), c = context.cutoff;
  const releasedAt = timestamp(r.released_at), verificationHash = hash(r.verification_hash);
  if (!c || uuid(r.cutoff_id) !== c.cutoff_id || hash(r.cutoff_hash) !== c.cutoff_hash
    || verificationHash !== context.verificationHash || releasedAt.slice(0, 10) !== c.frozen_at.slice(0, 10)
    || releasedAt < c.frozen_at || r.released !== true || r.maintenance !== false || r.accounts_restored !== true
    || r.automation_resumed !== true || r.source_shutdown !== 'operator-managed') invalid();
  const raw = object(r.counts, COUNT_KEYS);
  const counts = { employees: count(raw.employees), active_employees: count(raw.active_employees),
    active_admins: count(raw.active_admins), active_plans: count(raw.active_plans), active_tasks: count(raw.active_tasks),
    queued_employees: count(raw.queued_employees) };
  if (counts.active_employees > counts.employees || counts.queued_employees !== counts.active_employees) invalid();
  return freeze({ ...binding, scope: 'site-release' as const, cutoff_id: c.cutoff_id, cutoff_hash: c.cutoff_hash,
    verification_hash: verificationHash, released_at: releasedAt, counts, released: true as const, maintenance: false as const,
    accounts_restored: true as const, automation_resumed: true as const, source_shutdown: 'operator-managed' as const });
}
function blockers(value: unknown): SiteReleaseBlocker[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const size = count(Object.getOwnPropertyDescriptor(value, 'length')?.value, BLOCKERS.length);
  if (Reflect.ownKeys(value).length !== size + 1) invalid();
  const result: SiteReleaseBlocker[] = [];
  let previous = -1;
  for (let index = 0; index < size; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field)) invalid();
    const position = BLOCKERS.findIndex(key => key === field.value);
    if (position <= previous) invalid();
    result.push(BLOCKERS[position]); previous = position;
  }
  return result;
}
function status(value: unknown, context: SiteReleaseContext, state: JobState): SiteReleaseStatus {
  const r = object(value, [...COMMON, 'cutoff', 'verification_hash', 'released', 'receipt', 'maintenance', 'blockers', 'can_release']);
  const binding = common(r, context, 'site-release-status');
  const c = r.cutoff === null ? null : cutoff(r.cutoff, context.sourceSiteId);
  const verificationHash = r.verification_hash === null ? null : hash(r.verification_hash);
  const released = boolean(r.released), maintenance = boolean(r.maintenance), canRelease = boolean(r.can_release);
  const reasons = blockers(r.blockers);
  if (!sameCutoff(c, context.cutoff) || (state.cutoff && c && !sameCutoff(c, state.cutoff))
    || (state.cutoffConfirmed && !c) || (verificationHash !== null && verificationHash !== context.verificationHash)
    || (state.pending?.kind === 'release' && verificationHash !== null && verificationHash !== state.pending.verificationHash)) invalid();
  const historical = r.receipt === null ? null : receipt(r.receipt, context);
  if (released) {
    if (canRelease || reasons.length || !historical || !c || verificationHash !== historical.verification_hash) invalid();
    // maintenance describes the current site; the receipt describes this historical release.
  } else {
    if (historical || state.receipt || canRelease !== (reasons.length === 0)
      || reasons.includes('missing_cutoff') !== (c === null) || reasons.includes('not_verified') !== (verificationHash === null)
      || (reasons.includes('cutoff_expired') && c === null) || (!maintenance && !reasons.includes('maintenance_mismatch'))) invalid();
  }
  if (state.receipt && JSON.stringify(state.receipt) !== JSON.stringify(historical)) invalid();
  return freeze({ ...binding, scope: 'site-release-status' as const, cutoff: c, verification_hash: verificationHash,
    released, receipt: historical, maintenance, blockers: reasons, can_release: canRelease });
}
type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
type PendingWrite = NonNullable<JobState['pending']>;
async function request<T>(state: JobState, pending: PendingWrite | null,
  operation: (session: string) => Query, validate: (value: unknown) => T, commit: (value: T) => void,
  signal?: AbortSignal, pin?: () => void): Promise<T> {
  let writing = false, inFlight = false, finished = false;
  const track = (query: Query) => {
    inFlight = true;
    return Promise.resolve(query).finally(() => { inFlight = false; if (finished && writing) state.activeWrite = false; });
  };
  try {
    checkAbort(signal);
    if (state.activeWrite || (pending && (state.pending || state.receipt))) invalid();
    const generation = state.writeGeneration;
    const session = uuid(getAdminFinancialSessionToken());
    checkAbort(signal);
    if (pending) { writing = true; state.activeWrite = true; state.writeGeneration++; }
    const result = await withSignal(() => {
      checkAbort(signal);
      if (pending) { pin?.(); state.pending = pending; }
      const raw = operation(session);
      let query: Query;
      try { query = signal ? raw.abortSignal(signal) : raw; }
      catch { void track(raw).catch(() => undefined); invalid(); }
      return track(query);
    }, signal);
    checkAbort(signal);
    if (result.error !== null || (!pending && (state.activeWrite || generation !== state.writeGeneration))) invalid();
    const checked = validate(result.data);
    checkAbort(signal);
    commit(checked);
    state.pending = undefined;
    return checked;
  } catch {
    if (signal?.aborted) throw new DOMException(failure, 'AbortError');
    throw new Error(failure);
  } finally { finished = true; if (writing && !inFlight) state.activeWrite = false; }
}

export async function bindSiteReleaseCutoff(jobToken: string, jobId: string, sourceSiteId: string,
  packageId: string, input: SourceCutoff, signal?: AbortSignal): Promise<SiteReleaseCutoffReceipt> {
  try {
    checkAbort(signal);
    const token = uuid(jobToken), binding = { jobId: uuid(jobId), sourceSiteId: uuid(sourceSiteId), packageId: uuid(packageId) };
    const snapshot = cutoff(input, binding.sourceSiteId), state = jobState(binding);
    if (state.cutoff && !sameCutoff(snapshot, state.cutoff)) invalid();
    return await request(state, { kind: 'bind' }, session => supabase.rpc('employee_import_site_bind_cutoff', {
      p_admin_session_token: session, p_job_token: token, p_cutoff: { ...snapshot },
    }), value => {
      const r = object(value, [...COMMON, 'cutoff']), checked = cutoff(r.cutoff, binding.sourceSiteId);
      const identity = common(r, binding, 'site-cutover-binding');
      if (!sameCutoff(snapshot, checked)) invalid();
      return freeze({ ...identity, scope: 'site-cutover-binding' as const, cutoff: checked });
    }, () => { state.cutoffConfirmed = true; }, signal, () => { state.cutoff = snapshot; });
  } catch {
    if (signal?.aborted) throw new DOMException(failure, 'AbortError');
    throw new Error(failure);
  }
}

export function createSiteReleaseSession(input: SiteReleaseContext): SiteReleaseSession {
  try {
    const r = object(input, ['jobId', 'jobToken', 'sourceSiteId', 'packageId', 'verificationHash', 'cutoff']);
    // Only the closure holds the token; none of the public results expose it.
    const context = freeze({ jobId: uuid(r.jobId), jobToken: uuid(r.jobToken), sourceSiteId: uuid(r.sourceSiteId),
      packageId: uuid(r.packageId), verificationHash: hash(r.verificationHash),
      cutoff: r.cutoff === null ? null : cutoff(r.cutoff, uuid(r.sourceSiteId)) });
    const state = jobState({ jobId: context.jobId, sourceSiteId: context.sourceSiteId, packageId: context.packageId });
    if (state.cutoff && context.cutoff && !sameCutoff(state.cutoff, context.cutoff)) invalid();
    let confirmed = false;
    return Object.freeze({
      // This reads saved verification/status, not a new ten-domain physical-data verification.
      status(signal?: AbortSignal) {
        return request(state, null, session => supabase.rpc('get_employee_import_site_release_status', {
          p_admin_session_token: session, p_job_id: context.jobId,
        }), value => status(value, context, state), result => {
          if (result.cutoff) { state.cutoff = result.cutoff; state.cutoffConfirmed = true; }
          if (result.receipt) { state.receipt = result.receipt; confirmed = true; }
        }, signal);
      },
      async release(password: string, confirmation: string, signal?: AbortSignal) {
        try {
          checkAbort(signal);
          if (confirmed || !context.cutoff || typeof password !== 'string' || !password
            || confirmation !== '確認啟用新站') invalid();
          if (state.cutoff && !sameCutoff(state.cutoff, context.cutoff)) invalid();
          return await request(state, { kind: 'release', verificationHash: context.verificationHash }, session =>
            supabase.rpc('employee_import_site_release', { p_admin_session_token: session, p_job_token: context.jobToken,
              p_admin_password: password, p_confirmation: confirmation, p_verification_hash: context.verificationHash }),
          value => receipt(value, context), result => { state.receipt = result; state.cutoffConfirmed = true; confirmed = true; },
          signal, () => { state.cutoff = context.cutoff!; });
        } catch {
          if (signal?.aborted) throw new DOMException(failure, 'AbortError');
          throw new Error(failure);
        } finally { password = ''; }
      },
    });
  } catch { throw new Error(failure); }
}
