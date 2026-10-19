import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import type { TemporaryTransferSink } from './container';
import type { TransferByteSource } from './crypto';
import { dispatchTransferChecks } from './dispatchTransfer';
import { claimEntryPath, validateManifest, type ManifestEntry, type VolumeManifest } from './manifest';
import { Sha256 } from './sha256';
import {
  exportVerificationData, stageVerificationImport, validateVerificationCatalog, validateVerificationPlan,
  validateVerificationRow, validateVerificationVerification, verificationEntryPath, VERIFICATION_TRANSFER_LIMITS,
  type VerificationCatalog, type VerificationExportSource, type VerificationImportFiles, type VerificationImportTarget,
  type VerificationPlan,
} from './verificationTransfer';

// Controlled single verification substage only: no UI, whole-site completion, multi-volume,
// task close/cancel, object deletion or automatic retry. Never fetch a source_url directly.
export const VERIFICATION_MEDIA_LIMITS = Object.freeze({ maxFiles: 3000, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 });
export type VerificationMediaDirection = 'export' | 'import';
export type VerificationMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf';
export interface VerificationMediaFile {
  key: string; source_url: string; bytes: number; sha256: string; content_type: VerificationMediaType;
}
export interface VerificationMediaReference {
  key: string; source_url: string; bucket: 'verification-documents'; path: string; file: VerificationMediaFile | null;
}
export interface VerificationMediaInventory {
  scope: 'employee-verification-media'; direction: VerificationMediaDirection;
  files: VerificationMediaReference[]; full_site_complete: false;
}
export interface VerificationMediaSession {
  readonly direction: VerificationMediaDirection;
  inventory(signal?: AbortSignal): Promise<VerificationMediaInventory>;
  bind(files: readonly VerificationMediaFile[], signal?: AbortSignal): Promise<void>;
  // A bounded, validated buffer; callers must await a temporary sink before counting progress.
  download(reference: VerificationMediaReference, signal?: AbortSignal): Promise<{ file: VerificationMediaFile; bytes: Uint8Array }>;
  upload(file: VerificationMediaFile, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  recheckExport(files: readonly VerificationMediaFile[], signal?: AbortSignal): Promise<void>;
  // Explicitly call AFTER ALL employee apply calls complete, THEN call the SQL verification API.
  // Only SQL can prove that this readback is later than the last employee apply.
  recheckImport(files: readonly VerificationMediaFile[], signal?: AbortSignal): Promise<void>;
}
export interface VerificationMediaProgress {
  scope: 'employee-verification-media'; phase: 'export' | 'validate' | 'stage' | 'upload' | 'recheck';
  files: number; bytes: number; rows: number; fullSiteComplete: false;
}
export interface VerificationMediaOptions {
  signal?: AbortSignal; onProgress?: (progress: VerificationMediaProgress) => void;
}
export interface VerificationBundle {
  catalog: VerificationCatalog; media: VerificationMediaFile[]; entries: ManifestEntry[];
  rows: number; bytes: number; fullSiteComplete: false;
}
// The caller MUST authenticate the complete encrypted container through real EOF before
// exposing these isolated, reopenable, immutable payload files. Do not pass a live decoder.
export interface VerificationBundleFiles extends VerificationImportFiles {
  // Exact payload paths (manifest.json is metadata, not a payload); no omitted/extra files.
  paths(): readonly string[];
}
export interface VerificationBundleInput {
  catalog: unknown; media: unknown; manifest: unknown;
}
const { object, count } = dispatchTransferChecks;
const limits = VERIFICATION_MEDIA_LIMITS;
const encoder = new TextEncoder();
const PREFIX = '/storage/v1/object/public/verification-documents/';
const BUCKET = 'verification-documents';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH = new RegExp(`^(id-front|id-back|selfie)/(${UUID})-[A-Za-z0-9._-]+\\.[A-Za-z0-9]{1,8}$`);
const TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const failure = 'Verification media operation is unconfirmed; reconcile server staging and uploads before retrying. No automatic retry, rollback, deletion or close was performed.';
export class VerificationMediaError extends Error {
  constructor(readonly serverStagingOrUploadsMayExist: boolean, readonly cancelled: boolean, readonly cleanupRequired = false) {
    super(cleanupRequired ? 'Verification plaintext cleanup was not confirmed. Do not reuse the workspace. ' + failure : failure);
    this.name = 'VerificationMediaError';
  }
}
function invalid(): never { throw new VerificationMediaError(false, false); }
function check(signal?: AbortSignal): void { if (signal?.aborted) throw new VerificationMediaError(false, true); }
// Deliberately await each operation, even after abort. Do not race a write then let it
// finish after cleanup/return. Execution is serial (one worker, no detached workers).
async function settled<T>(operation: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  check(signal);
  const result = await operation();
  check(signal);
  return result;
}
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
function sha(bytes: Uint8Array): string { return new Sha256().update(bytes).digestHex(); }
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, max);
  if (Reflect.ownKeys(value).length !== size + 1) invalid();
  return Array.from({ length: size }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field)) invalid();
    return field.value;
  });
}
function origin(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(value)) invalid();
  return value;
}
function source(value: unknown): { url: string; path: string; origin: string; owner: string } {
  if (typeof value !== 'string' || value.length > 512 || value !== value.trim()) invalid();
  const at = value.indexOf(PREFIX);
  if (at < 0) invalid();
  const host = origin(value.slice(0, at)), path = value.slice(at + PREFIX.length), match = PATH.exec(path);
  if (!match || match[0] !== path || path.includes('..') || path.split('/')[1].length > 128) invalid();
  return { url: value, path, origin: host, owner: match[2] };
}
export function verificationMediaEntryPath(file: Pick<VerificationMediaFile, 'source_url'>): string {
  return `media/${BUCKET}/${source(file.source_url).path}`;
}
function tuple(value: unknown): VerificationMediaFile {
  const record = object(value, ['key', 'source_url', 'bytes', 'sha256', 'content_type']);
  const ref = source(record.source_url), key = hash(record.key), bytes = count(record.bytes, limits.maxFileBytes);
  if (!bytes || key !== sha(encoder.encode(ref.url)) || typeof record.content_type !== 'string' || !TYPES.includes(record.content_type)) invalid();
  return { key, source_url: ref.url, bytes, sha256: hash(record.sha256), content_type: record.content_type as VerificationMediaType };
}
function tuples(value: unknown): VerificationMediaFile[] {
  const files = array(value, limits.maxFiles).map(tuple);
  ordered(files);
  if (files.reduce((n, f) => n + f.bytes, 0) > limits.maxTotalBytes) invalid();
  return files;
}
function ordered(files: readonly { key: string }[]): void {
  for (let i = 1; i < files.length; i++) if (files[i - 1].key >= files[i].key) invalid();
}
function same(a: VerificationMediaFile, b: VerificationMediaFile): boolean {
  return a.key === b.key && a.source_url === b.source_url && a.bytes === b.bytes && a.sha256 === b.sha256 && a.content_type === b.content_type;
}
function reference(value: unknown): VerificationMediaReference {
  const record = object(value, ['key', 'source_url', 'bucket', 'path', 'file']);
  const ref = source(record.source_url), key = hash(record.key);
  // Inventory always returns SOURCE paths, even for import. Target paths are server-owned.
  if (key !== sha(encoder.encode(ref.url)) || record.bucket !== BUCKET || record.path !== ref.path) invalid();
  const file = record.file === null ? null : tuple(record.file);
  if (file && (file.key !== key || file.source_url !== ref.url)) invalid();
  return { key, source_url: ref.url, bucket: BUCKET, path: ref.path, file };
}
function inventory(value: unknown, direction: VerificationMediaDirection): VerificationMediaInventory {
  const record = object(value, ['scope', 'direction', 'files', 'full_site_complete']);
  if (record.scope !== 'employee-verification-media' || record.direction !== direction || record.full_site_complete !== false) invalid();
  const files = array(record.files, limits.maxFiles).map(reference);
  ordered(files);
  if (files.reduce((n, f) => n + (f.file?.bytes ?? 0), 0) > limits.maxTotalBytes) invalid();
  return { scope: 'employee-verification-media', direction, files, full_site_complete: false };
}
function matches(refs: readonly VerificationMediaReference[], files: readonly VerificationMediaFile[]): void {
  if (refs.length !== files.length) invalid();
  for (let i = 0; i < refs.length; i++) {
    if (refs[i].key !== files[i].key || refs[i].source_url !== files[i].source_url || (refs[i].file && !same(refs[i].file!, files[i]))) invalid();
  }
}
function detect(bytes: Uint8Array): VerificationMediaType {
  const starts = (signature: number[], offset = 0) => signature.every((b, i) => bytes[offset + i] === b);
  if (bytes.length >= 3 && starts([255, 216, 255])) return 'image/jpeg';
  if (bytes.length >= 8 && starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (bytes.length >= 6 && (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))) return 'image/gif';
  if (bytes.length >= 12 && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)) return 'image/webp';
  if (bytes.length >= 5 && starts([37, 80, 68, 70, 45])) return 'application/pdf';
  return invalid();
}
function inspect(file: VerificationMediaFile, bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== file.bytes || sha(bytes) !== file.sha256 || detect(bytes) !== file.content_type) invalid();
}
function receipt(value: unknown, file: VerificationMediaFile): void {
  const record = object(value, ['success', 'key', 'bytes', 'sha256', 'content_type', 'full_site_complete']);
  if (record.success !== true || record.full_site_complete !== false || record.key !== file.key || record.bytes !== file.bytes
    || record.sha256 !== file.sha256 || record.content_type !== file.content_type) invalid();
}

