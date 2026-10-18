import type { TemporaryTransferSink } from './container';
import type { TransferByteSource } from './crypto';
import type { VolumeManifest } from './manifest';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import { validateIdentityCatalog, type IdentityCatalog } from './identityTransfer';

export const ACTIVITY_PROTOCOL = 'employee-activity-v1';
export const ACTIVITY_TABLE_KEYS = Object.freeze([
  'employee_login_history', 'work_sessions', 'work_stop_markers',
] as const);
export type ActivityTableKey = typeof ACTIVITY_TABLE_KEYS[number];
export const ACTIVITY_TRANSFER_LIMITS = Object.freeze({
  maxRows: 500000, maxTableBytes: 256 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024,
  maxLineBytes: 64 * 1024, maxPageRows: 200, maxPageBytes: 256 * 1024,
  maxChunks: 500001, maxInputBytes: 1024 * 1024,
});
const limits = ACTIVITY_TRANSFER_LIMITS;
const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const FLAGS = ['maintenance', 'financial_data_pending', 'dependencies_pending', 'replacement_ready', 'full_site_complete'] as const;
export interface ActivityPending {
  maintenance: true; financial_data_pending: true; dependencies_pending: true;
  replacement_ready: false; full_site_complete: false;
}
export interface ActivityTableCatalog {
  key: ActivityTableKey; rows: number; bytes: number; row_hashes_sha256: string;
}
export interface ActivityCatalog {
  version: 1; scope: 'employee-activity'; site_id: string; package_id: string;
  identity_catalog: IdentityCatalog; tables: ActivityTableCatalog[]; full_site_complete: false;
}
export type ActivityCounts = Record<ActivityTableKey, number>;
export const ACTIVITY_CONFLICT_REASONS = Object.freeze([
  'activity_target_not_empty', 'activity_uuid_collision', 'source_employee_missing', 'work_duration_out_of_range',
] as const);
export interface ActivityPlan extends ActivityPending {
  scope: 'employee-activity'; can_restore: boolean; counts: ActivityCounts;
  employees: number; running_work_sessions: number;
  conflicts: typeof ACTIVITY_CONFLICT_REASONS[number][]; plan_hash: string;
}
export interface ActivityVerifyReceipt extends ActivityPending {
  success: true; scope: 'employee-activity'; counts: ActivityCounts;
  completed_employees: number; total_employees: number; verified: true; repeated: boolean;
}
export interface ActivityApplyReceipt extends ActivityVerifyReceipt { employee_id: string }
export type ActivityReceipt = ActivityApplyReceipt | ActivityVerifyReceipt;
export interface ActivityExportSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(key: ActivityTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(signal?: AbortSignal): Promise<unknown>;
}
export interface ActivityImportTarget {
  bind(catalog: ActivityCatalog, signal?: AbortSignal): Promise<unknown>;
  stage(key: ActivityTableKey, chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<unknown>;
  plan(signal?: AbortSignal): Promise<unknown>;
}
export interface ActivityImportFiles {
  // Only reopen isolated immutable files after authenticating the entire volume through EOF.
  open(path: string): TransferByteSource | ReadableStream<Uint8Array>;
  // Invalidate pending reads/writes and discard all temporary plaintext, including on success.
  abort(reason: unknown): Promise<void>;
}
export interface ActivityProgress {
  scope: 'employee-activity'; phase: 'export' | 'validate' | 'stage' | 'plan';
  tableKey?: ActivityTableKey; rows: number; bytes: number; fullSiteComplete: false;
}
export interface ActivityTransferOptions {
  signal?: AbortSignal; onProgress?: (progress: ActivityProgress) => void;
}
export interface ActivityExportResult {
  catalog: ActivityCatalog; entries: { path: string; kind: 'ndjson'; bytes: number; sha256: string }[];
  rows: number; bytes: number; fullSiteComplete: false;
}
export interface ActivityImportResult {
  plan: ActivityPlan; rows: number; bytes: number; fullSiteComplete: false;
}
export class ActivityTransferCleanupError extends Error {
  readonly cleanupRequired = true;
  constructor(readonly stagingMayExist = false) {
    super('Employee activity temporary plaintext cleanup was not confirmed. Do not reuse the workspace; reconcile any server staging.');
    this.name = 'ActivityTransferCleanupError';
  }
}
export class ActivityImportStagingMayExistError extends Error {
  readonly stagingMayExist = true;
  constructor(readonly cancelled: boolean) {
    super('Employee activity import stopped. Server staging may exist; reconcile before rerunning. No automatic retry, cancel, rollback, restore or close was performed.');
    this.name = 'ActivityImportStagingMayExistError';
  }
}
function invalid(): never { throw new Error('Invalid employee activity transfer.'); }
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

// Snapshot arrays as well as objects; never invoke an accessor, iterator or a second proxy get.
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, max);
  const own = Reflect.ownKeys(value);
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
export function activityTableKey(value: unknown): ActivityTableKey {
  const key = ACTIVITY_TABLE_KEYS.find(key => value === key);
  if (!key) invalid();
  return key;
}
export function activityEntryPath(key: ActivityTableKey): string { return `data/activity-${activityTableKey(key)}.ndjson`; }
function pending(record: Record<string, unknown>): ActivityPending {
  if (record.maintenance !== true || record.financial_data_pending !== true || record.dependencies_pending !== true
    || record.replacement_ready !== false || record.full_site_complete !== false) invalid();
  return { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
}
function counts(value: unknown, max: number = limits.maxRows): ActivityCounts {
  const record = object(value, ACTIVITY_TABLE_KEYS);
  return {
    employee_login_history: count(record.employee_login_history, max), work_sessions: count(record.work_sessions, max),
    work_stop_markers: count(record.work_stop_markers, max),
  };
}
export function validateActivityCatalog(value: unknown): ActivityCatalog {
  const record = object(value, ['version', 'scope', 'site_id', 'package_id', 'identity_catalog', 'tables', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'employee-activity' || record.full_site_complete !== false) invalid();
  const raw = array(record.tables, ACTIVITY_TABLE_KEYS.length);
  if (raw.length !== ACTIVITY_TABLE_KEYS.length) invalid();
  let total = 0;
  const tables = ACTIVITY_TABLE_KEYS.map((key, index) => {
    const table = object(raw[index], ['key', 'rows', 'bytes', 'row_hashes_sha256']);
    if (table.key !== key) invalid();
    const rows = count(table.rows, limits.maxRows), bytes = count(table.bytes, limits.maxTableBytes);
    if ((rows === 0) !== (bytes === 0)) invalid();
    total += bytes;
    return { key, rows, bytes, row_hashes_sha256: hash(table.row_hashes_sha256) };
  });
  if (total > limits.maxTotalBytes) invalid();
  const site = uuid(record.site_id), packageId = uuid(record.package_id);
  const identity = validateIdentityCatalog(record.identity_catalog);
  if (identity.site_id !== site || identity.package_id !== packageId) invalid();
  for (const table of identity.tables) hash(table.row_hashes_sha256);
  return { version: 1, scope: 'employee-activity', site_id: site, package_id: packageId, identity_catalog: identity,
    tables, full_site_complete: false };
}
export function validateActivityPlan(value: unknown): ActivityPlan {
  const record = object(value, ['scope', 'can_restore', 'counts', 'employees', 'running_work_sessions', 'conflicts', 'plan_hash', ...FLAGS]);
  if (record.scope !== 'employee-activity' || typeof record.can_restore !== 'boolean') invalid();
  const conflicts = array(record.conflicts, 200).map(value => {
    const reason = ACTIVITY_CONFLICT_REASONS.find(reason => reason === value);
    if (!reason) invalid();
    return reason;
  });
  const restored = counts(record.counts), employees = count(record.employees, limits.maxRows);
  const running = count(record.running_work_sessions, restored.work_sessions);
  if (record.can_restore !== (conflicts.length === 0)) invalid();
  return { scope: 'employee-activity', can_restore: record.can_restore, counts: restored, employees,
    running_work_sessions: running, conflicts, plan_hash: hash(record.plan_hash), ...pending(record) };
}
const RECEIPT_FIELDS = ['success', 'scope', 'counts', 'completed_employees', 'total_employees', 'verified', 'repeated', ...FLAGS];
function receipt(record: Record<string, unknown>): ActivityVerifyReceipt {
  if (record.success !== true || record.scope !== 'employee-activity' || record.verified !== true
    || typeof record.repeated !== 'boolean') invalid();
  const completed = count(record.completed_employees, limits.maxRows), total = count(record.total_employees, limits.maxRows);
  if (completed > total) invalid();
  return { success: true, scope: 'employee-activity', counts: counts(record.counts), completed_employees: completed,
    total_employees: total, verified: true, repeated: record.repeated, ...pending(record) };
}
export function validateActivityApplyReceipt(value: unknown): ActivityApplyReceipt {
  const record = object(value, [...RECEIPT_FIELDS, 'employee_id']);
  const checked = receipt(record);
  if (checked.completed_employees === 0) invalid();
  return { ...checked, employee_id: uuid(record.employee_id) };
}
export function validateActivityVerifyReceipt(value: unknown): ActivityVerifyReceipt {
  const checked = receipt(object(value, RECEIPT_FIELDS));
  if (checked.completed_employees !== checked.total_employees) invalid();
  return checked;
}
export function validateActivityVerification(value: unknown): { verified: true; scope: 'employee-activity'; full_site_complete: false } {
  const record = object(value, ['verified', 'scope', 'full_site_complete']);
  if (record.verified !== true || record.scope !== 'employee-activity' || record.full_site_complete !== false) invalid();
  return { verified: true, scope: 'employee-activity', full_site_complete: false };
}
export function validateActivityBind(value: unknown): { success: true; scope: 'employee-activity'; full_site_complete: false; repeated: boolean } {
  const record = object(value, ['success', 'scope', 'full_site_complete', 'repeated']);
  if (record.success !== true || record.scope !== 'employee-activity' || record.full_site_complete !== false
    || typeof record.repeated !== 'boolean') invalid();
  return { success: true, scope: 'employee-activity', full_site_complete: false, repeated: record.repeated };
}
export function validateActivityClose(value: unknown): { success: true; scope: 'employee-activity'; full_site_complete: false } {
  const record = object(value, ['success', 'scope', 'full_site_complete']);
  if (record.success !== true || record.scope !== 'employee-activity' || record.full_site_complete !== false) invalid();
  return { success: true, scope: 'employee-activity', full_site_complete: false };
}
export function validateActivityManifest(manifest: VolumeManifest, input: ActivityCatalog): void {
  const catalog = validateActivityCatalog(input);
  const record = object(manifest, ['version', 'scope', 'exportId', 'volumeId', 'sourceSiteId', 'createdAt', 'volumeIndex', 'volumeCount', 'entries']);
  if (record.version !== 1 || record.scope !== 'replacement-backup' || record.exportId !== catalog.package_id
    || record.sourceSiteId !== catalog.site_id || record.volumeIndex !== 1 || record.volumeCount !== 1) invalid();
  const entries = array(record.entries, ACTIVITY_TABLE_KEYS.length);
  if (entries.length !== ACTIVITY_TABLE_KEYS.length) invalid();
  for (let index = 0; index < ACTIVITY_TABLE_KEYS.length; index++) {
    const entry = object(entries[index], ['path', 'kind', 'bytes', 'sha256']);
    if (entry.path !== activityEntryPath(catalog.tables[index].key) || entry.kind !== 'ndjson'
      || entry.bytes !== catalog.tables[index].bytes) invalid();
    hash(entry.sha256); // Container authentication must already have verified the actual entry digest.
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
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hs) > 23
    || Number(mins) > 59 || Number(ss) > 59) invalid();
}
const SPEC: Record<ActivityTableKey, Record<string, string>> = {
  employee_login_history: { id: 'uuid!', user_id: 'uuid!', username: 'text!', employee_id: 'text!', action_type: 'text!',
    ip_address: 'text', user_agent: 'text', session_id: 'text', created_at: 'time', device_info: 'jsonb' },
  work_sessions: { id: 'uuid!', user_id: 'uuid!', start_time: 'time!', end_time: 'time', duration_minutes: 'integer',
    created_at: 'time', last_heartbeat_at: 'time' },
  work_stop_markers: { id: 'uuid!', user_id: 'uuid!', stopped_at: 'time!' },
};
export function activityCursor(key: ActivityTableKey, value: unknown): string {
  activityTableKey(key);
  return uuid(value);
}
// Scan strings rather than parsed objects: JSON.parse loses duplicate keys and numeric precision.
// Keep a separate key set for each object; the row object counts as depth one.
function checkJson(line: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '{' || char === '[') {
      if (stack.length === 32) invalid();
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
        if (!keys || keys.has(decoded)) invalid();
        keys.add(decoded);
      }
    }
  }
}
export function validateActivityRow(line: string, key: ActivityTableKey): string {
  if (typeof line !== 'string' || line.length > limits.maxLineBytes) invalid();
  unicode(line);
  const bytes = encoder.encode(line);
  if (bytes.length + (line.endsWith('\n') ? 0 : 1) > limits.maxLineBytes) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { invalid(); }
  const spec = SPEC[activityTableKey(key)], row = object(parsed, Object.keys(spec));
  checkJson(line);
  for (const [field, type] of Object.entries(spec)) {
    const value = row[field];
    if (value === null) { if (type.endsWith('!')) invalid(); continue; }
    switch (type.replace('!', '')) {
      case 'uuid': uuid(value); break;
      case 'text': if (typeof value !== 'string') invalid(); break;
      case 'integer': if (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) invalid(); break;
      // Any JSON value is valid here. Its original number lexemes, not parsed JS numbers, are transferred.
      case 'jsonb': break;
      case 'time': timestamp(value); break;
      default: invalid();
    }
  }
  if (key === 'work_stop_markers' && row.id !== row.user_id) invalid();
  if (key === 'employee_login_history') {
    const session = row.session_id;
    if (!['login', 'logout'].includes(row.action_type as string)
      || (session !== null && (typeof session !== 'string' || session.length !== 72 || !/^history-[0-9a-f]{64}$/.test(session)))) invalid();
  }
  // An unfinished source session stays NULL here; only target SQL ends it at the last heartbeat.
  return activityCursor(key, row.id);
}
export interface ActivityPage {
  table_key: ActivityTableKey; count: number; ndjson: string; next_after: string | null; sha256: string;
}
export function validateActivityPage(value: unknown, key: ActivityTableKey, after: string | null): ActivityPage {
  const record = object(value, ['table_key', 'count', 'ndjson', 'next_after', 'sha256']);
  if (record.table_key !== activityTableKey(key) || typeof record.ndjson !== 'string' || record.ndjson.length > limits.maxPageBytes) invalid();
  unicode(record.ndjson);
  const bytes = encoder.encode(record.ndjson), size = count(record.count, limits.maxPageRows);
  if (bytes.length > limits.maxPageBytes || (bytes.length > 0 && bytes[bytes.length - 1] !== 10)
    || new Sha256().update(bytes).digestHex() !== hash(record.sha256)) invalid();
  let last = after === null ? null : activityCursor(key, after), rows = 0, start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    if (end - start + 1 > limits.maxLineBytes) invalid();
    const id = validateActivityRow(decoder.decode(bytes.subarray(start, end)), key);
    if (last !== null && id <= last) invalid();
    last = id; rows++; start = end + 1;
  }
  const next = record.next_after === null ? null : activityCursor(key, record.next_after);
  if (rows !== size || (next !== null && (size === 0 || next !== last))) invalid();
  return { table_key: key, count: size, ndjson: record.ndjson, next_after: next, sha256: hash(record.sha256) };
}
export function validateActivityStage(value: unknown, rows: number, bytes: number, digest: string): {
  success: true; rows: number; bytes: number; sha256: string; repeated: boolean;
} {
  const record = object(value, ['success', 'rows', 'bytes', 'sha256', 'repeated']);
  if (record.success !== true || typeof record.repeated !== 'boolean' || record.rows !== rows
    || record.bytes !== bytes || hash(record.sha256) !== digest) invalid();
  return { success: true, rows, bytes, sha256: digest, repeated: record.repeated };
}

