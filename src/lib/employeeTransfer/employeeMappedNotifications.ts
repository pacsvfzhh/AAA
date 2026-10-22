import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { NOTIFICATIONS_CONFLICT_REASONS, NOTIFICATIONS_TABLE_KEYS, NOTIFICATIONS_TRANSFER_LIMITS,
  notificationsTableKey, validateNotificationsCatalog, validateNotificationsPage,
  type NotificationsCatalog, type NotificationsTableKey } from './notificationsTransfer';
import { Sha256 } from './sha256';

const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const limits = NOTIFICATIONS_TRANSFER_LIMITS;
const encoder = new TextEncoder();
const EMPTY_HASH = new Sha256().digestHex();
const SCOPE = 'employee-mapped-notifications';
const failure = 'Mapped employee notifications request is unconfirmed. Reconcile the original task with an explicit status request (the same table and chunk after an unknown stage) before further writes. No automatic retry, business restore, media transfer, configuration apply, archive, replacement or maintenance release was performed.';
const BINDING_KEYS = ['job_id', 'site_id', 'source_site_id', 'package_id', 'mapping_hash'] as const;
const COMMON_KEYS = ['scope', ...BINDING_KEYS, 'maintenance', 'dependencies_pending', 'financial_data_pending',
  'can_restore', 'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete',
  'configuration_pending', 'records_pending', 'media_pending', 'automation_pending'] as const;
const CONFLICTS = [...NOTIFICATIONS_CONFLICT_REASONS, 'mapped_reward_mismatch',
  'notification_target_not_empty', 'notification_uuid_collision'] as const;
