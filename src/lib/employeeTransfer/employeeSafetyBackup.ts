import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { MAX_CONTAINER_INPUT_BYTES, verifyEncryptedVolume, writeEncryptedVolume, type ContainerLimits, type TransferEntry } from './container';
import { readTransferMetadata, type TransferByteSource, type TransferMetadata } from './crypto';
import type { ReplacementBackupFile } from './replacementBackup';
import type { ArchiveBundleWorkspace, ArchiveBundleWorkspaceFactory } from './archiveBundle';
import { validateVolumeInfo, type ManifestEntry, type VolumeInfo, type VolumeManifest } from './manifest';
import { EMPLOYEE_BACKUP_LIMITS, EMPLOYEE_BACKUP_PROJECTIONS, EMPLOYEE_BACKUP_TABLE_KEYS, validateEmployeeBackupRow, type EmployeeBackupTableKey } from './employeeBackup';
import { CHAT_TABLE_KEYS, chatCursor, validateChatBackupRow, type ChatTableKey } from './chatTransfer';
import { NOTIFICATIONS_TABLE_KEYS, notificationsCursor, validateNotificationsRow, type NotificationsTableKey } from './notificationsTransfer';
import { archivesCursor, validateArchivesRow } from './archiveTransfer';
import { dispatchTransferChecks, type DispatchTableKey } from './dispatchTransfer';
import { Sha256 } from './sha256';

export const EMPLOYEE_SAFETY_BACKUP_PROTOCOL = 'employee-safety-records-v1';
export const EMPLOYEE_SAFETY_BACKUP_CATALOG_PATH = 'data/employee-safety-backup-catalog.ndjson';
const DISPATCH_KEYS = ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'valid_order_data', 'used_order_data'] as const;
// History has completed_at, not the live order's rate/processed_at.
const ORDERS_HISTORY_PROJECTIONS = {
  ...EMPLOYEE_BACKUP_PROJECTIONS,
  orders: { id: 'uuid!', user_id: 'uuid!', status: 'text!', commission_amount: 'numeric',
    created_at: 'timestamp with time zone', completed_at: 'timestamp with time zone' },
};
export const EMPLOYEE_SAFETY_BACKUP_TABLE_KEYS = Object.freeze([
  ...EMPLOYEE_BACKUP_TABLE_KEYS, ...CHAT_TABLE_KEYS, ...NOTIFICATIONS_TABLE_KEYS, ...DISPATCH_KEYS,
  'content_audit_events', 'content_audit_recipient_versions', 'orders_history', 'administrators',
] as const);
export type EmployeeSafetyBackupTableKey = typeof EMPLOYEE_SAFETY_BACKUP_TABLE_KEYS[number];
export const EMPLOYEE_SAFETY_BACKUP_LIMITS = Object.freeze({ ...EMPLOYEE_BACKUP_LIMITS, maxEntries: 49 });
const FLAGS = Object.freeze({ records_only: true, media_included: false, complete_employee_backup: false,
  can_archive: false, can_replace: false, full_site_complete: false } as const);
type SafetyFlags = typeof FLAGS;
export interface EmployeeSafetyBackupCatalog extends SafetyFlags {
  version: 1; protocol: typeof EMPLOYEE_SAFETY_BACKUP_PROTOCOL; scope: 'employee-safety-records';
  job_id: string; site_id: string; employee_id: string; username: string; fingerprint: string;
  tables: { key: EmployeeSafetyBackupTableKey; rows: number; bytes: number; row_hashes_sha256: string }[];
}
export interface EmployeeSafetyBackupSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(catalog: EmployeeSafetyBackupCatalog, key: EmployeeSafetyBackupTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(catalog: EmployeeSafetyBackupCatalog, signal?: AbortSignal): Promise<unknown>;
}
export interface EmployeeSafetyBackupIdentity {
  readonly job_id: string; readonly job_token: string; readonly site_id: string; readonly employee_id: string; readonly username: string;
}
export interface EmployeeSafetyBackupBegin {
  success: true; job_id: string; job_token: string; site_id: string; catalog: EmployeeSafetyBackupCatalog;
  scope: 'employee-safety-records'; full_site_complete: false;
}
export interface EmployeeSafetyBackupSession extends EmployeeSafetyBackupSource {
  begin(signal?: AbortSignal): Promise<EmployeeSafetyBackupBegin>;
  identity(): Readonly<EmployeeSafetyBackupIdentity> | null;
  close(catalog: EmployeeSafetyBackupCatalog, signal?: AbortSignal): Promise<unknown>;
}
export type EmployeeSafetyBackupPhase = 'begin' | 'catalog' | 'page' | 'verify' | 'close' | 'stop' | 'records-export'
  | 'source-recheck' | 'save' | 'authenticate' | 'validate' | 'target-recheck' | 'consume';
export interface EmployeeSafetyBackupOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { phase: EmployeeSafetyBackupPhase; rows: number; bytes: number; fullSiteComplete: false }) => void;
  limits?: { maxTotalBytes?: number };
}
export interface EmployeeSafetyBackupResult extends SafetyFlags {
  backupId: string; catalog: EmployeeSafetyBackupCatalog; manifest: VolumeManifest;
  rows: number; bytes: number; cipherBytes: number; cipherSha256: string; recordsVerified: true;
  recordsOnly: true; mediaIncluded: false; completeEmployeeBackup: false; canArchive: false; canReplace: false; fullSiteComplete: false;
}
export class EmployeeSafetyBackupError extends Error {
  constructor(readonly phase: EmployeeSafetyBackupPhase, readonly cancelled: boolean, readonly outcomeUnknown: boolean,
    readonly encryptedFileState: 'not-written' | 'unknown' | 'saved' | 'verified', readonly cleanupRequired: boolean) {
    super(`Employee safety records backup stopped during ${phase}. Keep and inspect any independent encrypted file, including incomplete or unconfirmed writes. `
      + 'Reconcile task status explicitly; no automatic retry, cancel, close, delete, rollback, sealing, archive, replacement or maintenance release was performed. '
      + 'This is not a complete employee backup; media is not included.'
      + (cleanupRequired ? ' Temporary plaintext cleanup was not confirmed; do not reuse the workspace.' : ''));
    this.name = 'EmployeeSafetyBackupError';
  }
}
const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const limits = EMPLOYEE_SAFETY_BACKUP_LIMITS;
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sha = (bytes: Uint8Array) => new Sha256().update(bytes).digestHex();
const EMPTY_HASH = sha(new Uint8Array());
const completedExports = new WeakMap<EmployeeSafetyBackupSource, string>();
function invalid(): never { throw new Error('Invalid employee safety records backup.'); }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36) invalid();
  return dispatchTransferChecks.uuid(value);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64) invalid();
  return dispatchTransferChecks.hash(value);
}
function text(value: unknown, maximum: number = limits.maxPageBytes): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) invalid();
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(); }
    else if (code >= 0xdc00 && code <= 0xdfff) invalid();
  }
  return value;
}
function username(value: unknown): string {
  const result = text(value, 512);
  if (result !== result.trim() || Array.from(result).length < 1 || Array.from(result).length > 256) invalid();
  return result;
}
function array(value: unknown, size: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || length.value !== size || Reflect.ownKeys(value).length !== size + 1) invalid();
  return Array.from({ length: size }, (_, i) => {
    const item = Object.getOwnPropertyDescriptor(value, String(i));
    if (!item?.enumerable || !('value' in item)) invalid();
    return item.value;
  });
}
function same(a: unknown, b: unknown): void {
  const stable = (v: unknown) => JSON.stringify(v, (_, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const r = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(r).sort().map(key => [key, r[key]]));
    }
    return item;
  });
  if (stable(a) !== stable(b)) invalid();
}
function flags(r: Record<string, unknown>): void {
  for (const [key, expected] of Object.entries(FLAGS)) if (r[key] !== expected) invalid();
}
function tableKey(value: unknown): EmployeeSafetyBackupTableKey {
  const key = EMPLOYEE_SAFETY_BACKUP_TABLE_KEYS.find(key => value === key);
  if (!key) invalid(); return key;
}
export function employeeSafetyBackupEntryPath(key: EmployeeSafetyBackupTableKey): string {
  return `data/employee-safety-backup-${tableKey(key)}.ndjson`;
}
export function validateEmployeeSafetyBackupCatalog(input: unknown): EmployeeSafetyBackupCatalog {
  const r = object(input, ['version', 'protocol', 'scope', 'job_id', 'site_id', 'employee_id', 'username', 'tables', 'fingerprint', ...Object.keys(FLAGS)]);
  flags(r);
  if (r.version !== 1 || r.protocol !== EMPLOYEE_SAFETY_BACKUP_PROTOCOL || r.scope !== 'employee-safety-records') invalid();
  let total = 0;
  const raw = array(r.tables, 48);
  const tables = EMPLOYEE_SAFETY_BACKUP_TABLE_KEYS.map((key, i) => {
    const t = object(raw[i], ['key', 'rows', 'bytes', 'row_hashes_sha256']);
    const rows = count(t.rows, limits.maxRows), bytes = count(t.bytes, limits.maxTableBytes), digest = hash(t.row_hashes_sha256);
    if (t.key !== key || (rows === 0) !== (bytes === 0) || (rows === 0 && digest !== EMPTY_HASH)
      || bytes < rows * 3 || bytes > rows * limits.maxLineBytes) invalid();
    if (key === 'accounts' && rows !== 1) invalid();
    if (['credentials', 'wallets', 'wallet_balance_baselines', 'work_stop_markers', 'employee_submit_time_settings'].includes(key) && rows > 1) invalid();
    total += bytes;
    return { key, rows, bytes, row_hashes_sha256: digest };
  });
  const c: EmployeeSafetyBackupCatalog = { version: 1, protocol: EMPLOYEE_SAFETY_BACKUP_PROTOCOL, scope: 'employee-safety-records',
    job_id: uuid(r.job_id), site_id: uuid(r.site_id), employee_id: uuid(r.employee_id), username: username(r.username),
    tables, fingerprint: hash(r.fingerprint), ...FLAGS };
  const size = enc.encode(JSON.stringify(c) + '\n').length;
  if (size > limits.maxCatalogBytes || total + size > limits.maxTotalBytes) invalid();
  return c;
}
function cursor(key: EmployeeSafetyBackupTableKey, value: unknown): string {
  tableKey(key);
  if ((CHAT_TABLE_KEYS as readonly string[]).includes(key)) return chatCursor(key as ChatTableKey, value);
  if ((NOTIFICATIONS_TABLE_KEYS as readonly string[]).includes(key)) return notificationsCursor(key as NotificationsTableKey, value);
  if (key === 'content_audit_events' || key === 'content_audit_recipient_versions') return archivesCursor(key, value);
  if (key === 'wallet_ledger_entries' || key === 'wallet_reconciliation_audit') {
    if (typeof value !== 'string' || value.length > 19 || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > 9223372036854775807n) invalid();
    return value;
  }
  return uuid(value);
}
function ordered(key: EmployeeSafetyBackupTableKey, id: string, previous: string | null): boolean {
  return previous === null || (key === 'wallet_ledger_entries' || key === 'wallet_reconciliation_audit' ? BigInt(id) > BigInt(previous) : id > previous);
}
function adminRow(line: string): string {
  const row = object(JSON.parse(line), ['id', 'username', 'role', 'parent_id', 'created_at', 'updated_at']);
  const seen = new Set<string>();
  for (const token of line.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    const value = text(JSON.parse(token[0]));
    if (/^[\t\r ]*:/.test(line.slice(token.index! + token[0].length))) { if (seen.has(value)) invalid(); seen.add(value); }
  }
  text(row.username); if (!['super_admin', 'secondary_admin', 'emergency_admin'].includes(row.role as string)) invalid();
  if (row.parent_id !== null) uuid(row.parent_id);
  for (const field of ['created_at', 'updated_at']) if (row[field] !== null) {
    const time = text(row[field]);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(time) || !Number.isFinite(Date.parse(time))) invalid();
  }
  return uuid(row.id);
}
export function validateEmployeeSafetyBackupRow(line: string, key: EmployeeSafetyBackupTableKey, c: EmployeeSafetyBackupCatalog): string {
  tableKey(key); text(line, limits.maxLineBytes);
  if (enc.encode(line).length + (line.endsWith('\n') ? 0 : 1) > limits.maxLineBytes
    || (line.endsWith('\n') ? line.slice(0, -1) : line).includes('\n')) invalid();
  const core = { projections: EMPLOYEE_BACKUP_PROJECTIONS, target_employee_id: c.employee_id, username: c.username };
  let id: string;
  if ((EMPLOYEE_BACKUP_TABLE_KEYS as readonly string[]).includes(key)) id = validateEmployeeBackupRow(line, key as EmployeeBackupTableKey, core);
  else if ((CHAT_TABLE_KEYS as readonly string[]).includes(key)) id = validateChatBackupRow(line, key as ChatTableKey);
  else if ((NOTIFICATIONS_TABLE_KEYS as readonly string[]).includes(key)) id = validateNotificationsRow(line, key as NotificationsTableKey);
  else if ((DISPATCH_KEYS as readonly string[]).includes(key)) id = dispatchTransferChecks.rowIdentity(line, key as DispatchTableKey);
  else if (key === 'content_audit_events' || key === 'content_audit_recipient_versions') id = validateArchivesRow(line, key);
  else if (key === 'orders_history') id = validateEmployeeBackupRow(line, 'orders', { ...core, projections: ORDERS_HISTORY_PROJECTIONS });
  else id = adminRow(line);
  const row = JSON.parse(line) as Record<string, unknown>;
  // These two employee_id fields are employee numbers, not account UUIDs.
  for (const field of ['user_id', 'employee_id', 'recipient_id']) {
    if (field === 'employee_id' && (key === 'accounts' || key === 'employee_login_history')) continue;
    if (field === 'employee_id' && key === 'content_audit_events' && row.entity_type === 'notification' && row.employee_id === null) continue;
    if (Object.prototype.hasOwnProperty.call(row, field) && row[field] !== c.employee_id) invalid();
  }
  return id;
}
export function validateEmployeeSafetyBackupPage(input: unknown, c: EmployeeSafetyBackupCatalog, key: EmployeeSafetyBackupTableKey, previous: string | null) {
  tableKey(key); if (previous !== null) cursor(key, previous);
  const r = object(input, ['table_key', 'count', 'bytes', 'ndjson', 'next_after', 'sha256', 'fingerprint']);
  const raw = enc.encode(text(r.ndjson)), n = count(r.count, limits.maxPageRows), size = count(r.bytes, limits.maxPageBytes);
  if (r.table_key !== key || r.fingerprint !== c.fingerprint || raw.length !== size
    || (size > 0 && raw[size - 1] !== 10) || sha(raw) !== hash(r.sha256)) invalid();
  let last = previous, rows = 0, start = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] === 10) {
    const id = validateEmployeeSafetyBackupRow(dec.decode(raw.subarray(start, i + 1)), key, c);
    if (!ordered(key, id, last) || ++rows > n) invalid();
    last = id; start = i + 1;
  }
  const next = r.next_after === null ? null : cursor(key, r.next_after);
  if (rows !== n || (next !== null && (rows === 0 || next !== last))) invalid();
  return { raw, count: n, bytes: size, next_after: next };
}
export function validateEmployeeSafetyBackupVerification(input: unknown, c: EmployeeSafetyBackupCatalog): void {
  const r = object(input, ['verified', 'fingerprint', ...Object.keys(FLAGS)]); flags(r);
  if (r.verified !== true || r.fingerprint !== c.fingerprint) invalid();
}