// Bounded state only: one input fragment, one line, and two incremental digests per table.
class TableVerifier {
  private readonly line = new Uint8Array(limits.maxLineBytes);
  private readonly digest = new Sha256();
  private readonly rowHashes = new Sha256();
  private last: string | null = null;
  private used = 0;
  private rows = 0;
  private bytes = 0;
  constructor(private readonly expected: ActivityTableCatalog) {}
  async push(input: Uint8Array, signal?: AbortSignal, onLine?: (text: string, raw: Uint8Array) => Promise<void>): Promise<void> {
    checkAbort(signal);
    if (!(input instanceof Uint8Array) || input.length > limits.maxInputBytes) invalid();
    this.bytes += input.length;
    if (this.bytes > this.expected.bytes) invalid();
    const chunk = new Uint8Array(input); // Producer may reuse its buffer across awaits.
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
        const id = validateActivityRow(text, this.expected.key);
        if (this.last !== null && id <= this.last) invalid();
        this.last = id;
        this.rowHashes.update(encoder.encode(new Sha256().update(raw).digestHex()));
        if (onLine) await onLine(text, raw);
        checkAbort(signal); this.used = 0;
      }
    }
  }
  finish(): string {
    if (this.used || this.rows !== this.expected.rows || this.bytes !== this.expected.bytes
      || this.rowHashes.digestHex() !== this.expected.row_hashes_sha256) invalid();
    return this.digest.digestHex();
  }
}
export async function exportActivityData(
  source: ActivityExportSource, sink: TemporaryTransferSink, options: ActivityTransferOptions = {},
): Promise<ActivityExportResult> {
  const { signal, onProgress } = options;
  try {
    const catalog = validateActivityCatalog(await withSignal(() => source.catalog(signal), signal));
    const entries: ActivityExportResult['entries'] = [];
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      const verifier = new TableVerifier(table), path = activityEntryPath(table.key);
      let after: string | null = null;
      do {
        const page = validateActivityPage(await withSignal(() => source.page(table.key, after, signal), signal), table.key, after);
        const raw = encoder.encode(page.ndjson), pageBytes = raw.length;
        await verifier.push(raw, signal);
        await withSignal(() => sink.append(path, raw, signal), signal);
        checkAbort(signal);
        rows += page.count; bytes += pageBytes;
        onProgress?.({ scope: 'employee-activity', phase: 'export', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal); after = page.next_after;
      } while (after !== null);
      entries.push({ path, kind: 'ndjson', bytes: table.bytes, sha256: verifier.finish() });
    }
    validateActivityVerification(await withSignal(() => source.verify(signal), signal));
    checkAbort(signal);
    return { catalog, entries, rows, bytes, fullSiteComplete: false };
  } catch {
    try { await sink.abort(new Error('Employee activity export discarded.')); } catch { throw new ActivityTransferCleanupError(); }
    checkAbort(signal);
    throw new Error('Employee activity export validation, source verification or temporary write failed.');
  }
}
async function scanTable(
  files: ActivityImportFiles, table: ActivityTableCatalog, signal?: AbortSignal,
  onLine?: (text: string, raw: Uint8Array) => Promise<void>,
): Promise<void> {
  checkAbort(signal);
  const source = files.open(activityEntryPath(table.key));
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
export async function stageActivityImport(
  input: unknown, files: ActivityImportFiles, target: ActivityImportTarget, options: ActivityTransferOptions = {},
): Promise<ActivityImportResult> {
  const { signal, onProgress } = options;
  let stagingMayExist = false;
  let outcome: { result: ActivityImportResult } | { error: unknown };
  try {
    checkAbort(signal);
    const catalog = validateActivityCatalog(input);
    let checkedRows = 0, checkedBytes = 0;
    for (const table of catalog.tables) {
      await scanTable(files, table, signal);
      checkedRows += table.rows; checkedBytes += table.bytes;
      onProgress?.({ scope: 'employee-activity', phase: 'validate', tableKey: table.key, rows: checkedRows, bytes: checkedBytes, fullSiteComplete: false });
      checkAbort(signal);
    }
    validateActivityBind(await withSignal(() => {
      stagingMayExist = true;
      return target.bind(validateActivityCatalog(catalog), signal);
    }, signal));
    checkAbort(signal);
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      let chunkNo = 0, pageRows = 0, pageBytes = 0, page = '', digest = new Sha256();
      const flush = async () => {
        count(chunkNo, limits.maxChunks - 1);
        validateActivityStage(await withSignal(() => target.stage(table.key, chunkNo, page, signal), signal), pageRows, pageBytes, digest.digestHex());
        checkAbort(signal);
        rows += pageRows; bytes += pageBytes; chunkNo++;
        pageRows = 0; pageBytes = 0; page = ''; digest = new Sha256();
        onProgress?.({ scope: 'employee-activity', phase: 'stage', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal);
      };
      await scanTable(files, table, signal, async (text, raw) => {
        if (pageBytes + raw.length > limits.maxPageBytes) await flush();
        page += text; pageRows++; pageBytes += raw.length; digest.update(raw);
        if (pageRows === limits.maxPageRows || pageBytes === limits.maxPageBytes) await flush();
      });
      if (pageRows || chunkNo === 0) await flush();
    }
    const plan = validateActivityPlan(await withSignal(() => target.plan(signal), signal));
    if (catalog.tables.some(table => plan.counts[table.key] !== table.rows)
      || plan.employees !== catalog.identity_catalog.tables[0].rows) invalid();
    checkAbort(signal);
    onProgress?.({ scope: 'employee-activity', phase: 'plan', rows, bytes, fullSiteComplete: false });
    checkAbort(signal);
    outcome = { result: { plan, rows, bytes, fullSiteComplete: false } };
  } catch { outcome = { error: true }; }
  try { await files.abort(new Error('Employee activity import plaintext discarded.')); }
  catch { throw new ActivityTransferCleanupError(stagingMayExist); }
  if ('error' in outcome) {
    if (stagingMayExist) throw new ActivityImportStagingMayExistError(signal?.aborted === true);
    checkAbort(signal);
    throw new Error('Employee activity import stopped before server staging began.');
  }
  checkAbort(signal);
  return outcome.result;
}