export type EmployeeMappedNotificationsConflict = typeof CONFLICTS[number];
export type EmployeeMappedNotificationsCounts = Readonly<Record<NotificationsTableKey, number>>;
interface Common {
  readonly scope: 'employee-mapped-notifications';
  readonly job_id: string; readonly site_id: string; readonly source_site_id: string; readonly package_id: string;
  readonly mapping_hash: string; readonly maintenance: true; readonly dependencies_pending: true;
  readonly financial_data_pending: true; readonly can_restore: false; readonly complete_employee_backup: false;
  readonly can_archive: false; readonly can_replace: false; readonly full_site_complete: false;
  readonly configuration_pending: true; readonly records_pending: true; readonly media_pending: true; readonly automation_pending: true;
}
export interface EmployeeMappedNotificationsPlan extends Common {
  readonly catalog_hash: string; readonly plan_hash: string; readonly checked: true;
  readonly counts: EmployeeMappedNotificationsCounts; readonly employees: number; readonly rewards: number;
  readonly conflicts: readonly EmployeeMappedNotificationsConflict[];
}
export interface EmployeeMappedNotificationsTable {
  readonly key: NotificationsTableKey; readonly chunks: number; readonly rows: number;
  readonly bytes: number; readonly row_hashes_sha256: string;
}
export interface EmployeeMappedNotificationsChunk {
  readonly table_key: NotificationsTableKey; readonly chunk_no: number; readonly rows: number;
  readonly bytes: number; readonly sha256: string;
}
export interface EmployeeMappedNotificationsStatus extends Common {
  readonly bound: boolean; readonly catalog_hash: string | null; readonly catalog: NotificationsCatalog | null;
  readonly tables: readonly EmployeeMappedNotificationsTable[]; readonly complete: boolean;
  readonly plan: EmployeeMappedNotificationsPlan | null; readonly chunk: EmployeeMappedNotificationsChunk | null;
}
export interface EmployeeMappedNotificationsBindReceipt {
  readonly success: true; readonly scope: 'employee-mapped-notifications'; readonly catalog_hash: string; readonly full_site_complete: false;
}
export interface EmployeeMappedNotificationsStageReceipt extends EmployeeMappedNotificationsChunk {
  readonly success: true; readonly scope: 'employee-mapped-notifications'; readonly full_site_complete: false;
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
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, max);
  if (Reflect.ownKeys(value).length !== size + 1) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < size; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field)) invalid();
    result.push(field.value);
  }
  return result;
}
// Only traverse fresh validator-owned snapshots, never caller objects/getters/iterators.
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function catalog(value: unknown): NotificationsCatalog { return freeze(validateNotificationsCatalog(value)); }
function common(r: Record<string, unknown>): Common {
  if (r.scope !== SCOPE || r.maintenance !== true || r.dependencies_pending !== true || r.financial_data_pending !== true
    || r.can_restore !== false || r.complete_employee_backup !== false || r.can_archive !== false || r.can_replace !== false
    || r.full_site_complete !== false || r.configuration_pending !== true || r.records_pending !== true
    || r.media_pending !== true || r.automation_pending !== true) invalid();
  return { scope: SCOPE, job_id: uuid(r.job_id), site_id: uuid(r.site_id), source_site_id: uuid(r.source_site_id),
    package_id: uuid(r.package_id), mapping_hash: hash(r.mapping_hash), maintenance: true, dependencies_pending: true,
    financial_data_pending: true, can_restore: false, complete_employee_backup: false, can_archive: false, can_replace: false,
    full_site_complete: false, configuration_pending: true, records_pending: true, media_pending: true, automation_pending: true };
}
function sameBinding(a: Common, b: Common): boolean { return BINDING_KEYS.every(key => a[key] === b[key]); }
function checkCatalog(c: NotificationsCatalog, b: Common): void {
  if (c.site_id !== b.source_site_id || c.package_id !== b.package_id) invalid();
}
function checkPlanCatalog(p: EmployeeMappedNotificationsPlan, c: NotificationsCatalog): void {
  checkCatalog(c, p);
  if (p.employees !== c.identity_catalog.tables[0].rows || c.tables.some(t => p.counts[t.key] !== t.rows)) invalid();
}
function plan(value: unknown): EmployeeMappedNotificationsPlan {
  const r = object(value, [...COMMON_KEYS, 'catalog_hash', 'plan_hash', 'checked', 'counts', 'employees', 'rewards', 'conflicts']);
  const binding = common(r), rawCounts = object(r.counts, NOTIFICATIONS_TABLE_KEYS);
  if (r.checked !== true) invalid();
  const counts = Object.fromEntries(NOTIFICATIONS_TABLE_KEYS.map(key => [key, count(rawCounts[key], limits.maxRows)])) as Record<NotificationsTableKey, number>;
  const conflicts = array(r.conflicts, CONFLICTS.length).map(value => {
    const reason = CONFLICTS.find(reason => reason === value);
    if (!reason) invalid();
    return reason;
  });
  if (conflicts.some((reason, index) => index > 0 && reason <= conflicts[index - 1])) invalid();
  return freeze({ ...binding, catalog_hash: hash(r.catalog_hash), plan_hash: hash(r.plan_hash), checked: true as const,
    counts, employees: count(r.employees, limits.maxRows), rewards: count(r.rewards, limits.maxRows), conflicts });
}
function chunk(value: unknown): EmployeeMappedNotificationsChunk {
  const r = object(value, ['table_key', 'chunk_no', 'rows', 'bytes', 'sha256']);
  const key = notificationsTableKey(r.table_key), no = count(r.chunk_no, limits.maxChunks - 1);
  const rows = count(r.rows, limits.maxPageRows), bytes = count(r.bytes, limits.maxPageBytes), digest = hash(r.sha256);
  if ((rows === 0) !== (bytes === 0) || (rows === 0 && (no !== 0 || digest !== EMPTY_HASH))) invalid();
  return Object.freeze({ table_key: key, chunk_no: no, rows, bytes, sha256: digest });
}
function sameChunk(a: EmployeeMappedNotificationsChunk, b: EmployeeMappedNotificationsChunk): boolean {
  return a.table_key === b.table_key && a.chunk_no === b.chunk_no && a.rows === b.rows && a.bytes === b.bytes && a.sha256 === b.sha256;
}
function status(value: unknown): EmployeeMappedNotificationsStatus {
  const r = object(value, [...COMMON_KEYS, 'bound', 'catalog_hash', 'catalog', 'tables', 'complete', 'plan', 'chunk']);
  const binding = common(r), bound = boolean(r.bound), complete = boolean(r.complete);
  const c = r.catalog === null ? null : catalog(r.catalog), digest = r.catalog_hash === null ? null : hash(r.catalog_hash);
  if (bound !== (c !== null) || bound !== (digest !== null)) invalid();
  if (c) checkCatalog(c, binding);
  const raw = array(r.tables, NOTIFICATIONS_TABLE_KEYS.length);
  if (raw.length !== NOTIFICATIONS_TABLE_KEYS.length) invalid();
  let totalBytes = 0;
  const tables = NOTIFICATIONS_TABLE_KEYS.map((key, index) => {
    const t = object(raw[index], ['key', 'chunks', 'rows', 'bytes', 'row_hashes_sha256']);
    if (t.key !== key) invalid();
    const chunks = count(t.chunks, limits.maxChunks), rows = count(t.rows, limits.maxRows);
    const bytes = count(t.bytes, limits.maxTableBytes), rowHash = hash(t.row_hashes_sha256);
    if ((rows === 0) !== (bytes === 0) || (rows === 0 && rowHash !== EMPTY_HASH)
      || (chunks === 0 && rows !== 0) || (rows > 0 && (chunks > rows || rows > chunks * limits.maxPageRows || bytes > chunks * limits.maxPageBytes))) invalid();
    const expected = c?.tables[index];
    if (!bound && (chunks !== 0 || rows !== 0 || bytes !== 0 || rowHash !== EMPTY_HASH)) invalid();
    if (expected && (rows > expected.rows || bytes > expected.bytes || (expected.rows === 0 && chunks > 1)
      || (rows === expected.rows && (bytes !== expected.bytes || rowHash !== expected.row_hashes_sha256))
      || (rows < expected.rows && bytes >= expected.bytes))) invalid();
    totalBytes += bytes;
    return Object.freeze({ key, chunks, rows, bytes, row_hashes_sha256: rowHash });
  });
  if (totalBytes > limits.maxTotalBytes || complete !== (bound && tables.every((t, i) => t.chunks > 0
    && t.rows === c!.tables[i].rows && t.bytes === c!.tables[i].bytes && t.row_hashes_sha256 === c!.tables[i].row_hashes_sha256))) invalid();
  const p = r.plan === null ? null : plan(r.plan), receipt = r.chunk === null ? null : chunk(r.chunk);
  if ((!complete && p !== null) || (!bound && (p !== null || receipt !== null))) invalid();
  if (p) {
    if (!sameBinding(binding, p) || p.catalog_hash !== digest) invalid();
    checkPlanCatalog(p, c!);
  }
  if (receipt) {
    const t = tables[NOTIFICATIONS_TABLE_KEYS.indexOf(receipt.table_key)];
    if (receipt.chunk_no >= t.chunks || receipt.rows > t.rows || receipt.bytes > t.bytes
      || (receipt.rows === 0 && t.rows !== 0) || (t.chunks === 1 && (receipt.rows !== t.rows || receipt.bytes !== t.bytes))) invalid();
  }
  return freeze({ ...binding, bound, catalog_hash: digest, catalog: c, tables, complete, plan: p, chunk: receipt });
}
export function validateEmployeeMappedNotificationsPlan(value: unknown): EmployeeMappedNotificationsPlan {
  try { return plan(value); } catch { invalid(); }
}
export function validateEmployeeMappedNotificationsStatus(value: unknown): EmployeeMappedNotificationsStatus {
  try { return status(value); } catch { invalid(); }
}