// Accept a transport, never an endpoint/key override. Tests replace RPC/auth modules and
// compile fixture env values; production always uses the current Vite environment.
export function createVerificationMediaSession(
  jobToken: string, direction: VerificationMediaDirection, transport: typeof fetch = globalThis.fetch,
): VerificationMediaSession {
  let admin: string, endpoint: string, apiKey: string;
  try {
    admin = uuid(getAdminFinancialSessionToken()); uuid(jobToken);
    if (direction !== 'export' && direction !== 'import') invalid();
    const configured = import.meta.env.VITE_SUPABASE_URL;
    const host = origin(typeof configured === 'string' && configured.endsWith('/') ? configured.slice(0, -1) : configured);
    endpoint = host + '/functions/v1/employee-transfer-media';
    apiKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (typeof apiKey !== 'string' || !apiKey || apiKey !== apiKey.trim() || /[\r\n]/.test(apiKey)) invalid();
  } catch { throw new VerificationMediaError(false, false); }
  let busy = false;
  // Read-only inventory is harmless; every Edge action can commit a server receipt.
  const run = async <T>(operation: (mark: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    let mayExist = false;
    try {
      check(signal);
      if (busy) invalid();
      busy = true;
      try { return await operation(() => { mayExist = true; }); } finally { busy = false; }
    } catch { throw new VerificationMediaError(mayExist, signal?.aborted === true); }
  };
  const params = () => ({ p_admin_session_token: admin, p_job_token: jobToken });
  const readInventory = async (signal?: AbortSignal) => {
    const result = await settled(() => {
      const query = supabase.rpc('get_employee_transfer_verification_media', { ...params(), p_direction: direction });
      return signal ? query.abortSignal(signal) : query;
    }, signal);
    if (result.error) invalid();
    return inventory(result.data, direction);
  };
  const post = async (action: string, key: string, mark: () => void, signal?: AbortSignal, body?: Uint8Array): Promise<Response> => {
    check(signal); mark();
    const res = await transport(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
      headers: { apikey: apiKey, 'Content-Type': 'application/octet-stream', 'x-transfer-action': action,
        'x-admin-session-token': admin, 'x-transfer-job-token': jobToken, 'x-transfer-object-key': key }, body });
    if (signal?.aborted || !res.ok || res.redirected) {
      try { await res.body?.cancel(); } catch { /* Redacted, including a late response after local abort. */ }
      invalid();
    }
    return res;
  };
  const command = async (action: string, file: VerificationMediaFile, mark: () => void, signal?: AbortSignal, bytes?: Uint8Array) => {
    const res = await post(action, file.key, mark, signal, bytes);
    // Receipts are tiny. Never parse an unbounded JSON/error response.
    const raw = await readBytes(res.body, 4096, signal);
    receipt(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)), file);
  };
  const recheck = (mode: VerificationMediaDirection, input: readonly VerificationMediaFile[], signal?: AbortSignal) => run(async mark => {
    if (direction !== mode) invalid();
    const files = tuples(input), refs = await readInventory(signal);
    matches(refs.files, files);
    for (const file of files) await command(mode === 'export' ? 'recheck-export' : 'recheck-import', file, mark, signal);
  }, signal);
  return Object.freeze({
    direction,
    inventory: (signal?: AbortSignal) => run(() => readInventory(signal), signal),
    bind: (input: readonly VerificationMediaFile[], signal?: AbortSignal) => run(async mark => {
      if (direction !== 'import') invalid();
      const files = tuples(input);
      matches((await readInventory(signal)).files, files);
      const result = await settled(() => {
        mark();
        const query = supabase.rpc('employee_import_verification_media_bind', { ...params(), p_files: files });
        return signal ? query.abortSignal(signal) : query;
      }, signal);
      if (result.error) invalid();
      const r = object(result.data, ['success', 'scope', 'files', 'bytes', 'repeated', 'full_site_complete']);
      if (r.success !== true || r.scope !== 'employee-verification-media' || r.files !== files.length
        || r.bytes !== files.reduce((n, f) => n + f.bytes, 0) || typeof r.repeated !== 'boolean' || r.full_site_complete !== false) invalid();
    }, signal),
    download: (input: VerificationMediaReference, signal?: AbortSignal) => run(async mark => {
      if (direction !== 'export') invalid();
      const ref = reference(input);
      if (source(ref.source_url).origin !== endpoint.slice(0, -'/functions/v1/employee-transfer-media'.length)) invalid();
      const res = await post('download', ref.key, mark, signal);
      const digest = res.headers.get('x-transfer-sha256'), contentType = res.headers.get('x-transfer-content-type');
      if (res.headers.get('content-type') !== 'application/octet-stream') {
        try { await res.body?.cancel(); } catch { /* Redacted. */ }
        invalid();
      }
      const bytes = await readBytes(res.body, ref.file?.bytes ?? limits.maxFileBytes, signal);
      const file = tuple({ key: ref.key, source_url: ref.source_url, bytes: bytes.length, sha256: digest, content_type: contentType });
      inspect(file, bytes);
      if (ref.file && !same(ref.file, file)) invalid();
      return { file, bytes };
    }, signal),
    upload: (input: VerificationMediaFile, inputBytes: Uint8Array, signal?: AbortSignal) => run(async mark => {
      if (direction !== 'import') invalid();
      const file = tuple(input);
      if (!(inputBytes instanceof Uint8Array) || inputBytes.length !== file.bytes) invalid();
      const bytes = new Uint8Array(inputBytes); // Do not retain a producer's mutable view across fetch awaits.
      inspect(file, bytes);
      await command('upload', file, mark, signal, bytes);
    }, signal),
    recheckExport: (files: readonly VerificationMediaFile[], signal?: AbortSignal) => recheck('export', files, signal),
    recheckImport: (files: readonly VerificationMediaFile[], signal?: AbortSignal) => recheck('import', files, signal),
  });
}