type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
export async function stopOwnedEmployeeSafetyBackup(password: string, confirmation: string, jobId: string | null = null, signal?: AbortSignal) {
  let sent = false;
  try {
    checkAbort(signal);
    if (!password || confirmation !== '確認停止員工備份任務') invalid();
    if (jobId !== null) uuid(jobId);
    const { data, error } = await withSignal(() => {
      const query = supabase.rpc('employee_safety_backup_stop_owned', {
        p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_admin_password: password,
        p_confirmation: confirmation, p_job_id: jobId,
      });
      sent = true;
      return signal ? query.abortSignal(signal) : query;
    }, signal);
    checkAbort(signal);
    if (error) invalid();
    const r = object(data, ['success', 'cancelled', 'job_id', 'scope', 'full_site_complete']);
    if (r.success !== true || typeof r.cancelled !== 'boolean' || r.scope !== 'employee-safety-records' || r.full_site_complete !== false) invalid();
    const id = r.job_id === null ? null : uuid(r.job_id);
    if ((r.cancelled && (id === null || (jobId !== null && jobId !== id))) || (!r.cancelled && id !== null)) invalid();
    return { success: true as const, cancelled: r.cancelled, jobId: id, fullSiteComplete: false as const };
  } catch {
    throw new EmployeeSafetyBackupError('stop', signal?.aborted === true, sent, 'not-written', false);
  } finally { password = ''; }
}
export function createEmployeeSafetyBackupSession(inputUsername: string, password: string): EmployeeSafetyBackupSession {
  const name = username(inputUsername);
  if (typeof password !== 'string' || !password.length) invalid();
  let attempted = false, busy = false, closed = false, baseline: EmployeeSafetyBackupCatalog | null = null;
  let identity: Readonly<EmployeeSafetyBackupIdentity> | null = null;
  const request = async <T>(phase: EmployeeSafetyBackupPhase, operation: () => Query, validate: (data: unknown) => T, signal?: AbortSignal): Promise<T> => {
    if (busy) throw new EmployeeSafetyBackupError(phase, false, false, 'not-written', false);
    busy = true; let sent = false;
    try {
      const { data, error } = await withSignal(() => { const query = operation(); sent = true; return signal ? query.abortSignal(signal) : query; }, signal);
      checkAbort(signal); if (error) invalid(); const result = validate(data); checkAbort(signal); return result;
    } catch { throw new EmployeeSafetyBackupError(phase, signal?.aborted === true, sent && (phase === 'begin' || phase === 'close'), 'not-written', false); }
    finally { busy = false; }
  };
  const args = () => {
    if (!identity || closed) invalid();
    return { p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: identity.job_token };
  };
  const bound = (input: EmployeeSafetyBackupCatalog) => {
    const c = validateEmployeeSafetyBackupCatalog(input); if (!baseline) invalid(); same(c, baseline); return c;
  };
  const session: EmployeeSafetyBackupSession = {
    begin(signal) {
      return request('begin', () => {
        if (attempted) invalid(); attempted = true;
        const secret = password; password = '';
        return supabase.rpc('employee_safety_backup_begin', { p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_admin_password: secret, p_username: name });
      }, value => {
        const r = object(value, ['success', 'job_id', 'job_token', 'site_id', 'catalog', 'scope', 'full_site_complete']);
        if (r.success !== true || r.scope !== 'employee-safety-records' || r.full_site_complete !== false) invalid();
        const c = validateEmployeeSafetyBackupCatalog(r.catalog);
        if (c.username !== name || c.job_id !== uuid(r.job_id) || c.site_id !== uuid(r.site_id)) invalid();
        baseline = validateEmployeeSafetyBackupCatalog(c);
        identity = Object.freeze({ job_id: c.job_id, job_token: uuid(r.job_token), site_id: c.site_id, employee_id: c.employee_id, username: c.username });
        return { success: true, job_id: c.job_id, job_token: identity.job_token, site_id: c.site_id, catalog: c, scope: 'employee-safety-records', full_site_complete: false };
      }, signal);
    },
    identity: () => identity,
    catalog(signal) {
      return request('catalog', () => supabase.rpc('get_employee_safety_backup_catalog', args()), value => {
        const c = validateEmployeeSafetyBackupCatalog(value); return bound(c);
      }, signal);
    },
    page(input, key, previous, signal) {
      let c: EmployeeSafetyBackupCatalog;
      return request('page', () => {
        c = bound(input); tableKey(key); if (previous !== null) cursor(key, previous);
        return supabase.rpc('get_employee_safety_backup_page', { ...args(), p_catalog_fingerprint: c.fingerprint, p_table_key: key, p_after: previous, p_limit: 200 });
      }, value => { validateEmployeeSafetyBackupPage(value, c, key, previous); return value; }, signal);
    },
    verify(input, signal) {
      let c: EmployeeSafetyBackupCatalog;
      return request('verify', () => { c = bound(input); return supabase.rpc('employee_safety_backup_verify', { ...args(), p_catalog_fingerprint: c.fingerprint }); },
        value => { validateEmployeeSafetyBackupVerification(value, c); return value; }, signal);
    },
    close(input, signal) {
      return request('close', () => {
        const c = bound(input); if (completedExports.get(session) !== c.fingerprint) invalid();
        // Once dispatched, even a lost close response must not be automatically repeated.
        const auth = args(); closed = true;
        return supabase.rpc('employee_safety_backup_close', { ...auth, p_catalog_fingerprint: c.fingerprint });
      }, value => {
        const r = object(value, ['success', 'scope', 'full_site_complete']);
        if (r.success !== true || r.scope !== 'employee-safety-records' || r.full_site_complete !== false) invalid();
        return { success: true, scope: 'employee-safety-records', full_site_complete: false };
      }, signal);
    },
  };
  return session;
}