type PendingWrite = { kind: 'bind' } | { kind: 'stage'; chunk: EmployeeMappedNotificationsChunk };
type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
type Result = EmployeeMappedNotificationsPlan | EmployeeMappedNotificationsStatus | EmployeeMappedNotificationsBindReceipt | EmployeeMappedNotificationsStageReceipt;
export interface EmployeeMappedNotificationsSession {
  bind(catalog: NotificationsCatalog, signal?: AbortSignal): Promise<EmployeeMappedNotificationsBindReceipt>;
  stage(tableKey: NotificationsTableKey, chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<EmployeeMappedNotificationsStageReceipt>;
  plan(signal?: AbortSignal): Promise<EmployeeMappedNotificationsPlan>;
  status(tableKey?: NotificationsTableKey | null, chunkNo?: number | null, signal?: AbortSignal): Promise<EmployeeMappedNotificationsStatus>;
}
// SQL54 is implemented separately. Keep this local transport contract isolated until shared RPC types are updated.
const rpc: (name: string, args: Record<string, unknown>) => Query = supabase.rpc.bind(supabase) as unknown as
  (name: string, args: Record<string, unknown>) => Query;
export function createEmployeeMappedNotificationsSession(jobToken: string): EmployeeMappedNotificationsSession {
  try { uuid(jobToken); } catch { invalid(); }
  let busy = false, bound = false, complete = false;
  let uncertain: PendingWrite | undefined;
  let c: NotificationsCatalog | undefined, catalogHash: string | undefined, binding: Common | undefined;
  let planned: EmployeeMappedNotificationsPlan | undefined;
  let progress: readonly EmployeeMappedNotificationsTable[] | undefined;
  const chunks = new Map<string, EmployeeMappedNotificationsChunk>();
  const chunkId = (key: NotificationsTableKey, no: number) => `${key}:${no}`;
  const checkBinding = (b: Common) => {
    if (binding && !sameBinding(binding, b)) invalid();
    if (c) checkCatalog(c, b);
  };
  const checkPlan = (p: EmployeeMappedNotificationsPlan) => {
    checkBinding(p);
    if (catalogHash && p.catalog_hash !== catalogHash) invalid();
    if (c) checkPlanCatalog(p, c);
    if (planned && (p.plan_hash !== planned.plan_hash || p.employees !== planned.employees || p.rewards !== planned.rewards
      || NOTIFICATIONS_TABLE_KEYS.some(key => p.counts[key] !== planned!.counts[key]))) invalid();
  };
  const checkStatus = (s: EmployeeMappedNotificationsStatus, key: NotificationsTableKey | null, no: number | null) => {
    checkBinding(s);
    if ((bound && !s.bound) || (complete && !s.complete)
      || (s.bound && catalogHash && catalogHash !== s.catalog_hash)
      || (s.catalog && c && JSON.stringify(c) !== JSON.stringify(s.catalog))) invalid();
    if (s.catalog && planned) checkPlanCatalog(planned, s.catalog);
    if (s.chunk && (s.chunk.table_key !== key || s.chunk.chunk_no !== no)) invalid();
    if (key !== null) {
      const t = s.tables[NOTIFICATIONS_TABLE_KEYS.indexOf(key)];
      if ((s.chunk !== null) !== (no! < t.chunks)) invalid();
    } else if (s.chunk !== null) invalid();
    const observed = new Map(chunks);
    if (s.chunk) {
      const id = chunkId(s.chunk.table_key, s.chunk.chunk_no), prior = observed.get(id);
      if (prior && !sameChunk(prior, s.chunk)) invalid();
      observed.set(id, s.chunk);
    }
    for (let i = 0; i < s.tables.length; i++) {
      const t = s.tables[i], prior = progress?.[i];
      if (prior && (t.chunks < prior.chunks || t.rows < prior.rows || t.bytes < prior.bytes
        || (t.chunks === prior.chunks && (t.rows !== prior.rows || t.bytes !== prior.bytes || t.row_hashes_sha256 !== prior.row_hashes_sha256))
        || (t.chunks > prior.chunks && t.rows === prior.rows && !(t.rows === 0 && prior.chunks === 0 && t.chunks === 1)))) invalid();
      const known = [...observed.values()].filter(receipt => receipt.table_key === t.key);
      const added = known.filter(receipt => receipt.chunk_no >= (prior?.chunks ?? 0));
      const minimumRows = (prior?.rows ?? 0) + added.reduce((n, receipt) => n + receipt.rows, 0);
      const minimumBytes = (prior?.bytes ?? 0) + added.reduce((n, receipt) => n + receipt.bytes, 0);
      if (minimumRows > t.rows || minimumBytes > t.bytes
        || (added.length === t.chunks - (prior?.chunks ?? 0) && (minimumRows !== t.rows || minimumBytes !== t.bytes))) invalid();
      if (known.some(receipt => receipt.chunk_no >= t.chunks) || known.reduce((n, receipt) => n + receipt.rows, 0) > t.rows
        || known.reduce((n, receipt) => n + receipt.bytes, 0) > t.bytes) invalid();
      if (known.length === t.chunks && (known.reduce((n, receipt) => n + receipt.rows, 0) !== t.rows
        || known.reduce((n, receipt) => n + receipt.bytes, 0) !== t.bytes)) invalid();
    }
    if (key !== null) {
      const known = chunks.get(chunkId(key, no!));
      if (known && (!s.chunk || !sameChunk(known, s.chunk))) invalid();
    }
    if (uncertain?.kind === 'stage' && uncertain.chunk.table_key === key && uncertain.chunk.chunk_no === no
      && s.chunk && !sameChunk(uncertain.chunk, s.chunk)) invalid();
    if (s.plan) checkPlan(s.plan);
  };
  const writable = () => { if (uncertain) invalid(); };
  const request = async <T extends Result>(prepare: () => {
    operation: (auth: { p_admin_session_token: string; p_job_token: string }) => Query;
    validate: (value: unknown) => T; commit: (value: T) => void;
    writing?: { pending: PendingWrite; pin?: () => void };
  }, signal?: AbortSignal): Promise<T> => {
    if (busy) invalid();
    busy = true;
    let inFlight = false, finished = false;
    const track = (query: Query) => {
      inFlight = true;
      return Promise.resolve(query).finally(() => { inFlight = false; if (finished) busy = false; });
    };
    try {
      checkAbort(signal);
      const { operation, validate, commit, writing } = prepare();
      const { data, error } = await withSignal(() => {
        checkAbort(signal);
        const auth = { p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: jobToken };
        checkAbort(signal);
        if (writing) { writing.pin?.(); uncertain = writing.pending; }
        const raw = operation(auth);
        let query: Query;
        try { query = signal ? raw.abortSignal(signal) : raw; }
        catch { void track(raw).catch(() => undefined); invalid(); }
        return track(query);
      }, signal);
      checkAbort(signal);
      if (error) invalid();
      const result = validate(data);
      checkAbort(signal);
      commit(result);
      return result;
    } catch {
      if (signal?.aborted) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { finished = true; if (!inFlight) busy = false; }
  };
  return {
    bind(input, signal) {
      return request(() => {
        writable();
        const snapshot = catalog(input);
        if (c && JSON.stringify(c) !== JSON.stringify(snapshot)) invalid();
        if (binding) checkCatalog(snapshot, binding);
        if (planned) checkPlanCatalog(planned, snapshot);
        return { writing: { pending: { kind: 'bind' }, pin: () => { c ??= snapshot; } },
          operation: auth => rpc('employee_import_mapped_notifications_bind', { ...auth, p_catalog: snapshot }),
          validate: value => {
            const r = object(value, ['success', 'scope', 'catalog_hash', 'full_site_complete']), digest = hash(r.catalog_hash);
            if (r.success !== true || r.scope !== SCOPE || r.full_site_complete !== false || (catalogHash && digest !== catalogHash)) invalid();
            return Object.freeze({ success: true as const, scope: SCOPE, catalog_hash: digest, full_site_complete: false as const });
          }, commit: result => { bound = true; catalogHash = result.catalog_hash; uncertain = undefined; } };
      }, signal);
    },
    stage(tableKey, chunkNo, ndjson, signal) {
      return request(() => {
        writable();
        const key = notificationsTableKey(tableKey), no = count(chunkNo, limits.maxChunks - 1);
        if (!bound || !c || typeof ndjson !== 'string' || ndjson.length > limits.maxPageBytes) invalid();
        const bytes = encoder.encode(ndjson), digest = new Sha256().update(bytes).digestHex();
        let rows = 0;
        for (const byte of bytes) if (byte === 10) rows++;
        validateNotificationsPage({ table_key: key, count: rows, ndjson, next_after: null, sha256: digest }, key, null);
        const expected = chunk({ table_key: key, chunk_no: no, rows, bytes: bytes.length, sha256: digest });
        const table = c.tables[NOTIFICATIONS_TABLE_KEYS.indexOf(key)], known = chunks.get(chunkId(key, no));
        if (rows > table.rows || bytes.length > table.bytes || (rows === 0 && table.rows !== 0) || (known && !sameChunk(known, expected))) invalid();
        const staged = progress?.find(t => t.key === key);
        const prior = [...chunks.values()].filter(receipt => receipt.table_key === key && receipt.chunk_no !== no);
        const frontier = prior.reduce((n, receipt) => Math.max(n, receipt.chunk_no + 1), staged?.chunks ?? 0);
        if (no > frontier || (complete && !known && (!staged || no >= staged.chunks))) invalid();
        const added = [...prior, expected].filter(receipt => receipt.chunk_no >= (staged?.chunks ?? 0));
        if ((staged?.rows ?? 0) + added.reduce((n, receipt) => n + receipt.rows, 0) > table.rows
          || (staged?.bytes ?? 0) + added.reduce((n, receipt) => n + receipt.bytes, 0) > table.bytes
          || prior.reduce((n, receipt) => n + receipt.rows, rows) > table.rows
          || prior.reduce((n, receipt) => n + receipt.bytes, bytes.length) > table.bytes) invalid();
        return { writing: { pending: { kind: 'stage', chunk: expected } },
          operation: auth => rpc('employee_import_mapped_notifications_stage', { ...auth, p_table_key: key, p_chunk_no: no, p_ndjson: ndjson }),
          validate: value => {
            const r = object(value, ['success', 'scope', 'table_key', 'chunk_no', 'rows', 'bytes', 'sha256', 'full_site_complete']);
            const receipt = chunk({ table_key: r.table_key, chunk_no: r.chunk_no, rows: r.rows, bytes: r.bytes, sha256: r.sha256 });
            if (r.success !== true || r.scope !== SCOPE || r.full_site_complete !== false || !sameChunk(expected, receipt)) invalid();
            return Object.freeze({ success: true as const, scope: SCOPE, ...receipt, full_site_complete: false as const });
          }, commit: result => { chunks.set(chunkId(key, no), result); uncertain = undefined; } };
      }, signal);
    },
    plan(signal) {
      return request(() => ({ operation: auth => rpc('employee_import_mapped_notifications_plan', auth),
        validate: value => { const p = plan(value); checkPlan(p); return p; },
        commit: p => { binding = p; catalogHash = p.catalog_hash; planned = p; bound = true; complete = true; } }), signal);
    },
    status(tableKey = null, chunkNo = null, signal) {
      return request(() => {
        const key = tableKey === null ? null : notificationsTableKey(tableKey);
        const no = chunkNo === null ? null : count(chunkNo, limits.maxChunks - 1);
        if ((key === null) !== (no === null)) invalid();
        return { operation: auth => rpc('employee_import_mapped_notifications_status', { ...auth, p_table_key: key, p_chunk_no: no }),
          validate: value => { const s = status(value); checkStatus(s, key, no); return s; },
          commit: s => {
            binding = s; progress = s.tables; bound = s.bound; complete = s.complete;
            if (s.catalog) { c ??= s.catalog; catalogHash = s.catalog_hash!; }
            if (s.plan) planned = s.plan;
            if (s.chunk) chunks.set(chunkId(s.chunk.table_key, s.chunk.chunk_no), s.chunk);
            if (uncertain?.kind === 'bind' || (uncertain?.kind === 'stage' && uncertain.chunk.table_key === key && uncertain.chunk.chunk_no === no)) uncertain = undefined;
          } };
      }, signal);
    },
  };
}
