import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { MAX_CONTAINER_INPUT_BYTES, writeEncryptedVolume, verifyEncryptedVolume, type ContainerLimits, type TransferEntry } from './container';
import type { TransferByteSource } from './crypto';
import type { ReplacementBackupFile } from './replacementBackup';
import type { ArchiveBundleWorkspace, ArchiveBundleWorkspaceFactory } from './archiveBundle';
import { validateVolumeInfo, type VolumeInfo, type VolumeManifest, type ManifestEntry } from './manifest';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';

export const EMPLOYEE_BACKUP_PROTOCOL = 'replacement-records-v1';
export const EMPLOYEE_BACKUP_CATALOG_PATH = 'data/employee-backup-catalog.ndjson';
export const EMPLOYEE_BACKUP_TABLE_KEYS = Object.freeze([
  'accounts', 'credentials', 'orders', 'wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions',
  'withdrawals', 'wallet_reconciliation_audit', 'employee_login_history', 'work_sessions', 'work_stop_markers',
  'verification_requests', 'dispatch_group_members', 'employee_submit_time_settings',
] as const);
export type EmployeeBackupTableKey = typeof EMPLOYEE_BACKUP_TABLE_KEYS[number];
export const EMPLOYEE_BACKUP_LIMITS = Object.freeze({
  maxRows: 500000, maxTableBytes: 268435456, maxTotalBytes: 1073741824,
  maxPageRows: 200, maxPageBytes: 262144, maxLineBytes: 65536, maxCatalogBytes: 65536,
});
const MISSING = ['chat', 'notifications', 'media', 'dispatch_configuration', 'used_order_data', 'orders_history', 'archive_evidence'];
const EXCLUDED = ['active_sessions', 'account_locks', 'detailed_orders', 'financial_operations'];
const FLAGS = { records_only: true, media_included: false, can_archive: false, can_replace: false, full_site_complete: false } as const;
const INCOMPLETE = { ...FLAGS, complete_employee_backup: false, backup_sealed: false } as const;
type Projection = Record<EmployeeBackupTableKey, Record<string, string>>;
const SPEC: Projection = {
  accounts: { id: 'uuid!', username: 'text!', password_hash: 'text!', employee_id: 'text!', is_verified: 'boolean', is_active: 'boolean', total_income: 'numeric', first_success_order_date: 'timestamp with time zone', created_by: 'uuid', remarks: 'text', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone', tags: 'text[]', is_pinned: 'boolean' },
  credentials: { id: 'uuid!', password_hash: 'text!', created_at: 'timestamp with time zone!', updated_at: 'timestamp with time zone!' },
  orders: { id: 'uuid!', user_id: 'uuid!', status: 'text!', commission_amount: 'numeric', commission_rate: 'numeric', created_at: 'timestamp with time zone', processed_at: 'timestamp with time zone' },
  wallets: { id: 'uuid!', user_id: 'uuid!', available_balance: 'numeric', frozen_balance: 'numeric', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone' },
  wallet_balance_baselines: { id: 'uuid!', user_id: 'uuid!', available_balance: 'numeric!', frozen_balance: 'numeric!', total_income: 'numeric!', last_ledger_id: 'bigint-text!', established_at: 'timestamp with time zone!' },
  wallet_ledger_entries: { id: 'bigint-text!', user_id: 'uuid!', operation_id: 'uuid!', source_type: 'text!', source_id: 'uuid!', event_type: 'text!', available_delta: 'numeric!', frozen_delta: 'numeric!', income_delta: 'numeric!', created_at: 'timestamp with time zone!' },
  wallet_transactions: { id: 'uuid!', user_id: 'uuid!', type: 'text!', amount: 'numeric!', balance_before: 'numeric!', balance_after: 'numeric!', reference_id: 'uuid', remarks: 'text', created_by: 'uuid', created_at: 'timestamp with time zone', operation_id: 'uuid' },
  withdrawals: { id: 'uuid!', user_id: 'uuid!', amount: 'numeric!', status: 'text!', audit_remark: 'text', audited_by: 'uuid', audited_at: 'timestamp with time zone', created_at: 'timestamp with time zone', last_operation_id: 'uuid' },
  wallet_reconciliation_audit: { id: 'bigint-text!', user_id: 'uuid!', available_before: 'numeric!', available_after: 'numeric!', frozen_before: 'numeric!', frozen_after: 'numeric!', income_before: 'numeric!', income_after: 'numeric!', pending_amount: 'numeric!', ledger_total: 'numeric!', reason: 'text!', repaired_at: 'timestamp with time zone!' },
  employee_login_history: { id: 'uuid!', user_id: 'uuid!', username: 'text!', employee_id: 'text!', action_type: 'text!', ip_address: 'text', user_agent: 'text', session_id: 'text', created_at: 'timestamp with time zone', device_info: 'jsonb', device_info_is_sql_null: 'boolean!' },
  work_sessions: { id: 'uuid!', user_id: 'uuid!', start_time: 'timestamp with time zone!', end_time: 'timestamp with time zone', duration_minutes: 'integer', created_at: 'timestamp with time zone', last_heartbeat_at: 'timestamp with time zone' },
  work_stop_markers: { id: 'uuid!', user_id: 'uuid!', stopped_at: 'timestamp with time zone!' },
  verification_requests: { id: 'uuid!', user_id: 'uuid!', real_name: 'text!', wallet_address: 'text!', phone: 'text!', email: 'text!', status: 'text!', audit_remark: 'text', audited_by: 'uuid', audited_at: 'timestamp with time zone', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone', id_front_url: 'text', id_back_url: 'text', selfie_url: 'text' },
  dispatch_group_members: { id: 'uuid!', group_id: 'uuid!', user_id: 'uuid!', assigned_by: 'uuid', assigned_at: 'timestamp with time zone' },
  employee_submit_time_settings: { id: 'uuid!', user_id: 'uuid!', group_id: 'uuid', min_seconds: 'integer', max_seconds: 'integer', created_at: 'timestamp with time zone' },
};
export interface EmployeeBackupCatalog {
  version: 1; protocol: typeof EMPLOYEE_BACKUP_PROTOCOL; scope: 'employee-replacement-records';
  job_id: string; source_site_id: string; package_id: string; target_site_id: string;
  source_employee_id: string; target_employee_id: string; username: string; source_fingerprint: string; fingerprint: string;
  tables: { key: EmployeeBackupTableKey; rows: number; bytes: number; row_hashes_sha256: string }[];
  projections: Projection; missing_domains: string[]; excluded_data: string[];
  records_only: true; complete_employee_backup: false; backup_sealed: false;
  media_included: false; can_archive: false; can_replace: false; full_site_complete: false;
}
export interface EmployeeBackupSession {
  catalog(signal?: AbortSignal): Promise<EmployeeBackupCatalog>;
  page(catalog: EmployeeBackupCatalog, key: EmployeeBackupTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(catalog: EmployeeBackupCatalog, signal?: AbortSignal): Promise<unknown>;
}
export type EmployeeBackupPhase = 'records-export' | 'source-recheck' | 'save' | 'authenticate' | 'target-recheck';
export interface EmployeeBackupOptions {
  signal?: AbortSignal;
  onProgress?: (value: { phase: EmployeeBackupPhase; rows: number; bytes: number; fullSiteComplete: false }) => void;
  limits?: { maxTotalBytes?: number };
}
export interface EmployeeBackupResult {
  backupId: string; catalog: EmployeeBackupCatalog; manifest: VolumeManifest;
  rows: number; bytes: number; cipherBytes: number; cipherSha256: string;
  recordsVerified: true; completeEmployeeBackup: false; mediaIncluded: false;
  canArchive: false; canReplace: false; fullSiteComplete: false; missingDomains: string[];
}
export class EmployeeBackupError extends Error {
  constructor(readonly phase: EmployeeBackupPhase, readonly cancelled: boolean, readonly outcomeUnknown: boolean,
    readonly encryptedFileState: 'not-written' | 'unknown' | 'saved' | 'verified', readonly cleanupRequired: boolean) {
    super('Employee records backup was not confirmed. Keep and inspect any independent encrypted file; a write may be incomplete or unconfirmed. '
      + 'No automatic retry, delete, rollback, sealing, archive, replacement or maintenance release was performed. This is not a complete employee backup.'
      + (cleanupRequired ? ' Temporary plaintext cleanup was not confirmed; do not reuse the workspace.' : ''));
    this.name = 'EmployeeBackupError';
  }
}
const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sha = (bytes: Uint8Array) => new Sha256().update(bytes).digestHex();
function invalid(): never { throw new Error('Invalid employee records backup.'); }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36) invalid();
  return dispatchTransferChecks.uuid(value);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64) invalid();
  return dispatchTransferChecks.hash(value);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > EMPLOYEE_BACKUP_LIMITS.maxPageBytes || value.includes('\0')) invalid();
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(); }
    else if (code >= 0xdc00 && code <= 0xdfff) invalid();
  }
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const n = count(length.value, maximum);
  if (Reflect.ownKeys(value).length !== n + 1) invalid();
  return Array.from({ length: n }, (_, i) => {
    const item = Object.getOwnPropertyDescriptor(value, String(i));
    if (!item?.enumerable || !('value' in item)) invalid();
    return item.value;
  });
}
function same(actual: unknown, expected: unknown): void {
  const stable = (value: unknown) => JSON.stringify(value, (_, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
    }
    return item;
  });
  if (stable(actual) !== stable(expected)) invalid();
}
function flagCheck(r: Record<string, unknown>, complete = false): void {
  for (const [key, expected] of Object.entries(complete ? INCOMPLETE : FLAGS)) if (r[key] !== expected) invalid();
  if (r.protocol !== EMPLOYEE_BACKUP_PROTOCOL) invalid();
}
function list(value: unknown, expected: string[]): string[] {
  const result = array(value, expected.length).map(text); same(result, expected); return result;
}
export function employeeBackupEntryPath(key: EmployeeBackupTableKey): string {
  if (!EMPLOYEE_BACKUP_TABLE_KEYS.includes(key)) invalid();
  return `data/employee-backup-${key}.ndjson`;
}
function cursor(key: EmployeeBackupTableKey, value: unknown): string {
  if (key !== 'wallet_ledger_entries' && key !== 'wallet_reconciliation_audit') return uuid(value);
  if (typeof value !== 'string' || value.length > 19 || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > 9223372036854775807n) invalid();
  return value;
}
function after(key: EmployeeBackupTableKey, value: string, previous: string | null): boolean {
  return previous === null || (key === 'wallet_ledger_entries' || key === 'wallet_reconciliation_audit'
    ? BigInt(value) > BigInt(previous) : value > previous);
}
export function validateEmployeeBackupCatalog(input: unknown): EmployeeBackupCatalog {
  const r = object(input, ['version', 'protocol', 'scope', 'job_id', 'source_site_id', 'package_id', 'target_site_id',
    'source_employee_id', 'target_employee_id', 'username', 'source_fingerprint', 'fingerprint', 'tables', 'projections',
    'missing_domains', 'excluded_data', ...Object.keys(INCOMPLETE)]);
  flagCheck(r, true);
  if (r.version !== 1 || r.scope !== 'employee-replacement-records') invalid();
  const projections = object(r.projections, EMPLOYEE_BACKUP_TABLE_KEYS), checked = {} as Projection;
  for (const key of EMPLOYEE_BACKUP_TABLE_KEYS) {
    const fields = object(projections[key], Object.keys(SPEC[key]));
    checked[key] = {};
    for (const [field, type] of Object.entries(SPEC[key])) { if (fields[field] !== type) invalid(); checked[key][field] = type; }
  }
  let total = 0;
  const raw = array(r.tables, 15);
  if (raw.length !== 15) invalid();
  const tables = EMPLOYEE_BACKUP_TABLE_KEYS.map((key, i) => {
    const t = object(raw[i], ['key', 'rows', 'bytes', 'row_hashes_sha256']);
    const rows = count(t.rows, EMPLOYEE_BACKUP_LIMITS.maxRows), bytes = count(t.bytes, EMPLOYEE_BACKUP_LIMITS.maxTableBytes);
    if (t.key !== key || (rows === 0) !== (bytes === 0)) invalid();
    const digest = hash(t.row_hashes_sha256);
    if (rows === 0 && digest !== sha(new Uint8Array())) invalid();
    total += bytes;
    if (key === 'accounts' && rows !== 1) invalid();
    if (['credentials', 'wallets', 'wallet_balance_baselines', 'work_stop_markers', 'employee_submit_time_settings'].includes(key) && rows > 1) invalid();
    return { key, rows, bytes, row_hashes_sha256: digest };
  });
  if (total > EMPLOYEE_BACKUP_LIMITS.maxTotalBytes) invalid();
  const result: EmployeeBackupCatalog = { version: 1, protocol: EMPLOYEE_BACKUP_PROTOCOL, scope: 'employee-replacement-records',
    job_id: uuid(r.job_id), source_site_id: uuid(r.source_site_id), package_id: uuid(r.package_id), target_site_id: uuid(r.target_site_id),
    source_employee_id: uuid(r.source_employee_id), target_employee_id: uuid(r.target_employee_id), username: text(r.username),
    source_fingerprint: hash(r.source_fingerprint), fingerprint: hash(r.fingerprint), tables, projections: checked,
    missing_domains: list(r.missing_domains, MISSING), excluded_data: list(r.excluded_data, EXCLUDED), ...INCOMPLETE };
  if (!result.username || enc.encode(JSON.stringify(result) + '\n').length > EMPLOYEE_BACKUP_LIMITS.maxCatalogBytes) invalid();
  return result;
}
function rowIdentity(line: string, key: EmployeeBackupTableKey, catalog: EmployeeBackupCatalog): string {
  const value: unknown = JSON.parse(line), row = object(value, Object.keys(catalog.projections[key]));
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '{') stack.push(new Set());
    else if (line[i] === '[') stack.push(null);
    else if (line[i] === '}' || line[i] === ']') stack.pop();
    else if (line[i] === '"') {
      const start = i;
      while (++i < line.length) { if (line[i] === '\\') i++; else if (line[i] === '"') break; }
      const token = text(JSON.parse(line.slice(start, i + 1)));
      let end = i + 1;
      while (/[\t\r ]/.test(line[end] ?? '') && end < line.length) end++;
      if (line[end] === ':') { const keys = stack[stack.length - 1]; if (!keys || keys.has(token)) invalid(); keys.add(token); }
    }
    if (stack.length > 64) invalid();
  }
  for (const [field, spec] of Object.entries(catalog.projections[key])) {
    const v = row[field], type = spec.replace(/!$/, '');
    if (v === null) { if (spec.endsWith('!')) invalid(); continue; }
    if (type === 'uuid') uuid(v);
    else if (type === 'bigint-text') {
      if (typeof v !== 'string' || v.length > 19 || !/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) > 9223372036854775807n) invalid();
    } else if (type === 'text') text(v);
    else if (type === 'boolean') { if (typeof v !== 'boolean') invalid(); }
    else if (type === 'integer') { if (typeof v !== 'number' || !Number.isInteger(v) || v < -2147483648 || v > 2147483647) invalid(); }
    else if (type === 'numeric') { if (typeof v !== 'number') invalid(); }
    else if (type === 'text[]') { for (const item of array(v, 65536)) if (item !== null) text(item); }
    else if (type === 'timestamp with time zone') {
      const t = text(v);
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(t) || !Number.isFinite(Date.parse(t))) invalid();
    }
  }
  const id = cursor(key, row.id);
  if (['accounts', 'credentials', 'wallets', 'wallet_balance_baselines', 'work_stop_markers'].includes(key) && id !== catalog.target_employee_id) invalid();
  if (key !== 'accounts' && key !== 'credentials' && row.user_id !== catalog.target_employee_id) invalid();
  if (key === 'accounts' && row.username !== catalog.username) invalid();
  if (key === 'orders' && row.status !== 'success' && row.status !== 'failure') invalid();
  if (key === 'employee_login_history' && ((row.session_id !== null && !/^history-[0-9a-f]{64}$/.test(text(row.session_id)))
    || (row.device_info_is_sql_null === true && row.device_info !== null))) invalid();
  return id;
}
export function validateEmployeeBackupPage(input: unknown, catalog: EmployeeBackupCatalog, key: EmployeeBackupTableKey, previous: string | null) {
  employeeBackupEntryPath(key);
  if (previous !== null) cursor(key, previous);
  const r = object(input, ['protocol', 'source_employee_id', 'target_employee_id', 'fingerprint', 'table_key', 'count', 'bytes',
    'ndjson', 'next_after', 'sha256', ...Object.keys(FLAGS)]);
  flagCheck(r);
  if (r.source_employee_id !== catalog.source_employee_id || r.target_employee_id !== catalog.target_employee_id
    || r.fingerprint !== catalog.fingerprint || r.table_key !== key) invalid();
  const raw = enc.encode(text(r.ndjson)), n = count(r.count, 200), size = count(r.bytes, 262144);
  if (raw.length !== size || raw.length > 262144 || (size && raw[size - 1] !== 10) || sha(raw) !== hash(r.sha256)) invalid();
  let last = previous, rows = 0, start = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] === 10) {
    const line = raw.subarray(start, i + 1);
    if (line.length > 65536) invalid();
    const id = rowIdentity(dec.decode(line), key, catalog);
    if (!after(key, id, last) || ++rows > n) invalid();
    last = id; start = i + 1;
  }
  const next = r.next_after === null ? null : cursor(key, r.next_after);
  if (rows !== n || (next !== null && (rows === 0 || next !== last))) invalid();
  return { raw, count: n, bytes: size, next_after: next };
}
export function validateEmployeeBackupVerification(input: unknown, catalog: EmployeeBackupCatalog): void {
  const r = object(input, ['verified', 'protocol', 'scope', 'source_employee_id', 'target_employee_id', 'fingerprint', 'missing_domains', ...Object.keys(INCOMPLETE)]);
  flagCheck(r, true);
  if (r.verified !== true || r.scope !== catalog.scope || r.source_employee_id !== catalog.source_employee_id
    || r.target_employee_id !== catalog.target_employee_id || r.fingerprint !== catalog.fingerprint) invalid();
  same(list(r.missing_domains, MISSING), catalog.missing_domains);
}