async function* checkedChunks(
  input: TransferByteSource | ReadableStream<Uint8Array>, signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  check(signal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, iterator: AsyncIterator<Uint8Array> | undefined;
  if (input && 'getReader' in input) reader = input.getReader();
  else if (input && Symbol.asyncIterator in input) iterator = input[Symbol.asyncIterator]();
  else invalid();
  let ended = false;
  try {
    while (true) {
      const next = reader ? await settled(() => reader.read(), signal) : await settled(() => iterator!.next(), signal);
      if (next.done) { ended = true; break; }
      if (!(next.value instanceof Uint8Array)) invalid();
      yield next.value; check(signal);
    }
  } finally {
    // Drain/cancel serially, with no pending worker capable of writing after cleanup.
    if (reader) { try { if (!ended) await reader.cancel(); } finally { reader.releaseLock(); } }
    else if (!ended && iterator?.return) await iterator.return();
  }
}
async function consume(
  input: TransferByteSource | ReadableStream<Uint8Array>, onChunk: (bytes: Uint8Array) => Promise<void>, signal?: AbortSignal,
): Promise<void> {
  for await (const chunk of checkedChunks(input, signal)) { await onChunk(chunk); check(signal); }
}
async function readBytes(stream: ReadableStream<Uint8Array> | null, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!stream) invalid();
  const bytes = new Uint8Array(max);
  let used = 0;
  await consume(stream, async chunk => {
    if (chunk.length > max - used) invalid();
    bytes.set(chunk, used); used += chunk.length;
  }, signal);
  return bytes.subarray(0, used);
}
function progress(options: VerificationMediaOptions, phase: VerificationMediaProgress['phase'], files: number, bytes: number, rows = 0): void {
  check(options.signal);
  options.onProgress?.({ scope: 'employee-verification-media', phase, files, bytes, rows, fullSiteComplete: false });
  check(options.signal);
}
async function discard(files: Pick<VerificationImportFiles, 'abort'>, mayExist: boolean, signal?: AbortSignal): Promise<void> {
  try { await files.abort(new Error('Verification temporary plaintext discarded.')); }
  catch { throw new VerificationMediaError(mayExist, signal?.aborted === true, true); }
}
function refsFromRow(text: string, refs: Map<string, VerificationMediaReference>): void {
  validateVerificationRow(text, 'verification_requests');
  const row = JSON.parse(text) as Record<string, unknown>;
  for (const field of ['id_front_url', 'id_back_url', 'selfie_url']) {
    if (row[field] === null) continue;
    const ref = source(row[field]);
    if (ref.owner !== row.user_id) invalid();
    const key = sha(encoder.encode(ref.url));
    const existing = refs.get(key);
    if (existing && existing.source_url !== ref.url) invalid();
    refs.set(key, { key, source_url: ref.url, bucket: BUCKET, path: ref.path, file: null });
    if (refs.size > limits.maxFiles) invalid();
  }
}
function sortedRefs(refs: Map<string, VerificationMediaReference>): VerificationMediaReference[] {
  return [...refs.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
export async function exportVerificationBundle(
  sourceApi: VerificationExportSource, sink: TemporaryTransferSink, media: VerificationMediaSession, options: VerificationMediaOptions = {},
): Promise<VerificationBundle> {
  let mayExist = false;
  try {
    if (media.direction !== 'export') invalid();
    const refs = new Map<string, VerificationMediaReference>();
    // exportVerificationData validates raw pages, order and row-hash catalog. Inspect
    // URLs in those same bytes before the sink receives them; never reserialize records.
    const data = await exportVerificationData({
      catalog: () => settled(() => sourceApi.catalog(options.signal), options.signal),
      page: (key, after) => settled(() => sourceApi.page(key, after, options.signal), options.signal),
      verify: () => settled(() => sourceApi.verify(options.signal), options.signal),
    }, {
      async append(path, raw) {
        check(options.signal);
        for (const line of new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\n').slice(0, -1)) refsFromRow(line, refs);
        await settled(() => sink.append(path, raw, options.signal), options.signal);
      },
      async abort() { /* The outer owner performs exactly one real cleanup. */ },
    }); // No abort race around pending record sink writes.
    const available = await settled(() => media.inventory(options.signal), options.signal);
    const expected = sortedRefs(refs);
    if (available.files.length !== expected.length || available.files.some((f, i) => f.key !== expected[i].key || f.source_url !== expected[i].source_url)) invalid();
    const paths = new Set<string>();
    for (const entry of data.entries) claimEntryPath(entry.path, paths);
    for (const ref of available.files) claimEntryPath(verificationMediaEntryPath(ref), paths);
    const files: VerificationMediaFile[] = [], entries: ManifestEntry[] = [...data.entries];
    let bytes = data.bytes;
    for (const ref of available.files) {
      mayExist = true; // Download itself records a server-owned receipt.
      const downloaded = await settled(() => media.download(ref, options.signal), options.signal);
      bytes += downloaded.file.bytes;
      if (bytes > limits.maxTotalBytes) invalid();
      const path = verificationMediaEntryPath(downloaded.file);
      await settled(() => sink.append(path, downloaded.bytes, options.signal), options.signal);
      files.push(downloaded.file);
      entries.push({ path, kind: 'media', bytes: downloaded.file.bytes, sha256: downloaded.file.sha256 });
      progress(options, 'export', files.length, bytes, data.rows);
    }
    await settled(() => media.recheckExport(files, options.signal), options.signal);
    mayExist = true;
    validateVerificationVerification(await settled(() => sourceApi.verify(options.signal), options.signal));
    return { catalog: data.catalog, media: files, entries, rows: data.rows, bytes, fullSiteComplete: false };
  } catch {
    await discard(sink, mayExist, options.signal);
    throw new VerificationMediaError(mayExist, options.signal?.aborted === true);
  }
}

function bundle(input: VerificationBundleInput, files: VerificationBundleFiles): { catalog: VerificationCatalog; media: VerificationMediaFile[]; manifest: VolumeManifest } {
  const catalog = validateVerificationCatalog(input.catalog), media = tuples(input.media);
  // Snapshot untrusted arrays/entries before calling the general manifest validator.
  const raw = object(input.manifest, ['version', 'scope', 'exportId', 'volumeId', 'sourceSiteId', 'createdAt', 'volumeIndex', 'volumeCount', 'entries']);
  const entries = array(raw.entries, limits.maxFiles + 1).map(e => object(e, ['path', 'kind', 'bytes', 'sha256']));
  const manifest = validateManifest({ ...raw, entries });
  if (manifest.scope !== 'replacement-backup' || manifest.exportId !== catalog.package_id || manifest.sourceSiteId !== catalog.site_id
    || manifest.volumeIndex !== 1 || manifest.volumeCount !== 1 || entries.length !== media.length + 1) invalid();
  const expected = new Map<string, { kind: string; bytes: number; sha256?: string }>();
  expected.set(verificationEntryPath('verification_requests'), { kind: 'ndjson', bytes: catalog.tables[0].bytes });
  for (const file of media) {
    const path = verificationMediaEntryPath(file);
    if (expected.has(path)) invalid();
    expected.set(path, { kind: 'media', bytes: file.bytes, sha256: file.sha256 });
  }
  for (const entry of manifest.entries) {
    const e = expected.get(entry.path);
    if (!e || e.kind !== entry.kind || e.bytes !== entry.bytes || (e.sha256 !== undefined && e.sha256 !== entry.sha256)) invalid();
  }
  if (manifest.entries.reduce((n, e) => n + e.bytes, 0) > limits.maxTotalBytes) invalid();
  const paths = array(files.paths(), limits.maxFiles + 1);
  if (paths.length !== expected.size || new Set(paths).size !== paths.length || paths.some(p => typeof p !== 'string' || !expected.has(p))) invalid();
  return { catalog, media, manifest };
}
async function scanRecords(
  files: VerificationBundleFiles, catalog: VerificationCatalog, entry: ManifestEntry, signal?: AbortSignal,
): Promise<VerificationMediaReference[]> {
  const table = catalog.tables[0], digest = new Sha256(), rowHashes = new Sha256();
  const refs = new Map<string, VerificationMediaReference>(), line = new Uint8Array(VERIFICATION_TRANSFER_LIMITS.maxLineBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let used = 0, bytes = 0, rows = 0, last: string | null = null;
  await consume(files.open(entry.path), async chunk => {
    if (chunk.length > VERIFICATION_TRANSFER_LIMITS.maxInputBytes) invalid();
    bytes += chunk.length;
    if (bytes > table.bytes) invalid();
    const copy = new Uint8Array(chunk); digest.update(copy);
    for (const byte of copy) {
      if (used === line.length) invalid();
      line[used++] = byte;
      if (byte !== 10) continue;
      const raw = line.subarray(0, used), text = decoder.decode(raw), id = validateVerificationRow(text, table.key);
      if (last !== null && id <= last) invalid();
      last = id; rows++;
      if (rows > table.rows) invalid();
      refsFromRow(text, refs);
      rowHashes.update(encoder.encode(sha(raw))); used = 0;
    }
  }, signal);
  if (used || bytes !== table.bytes || rows !== table.rows || rowHashes.digestHex() !== table.row_hashes_sha256 || digest.digestHex() !== entry.sha256) invalid();
  return sortedRefs(refs);
}
async function scanMedia(files: VerificationImportFiles, file: VerificationMediaFile, signal?: AbortSignal, collect = false): Promise<Uint8Array> {
  const digest = new Sha256(), head = new Uint8Array(12), output = new Uint8Array(collect ? file.bytes : 0);
  let used = 0;
  await consume(files.open(verificationMediaEntryPath(file)), async chunk => {
    if (chunk.length > VERIFICATION_TRANSFER_LIMITS.maxInputBytes || chunk.length > file.bytes - used) invalid();
    const copy = new Uint8Array(chunk);
    if (used < head.length) head.set(copy.subarray(0, head.length - used), used);
    if (collect) output.set(copy, used);
    digest.update(copy); used += copy.length;
  }, signal);
  if (used !== file.bytes || digest.digestHex() !== file.sha256 || detect(head.subarray(0, Math.min(used, head.length))) !== file.content_type) invalid();
  return output;
}
export async function stageVerificationBundle(
  input: VerificationBundleInput, files: VerificationBundleFiles, target: VerificationImportTarget,
  media: VerificationMediaSession, options: VerificationMediaOptions = {},
): Promise<{ plan: VerificationPlan; files: number; bytes: number; rows: number; fullSiteComplete: false; serverStagingOrUploadsMayExist: true }> {
  let mayExist = false;
  let result: { plan: VerificationPlan; files: number; bytes: number; rows: number; fullSiteComplete: false; serverStagingOrUploadsMayExist: true } | undefined;
  try {
    check(options.signal);
    if (media.direction !== 'import') invalid();
    const checked = bundle(input, files);
    // ALL raw records, paths, actual file digests and tuple relations are checked
    // before ANY record bind/stage, media bind or upload can start.
    const recordEntry = checked.manifest.entries.find(e => e.kind === 'ndjson')!;
    matches(await scanRecords(files, checked.catalog, recordEntry, options.signal), checked.media);
    for (const file of checked.media) await scanMedia(files, file, options.signal);
    progress(options, 'validate', checked.media.length, checked.manifest.entries.reduce((n, e) => n + e.bytes, 0), checked.catalog.tables[0].rows);
    // Adapt the existing real two-pass record stager: defer only its cleanup to this
    // outer owner. Await each target call without racing abort, so no late writes.
    const staged = await stageVerificationImport(checked.catalog, {
      open: path => checkedChunks(files.open(path), options.signal),
      async abort() { /* Outer finally owns all plaintext. */ },
    }, {
      bind: catalog => settled(() => { mayExist = true; return target.bind(catalog, options.signal); }, options.signal),
      stage: (key, no, raw) => settled(() => target.stage(key, no, raw, options.signal), options.signal),
      plan: () => settled(() => target.plan(options.signal), options.signal),
    }, { onProgress: p => {
      if (p.phase === 'stage') progress(options, 'stage', 0, p.bytes, p.rows);
    } }); // Do not give the existing stager a signal that could race outstanding writes.
    const stagedPlan = validateVerificationPlan(staged.plan);
    if (checked.media.length && (stagedPlan.can_restore || !stagedPlan.conflicts.includes('media_incomplete'))) invalid();
    check(options.signal);
    matches((await settled(() => media.inventory(options.signal), options.signal)).files, checked.media);
    mayExist = true;
    await settled(() => media.bind(checked.media, options.signal), options.signal);
    let uploaded = 0, bytes = recordEntry.bytes;
    for (const file of checked.media) {
      const raw = await scanMedia(files, file, options.signal, true); // Second media read; hash AGAIN before upload.
      await settled(() => media.upload(file, raw, options.signal), options.signal);
      uploaded++; bytes += file.bytes;
      progress(options, 'upload', uploaded, bytes, staged.rows);
    }
    // Obtain the REAL refreshed server plan, never patch media_incomplete locally.
    const plan = validateVerificationPlan(await settled(() => target.plan(options.signal), options.signal));
    if (plan.counts.verification_requests !== checked.catalog.tables[0].rows || plan.employees !== checked.catalog.identity_catalog.tables[0].rows) invalid();
    result = { plan, files: uploaded, bytes, rows: staged.rows, fullSiteComplete: false, serverStagingOrUploadsMayExist: true };
  } catch { /* Fixed, non-sensitive error after awaited plaintext cleanup. */ }
  await discard(files, mayExist, options.signal);
  if (!result || options.signal?.aborted) throw new VerificationMediaError(mayExist, options.signal?.aborted === true);
  return result;
}
