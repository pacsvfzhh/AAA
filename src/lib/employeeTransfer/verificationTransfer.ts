import type { TemporaryTransferSink } from './container';
import type { TransferByteSource } from './crypto';
import type { VolumeManifest } from './manifest';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import { validateIdentityCatalog, type IdentityCatalog } from './identityTransfer';

export const VERIFICATION_PROTOCOL = 'employee-verification-v1';
export const VERIFICATION_TABLE_KEYS = Object.freeze(['verification_requests'] as const);
export type VerificationTableKey = typeof VERIFICATION_TABLE_KEYS[number];
export const VERIFICATION_TRANSFER_LIMITS = Object.freeze({
  maxRows: 500000, maxTableBytes: 256 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024,
  maxLineBytes: 64 * 1024, maxPageRows: 200, maxPageBytes: 256 * 1024,
  maxChunks: 500001, maxInputBytes: 1024 * 1024,
});
const limits = VERIFICATION_TRANSFER_LIMITS;
const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const FLAGS = ['maintenance', 'financial_data_pending', 'dependencies_pending', 'replacement_ready', 'full_site_complete'] as const;
export interface VerificationPending {
  maintenance: true; financial_data_pending: true; dependencies_pending: true;
  replacement_ready: false; full_site_complete: false;
}
export interface VerificationTableCatalog {
  key: VerificationTableKey; rows: number; bytes: number; row_hashes_sha256: string;
}
export interface VerificationCatalog {
  version: 1; scope: 'employee-verification'; site_id: string; package_id: string;
  identity_catalog: IdentityCatalog; tables: VerificationTableCatalog[]; full_site_complete: false;
}
export type VerificationCounts = { verification_requests: number };
export const VERIFICATION_CONFLICT_REASONS = Object.freeze([
  'verification_target_not_empty', 'verification_uuid_collision', 'source_employee_missing',
  'verification_admin_unmapped', 'media_incomplete',
] as const);
export interface VerificationPlan extends VerificationPending {
  scope: 'employee-verification'; can_restore: boolean; counts: VerificationCounts;
  employees: number; conflicts: typeof VERIFICATION_CONFLICT_REASONS[number][]; plan_hash: string;
}
// Receipt contracts only; this module does not implement restore or media operations.
export interface VerificationVerifyReceipt extends VerificationPending {
  success: true; scope: 'employee-verification'; counts: VerificationCounts;
  completed_employees: number; total_employees: number; verified: true; repeated: boolean;
}
export interface VerificationApplyReceipt extends VerificationVerifyReceipt { employee_id: string }
export type VerificationReceipt = VerificationApplyReceipt | VerificationVerifyReceipt;
export interface VerificationExportSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(key: VerificationTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  // Reserved for the coordinator after actual media export. exportVerificationData does not call it.
  verify(signal?: AbortSignal): Promise<unknown>;
}
export interface VerificationImportTarget {
  bind(catalog: VerificationCatalog, signal?: AbortSignal): Promise<unknown>;
  stage(key: VerificationTableKey, chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<unknown>;
  plan(signal?: AbortSignal): Promise<unknown>;
}
export interface VerificationImportFiles {
  // Only reopen isolated immutable files after authenticating the entire volume through EOF.
  open(path: string): TransferByteSource | ReadableStream<Uint8Array>;
  // Invalidate pending reads/writes and discard all temporary plaintext, including on success.
  abort(reason: unknown): Promise<void>;
}
export interface VerificationProgress {
  scope: 'employee-verification'; phase: 'export' | 'validate' | 'stage' | 'plan';
  tableKey?: VerificationTableKey; rows: number; bytes: number; fullSiteComplete: false;
}
export interface VerificationTransferOptions {
  signal?: AbortSignal; onProgress?: (progress: VerificationProgress) => void;
}
export interface VerificationExportResult {
  catalog: VerificationCatalog; entries: { path: string; kind: 'ndjson'; bytes: number; sha256: string }[];
  rows: number; bytes: number; fullSiteComplete: false;
}
export interface VerificationImportResult {
  plan: VerificationPlan; rows: number; bytes: number; fullSiteComplete: false;
}
export class VerificationTransferCleanupError extends Error {
  readonly cleanupRequired = true;
  constructor(readonly stagingMayExist = false) {
    super('Employee verification temporary plaintext cleanup was not confirmed. Do not reuse the workspace; reconcile any server staging.');
    this.name = 'VerificationTransferCleanupError';
  }
}
export class VerificationImportStagingMayExistError extends Error {
  readonly stagingMayExist = true;
  constructor(readonly cancelled: boolean) {
    super('Employee verification import stopped. Server staging may exist; reconcile before rerunning. No automatic retry, cancel, rollback, restore or close was performed.');
    this.name = 'VerificationImportStagingMayExistError';
  }
}
function invalid(): never { throw new Error('Invalid employee verification transfer.'); }
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
export function verificationTableKey(value: unknown): VerificationTableKey {
  if (value !== 'verification_requests') invalid();
  return value;
}
export function verificationEntryPath(key: VerificationTableKey): string { return `data/verification-${verificationTableKey(key)}.ndjson`; }
function pending(record: Record<string, unknown>): VerificationPending {
  if (record.maintenance !== true || record.financial_data_pending !== true || record.dependencies_pending !== true
    || record.replacement_ready !== false || record.full_site_complete !== false) invalid();
  return { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
}
function counts(value: unknown): VerificationCounts {
  const record = object(value, VERIFICATION_TABLE_KEYS);
  return { verification_requests: count(record.verification_requests, limits.maxRows) };
}
export function validateVerificationCatalog(value: unknown): VerificationCatalog {
  const record = object(value, ['version', 'scope', 'site_id', 'package_id', 'identity_catalog', 'tables', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'employee-verification' || record.full_site_complete !== false) invalid();
  const raw = array(record.tables, VERIFICATION_TABLE_KEYS.length);
  if (raw.length !== VERIFICATION_TABLE_KEYS.length) invalid();
  let total = 0;
  const tables = VERIFICATION_TABLE_KEYS.map((key, index) => {
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
  return { version: 1, scope: 'employee-verification', site_id: site, package_id: packageId, identity_catalog: identity,
    tables, full_site_complete: false };
}
export function validateVerificationPlan(value: unknown): VerificationPlan {
  const record = object(value, ['scope', 'can_restore', 'counts', 'employees', 'conflicts', 'plan_hash', ...FLAGS]);
  if (record.scope !== 'employee-verification' || typeof record.can_restore !== 'boolean') invalid();
  const conflicts = array(record.conflicts, 200).map(value => {
    const reason = VERIFICATION_CONFLICT_REASONS.find(reason => reason === value);
    if (!reason) invalid();
    return reason;
  });
  const restored = counts(record.counts), employees = count(record.employees, limits.maxRows);
  if (record.can_restore !== (conflicts.length === 0)) invalid();
  return { scope: 'employee-verification', can_restore: record.can_restore, counts: restored, employees,
    conflicts, plan_hash: hash(record.plan_hash), ...pending(record) };
}
const RECEIPT_FIELDS = ['success', 'scope', 'counts', 'completed_employees', 'total_employees', 'verified', 'repeated', ...FLAGS];
function receipt(record: Record<string, unknown>): VerificationVerifyReceipt {
  if (record.success !== true || record.scope !== 'employee-verification' || record.verified !== true
    || typeof record.repeated !== 'boolean') invalid();
  const completed = count(record.completed_employees, limits.maxRows), total = count(record.total_employees, limits.maxRows);
  if (completed > total) invalid();
  return { success: true, scope: 'employee-verification', counts: counts(record.counts), completed_employees: completed,
    total_employees: total, verified: true, repeated: record.repeated, ...pending(record) };
}
export function validateVerificationApplyReceipt(value: unknown): VerificationApplyReceipt {
  const record = object(value, [...RECEIPT_FIELDS, 'employee_id']);
  const checked = receipt(record);
  if (checked.completed_employees === 0) invalid();
  return { ...checked, employee_id: uuid(record.employee_id) };
}
export function validateVerificationVerifyReceipt(value: unknown): VerificationVerifyReceipt {
  const checked = receipt(object(value, RECEIPT_FIELDS));
  if (checked.completed_employees !== checked.total_employees) invalid();
  return checked;
}
export function validateVerificationVerification(value: unknown): { verified: true; scope: 'employee-verification'; full_site_complete: false } {
  const record = object(value, ['verified', 'scope', 'full_site_complete']);
  if (record.verified !== true || record.scope !== 'employee-verification' || record.full_site_complete !== false) invalid();
  return { verified: true, scope: 'employee-verification', full_site_complete: false };
}
export function validateVerificationBind(value: unknown): { success: true; scope: 'employee-verification'; full_site_complete: false; repeated: boolean } {
  const record = object(value, ['success', 'scope', 'full_site_complete', 'repeated']);
  if (record.success !== true || record.scope !== 'employee-verification' || record.full_site_complete !== false
    || typeof record.repeated !== 'boolean') invalid();
  return { success: true, scope: 'employee-verification', full_site_complete: false, repeated: record.repeated };
}
export function validateVerificationClose(value: unknown): { success: true; scope: 'employee-verification'; full_site_complete: false } {
  const record = object(value, ['success', 'scope', 'full_site_complete']);
  if (record.success !== true || record.scope !== 'employee-verification' || record.full_site_complete !== false) invalid();
  return { success: true, scope: 'employee-verification', full_site_complete: false };
}
export function validateVerificationManifest(manifest: VolumeManifest, input: VerificationCatalog): void {
  const catalog = validateVerificationCatalog(input);
  const record = object(manifest, ['version', 'scope', 'exportId', 'volumeId', 'sourceSiteId', 'createdAt', 'volumeIndex', 'volumeCount', 'entries']);
  if (record.version !== 1 || record.scope !== 'replacement-backup' || record.exportId !== catalog.package_id
    || record.sourceSiteId !== catalog.site_id || record.volumeIndex !== 1 || record.volumeCount !== 1) invalid();
  const entries = array(record.entries, VERIFICATION_TABLE_KEYS.length);
  if (entries.length !== VERIFICATION_TABLE_KEYS.length) invalid();
  for (let index = 0; index < VERIFICATION_TABLE_KEYS.length; index++) {
    const entry = object(entries[index], ['path', 'kind', 'bytes', 'sha256']);
    if (entry.path !== verificationEntryPath(catalog.tables[index].key) || entry.kind !== 'ndjson'
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
// The 15 physical fields, including historically named identity/address fields, are transferred unchanged.
const SPEC: Record<VerificationTableKey, Record<string, string>> = {
  verification_requests: { id: 'uuid!', user_id: 'uuid!', real_name: 'text!', wallet_address: 'text!', phone: 'text!',
    email: 'text!', status: 'text!', audit_remark: 'text', audited_by: 'uuid', audited_at: 'time', created_at: 'time',
    updated_at: 'time', id_front_url: 'text', id_back_url: 'text', selfie_url: 'text' },
};
export function verificationCursor(key: VerificationTableKey, value: unknown): string {
  verificationTableKey(key);
  return uuid(value);
}
// Track raw keys per object because JSON.parse discards duplicate and escaped-equivalent keys.
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
export function validateVerificationRow(line: string, key: VerificationTableKey): string {
  if (typeof line !== 'string' || line.length > limits.maxLineBytes) invalid();
  unicode(line);
  const bytes = encoder.encode(line);
  if (bytes.length + (line.endsWith('\n') ? 0 : 1) > limits.maxLineBytes) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { invalid(); }
  const spec = SPEC[verificationTableKey(key)], row = object(parsed, Object.keys(spec));
  checkJson(line);
  for (const [field, type] of Object.entries(spec)) {
    const value = row[field];
    if (value === null) { if (type.endsWith('!')) invalid(); continue; }
    switch (type.replace('!', '')) {
      case 'uuid': uuid(value); break;
      // URL columns are text here; source URL safety and media mapping are a separate layer.
      case 'text': if (typeof value !== 'string') invalid(); break;
      case 'time': timestamp(value); break;
      default: invalid();
    }
  }
  if (!['pending', 'approved', 'rejected'].includes(row.status as string)) invalid();
  return verificationCursor(key, row.id);
}
export interface VerificationPage {
  table_key: VerificationTableKey; count: number; ndjson: string; next_after: string | null; sha256: string;
}
export function validateVerificationPage(value: unknown, key: VerificationTableKey, after: string | null): VerificationPage {
  const record = object(value, ['table_key', 'count', 'ndjson', 'next_after', 'sha256']);
  if (record.table_key !== verificationTableKey(key) || typeof record.ndjson !== 'string' || record.ndjson.length > limits.maxPageBytes) invalid();
  unicode(record.ndjson);
  const bytes = encoder.encode(record.ndjson), size = count(record.count, limits.maxPageRows);
  if (bytes.length > limits.maxPageBytes || (bytes.length > 0 && bytes[bytes.length - 1] !== 10)
    || new Sha256().update(bytes).digestHex() !== hash(record.sha256)) invalid();
  let last = after === null ? null : verificationCursor(key, after), rows = 0, start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    if (end - start + 1 > limits.maxLineBytes) invalid();
    const id = validateVerificationRow(decoder.decode(bytes.subarray(start, end)), key);
    if (last !== null && id <= last) invalid();
    last = id; rows++; start = end + 1;
  }
  const next = record.next_after === null ? null : verificationCursor(key, record.next_after);
  if (rows !== size || (next !== null && (size === 0 || next !== last))) invalid();
  return { table_key: key, count: size, ndjson: record.ndjson, next_after: next, sha256: hash(record.sha256) };
}
export function validateVerificationStage(value: unknown, rows: number, bytes: number, digest: string): {
  success: true; rows: number; bytes: number; sha256: string; repeated: boolean;
} {
  const record = object(value, ['success', 'rows', 'bytes', 'sha256', 'repeated']);
  if (record.success !== true || typeof record.repeated !== 'boolean' || record.rows !== rows
    || record.bytes !== bytes || hash(record.sha256) !== digest) invalid();
  return { success: true, rows, bytes, sha256: digest, repeated: record.repeated };
}

// Bounded state only: one input fragment, one line, and two incremental digests.
class TableVerifier {
  private readonly line = new Uint8Array(limits.maxLineBytes);
  private readonly digest = new Sha256();
  private readonly rowHashes = new Sha256();
  private last: string | null = null;
  private used = 0;
  private rows = 0;
  private bytes = 0;
  constructor(private readonly expected: VerificationTableCatalog) {}
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
        const id = validateVerificationRow(text, this.expected.key);
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
export async function exportVerificationData(
  source: VerificationExportSource, sink: TemporaryTransferSink, options: VerificationTransferOptions = {},
): Promise<VerificationExportResult> {
  const { signal, onProgress } = options;
  try {
    const catalog = validateVerificationCatalog(await withSignal(() => source.catalog(signal), signal));
    const entries: VerificationExportResult['entries'] = [];
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      const verifier = new TableVerifier(table), path = verificationEntryPath(table.key);
      let after: string | null = null;
      do {
        const page = validateVerificationPage(await withSignal(() => source.page(table.key, after, signal), signal), table.key, after);
        const raw = encoder.encode(page.ndjson), pageBytes = raw.length;
        await verifier.push(raw, signal);
        await withSignal(() => sink.append(path, raw, signal), signal);
        checkAbort(signal);
        rows += page.count; bytes += pageBytes;
        onProgress?.({ scope: 'employee-verification', phase: 'export', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal); after = page.next_after;
      } while (after !== null);
      entries.push({ path, kind: 'ndjson', bytes: table.bytes, sha256: verifier.finish() });
    }
    // Records only. The media coordinator must export files before explicitly verifying/closing the source.
    checkAbort(signal);
    return { catalog, entries, rows, bytes, fullSiteComplete: false };
  } catch {
    try { await sink.abort(new Error('Employee verification export discarded.')); } catch { throw new VerificationTransferCleanupError(); }
    checkAbort(signal);
    throw new Error('Employee verification export validation or temporary write failed.');
  }
}
async function scanTable(
  files: VerificationImportFiles, table: VerificationTableCatalog, signal?: AbortSignal,
  onLine?: (text: string, raw: Uint8Array) => Promise<void>,
): Promise<void> {
  checkAbort(signal);
  const source = files.open(verificationEntryPath(table.key));
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
export async function stageVerificationImport(
  input: unknown, files: VerificationImportFiles, target: VerificationImportTarget, options: VerificationTransferOptions = {},
): Promise<VerificationImportResult> {
  const { signal, onProgress } = options;
  let stagingMayExist = false;
  let outcome: { result: VerificationImportResult } | { error: unknown };
  try {
    checkAbort(signal);
    const catalog = validateVerificationCatalog(input);
    let checkedRows = 0, checkedBytes = 0;
    for (const table of catalog.tables) {
      await scanTable(files, table, signal);
      checkedRows += table.rows; checkedBytes += table.bytes;
      onProgress?.({ scope: 'employee-verification', phase: 'validate', tableKey: table.key, rows: checkedRows, bytes: checkedBytes, fullSiteComplete: false });
      checkAbort(signal);
    }
    validateVerificationBind(await withSignal(() => {
      stagingMayExist = true;
      return target.bind(validateVerificationCatalog(catalog), signal);
    }, signal));
    checkAbort(signal);
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      let chunkNo = 0, pageRows = 0, pageBytes = 0, page = '', digest = new Sha256();
      const flush = async () => {
        count(chunkNo, limits.maxChunks - 1);
        validateVerificationStage(await withSignal(() => target.stage(table.key, chunkNo, page, signal), signal), pageRows, pageBytes, digest.digestHex());
        checkAbort(signal);
        rows += pageRows; bytes += pageBytes; chunkNo++;
        pageRows = 0; pageBytes = 0; page = ''; digest = new Sha256();
        onProgress?.({ scope: 'employee-verification', phase: 'stage', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal);
      };
      await scanTable(files, table, signal, async (text, raw) => {
        if (pageBytes + raw.length > limits.maxPageBytes) await flush();
        page += text; pageRows++; pageBytes += raw.length; digest.update(raw);
        if (pageRows === limits.maxPageRows || pageBytes === limits.maxPageBytes) await flush();
      });
      if (pageRows || chunkNo === 0) await flush();
    }
    const plan = validateVerificationPlan(await withSignal(() => target.plan(signal), signal));
    if (catalog.tables.some(table => plan.counts[table.key] !== table.rows)
      || plan.employees !== catalog.identity_catalog.tables[0].rows) invalid();
    checkAbort(signal);
    onProgress?.({ scope: 'employee-verification', phase: 'plan', rows, bytes, fullSiteComplete: false });
    checkAbort(signal);
    outcome = { result: { plan, rows, bytes, fullSiteComplete: false } };
  } catch { outcome = { error: true }; }
  try { await files.abort(new Error('Employee verification import plaintext discarded.')); }
  catch { throw new VerificationTransferCleanupError(stagingMayExist); }
  // Cancellation while awaiting plaintext cleanup cannot rule out server staging.
  if (signal?.aborted && stagingMayExist) throw new VerificationImportStagingMayExistError(true);
  if ('error' in outcome) {
    if (stagingMayExist) throw new VerificationImportStagingMayExistError(signal?.aborted === true);
    checkAbort(signal);
    throw new Error('Employee verification import stopped before server staging began.');
  }
  checkAbort(signal);
  return outcome.result;
}
