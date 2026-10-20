import type { TemporaryTransferSink } from './container';
import type { TransferByteSource } from './crypto';
import type { VolumeManifest } from './manifest';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';

export const ARCHIVES_PROTOCOL = 'site-archives-v1';
export const ARCHIVES_TABLE_KEYS = Object.freeze([
  'content_audit_events', 'deleted_employee_accounts', 'deleted_employee_notifications',
  'content_audit_recipient_versions', 'deleted_employee_summaries', 'deleted_employee_withdrawals',
] as const);
export type ArchivesTableKey = typeof ARCHIVES_TABLE_KEYS[number];
export const ARCHIVES_TRANSFER_LIMITS = Object.freeze({
  maxRows: 500000, maxTableBytes: 256 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024,
  maxLineBytes: 65536, maxPageRows: 200, maxPageBytes: 262144,
  maxChunks: 500001, maxInputBytes: 1024 * 1024,
});
const limits = ARCHIVES_TRANSFER_LIMITS;
const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const EMPTY_HASH = new Sha256().digestHex();
const FLAGS = ['maintenance', 'financial_data_pending', 'dependencies_pending', 'replacement_ready', 'full_site_complete'] as const;
export interface ArchivesPending {
  maintenance: true; financial_data_pending: true; dependencies_pending: true;
  replacement_ready: false; full_site_complete: false;
}
export interface ArchivesTableCatalog {
  key: ArchivesTableKey; rows: number; bytes: number; row_hashes_sha256: string;
}
export interface ArchivesCatalog {
  version: 1; scope: 'site-archives'; site_id: string; package_id: string;
  tables: ArchivesTableCatalog[]; full_site_complete: false;
}
export type ArchivesCounts = Record<ArchivesTableKey, number>;
export const ARCHIVES_CONFLICT_REASONS = Object.freeze(['archive_reference_missing', 'archive_record_conflict'] as const);
export interface ArchivesPlan extends ArchivesPending {
  scope: 'site-archives'; checked: true; can_restore: boolean; counts: ArchivesCounts;
  conflicts: typeof ARCHIVES_CONFLICT_REASONS[number][]; plan_hash: string; media_pending: true;
}
export interface ArchivesStatus extends ArchivesPending {
  readonly scope: 'site-archives'; readonly started: boolean; readonly records_verified: boolean;
  readonly counts: Readonly<ArchivesCounts>; readonly chunks: Readonly<ArchivesCounts>;
  readonly completed_chunks: Readonly<ArchivesCounts>; readonly media_pending: true;
}
export interface ArchivesExportSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(key: ArchivesTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(signal?: AbortSignal): Promise<unknown>;
}
export interface ArchivesImportTarget {
  bind(catalog: ArchivesCatalog, signal?: AbortSignal): Promise<unknown>;
  stage(key: ArchivesTableKey, chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<unknown>;
  plan(signal?: AbortSignal): Promise<unknown>;
}
export interface ArchivesImportFiles {
  // Caller must authenticate the complete same-package encrypted volume through EOF first.
  // Reopen isolated, immutable plaintext only; this interface is not ciphertext verification.
  open(path: string): TransferByteSource | ReadableStream<Uint8Array>;
  abort(reason: unknown): Promise<void>;
}
export interface ArchivesProgress {
  scope: 'site-archives'; phase: 'export' | 'validate' | 'stage' | 'plan';
  tableKey?: ArchivesTableKey; rows: number; bytes: number; fullSiteComplete: false;
}
export interface ArchivesTransferOptions {
  signal?: AbortSignal; onProgress?: (progress: ArchivesProgress) => void;
}
export interface ArchivesExportResult {
  catalog: ArchivesCatalog; entries: { path: string; kind: 'ndjson'; bytes: number; sha256: string }[];
  rows: number; bytes: number; fullSiteComplete: false;
}
export interface ArchivesImportResult {
  plan: ArchivesPlan; rows: number; bytes: number; fullSiteComplete: false;
}
export class ArchivesTransferCleanupError extends Error {
  readonly cleanupRequired = true;
  constructor(readonly stagingMayExist = false) {
    super('Archives temporary plaintext cleanup was not confirmed. Do not reuse the workspace; reconcile any server staging.');
    this.name = 'ArchivesTransferCleanupError';
  }
}
export class ArchivesImportStagingMayExistError extends Error {
  readonly stagingMayExist = true;
  constructor(readonly cancelled: boolean) {
    super('Archives import stopped. Server staging may exist; read status and reconcile before explicitly resuming. No automatic retry, cancel, rollback, restore or close was performed.');
    this.name = 'ArchivesImportStagingMayExistError';
  }
}
function invalid(): never { throw new Error('Invalid archives transfer.'); }
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
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, max), own = Reflect.ownKeys(value);
  if (own.length !== size + 1 || own.some(key => typeof key !== 'string'
    || (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= size)))) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < size; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field)) invalid();
    result.push(field.value);
  }
  return result;
}
export function archivesTableKey(value: unknown): ArchivesTableKey {
  const key = ARCHIVES_TABLE_KEYS.find(key => value === key);
  if (!key) invalid();
  return key;
}
export function archivesEntryPath(key: ArchivesTableKey): string { return `data/archives-${archivesTableKey(key)}.ndjson`; }
function pending(record: Record<string, unknown>): ArchivesPending {
  if (record.maintenance !== true || record.financial_data_pending !== true || record.dependencies_pending !== true
    || record.replacement_ready !== false || record.full_site_complete !== false) invalid();
  return { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
}
function counts(value: unknown, max: number = limits.maxRows): ArchivesCounts {
  const record = object(value, ARCHIVES_TABLE_KEYS);
  return Object.fromEntries(ARCHIVES_TABLE_KEYS.map(key => [key, count(record[key], max)])) as ArchivesCounts;
}
export function validateArchivesCatalog(value: unknown): ArchivesCatalog {
  const record = object(value, ['version', 'scope', 'site_id', 'package_id', 'tables', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'site-archives' || record.full_site_complete !== false) invalid();
  const raw = array(record.tables, ARCHIVES_TABLE_KEYS.length);
  if (raw.length !== ARCHIVES_TABLE_KEYS.length) invalid();
  let total = 0;
  const tables = ARCHIVES_TABLE_KEYS.map((key, index) => {
    const table = object(raw[index], ['key', 'rows', 'bytes', 'row_hashes_sha256']);
    if (table.key !== key) invalid();
    const rows = count(table.rows, limits.maxRows), bytes = count(table.bytes, limits.maxTableBytes);
    const digest = hash(table.row_hashes_sha256);
    if ((rows === 0) !== (bytes === 0) || (rows === 0 && digest !== EMPTY_HASH)) invalid();
    total += bytes;
    return { key, rows, bytes, row_hashes_sha256: digest };
  });
  if (total > limits.maxTotalBytes) invalid();
  return { version: 1, scope: 'site-archives', site_id: uuid(record.site_id), package_id: uuid(record.package_id), tables, full_site_complete: false };
}
export function validateArchivesPlan(value: unknown): ArchivesPlan {
  const record = object(value, ['scope', 'checked', 'can_restore', 'counts', 'conflicts', 'plan_hash', 'media_pending', ...FLAGS]);
  if (record.scope !== 'site-archives' || record.checked !== true || typeof record.can_restore !== 'boolean' || record.media_pending !== true) invalid();
  const conflicts = array(record.conflicts, ARCHIVES_CONFLICT_REASONS.length).map(value => {
    const reason = ARCHIVES_CONFLICT_REASONS.find(reason => reason === value);
    if (!reason) invalid();
    return reason;
  });
  if (new Set(conflicts).size !== conflicts.length || (record.can_restore && conflicts.length !== 0)) invalid();
  return { scope: 'site-archives', checked: true, can_restore: record.can_restore, counts: counts(record.counts),
    conflicts, plan_hash: hash(record.plan_hash), media_pending: true, ...pending(record) };
}
export function validateArchivesStatus(value: unknown): ArchivesStatus {
  const record = object(value, ['scope', 'started', 'records_verified', 'counts', 'chunks', 'completed_chunks', 'media_pending', ...FLAGS]);
  if (record.scope !== 'site-archives' || typeof record.started !== 'boolean' || typeof record.records_verified !== 'boolean'
    || record.media_pending !== true || (!record.started && record.records_verified)) invalid();
  const totals = counts(record.counts), chunks = counts(record.chunks, limits.maxChunks), completed = counts(record.completed_chunks, limits.maxChunks);
  for (const key of ARCHIVES_TABLE_KEYS) {
    if (completed[key] > chunks[key] || (!record.started && (chunks[key] !== 0 || completed[key] !== 0))
      || (record.started && (chunks[key] > Math.max(1, totals[key]) || chunks[key] < Math.ceil(totals[key] / limits.maxPageRows)))
      || (record.records_verified && completed[key] !== chunks[key])) invalid();
  }
  // Chunk counts are server-owned: byte-limited staging can create more than ceil(rows/200).
  return Object.freeze({ scope: 'site-archives', started: record.started, records_verified: record.records_verified,
    counts: Object.freeze(totals), chunks: Object.freeze(chunks), completed_chunks: Object.freeze(completed), media_pending: true, ...pending(record) });
}
export function validateArchivesVerification(value: unknown): {
  verified: true; scope: 'site-archives'; media_pending: true; full_site_complete: false;
} {
  const record = object(value, ['verified', 'scope', 'media_pending', 'full_site_complete']);
  if (record.verified !== true || record.scope !== 'site-archives' || record.media_pending !== true || record.full_site_complete !== false) invalid();
  return { verified: true, scope: 'site-archives', media_pending: true, full_site_complete: false };
}
export function validateArchivesBind(value: unknown): {
  success: true; scope: 'site-archives'; media_pending: true; full_site_complete: false; repeated: boolean;
} {
  const record = object(value, ['success', 'scope', 'media_pending', 'full_site_complete', 'repeated']);
  if (record.success !== true || record.scope !== 'site-archives' || record.media_pending !== true || record.full_site_complete !== false
    || typeof record.repeated !== 'boolean') invalid();
  return { success: true, scope: 'site-archives', media_pending: true, full_site_complete: false, repeated: record.repeated };
}
export function validateArchivesClose(value: unknown): {
  success: true; scope: 'site-archives'; media_pending: true; full_site_complete: false;
} {
  const record = object(value, ['success', 'scope', 'media_pending', 'full_site_complete']);
  if (record.success !== true || record.scope !== 'site-archives' || record.media_pending !== true || record.full_site_complete !== false) invalid();
  return { success: true, scope: 'site-archives', media_pending: true, full_site_complete: false };
}
// Isolated six-entry manifest only; never substitutes for authenticating the entire ciphertext.
export function validateArchivesManifest(manifest: VolumeManifest, input: ArchivesCatalog): void {
  const catalog = validateArchivesCatalog(input);
  const record = object(manifest, ['version', 'scope', 'exportId', 'volumeId', 'sourceSiteId', 'createdAt', 'volumeIndex', 'volumeCount', 'entries']);
  if (record.version !== 1 || record.scope !== 'replacement-backup' || record.exportId !== catalog.package_id
    || record.sourceSiteId !== catalog.site_id || record.volumeIndex !== 1 || record.volumeCount !== 1) invalid();
  uuid(record.volumeId); timestamp(record.createdAt);
  const entries = array(record.entries, ARCHIVES_TABLE_KEYS.length);
  if (entries.length !== ARCHIVES_TABLE_KEYS.length) invalid();
  for (let index = 0; index < ARCHIVES_TABLE_KEYS.length; index++) {
    const entry = object(entries[index], ['path', 'kind', 'bytes', 'sha256']);
    if (entry.path !== archivesEntryPath(catalog.tables[index].key) || entry.kind !== 'ndjson'
      || entry.bytes !== catalog.tables[index].bytes) invalid();
    hash(entry.sha256);
  }
}
function unicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) invalid();
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
}
function timestamp(value: unknown): void {
  if (typeof value !== 'string') invalid();
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.[0-9]{1,6})?(Z|\+00:00)$/.exec(value);
  if (!match || match[0].length !== value.length) invalid();
  const [, ys, ms, ds, hs, mins, ss] = match;
  const y = Number(ys), m = Number(ms), d = Number(ds);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hs) > 23 || Number(mins) > 59 || Number(ss) > 59) invalid();
}
// Fixed source-scope inventory, not a runtime schema or permission to insert private tables.
// actor_admin_id is nullable in the final events schema. Virtual tables remain independent archives.
const SPEC: Record<ArchivesTableKey, Record<string, string>> = {
  content_audit_events: { id: 'uuid!', operation_id: 'uuid!', entity_type: 'text!', entity_id: 'uuid!', action: 'text!',
    owner_admin_id: 'uuid!', owner_username: 'text', actor_admin_id: 'uuid', actor_username: 'text!', actor_role: 'text!',
    customer_id: 'uuid', employee_id: 'uuid', occurred_at: 'time!', before_data: 'jsonb', after_data: 'jsonb', media_refs: 'jsonb!',
    clear_reason: 'text', clear_started_at: 'time', cleared_at: 'time', cleared_by: 'uuid', cleared_username: 'text',
    employee_account: 'text', message_created_at: 'time', before_data_sql_null: 'boolean!', after_data_sql_null: 'boolean!' },
  deleted_employee_accounts: { id: 'uuid!', operation_id: 'uuid!', employee_id: 'uuid!', account_username: 'text', employee_number: 'text',
    account_created_at: 'time', account_remarks: 'text', owner_admin_id: 'uuid!', owner_username: 'text', actor_admin_id: 'uuid!',
    actor_username: 'text!', actor_role: 'text!', deletion_source: 'text!', deleted_at: 'time!', cleared_at: 'time', cleared_by: 'uuid',
    cleared_username: 'text', clear_reason: 'text', account_real_name: 'text' },
  deleted_employee_notifications: { id: 'uuid!', record_id: 'uuid!', message_id: 'uuid!', message_data: 'jsonb', recipient_data: 'jsonb',
    archived_event_id: 'uuid', cleared_at: 'time', cleared_by: 'uuid', clear_reason: 'text',
    message_data_sql_null: 'boolean!', recipient_data_sql_null: 'boolean!' },
  content_audit_recipient_versions: { id: 'text!', message_id: 'uuid!', recipient_id: 'uuid!', recipient_data: 'jsonb!' },
  deleted_employee_summaries: { id: 'uuid!', employee_id: 'uuid!', source_present: 'boolean!', is_verified: 'boolean',
    total_income: 'numeric', available_balance: 'numeric', frozen_balance: 'numeric', total_orders: 'bigint!' },
  deleted_employee_withdrawals: { id: 'text!', record_id: 'uuid!', withdrawal_id: 'uuid!', employee_id: 'uuid!', amount: 'numeric!',
    status: 'text!', created_at: 'time' },
};
const FORBIDDEN_KEYS = new Set([
  'delivery_claim_token', 'delivery_claim_channel', 'delivery_claim_until', 'delivery_completed_claim_token',
  'password', 'password_hash', 'current_session_token', 'current_tab_id',
  'session_token', 'token_hash', 'access_token', 'refresh_token', 'service_role_key', 'anon_key',
]);
export function archivesCursor(key: ArchivesTableKey, value: unknown): string {
  archivesTableKey(key);
  if (typeof value !== 'string') invalid();
  if (key === 'content_audit_recipient_versions' || key === 'deleted_employee_withdrawals') {
    if (value.length !== 73 || value[36] !== ':') invalid();
    uuid(value.slice(0, 36)); uuid(value.slice(37));
  } else uuid(value);
  return value;
}
// Every nested object is checked on the original JSON, including escaped-equivalent keys.
// Snapshot JSON is never executed. Free text is not scanned for guessed secrets or rewritten.
function checkJson(line: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '{' || char === '[') {
      // Row depth one plus at most 32 nested snapshot containers.
      if (stack.length === 33) invalid();
      stack.push(char === '{' ? new Set<string>() : null);
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = index;
      while (++index < line.length) {
        if (line[index] === '\\') index++;
        else if (line[index] === '"') break;
      }
      const decoded: unknown = JSON.parse(line.slice(start, index + 1));
      if (typeof decoded !== 'string') invalid();
      unicode(decoded);
      let after = index + 1;
      while (line[after] === ' ' || line[after] === '\t' || line[after] === '\r' || line[after] === '\n') after++;
      if (line[after] === ':') {
        const keys = stack[stack.length - 1];
        if (!keys || keys.has(decoded) || FORBIDDEN_KEYS.has(decoded)) invalid();
        keys.add(decoded);
      }
    }
  }
}
export function validateArchivesRow(line: string, key: ArchivesTableKey): string {
  if (typeof line !== 'string' || line.length > limits.maxLineBytes) invalid();
  unicode(line);
  const bytes = encoder.encode(line);
  if (bytes.length + (line.endsWith('\n') ? 0 : 1) > limits.maxLineBytes
    || (line.endsWith('\n') ? line.slice(0, -1) : line).includes('\n')) invalid();
  let parsed: unknown;
  try { checkJson(line); parsed = JSON.parse(line); } catch { invalid(); }
  const spec = SPEC[archivesTableKey(key)], row = object(parsed, Object.keys(spec));
  for (const [field, type] of Object.entries(spec)) {
    const value = row[field];
    // Nonnullable jsonb still admits JSON null; nullable JSON columns use explicit SQL-null markers.
    if (value === null) { if (type.endsWith('!') && type !== 'jsonb!') invalid(); continue; }
    switch (type.replace('!', '')) {
      case 'uuid': uuid(value); break;
      case 'text': if (typeof value !== 'string') invalid(); break;
      case 'boolean': if (typeof value !== 'boolean') invalid(); break;
      case 'time': timestamp(value); break;
      case 'bigint':
        if (typeof value !== 'string' || value.length > 19 || !/^(0|[1-9][0-9]*)(?![\s\S])/.test(value)
          || (value.length === 19 && value > '9223372036854775807')) invalid();
        break;
      // JSON syntax establishes numeric tokens, not JS floating-point accuracy. Even 1e400 may
      // be valid PostgreSQL numeric. SQL owns precision/range; the ORIGINAL text is always sent.
      case 'numeric': if (typeof value !== 'number') invalid(); break;
      case 'jsonb': break;
      default: invalid();
    }
  }
  for (const field of key === 'content_audit_events' ? ['before_data', 'after_data']
    : key === 'deleted_employee_notifications' ? ['message_data', 'recipient_data'] : []) {
    if (row[`${field}_sql_null`] === true && row[field] !== null) invalid();
  }
  if (key === 'content_audit_recipient_versions' && row.id !== `${row.message_id}:${row.recipient_id}`) invalid();
  if (key === 'deleted_employee_withdrawals' && row.id !== `${row.record_id}:${row.withdrawal_id}`) invalid();
  return archivesCursor(key, row.id);
}
export interface ArchivesPage {
  table_key: ArchivesTableKey; count: number; ndjson: string; next_after: string | null; sha256: string;
}
export function validateArchivesPage(value: unknown, key: ArchivesTableKey, after: string | null): ArchivesPage {
  const record = object(value, ['table_key', 'count', 'ndjson', 'next_after', 'sha256']);
  if (record.table_key !== archivesTableKey(key) || typeof record.ndjson !== 'string' || record.ndjson.length > limits.maxPageBytes) invalid();
  unicode(record.ndjson);
  const bytes = encoder.encode(record.ndjson), size = count(record.count, limits.maxPageRows);
  if (bytes.length > limits.maxPageBytes || (bytes.length > 0 && bytes[bytes.length - 1] !== 10)
    || new Sha256().update(bytes).digestHex() !== hash(record.sha256)) invalid();
  let last = after === null ? null : archivesCursor(key, after), rows = 0, start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    if (end - start + 1 > limits.maxLineBytes) invalid();
    const id = validateArchivesRow(decoder.decode(bytes.subarray(start, end)), key);
    // Fixed ASCII cursors compare exactly as PostgreSQL text COLLATE "C".
    if (last !== null && id <= last) invalid();
    last = id; rows++; start = end + 1;
  }
  const next = record.next_after === null ? null : archivesCursor(key, record.next_after);
  if (rows !== size || (next !== null && (size === 0 || next !== last))) invalid();
  return { table_key: key, count: size, ndjson: record.ndjson, next_after: next, sha256: hash(record.sha256) };
}
export function validateArchivesStage(value: unknown, rows: number, bytes: number, digest: string): {
  success: true; rows: number; bytes: number; sha256: string; repeated: boolean;
} {
  const record = object(value, ['success', 'rows', 'bytes', 'sha256', 'repeated']);
  if (record.success !== true || typeof record.repeated !== 'boolean' || record.rows !== rows || record.bytes !== bytes || hash(record.sha256) !== digest) invalid();
  return { success: true, rows, bytes, sha256: digest, repeated: record.repeated };
}
class TableVerifier {
  private readonly line = new Uint8Array(limits.maxLineBytes);
  private readonly digest = new Sha256();
  private readonly rowHashes = new Sha256();
  private last: string | null = null;
  private used = 0;
  private rows = 0;
  private bytes = 0;
  constructor(private readonly expected: ArchivesTableCatalog) {}
  async push(input: Uint8Array, signal?: AbortSignal, onLine?: (text: string, raw: Uint8Array) => Promise<void>): Promise<void> {
    checkAbort(signal);
    if (!(input instanceof Uint8Array) || input.length > limits.maxInputBytes) invalid();
    this.bytes += input.length;
    if (this.bytes > this.expected.bytes) invalid();
    const chunk = new Uint8Array(input);
    this.digest.update(chunk);
    let start = 0;
    while (start < chunk.length) {
      checkAbort(signal);
      const lf = chunk.indexOf(10, start), end = lf === -1 ? chunk.length : lf + 1;
      if (this.used + end - start > this.line.length) invalid();
      this.line.set(chunk.subarray(start, end), this.used); this.used += end - start; start = end;
      if (lf !== -1) {
        if (++this.rows > this.expected.rows) invalid();
        const raw = this.line.subarray(0, this.used), text = decoder.decode(raw);
        const id = validateArchivesRow(text, this.expected.key);
        if (this.last !== null && id <= this.last) invalid();
        this.last = id;
        this.rowHashes.update(encoder.encode(new Sha256().update(raw).digestHex()));
        if (onLine) await onLine(text, raw);
        checkAbort(signal); this.used = 0;
      }
    }
  }
  finish(): string {
    if (this.used || this.rows !== this.expected.rows || this.bytes !== this.expected.bytes || this.rowHashes.digestHex() !== this.expected.row_hashes_sha256) invalid();
    return this.digest.digestHex();
  }
}
export async function exportArchivesData(
  source: ArchivesExportSource, sink: TemporaryTransferSink, options: ArchivesTransferOptions = {},
): Promise<ArchivesExportResult> {
  const { signal, onProgress } = options;
  try {
    const catalog = validateArchivesCatalog(await withSignal(() => source.catalog(signal), signal));
    const entries: ArchivesExportResult['entries'] = [];
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      const verifier = new TableVerifier(table), path = archivesEntryPath(table.key);
      let after: string | null = null;
      do {
        const page = validateArchivesPage(await withSignal(() => source.page(table.key, after, signal), signal), table.key, after);
        const raw = encoder.encode(page.ndjson), pageBytes = raw.length;
        await verifier.push(raw, signal);
        await withSignal(() => sink.append(path, raw, signal), signal);
        checkAbort(signal);
        rows += page.count; bytes += pageBytes;
        onProgress?.({ scope: 'site-archives', phase: 'export', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal); after = page.next_after;
      } while (after !== null);
      entries.push({ path, kind: 'ndjson', bytes: table.bytes, sha256: verifier.finish() });
    }
    validateArchivesVerification(await withSignal(() => source.verify(signal), signal));
    checkAbort(signal);
    return { catalog, entries, rows, bytes, fullSiteComplete: false };
  } catch {
    try { await sink.abort(new Error('Archives export discarded.')); } catch { throw new ArchivesTransferCleanupError(); }
    checkAbort(signal);
    throw new Error('Archives export validation, source verification or temporary write failed.');
  }
}
async function scanTable(
  files: ArchivesImportFiles, table: ArchivesTableCatalog, signal?: AbortSignal,
  onLine?: (text: string, raw: Uint8Array) => Promise<void>,
): Promise<void> {
  checkAbort(signal);
  const source = files.open(archivesEntryPath(table.key));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  if (source && 'getReader' in source && typeof source.getReader === 'function') reader = source.getReader();
  else if (source && Symbol.asyncIterator in source && typeof source[Symbol.asyncIterator] === 'function') iterator = source[Symbol.asyncIterator]();
  else invalid();
  const verifier = new TableVerifier(table);
  let ended = false;
  try {
    while (true) {
      const next = reader ? await withSignal(() => reader!.read(), signal) : await withSignal(() => iterator!.next(), signal);
      checkAbort(signal);
      if (next.done) { ended = true; break; }
      await verifier.push(next.value, signal, onLine);
    }
    verifier.finish();
  } finally {
    if (reader) {
      try { if (!ended) void reader.cancel().catch(() => undefined); } finally { reader.releaseLock(); }
    } else if (!ended && iterator?.return) {
      try { void Promise.resolve(iterator.return()).catch(() => undefined); } catch { /* Do not await a blocked producer. */ }
    }
  }
}
export async function stageArchivesImport(
  input: unknown, files: ArchivesImportFiles, target: ArchivesImportTarget, options: ArchivesTransferOptions = {},
): Promise<ArchivesImportResult> {
  const { signal, onProgress } = options;
  let stagingMayExist = false;
  let outcome: { result: ArchivesImportResult } | { error: true };
  try {
    checkAbort(signal);
    const catalog = validateArchivesCatalog(input);
    let checkedRows = 0, checkedBytes = 0;
    for (const table of catalog.tables) {
      await scanTable(files, table, signal);
      checkedRows += table.rows; checkedBytes += table.bytes;
      onProgress?.({ scope: 'site-archives', phase: 'validate', tableKey: table.key, rows: checkedRows, bytes: checkedBytes, fullSiteComplete: false });
      checkAbort(signal);
    }
    validateArchivesBind(await withSignal(() => {
      stagingMayExist = true;
      return target.bind(validateArchivesCatalog(catalog), signal);
    }, signal));
    checkAbort(signal);
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      let chunkNo = 0, pageRows = 0, pageBytes = 0, page = '', digest = new Sha256();
      const flush = async () => {
        count(chunkNo, limits.maxChunks - 1);
        validateArchivesStage(await withSignal(() => target.stage(table.key, chunkNo, page, signal), signal), pageRows, pageBytes, digest.digestHex());
        checkAbort(signal);
        rows += pageRows; bytes += pageBytes; chunkNo++;
        pageRows = 0; pageBytes = 0; page = ''; digest = new Sha256();
        onProgress?.({ scope: 'site-archives', phase: 'stage', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal);
      };
      await scanTable(files, table, signal, async (text, raw) => {
        if (pageBytes + raw.length > limits.maxPageBytes) await flush();
        page += text; pageRows++; pageBytes += raw.length; digest.update(raw);
        if (pageRows === limits.maxPageRows || pageBytes === limits.maxPageBytes) await flush();
      });
      if (pageRows || chunkNo === 0) await flush();
    }
    const plan = validateArchivesPlan(await withSignal(() => target.plan(signal), signal));
    if (catalog.tables.some(table => plan.counts[table.key] !== table.rows)) invalid();
    checkAbort(signal);
    onProgress?.({ scope: 'site-archives', phase: 'plan', rows, bytes, fullSiteComplete: false });
    checkAbort(signal);
    outcome = { result: { plan, rows, bytes, fullSiteComplete: false } };
  } catch { outcome = { error: true }; }
  try { await files.abort(new Error('Archives import plaintext discarded.')); }
  catch { throw new ArchivesTransferCleanupError(stagingMayExist); }
  if (signal?.aborted && stagingMayExist) throw new ArchivesImportStagingMayExistError(true);
  if ('error' in outcome) {
    if (stagingMayExist) throw new ArchivesImportStagingMayExistError(signal?.aborted === true);
    checkAbort(signal);
    throw new Error('Archives import stopped before server staging began.');
  }
  checkAbort(signal);
  return outcome.result;
}