async function* read(source: TransferByteSource, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') invalid();
  const iterator = source[Symbol.asyncIterator](); let ended = false;
  try {
    for (;;) {
      const next = await withSignal(() => iterator.next(), signal); checkAbort(signal);
      if (next.done) { ended = true; return; }
      if (!(next.value instanceof Uint8Array) || next.value.length > MAX_CONTAINER_INPUT_BYTES) invalid();
      yield new Uint8Array(next.value);
    }
  } finally { if (!ended) { try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* Nonblocking cancellation. */ } } }
}
class CipherScan {
  bytes = 0; private ended = false; private readonly hash = new Sha256();
  async *read(source: TransferByteSource, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    for await (const raw of read(source, signal)) {
      this.bytes += raw.length; if (this.bytes > limits.maxCipherBytes) invalid(); this.hash.update(raw); yield raw;
    }
    this.ended = true;
  }
  digest(): string { if (!this.ended || !this.bytes) invalid(); return this.hash.digestHex(); }
}
class Run {
  readonly controller = new AbortController(); readonly signal = this.controller.signal;
  phase: EmployeeSafetyBackupPhase = 'authenticate';
  fileState: EmployeeSafetyBackupError['encryptedFileState'] = 'not-written'; unknown = false;
  private readonly spaces: { workspace: ArchiveBundleWorkspace; cleanup?: Promise<void> }[] = [];
  private readonly cancel = () => this.controller.abort();
  constructor(readonly options: EmployeeSafetyBackupOptions, private readonly factory: ArchiveBundleWorkspaceFactory) {
    options.signal?.addEventListener('abort', this.cancel, { once: true }); if (options.signal?.aborted) this.cancel();
  }
  workspace(): ArchiveBundleWorkspace {
    checkAbort(this.signal); const w = this.factory(); if (this.spaces.some(item => item.workspace === w)) invalid();
    const item: { workspace: ArchiveBundleWorkspace; cleanup?: Promise<void> } = { workspace: w }; this.spaces.push(item);
    return { open: path => w.open(path), append: (path, raw, signal) => w.append(path, raw, signal),
      abort: reason => item.cleanup ??= Promise.resolve().then(() => w.abort(reason)) };
  }
  progress(rows: number, bytes: number): void {
    checkAbort(this.signal); this.options.onProgress?.({ phase: this.phase, rows, bytes, fullSiteComplete: false }); checkAbort(this.signal);
  }
  async finish<T>(operation: () => Promise<T>): Promise<T> {
    let result: T | undefined, failed = false, cleanupRequired = false;
    try { result = await operation(); checkAbort(this.signal); } catch { failed = true; this.controller.abort(); }
    finally {
      for (const item of this.spaces) {
        item.cleanup ??= Promise.resolve().then(() => item.workspace.abort(new Error('Employee safety backup plaintext discarded.')));
        try { await item.cleanup; } catch { cleanupRequired = true; }
      }
      this.options.signal?.removeEventListener('abort', this.cancel);
    }
    if (failed || cleanupRequired || this.signal.aborted) throw new EmployeeSafetyBackupError(this.phase,
      this.options.signal?.aborted === true, this.unknown, this.fileState, cleanupRequired);
    return result!;
  }
}
function containerLimits(maximum: number = limits.maxTotalBytes): Partial<ContainerLimits> {
  return { maxEntries: 49, maxEntryBytes: limits.maxTableBytes, maxTotalBytes: maximum,
    maxZipBytes: limits.maxZipBytes, maxManifestBytes: 65536, maxLineBytes: limits.maxLineBytes };
}
function volume(info: VolumeInfo, c: EmployeeSafetyBackupCatalog): void {
  if (info.scope !== 'replacement-backup' || info.volumeIndex !== 1 || info.volumeCount !== 1 || info.sourceSiteId !== c.site_id
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(info.exportId)
    || [c.job_id, c.employee_id].includes(info.exportId)) invalid();
}
class TableScan {
  private readonly line = new Uint8Array(limits.maxLineBytes);
  private readonly hash = new Sha256(); private readonly rowHashes = new Sha256();
  private used = 0; rows = 0; bytes = 0; last: string | null = null;
  constructor(private readonly table: EmployeeSafetyBackupCatalog['tables'][number], private readonly catalog: EmployeeSafetyBackupCatalog) {}
  push(raw: Uint8Array, signal: AbortSignal): void {
    checkAbort(signal); this.bytes += raw.length; if (this.bytes > this.table.bytes) invalid(); this.hash.update(raw);
    let start = 0;
    while (start < raw.length) {
      checkAbort(signal); const lf = raw.indexOf(10, start), end = lf < 0 ? raw.length : lf + 1;
      if (this.used + end - start > this.line.length) invalid();
      this.line.set(raw.subarray(start, end), this.used); this.used += end - start; start = end;
      if (lf >= 0) {
        const line = this.line.subarray(0, this.used), id = validateEmployeeSafetyBackupRow(dec.decode(line), this.table.key, this.catalog);
        if (!ordered(this.table.key, id, this.last) || ++this.rows > this.table.rows) invalid();
        this.last = id; this.rowHashes.update(enc.encode(sha(line))); this.used = 0;
      }
    }
  }
  finish(): ManifestEntry {
    if (this.used || this.rows !== this.table.rows || this.bytes !== this.table.bytes || this.rowHashes.digestHex() !== this.table.row_hashes_sha256) invalid();
    return { path: employeeSafetyBackupEntryPath(this.table.key), kind: 'ndjson', bytes: this.bytes, sha256: this.hash.digestHex() };
  }
}
async function validateSaved(workspace: ArchiveBundleWorkspace, manifest: VolumeManifest, signal: AbortSignal): Promise<EmployeeSafetyBackupCatalog> {
  const catalogEntry = manifest.entries[manifest.entries.length - 1];
  if (manifest.entries.length !== 49 || catalogEntry?.path !== EMPLOYEE_SAFETY_BACKUP_CATALOG_PATH || catalogEntry.kind !== 'ndjson'
    || !catalogEntry.bytes || catalogEntry.bytes > limits.maxCatalogBytes) invalid();
  const pieces: Uint8Array[] = []; let size = 0;
  for await (const raw of read(workspace.open(EMPLOYEE_SAFETY_BACKUP_CATALOG_PATH), signal)) {
    size += raw.length; if (size > catalogEntry.bytes) invalid(); pieces.push(raw);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const raw of pieces) { bytes.set(raw, offset); offset += raw.length; }
  if (size !== catalogEntry.bytes || sha(bytes) !== catalogEntry.sha256) invalid();
  const c = validateEmployeeSafetyBackupCatalog(JSON.parse(dec.decode(bytes)));
  // Metadata may be canonicalized, never rows. This also rejects duplicate catalog keys.
  const canonical = enc.encode(JSON.stringify(c) + '\n');
  if (canonical.length !== bytes.length || !canonical.every((v, i) => v === bytes[i])) invalid();
  volume(manifest, c);
  for (const [i, table] of c.tables.entries()) {
    const scan = new TableScan(table, c);
    for await (const raw of read(workspace.open(employeeSafetyBackupEntryPath(table.key)), signal)) scan.push(raw, signal);
    same(scan.finish(), manifest.entries[i]);
  }
  return c;
}
export async function exportEmployeeSafetyBackup(
  source: EmployeeSafetyBackupSource, file: ReplacementBackupFile, createWorkspace: ArchiveBundleWorkspaceFactory,
  passphrase: string, input: VolumeInfo, options: EmployeeSafetyBackupOptions = {},
): Promise<EmployeeSafetyBackupResult> {
  completedExports.delete(source);
  const run = new Run(options, createWorkspace), signal = run.signal; run.phase = 'records-export';
  const result = await run.finish(async () => {
    checkAbort(signal);
    const info = validateVolumeInfo(input), maximum = count(options.limits?.maxTotalBytes ?? limits.maxTotalBytes, limits.maxTotalBytes);
    if (!maximum) invalid();
    const c = validateEmployeeSafetyBackupCatalog(await withSignal(() => source.catalog(signal), signal)); volume(info, c);
    const catalogBytes = enc.encode(JSON.stringify(c) + '\n');
    if (catalogBytes.length + c.tables.reduce((n, t) => n + t.bytes, 0) > maximum) invalid();
    const snapshot = run.workspace(), expected: ManifestEntry[] = []; let rows = 0, bytes = catalogBytes.length;
    for (const table of c.tables) {
      const scan = new TableScan(table, c); let previous: string | null = null;
      do {
        const page = validateEmployeeSafetyBackupPage(await withSignal(() => source.page(c, table.key, previous, signal), signal), c, table.key, previous);
        scan.push(page.raw, signal);
        if ((page.next_after === null) !== (scan.rows === table.rows)) invalid();
        await withSignal(() => snapshot.append(employeeSafetyBackupEntryPath(table.key), page.raw, signal), signal);
        rows += page.count; bytes += page.bytes; run.progress(rows, bytes); previous = page.next_after;
      } while (previous !== null);
      expected.push(scan.finish());
    }
    await withSignal(() => snapshot.append(EMPLOYEE_SAFETY_BACKUP_CATALOG_PATH, catalogBytes, signal), signal);
    expected.push({ path: EMPLOYEE_SAFETY_BACKUP_CATALOG_PATH, kind: 'ndjson', bytes: catalogBytes.length, sha256: sha(catalogBytes) });
    run.phase = 'source-recheck'; run.progress(rows, bytes);
    validateEmployeeSafetyBackupVerification(await withSignal(() => source.verify(c, signal), signal), c);
    async function* entries(): AsyncGenerator<TransferEntry> {
      for (const e of expected) yield { path: e.path, bytes: e.bytes, open: () => snapshot.open(e.path) };
    }
    run.phase = 'save'; run.progress(rows, bytes);
    const written = new CipherScan(), encrypted = written.read(writeEncryptedVolume(entries(), info, passphrase, { signal, limits: containerLimits(maximum) }), signal);
    try {
      await withSignal(async () => { run.unknown = true; run.fileState = 'unknown'; await file.write(encrypted, signal); }, signal);
      checkAbort(signal); written.digest(); run.fileState = 'saved'; run.unknown = false;
    } finally { void encrypted.return(undefined).catch(() => undefined); }
    await snapshot.abort(new Error('Employee safety backup snapshot discarded.')); checkAbort(signal);
    run.phase = 'authenticate'; run.progress(rows, bytes);
    const readback = run.workspace(), saved = new CipherScan(), stream = saved.read(file.open(), signal);
    let manifest: VolumeManifest;
    try { manifest = await verifyEncryptedVolume(stream, passphrase, readback, { signal, limits: containerLimits(maximum), expectedMetadata: { exportId: info.exportId, volumeId: info.volumeId } }); }
    finally { void stream.return(undefined).catch(() => undefined); }
    if (saved.digest() !== written.digest() || saved.bytes !== written.bytes) invalid();
    same(Object.fromEntries(Object.keys(info).map(key => [key, manifest[key as keyof VolumeInfo]])), info); same(manifest.entries, expected);
    run.phase = 'validate'; same(await validateSaved(readback, manifest, signal), c);
    run.fileState = 'verified'; run.phase = 'target-recheck'; run.progress(rows, bytes);
    validateEmployeeSafetyBackupVerification(await withSignal(() => source.verify(c, signal), signal), c);
    return { backupId: info.exportId, catalog: c, manifest, rows, bytes, cipherBytes: saved.bytes, cipherSha256: saved.digest(), recordsVerified: true,
      ...FLAGS, recordsOnly: true, mediaIncluded: false, completeEmployeeBackup: false, canArchive: false, canReplace: false, fullSiteComplete: false } as EmployeeSafetyBackupResult;
  });
  completedExports.set(source, result.catalog.fingerprint);
  return result;
}
export interface AuthenticatedEmployeeSafetyBackup {
  readonly catalog: EmployeeSafetyBackupCatalog;
  readonly manifest: VolumeManifest;
  open(path: string): TransferByteSource;
}
export async function withAuthenticatedEmployeeSafetyBackup<T>(
  file: Pick<ReplacementBackupFile, 'open'>, passphrase: string, createWorkspace: ArchiveBundleWorkspaceFactory,
  consume: (reader: AuthenticatedEmployeeSafetyBackup) => Promise<T>,
  options: { expectedMetadata?: TransferMetadata; signal?: AbortSignal } = {},
): Promise<T> {
  const run = new Run(options, createWorkspace), signal = run.signal;
  return run.finish(async () => {
    const workspace = run.workspace();
    // Header identity is not trusted until complete ciphertext authentication.
    const expectedMetadata = options.expectedMetadata ?? await readTransferMetadata(read(file.open(), signal), signal);
    const scan = new CipherScan(), stream = scan.read(file.open(), signal);
    let manifest: VolumeManifest;
    try { manifest = await verifyEncryptedVolume(stream, passphrase, workspace, { signal, limits: containerLimits(), expectedMetadata }); }
    finally { void stream.return(undefined).catch(() => undefined); }
    scan.digest(); run.phase = 'validate';
    const catalog = await validateSaved(workspace, manifest, signal);
    const allowed = new Set(manifest.entries.map(e => e.path)); let active = true;
    const reader: AuthenticatedEmployeeSafetyBackup = Object.freeze({
      get catalog() { if (!active) invalid(); return validateEmployeeSafetyBackupCatalog(catalog); },
      get manifest() { if (!active) invalid(); return structuredClone(manifest); },
      open(path: string): TransferByteSource {
        if (!active || !allowed.has(path)) invalid();
        return { async *[Symbol.asyncIterator]() {
          if (!active) invalid();
          for await (const raw of read(workspace.open(path), signal)) { if (!active) invalid(); yield raw; }
          if (!active) invalid();
        } };
      },
    });
    run.phase = 'consume';
    try { return await withSignal(() => consume(reader), signal); }
    finally { active = false; }
  });
}