type AuthArgs = { p_admin_session_token: string; p_job_token: string; p_source_employee_id: string };
type CheckArgs = AuthArgs & { p_catalog_fingerprint: string };
type Calls = {
  get_employee_import_replacement_backup: AuthArgs;
  get_employee_import_replacement_backup_page: CheckArgs & { p_table_key: EmployeeBackupTableKey; p_after: string | null; p_limit: number };
  employee_import_replacement_backup_verify: CheckArgs;
};
type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
// Local typed SQL39 surface until the shared Database RPC registry is synchronized.
const client = supabase as unknown as { rpc<K extends keyof Calls>(name: K, args: Calls[K]): Query };
export function createEmployeeBackupSession(jobToken: string, sourceEmployeeId: string, expectedJobId?: string): EmployeeBackupSession {
  uuid(jobToken); uuid(sourceEmployeeId); if (expectedJobId !== undefined) uuid(expectedJobId);
  let busy = false, baseline: EmployeeBackupCatalog | null = null;
  const request = async <T>(operation: () => Query, validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> => {
    if (busy) invalid(); busy = true;
    try {
      const { data, error } = await withSignal(() => { const query = operation(); return signal ? query.abortSignal(signal) : query; }, signal);
      checkAbort(signal); if (error) invalid(); const value = validate(data); checkAbort(signal); return value;
    } catch {
      if (signal?.aborted) throw new DOMException('Employee backup read cancelled; no rollback or maintenance release was performed.', 'AbortError');
      invalid();
    } finally { busy = false; }
  };
  const args = (): AuthArgs => ({ p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: jobToken, p_source_employee_id: sourceEmployeeId });
  const bound = (input: EmployeeBackupCatalog): EmployeeBackupCatalog => {
    const checked = validateEmployeeBackupCatalog(input);
    if (!baseline) invalid(); same(checked, baseline); return checked;
  };
  return {
    catalog(signal) {
      return request(() => client.rpc('get_employee_import_replacement_backup', args()), value => {
        const checked = validateEmployeeBackupCatalog(value);
        if (checked.source_employee_id !== sourceEmployeeId || (expectedJobId && checked.job_id !== expectedJobId)) invalid();
        if (baseline) same(checked, baseline); else baseline = validateEmployeeBackupCatalog(checked);
        return checked;
      }, signal);
    },
    page(input, key, previous, signal) {
      let c: EmployeeBackupCatalog;
      return request(() => {
        c = bound(input); employeeBackupEntryPath(key); if (previous !== null) cursor(key, previous);
        return client.rpc('get_employee_import_replacement_backup_page', { ...args(), p_catalog_fingerprint: c.fingerprint, p_table_key: key, p_after: previous, p_limit: 200 });
      }, value => { validateEmployeeBackupPage(value, c, key, previous); return value; }, signal);
    },
    verify(input, signal) {
      let c: EmployeeBackupCatalog;
      return request(() => { c = bound(input); return client.rpc('employee_import_replacement_backup_verify', { ...args(), p_catalog_fingerprint: c.fingerprint }); },
        value => { validateEmployeeBackupVerification(value, c); return value; }, signal);
    },
  };
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
  } finally { if (!ended) { try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* Nonblocking close. */ } } }
}
class CipherScan {
  bytes = 0; ended = false; readonly hash = new Sha256();
  async *read(source: TransferByteSource, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    for await (const raw of read(source, signal)) {
      this.bytes += raw.length; if (this.bytes > EMPLOYEE_BACKUP_LIMITS.maxTotalBytes) invalid(); this.hash.update(raw); yield raw;
    }
    this.ended = true;
  }
  digest(): string { if (!this.ended || !this.bytes) invalid(); return this.hash.digestHex(); }
}
export async function exportEmployeeBackup(
  source: EmployeeBackupSession, file: ReplacementBackupFile, createWorkspace: ArchiveBundleWorkspaceFactory,
  passphrase: string, input: VolumeInfo, options: EmployeeBackupOptions = {},
): Promise<EmployeeBackupResult> {
  const controller = new AbortController(), signal = controller.signal, cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true }); if (options.signal?.aborted) cancel();
  let phase: EmployeeBackupPhase = 'records-export', fileState: EmployeeBackupError['encryptedFileState'] = 'not-written';
  let unknown = false, failed = false, cleanupRequired = false, result: EmployeeBackupResult | undefined;
  const spaces: { workspace: ArchiveBundleWorkspace; cleanup?: Promise<void> }[] = [];
  const workspace = () => {
    checkAbort(signal); const w = createWorkspace(); if (spaces.some(item => item.workspace === w)) invalid();
    const item: { workspace: ArchiveBundleWorkspace; cleanup?: Promise<void> } = { workspace: w }; spaces.push(item);
    return { open: (path: string) => w.open(path), append: (path: string, raw: Uint8Array, s?: AbortSignal) => w.append(path, raw, s),
      abort: (reason: unknown) => item.cleanup ??= Promise.resolve().then(() => w.abort(reason)) };
  };
  const progress = (rows: number, bytes: number) => { checkAbort(signal); options.onProgress?.({ phase, rows, bytes, fullSiteComplete: false }); checkAbort(signal); };
  try {
    checkAbort(signal);
    const info = validateVolumeInfo(input), maximum = count(options.limits?.maxTotalBytes ?? EMPLOYEE_BACKUP_LIMITS.maxTotalBytes, EMPLOYEE_BACKUP_LIMITS.maxTotalBytes);
    if (!maximum || info.scope !== 'replacement-backup' || info.volumeCount !== 1 || info.volumeIndex !== 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(info.exportId)) invalid();
    const c = validateEmployeeBackupCatalog(await withSignal(() => source.catalog(signal), signal));
    if (info.sourceSiteId !== c.target_site_id || [c.package_id, c.job_id, c.source_employee_id, c.target_employee_id].includes(info.exportId)) invalid();
    const catalogBytes = enc.encode(JSON.stringify(c) + '\n'), expected: ManifestEntry[] = [];
    if (catalogBytes.length + c.tables.reduce((n, t) => n + t.bytes, 0) > maximum) invalid();
    const snapshot = workspace(); let rows = 0, bytes = catalogBytes.length;
    for (const t of c.tables) {
      const digest = new Sha256(), rowHashes = new Sha256(); let n = 0, size = 0, previous: string | null = null;
      do {
        const p = validateEmployeeBackupPage(await withSignal(() => source.page(c, t.key, previous, signal), signal), c, t.key, previous);
        n += p.count; size += p.bytes;
        if (n > t.rows || size > t.bytes || (p.next_after === null) !== (n === t.rows)) invalid();
        digest.update(p.raw);
        let start = 0;
        for (let i = 0; i < p.raw.length; i++) if (p.raw[i] === 10) { rowHashes.update(enc.encode(sha(p.raw.subarray(start, i + 1)))); start = i + 1; }
        await withSignal(() => snapshot.append(employeeBackupEntryPath(t.key), p.raw, signal), signal);
        rows += p.count; bytes += p.bytes; progress(rows, bytes); previous = p.next_after;
      } while (previous !== null);
      if (n !== t.rows || size !== t.bytes || rowHashes.digestHex() !== t.row_hashes_sha256) invalid();
      expected.push({ path: employeeBackupEntryPath(t.key), kind: 'ndjson', bytes: size, sha256: digest.digestHex() });
    }
    await withSignal(() => snapshot.append(EMPLOYEE_BACKUP_CATALOG_PATH, catalogBytes, signal), signal);
    expected.push({ path: EMPLOYEE_BACKUP_CATALOG_PATH, kind: 'ndjson', bytes: catalogBytes.length, sha256: sha(catalogBytes) });
    phase = 'source-recheck'; progress(rows, bytes);
    validateEmployeeBackupVerification(await withSignal(() => source.verify(c, signal), signal), c);
    const limits: Partial<ContainerLimits> = { maxEntries: 16, maxEntryBytes: EMPLOYEE_BACKUP_LIMITS.maxTableBytes,
      maxTotalBytes: maximum, maxZipBytes: EMPLOYEE_BACKUP_LIMITS.maxTotalBytes, maxManifestBytes: 65536, maxLineBytes: 65536 };
    async function* entries(): AsyncGenerator<TransferEntry> {
      for (const e of expected) yield { path: e.path, bytes: e.bytes, open: () => snapshot.open(e.path) };
    }
    phase = 'save'; progress(rows, bytes);
    const written = new CipherScan(), encrypted = written.read(writeEncryptedVolume(entries(), info, passphrase, { signal, limits }), signal);
    try {
      await withSignal(async () => { unknown = true; fileState = 'unknown'; await file.write(encrypted, signal); }, signal);
      checkAbort(signal); written.digest(); fileState = 'saved'; unknown = false;
    } finally { void encrypted.return(undefined).catch(() => undefined); }
    await snapshot.abort(new Error('Employee backup snapshot plaintext discarded.')); checkAbort(signal);
    const readback = workspace(), saved = new CipherScan();
    phase = 'authenticate'; progress(rows, bytes);
    const stream = saved.read(file.open(), signal);
    let manifest: VolumeManifest;
    try { manifest = await verifyEncryptedVolume(stream, passphrase, readback, { signal, limits, expectedMetadata: { exportId: info.exportId, volumeId: info.volumeId } }); }
    finally { void stream.return(undefined).catch(() => undefined); }
    if (saved.digest() !== written.digest() || saved.bytes !== written.bytes) invalid();
    same(validateVolumeInfo(Object.fromEntries(Object.keys(info).map(k => [k, manifest[k as keyof VolumeInfo]]))), info);
    same(manifest.entries, expected);
    // Authenticated manifest hashes must also equal our independently checked original pages.
    // Re-read decrypted workspace bytes so cleanup/readback adapters cannot fake persistence.
    for (const entry of expected) {
      const digest = new Sha256(); let size = 0;
      for await (const raw of read(readback.open(entry.path), signal)) { size += raw.length; if (size > entry.bytes) invalid(); digest.update(raw); }
      if (size !== entry.bytes || digest.digestHex() !== entry.sha256) invalid();
    }
    fileState = 'verified'; phase = 'target-recheck'; progress(rows, bytes);
    validateEmployeeBackupVerification(await withSignal(() => source.verify(c, signal), signal), c);
    checkAbort(signal);
    result = { backupId: info.exportId, catalog: c, manifest, rows, bytes, cipherBytes: saved.bytes, cipherSha256: saved.digest(),
      recordsVerified: true, completeEmployeeBackup: false, mediaIncluded: false, canArchive: false, canReplace: false,
      fullSiteComplete: false, missingDomains: [...c.missing_domains] };
  } catch { failed = true; controller.abort(); }
  finally {
    for (const item of spaces) {
      item.cleanup ??= Promise.resolve().then(() => item.workspace.abort(new Error('Employee backup plaintext discarded.')));
      try { await item.cleanup; } catch { cleanupRequired = true; }
    }
    options.signal?.removeEventListener('abort', cancel);
  }
  if (failed || cleanupRequired || signal.aborted || !result) throw new EmployeeBackupError(phase, options.signal?.aborted === true, unknown, fileState, cleanupRequired);
  return result;
}
