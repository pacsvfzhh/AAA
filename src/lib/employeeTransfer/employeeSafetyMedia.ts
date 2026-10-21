import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import { MAX_CONTAINER_INPUT_BYTES, verifyEncryptedVolume, writeEncryptedVolume, type ContainerLimits, type TransferEntry } from './container';
import { readTransferMetadata, type TransferByteSource } from './crypto';
import { validateVolumeInfo, type ManifestEntry, type VolumeInfo, type VolumeManifest } from './manifest';
import { withAuthenticatedEmployeeSafetyBackup, validateEmployeeSafetyBackupCatalog,
  EmployeeSafetyBackupError, type EmployeeSafetyBackupCatalog, type EmployeeSafetyBackupIdentity } from './employeeSafetyBackup';
import type { ArchiveBundleWorkspace, ArchiveBundleWorkspaceFactory } from './archiveBundle';
import type { ReplacementBackupFile } from './replacementBackup';

export const EMPLOYEE_SAFETY_MEDIA_CATALOG_PATH = 'data/employee-safety-media.ndjson';
export const EMPLOYEE_SAFETY_MEDIA_TIMEOUT_MS = 120000;
export const EMPLOYEE_SAFETY_MEDIA_LIMITS = Object.freeze({ maxFiles: 3000, maxFileBytes: 50 * 1024 * 1024,
  maxAvatarBytes: 5 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024, maxCatalogBytes: 4 * 1024 * 1024,
  maxManifestBytes: 2 * 1024 * 1024, maxZipBytes: 1100 * 1024 * 1024, maxCipherBytes: 1101 * 1024 * 1024 });
export type EmployeeSafetyMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf' | 'video/mp4' | 'video/webm';
export interface EmployeeSafetyMediaFile {
  key: string; source_url: string; bytes: number; sha256: string; content_type: EmployeeSafetyMediaType;
}
export interface EmployeeSafetyMediaReference {
  key: string; source_url: string; bucket: string; path: string;
  kind: 'verification' | 'chat' | 'notifications' | 'archives'; avatar: boolean; file: EmployeeSafetyMediaFile | null;
}
const FLAGS = Object.freeze({ complete_employee_backup: false, can_archive: false, can_replace: false, full_site_complete: false } as const);
const RESULT_FLAGS = Object.freeze({ completeEmployeeBackup: false, canArchive: false, canReplace: false, fullSiteComplete: false } as const);
export interface EmployeeSafetyMediaInventory {
  version: 1; scope: 'employee-safety-media'; records_catalog: EmployeeSafetyBackupCatalog;
  files: EmployeeSafetyMediaReference[]; verified: boolean;
  complete_employee_backup: false; can_archive: false; can_replace: false; full_site_complete: false;
}
export interface EmployeeSafetyMediaSource {
  inventory(signal?: AbortSignal): Promise<EmployeeSafetyMediaInventory>;
  download(ref: EmployeeSafetyMediaReference, signal?: AbortSignal): Promise<{ file: EmployeeSafetyMediaFile; bytes: Uint8Array }>;
  recheck(files: readonly EmployeeSafetyMediaFile[], signal?: AbortSignal): Promise<void>;
  verify(signal?: AbortSignal): Promise<EmployeeSafetyMediaInventory>;
}
export type EmployeeSafetyMediaPhase = 'inventory' | 'download' | 'recheck' | 'verify' | 'records-authenticate' | 'save' | 'authenticate' | 'validate' | 'cleanup' | 'final-recheck' | 'consume';
export class EmployeeSafetyMediaError extends Error {
  constructor(readonly phase: EmployeeSafetyMediaPhase, readonly cancelled: boolean, readonly outcomeUnknown: boolean,
    readonly encryptedFileState: 'not-written' | 'unknown' | 'saved' | 'verified', readonly cleanupRequired: boolean) {
    super(`Employee safety media backup stopped during ${phase}. Keep any independent encrypted file, including incomplete or unconfirmed writes. `
      + 'No automatic retry, deletion, close, stop, archive, replacement, activation or maintenance release was performed. This is not a complete employee backup.'
      + (cleanupRequired ? ' Temporary plaintext cleanup was not confirmed; do not reuse the workspace.' : ''));
    this.name = 'EmployeeSafetyMediaError';
  }
}
export interface EmployeeSafetyMediaOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { phase: EmployeeSafetyMediaPhase; files: number; bytes: number; cipherBytes: number; cipherSha256: string | null; fullSiteComplete: false }) => void;
  limits?: { maxTotalBytes?: number };
}
export interface EmployeeSafetyMediaCatalog {
  version: 1; scope: 'employee-safety-media-backup'; inventory: EmployeeSafetyMediaInventory;
  records_file: { export_id: string; volume_id: string; cipher_bytes: number; cipher_sha256: string };
}
export interface EmployeeSafetyMediaResult {
  catalog: EmployeeSafetyMediaCatalog; manifest: VolumeManifest; files: number; bytes: number; cipherBytes: number; cipherSha256: string;
  mediaVerified: true; completeEmployeeBackup: false; canArchive: false; canReplace: false; fullSiteComplete: false;
}
const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const limits = EMPLOYEE_SAFETY_MEDIA_LIMITS;
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sha = (raw: Uint8Array) => new Sha256().update(raw).digestHex();
const hashText = (text: string) => sha(enc.encode(text));
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IDENTITY = new RegExp(`^employee-safety-media-v1:(${UUID}):(${UUID}):(${UUID}):([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-f]{64})$`);
const TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm'];
function invalid(): never { throw new EmployeeSafetyMediaError('validate', false, false, 'not-written', false); }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !new RegExp(`^${UUID}$`).test(value)) invalid(); return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) invalid(); return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, maximum);
  if (Reflect.ownKeys(value).length !== size + 1) invalid();
  return Array.from({ length: size }, (_, i) => {
    const item = Object.getOwnPropertyDescriptor(value, String(i));
    if (!item?.enumerable || !('value' in item)) invalid(); return item.value;
  });
}
function same(a: unknown, b: unknown): void {
  const stable = (v: unknown) => JSON.stringify(v, (_, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const r = item as Record<string, unknown>; return Object.fromEntries(Object.keys(r).sort().map(key => [key, r[key]]));
    }
    return item;
  });
  if (stable(a) !== stable(b)) invalid();
}
function identity(value: unknown, key: unknown, c: EmployeeSafetyBackupCatalog): string {
  if (typeof value !== 'string') invalid();
  const m = IDENTITY.exec(value);
  if (!m || m[0] !== value || m[1] !== c.site_id || m[2] !== c.job_id || m[3] !== c.employee_id
    || m[4] !== c.fingerprint || hash(key) !== hashText(value)) invalid();
  return value;
}
function tuple(value: unknown, c: EmployeeSafetyBackupCatalog): EmployeeSafetyMediaFile {
  const r = object(value, ['key', 'source_url', 'bytes', 'sha256', 'content_type']);
  const source_url = identity(r.source_url, r.key, c), bytes = count(r.bytes, limits.maxFileBytes);
  if (!bytes || typeof r.content_type !== 'string' || !TYPES.includes(r.content_type)) invalid();
  return { key: hash(r.key), source_url, bytes, sha256: hash(r.sha256), content_type: r.content_type as EmployeeSafetyMediaType };
}
function reference(value: unknown, c: EmployeeSafetyBackupCatalog): EmployeeSafetyMediaReference {
  const r = object(value, ['key', 'source_url', 'bucket', 'path', 'kind', 'avatar', 'file']);
  const source_url = identity(r.source_url, r.key, c);
  if (typeof r.bucket !== 'string' || typeof r.path !== 'string' || typeof r.avatar !== 'boolean'
    || (r.avatar && r.kind !== 'chat') || r.path !== r.path.trim() || r.path.includes('..')
    || hashText(r.bucket + '/' + r.path) !== IDENTITY.exec(source_url)![7]) invalid();
  if (r.kind === 'verification') {
    const pattern = new RegExp(`^(id-front|id-back|selfie)/${c.employee_id}-[A-Za-z0-9._-]+\\.[A-Za-z0-9]{1,8}$`);
    if (r.bucket !== 'verification-documents' || r.path.length > 512 || r.path.split('/')[1]?.length > 128 || !pattern.test(r.path)) invalid();
  } else if (r.kind === 'archives') {
    if (r.bucket !== 'content-audit-evidence' || r.path.length > 512
      || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(r.path)) invalid();
  } else if (r.kind === 'chat' || r.kind === 'notifications') {
    if (!['announcement-images', 'chat-images', 'template-images', ...(r.kind === 'chat' ? ['super-customer-avatars'] : [])].includes(r.bucket)
      || r.path.length > 1024 || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9]{1,8}$/.test(r.path)
      || r.path.split('/').includes('.') || (r.bucket === 'super-customer-avatars' && (!r.avatar || !r.path.startsWith('avatars/')))) invalid();
  } else invalid();
  const ref: EmployeeSafetyMediaReference = { key: hash(r.key), source_url, bucket: r.bucket, path: r.path, kind: r.kind,
    avatar: r.avatar, file: r.file === null ? null : tuple(r.file, c) };
  if (ref.file) fileForReference(ref.file, ref);
  return ref;
}
function fileForReference(file: EmployeeSafetyMediaFile, ref: EmployeeSafetyMediaReference): void {
  if (file.key !== ref.key || file.source_url !== ref.source_url
    || (ref.kind === 'verification' && file.content_type.startsWith('video/'))
    || (ref.kind === 'archives' && ['application/pdf', 'video/webm'].includes(file.content_type))
    || (ref.avatar && (file.bytes > limits.maxAvatarBytes || !file.content_type.startsWith('image/')))) invalid();
  if (ref.file) same(file, ref.file);
}
function inventory(value: unknown): EmployeeSafetyMediaInventory {
  const r = object(value, ['version', 'scope', 'records_catalog', 'files', 'verified', ...Object.keys(FLAGS)]);
  for (const key of Object.keys(FLAGS)) if (r[key] !== false) invalid();
  if (r.version !== 1 || r.scope !== 'employee-safety-media' || typeof r.verified !== 'boolean') invalid();
  const c = validateEmployeeSafetyBackupCatalog(r.records_catalog), files = array(r.files, limits.maxFiles).map(value => reference(value, c));
  for (let i = 0; i < files.length; i++) if ((i && files[i - 1].key >= files[i].key) || (r.verified && files[i].file === null)) invalid();
  if (c.tables.reduce((n, t) => n + t.bytes, files.reduce((n, r) => n + (r.file?.bytes ?? 0), 0)) > limits.maxTotalBytes) invalid();
  return { version: 1, scope: 'employee-safety-media', records_catalog: c, files, verified: r.verified, ...FLAGS };
}
export function validateEmployeeSafetyMediaInventory(value: unknown): EmployeeSafetyMediaInventory {
  try { return inventory(value); } catch { return invalid(); }
}
export function employeeSafetyMediaEntryPath(ref: Pick<EmployeeSafetyMediaReference, 'bucket' | 'key'>): string {
  if (!['verification-documents', 'announcement-images', 'chat-images', 'template-images', 'super-customer-avatars', 'content-audit-evidence'].includes(ref.bucket)) invalid();
  return `media/${ref.bucket}/${hash(ref.key)}`;
}
function matches(current: EmployeeSafetyMediaInventory, baseline: EmployeeSafetyMediaInventory, files?: readonly EmployeeSafetyMediaFile[], verified = false): void {
  same(current.records_catalog, baseline.records_catalog);
  same(current.files.map(r => ({ ...r, file: null })), baseline.files.map(r => ({ ...r, file: null })));
  if (verified && !current.verified) invalid();
  for (const [i, ref] of current.files.entries()) {
    if (baseline.files[i].file) same(ref.file, baseline.files[i].file);
    if (files) { fileForReference(files[i], ref); if (verified) same(ref.file, files[i]); }
  }
  if (files && files.length !== current.files.length) invalid();
}
// Byte signatures only: neither decoding nor malware scanning. Mirrors the Edge allowlist.
function ebml(bytes: Uint8Array, offset: number, end: number, id = false): { value: number; length: number } | null {
  if (offset >= end) return null;
  let mask = 0x80, length = 1;
  while (mask && !(bytes[offset] & mask)) { mask >>= 1; length++; }
  if (!mask || length > (id ? 4 : 8) || offset + length > end) return null;
  let value = id ? bytes[offset] : bytes[offset] & (mask - 1), unknown = !id && value === mask - 1;
  for (let i = 1; i < length; i++) { value = value * 256 + bytes[offset + i]; unknown = unknown && bytes[offset + i] === 255; }
  return unknown || !Number.isSafeInteger(value) ? null : { value, length };
}
function detect(bytes: Uint8Array): EmployeeSafetyMediaType {
  const starts = (s: number[], at = 0) => s.every((v, i) => bytes[at + i] === v);
  if (bytes.length >= 3 && starts([255, 216, 255])) return 'image/jpeg';
  if (bytes.length >= 8 && starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (bytes.length >= 6 && (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))) return 'image/gif';
  if (bytes.length >= 12 && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)) return 'image/webp';
  if (bytes.length >= 5 && starts([37, 80, 68, 70, 45])) return 'application/pdf';
  if (bytes.length >= 16 && starts([102, 116, 121, 112], 4)) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size >= 16 && size <= bytes.length && (size - 16) % 4 === 0) for (let i = 8; i < size; i += i === 8 ? 8 : 4) {
      if (['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '].includes(String.fromCharCode(...bytes.subarray(i, i + 4)))) return 'video/mp4';
    }
  }
  if (starts([26, 69, 223, 163])) {
    const h = ebml(bytes, 4, bytes.length); let webm = false;
    if (h && h.value > 0 && h.value <= 4096) {
      let offset = 4 + h.length; const end = offset + h.value;
      if (end <= bytes.length) {
        while (offset < end) {
          const id = ebml(bytes, offset, end, true); if (!id) invalid(); offset += id.length;
          const size = ebml(bytes, offset, end); if (!size) invalid(); offset += size.length;
          if (size.value > end - offset) invalid();
          if (id.value === 0x4282) {
            if (webm || size.value !== 4 || String.fromCharCode(...bytes.subarray(offset, offset + 4)) !== 'webm') invalid(); webm = true;
          }
          offset += size.value;
        }
        if (webm) return 'video/webm';
      }
    }
  }
  return invalid();
}
function inspect(file: EmployeeSafetyMediaFile, bytes: Uint8Array, ref: EmployeeSafetyMediaReference): void {
  fileForReference(file, ref);
  if (!(bytes instanceof Uint8Array) || bytes.length !== file.bytes || sha(bytes) !== file.sha256 || detect(bytes) !== file.content_type) invalid();
}
function cancel(body: ReadableStream<Uint8Array> | null): void { try { void body?.cancel().catch(() => undefined); } catch { /* Nonblocking. */ } }
async function responseBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const encoding = response.headers.get('content-encoding'), length = response.headers.get('content-length');
  if (response.status !== 200 || response.redirected || response.headers.has('content-range')
    || (encoding !== null && encoding.toLowerCase() !== 'identity')) invalid();
  let expected: number | null = null;
  if (length !== null) {
    if (!/^[1-9][0-9]{0,8}$/.test(length)) invalid(); expected = Number(length); if (expected > maximum) invalid();
  }
  if (!response.body) invalid();
  const reader = response.body.getReader(); let bytes = new Uint8Array(Math.min(expected ?? 65536, maximum)), used = 0;
  const onAbort = () => { try { void reader.cancel().catch(() => undefined); } catch { /* Nonblocking. */ } };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const next = await withSignal(() => reader.read(), signal); checkAbort(signal); if (next.done) break;
      const raw = next.value;
      if (!(raw instanceof Uint8Array) || raw.length > maximum - used) invalid();
      if (used + raw.length > bytes.length) {
        const grown = new Uint8Array(Math.min(maximum, Math.max(used + raw.length, bytes.length * 2))); grown.set(bytes.subarray(0, used)); bytes = grown;
      }
      bytes.set(raw, used); used += raw.length;
    }
    if (!used || (expected !== null && used !== expected)) invalid(); return bytes.subarray(0, used);
  } finally {
    signal.removeEventListener('abort', onAbort); onAbort(); reader.releaseLock();
  }
}
async function deadline<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
  const controller = new AbortController(), abort = () => controller.abort();
  parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
  const timer = setTimeout(abort, EMPLOYEE_SAFETY_MEDIA_TIMEOUT_MS);
  try { return await withSignal(() => operation(controller.signal), controller.signal); }
  finally { clearTimeout(timer); parent.removeEventListener('abort', abort); controller.abort(); }
}
type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
export function createEmployeeSafetyMediaSource(
  input: EmployeeSafetyBackupIdentity, catalog: EmployeeSafetyBackupCatalog, transport: typeof fetch = globalThis.fetch,
): EmployeeSafetyMediaSource {
  let c: EmployeeSafetyBackupCatalog, jobToken: string, endpoint: string, apiKey: string;
  try {
    c = validateEmployeeSafetyBackupCatalog(catalog);
    const r = object(input, ['job_id', 'job_token', 'site_id', 'employee_id', 'username']);
    if (uuid(r.job_id) !== c.job_id || uuid(r.site_id) !== c.site_id || uuid(r.employee_id) !== c.employee_id || r.username !== c.username) invalid();
    jobToken = uuid(r.job_token);
    // Only current environment coordinates; never a caller-supplied URL, site token or direction.
    const url: unknown = import.meta.env.VITE_SUPABASE_URL;
    if (typeof url !== 'string') invalid(); const origin = url.endsWith('/') ? url.slice(0, -1) : url;
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(origin) || origin !== origin.trim()) invalid();
    endpoint = origin + '/functions/v1/employee-transfer-media'; apiKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (typeof apiKey !== 'string' || !apiKey || apiKey !== apiKey.trim() || /[\r\n]/.test(apiKey)) invalid();
  } catch { return invalid(); }
  let busy = false, baseline: EmployeeSafetyMediaInventory | null = null;
  const observed = new Map<string, EmployeeSafetyMediaFile>();
  const params = () => ({ p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: jobToken, p_catalog_fingerprint: c.fingerprint });
  const request = async <T>(phase: EmployeeSafetyMediaPhase, operation: (signal: AbortSignal, mark: () => void) => Promise<T>, inputSignal?: AbortSignal): Promise<T> => {
    if (busy) throw new EmployeeSafetyMediaError(phase, false, false, 'not-written', false);
    busy = true; const controller = new AbortController(); let sent = false;
    const abort = () => controller.abort(); inputSignal?.addEventListener('abort', abort, { once: true }); if (inputSignal?.aborted) abort();
    try { return await withSignal(() => operation(controller.signal, () => { sent = true; }), controller.signal); }
    catch { throw new EmployeeSafetyMediaError(phase, inputSignal?.aborted === true, sent, 'not-written', false); }
    finally { inputSignal?.removeEventListener('abort', abort); controller.abort(); busy = false; }
  };
  const readInventory = (verify: boolean, parent: AbortSignal) => deadline(async signal => {
    // SQL47 is not in the hand-maintained RPC types yet. Keep the local boundary unknown and validate every field.
    const rpc = supabase.rpc.bind(supabase) as unknown as (name: string, args: ReturnType<typeof params>) => Query;
    const result = await withSignal(() => rpc(verify ? 'employee_safety_backup_media_verify' : 'get_employee_safety_backup_media', params()).abortSignal(signal), signal);
    if (result.error) invalid(); const next = inventory(result.data); same(next.records_catalog, c);
    if (baseline) matches(next, baseline);
    for (const ref of next.files) if (observed.has(ref.key)) same(ref.file, observed.get(ref.key));
    if (verify && !next.verified) invalid();
    if (!baseline) baseline = inventory(next); return next;
  }, parent);
  const post = <T>(action: 'download' | 'recheck-export', ref: EmployeeSafetyMediaReference, parent: AbortSignal, mark: () => void, consume: (res: Response, signal: AbortSignal) => Promise<T>): Promise<T> => deadline(async signal => {
    const auth = params(); let res: Response | undefined;
    try {
      checkAbort(signal); mark();
      res = await withSignal<Response>(() => transport(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
        headers: { apikey: apiKey, 'Content-Type': 'application/octet-stream', 'x-transfer-scope': 'employee-safety', 'x-transfer-action': action,
          'x-admin-session-token': auth.p_admin_session_token, 'x-transfer-job-token': jobToken, 'x-transfer-object-key': ref.key } }).then(response => {
          if (signal.aborted) { cancel(response.body); checkAbort(signal); } return response;
        }), signal);
      checkAbort(signal); return await consume(res, signal);
    } finally { if (res) cancel(res.body); }
  }, parent);
  return Object.freeze({
    inventory: (signal?: AbortSignal) => request('inventory', s => readInventory(false, s), signal),
    download: (input: EmployeeSafetyMediaReference, signal?: AbortSignal) => request('download', async (s, mark) => {
      const ref = reference(input, c);
      const current = await readInventory(false, s), bound = current.files.find(r => r.key === ref.key); if (!bound) invalid(); same(ref, bound);
      return post('download', ref, s, mark, async (res, bodySignal) => {
        if (res.headers.get('content-type') !== 'application/octet-stream') invalid();
        const raw = await responseBytes(res, ref.file?.bytes ?? (ref.avatar ? limits.maxAvatarBytes : limits.maxFileBytes), bodySignal);
        const file = tuple({ key: ref.key, source_url: ref.source_url, bytes: raw.length, sha256: res.headers.get('x-transfer-sha256'), content_type: res.headers.get('x-transfer-content-type') }, c);
        inspect(file, raw, ref); if (observed.has(ref.key)) same(file, observed.get(ref.key)); observed.set(ref.key, { ...file }); return { file, bytes: raw };
      });
    }, signal),
    recheck: (input: readonly EmployeeSafetyMediaFile[], signal?: AbortSignal) => request('recheck', async (s, mark) => {
      const files = array(input, limits.maxFiles).map(v => tuple(v, c)), current = await readInventory(false, s);
      matches(current, current, files);
      if (current.files.some(ref => ref.file === null)) invalid();
      for (const [i, file] of files.entries()) await post('recheck-export', current.files[i], s, mark, async (res, bodySignal) => {
        if (res.headers.get('content-type') !== 'application/json') invalid();
        const r = object(JSON.parse(dec.decode(await responseBytes(res, 4096, bodySignal))), ['success', 'key', 'bytes', 'sha256', 'content_type', ...Object.keys(FLAGS)]);
        for (const key of Object.keys(FLAGS)) if (r[key] !== false) invalid();
        if (r.success !== true || r.key !== file.key || r.bytes !== file.bytes || r.sha256 !== file.sha256 || r.content_type !== file.content_type) invalid();
        observed.set(file.key, { ...file });
      });
    }, signal),
    verify: (signal?: AbortSignal) => request('verify', async s => {
      const next = await readInventory(true, s);
      // Server owns checked; locally observed tuples cannot be replaced by a new valid receipt.
      if (baseline) matches(next, baseline); return next;
    }, signal),
  });
}

async function* read(source: TransferByteSource, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') invalid();
  const iterator = source[Symbol.asyncIterator](); let ended = false;
  try {
    for (;;) {
      const next = await withSignal(() => iterator.next(), signal); checkAbort(signal);
      if (next.done) { ended = true; return; }
      if (!(next.value instanceof Uint8Array) || next.value.length > MAX_CONTAINER_INPUT_BYTES) invalid(); yield new Uint8Array(next.value);
    }
  } finally { if (!ended) { try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* Nonblocking. */ } } }
}
class CipherScan {
  bytes = 0; private ended = false; private readonly hash = new Sha256();
  async *read(source: TransferByteSource, run: Run): AsyncGenerator<Uint8Array> {
    for await (const raw of read(source, run.signal)) {
      this.bytes += raw.length; if (this.bytes > limits.maxCipherBytes) invalid(); this.hash.update(raw); yield raw;
    }
    this.ended = true;
  }
  digest(): string { if (!this.ended || !this.bytes) invalid(); return this.hash.digestHex(); }
}
// Across nested record readers, exports and later calls: a factory must never return a used plaintext workspace.
const usedWorkspaces = new WeakSet<ArchiveBundleWorkspace>(), attemptedFiles = new WeakSet<ReplacementBackupFile>();
class Run {
  readonly controller = new AbortController(); readonly signal = this.controller.signal;
  phase: EmployeeSafetyMediaPhase = 'records-authenticate'; fileState: EmployeeSafetyMediaError['encryptedFileState'] = 'not-written'; unknown = false;
  files = 0; bytes = 0; cipherBytes = 0; cipherSha256: string | null = null;
  private readonly spaces: { w: ArchiveBundleWorkspace; cleanup?: Promise<void> }[] = [];
  private readonly abort = () => this.controller.abort();
  constructor(readonly options: EmployeeSafetyMediaOptions, private readonly factory: ArchiveBundleWorkspaceFactory) {
    options.signal?.addEventListener('abort', this.abort, { once: true }); if (options.signal?.aborted) this.abort();
  }
  workspace = (): ArchiveBundleWorkspace => {
    checkAbort(this.signal); const w = this.factory(); if (usedWorkspaces.has(w)) invalid(); usedWorkspaces.add(w);
    const item: { w: ArchiveBundleWorkspace; cleanup?: Promise<void> } = { w }; this.spaces.push(item);
    return { open: path => w.open(path), append: (path, raw, signal) => w.append(path, raw, signal),
      abort: reason => this.discard(item, reason) };
  };
  progress(): void {
    checkAbort(this.signal); this.options.onProgress?.({ phase: this.phase, files: this.files, bytes: this.bytes,
      cipherBytes: this.cipherBytes, cipherSha256: this.cipherSha256, fullSiteComplete: false }); checkAbort(this.signal);
  }
  private discard(item: { w: ArchiveBundleWorkspace; cleanup?: Promise<void> }, reason: unknown): Promise<void> {
    return item.cleanup ??= (async () => {
      const controller = new AbortController();
      // Give prompt cleanup a turn even after cancellation; never hang on an untrusted cleanup promise.
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { cancelTimer ??= setTimeout(() => controller.abort(), 0); };
      const timer = setTimeout(() => controller.abort(), EMPLOYEE_SAFETY_MEDIA_TIMEOUT_MS);
      this.options.signal?.addEventListener('abort', abort, { once: true }); if (this.options.signal?.aborted) abort();
      try { await withSignal(() => item.w.abort(reason), controller.signal); }
      finally { clearTimeout(timer); clearTimeout(cancelTimer); this.options.signal?.removeEventListener('abort', abort); }
    })();
  }
  async cleanup(): Promise<void> {
    let failed = false;
    for (const item of this.spaces) {
      try { await this.discard(item, new Error('Employee safety media plaintext discarded.')); } catch { failed = true; }
    }
    if (failed) throw new EmployeeSafetyMediaError(this.phase, false, this.unknown, this.fileState, true);
  }
  async finish<T>(operation: () => Promise<T>): Promise<T> {
    let result: T | undefined, failed = false, cleanupRequired = false;
    try { result = await operation(); checkAbort(this.signal); }
    catch (error) {
      failed = true;
      if (error instanceof EmployeeSafetyMediaError || error instanceof EmployeeSafetyBackupError) {
        this.unknown ||= error.outcomeUnknown; cleanupRequired ||= error.cleanupRequired;
      }
      this.controller.abort();
    } finally {
      try { await this.cleanup(); } catch { cleanupRequired = true; }
      this.options.signal?.removeEventListener('abort', this.abort);
    }
    if (failed || cleanupRequired || this.signal.aborted) throw new EmployeeSafetyMediaError(this.phase,
      this.options.signal?.aborted === true, this.unknown, this.fileState, cleanupRequired);
    return result!;
  }
}
function containerLimits(run: Run): Partial<ContainerLimits> {
  const maximum = count(run.options.limits?.maxTotalBytes ?? limits.maxTotalBytes, limits.maxTotalBytes); if (!maximum) invalid();
  return { maxEntries: limits.maxFiles + 1, maxEntryBytes: limits.maxFileBytes, maxTotalBytes: maximum,
    maxZipBytes: limits.maxZipBytes, maxManifestBytes: limits.maxManifestBytes, maxLineBytes: limits.maxCatalogBytes };
}
interface RecordsBinding { catalog: EmployeeSafetyBackupCatalog; manifest: VolumeManifest; file: EmployeeSafetyMediaCatalog['records_file'] }
async function authenticateRecords(file: Pick<ReplacementBackupFile, 'open'>, passphrase: string, run: Run): Promise<RecordsBinding> {
  run.phase = 'records-authenticate';
  // Hash the very stream consumed by SQL46's full authenticated reader, not a separate unauthenticated pass.
  const scans: CipherScan[] = [];
  const scannedFile = { open() { const scan = new CipherScan(); scans.push(scan); return scan.read(file.open(), run); } };
  return withAuthenticatedEmployeeSafetyBackup(scannedFile, passphrase, run.workspace, async reader => {
    const scan = scans[scans.length - 1], digest = scan.digest(), manifest = reader.manifest;
    return { catalog: reader.catalog, manifest, file: { export_id: manifest.exportId, volume_id: manifest.volumeId, cipher_bytes: scan.bytes, cipher_sha256: digest } };
  }, { signal: run.signal });
}
function mediaVolume(input: VolumeInfo, records: RecordsBinding): void {
  const c = records.catalog;
  if (input.scope !== 'replacement-backup' || input.volumeIndex !== 1 || input.volumeCount !== 1 || input.sourceSiteId !== c.site_id) invalid();
  const forbidden = [records.manifest.exportId, records.manifest.volumeId, c.job_id, c.employee_id];
  for (const id of [input.exportId, input.volumeId]) {
    uuid(id); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || forbidden.includes(id)) invalid();
  }
  if (input.exportId === input.volumeId) invalid();
}
function catalog(value: unknown): EmployeeSafetyMediaCatalog {
  const r = object(value, ['version', 'scope', 'inventory', 'records_file']);
  if (r.version !== 1 || r.scope !== 'employee-safety-media-backup') invalid();
  const inv = inventory(r.inventory); if (!inv.verified) invalid();
  const f = object(r.records_file, ['export_id', 'volume_id', 'cipher_bytes', 'cipher_sha256']);
  const cipher_bytes = count(f.cipher_bytes, limits.maxCipherBytes); if (!cipher_bytes || typeof f.export_id !== 'string' || typeof f.volume_id !== 'string') invalid();
  return { version: 1, scope: 'employee-safety-media-backup', inventory: inv,
    records_file: { export_id: f.export_id, volume_id: f.volume_id, cipher_bytes, cipher_sha256: hash(f.cipher_sha256) } };
}
function expectedEntries(c: EmployeeSafetyMediaCatalog, raw: Uint8Array): ManifestEntry[] {
  return [{ path: EMPLOYEE_SAFETY_MEDIA_CATALOG_PATH, kind: 'ndjson', bytes: raw.length, sha256: sha(raw) },
    ...c.inventory.files.map(ref => ({ path: employeeSafetyMediaEntryPath(ref), kind: 'media' as const, bytes: ref.file!.bytes, sha256: ref.file!.sha256 }))];
}
async function bounded(source: TransferByteSource, maximum: number, run: Run): Promise<Uint8Array> {
  const bytes = new Uint8Array(maximum); let used = 0;
  for await (const raw of read(source, run.signal)) { if (raw.length > maximum - used) invalid(); bytes.set(raw, used); used += raw.length; }
  return bytes.subarray(0, used);
}
async function validateSaved(w: ArchiveBundleWorkspace, manifest: VolumeManifest, records: RecordsBinding, run: Run): Promise<EmployeeSafetyMediaCatalog> {
  run.phase = 'validate'; mediaVolume(manifest, records);
  const first = manifest.entries[0];
  if (first?.path !== EMPLOYEE_SAFETY_MEDIA_CATALOG_PATH || !first.bytes || first.bytes > limits.maxCatalogBytes) invalid();
  const raw = await bounded(w.open(first.path), first.bytes, run), text = dec.decode(raw), c = catalog(JSON.parse(text));
  if (text !== JSON.stringify(c) + '\n' || raw.length !== first.bytes || sha(raw) !== first.sha256) invalid();
  same(c.records_file, records.file); same(c.inventory.records_catalog, records.catalog); same(manifest.entries, expectedEntries(c, raw));
  const total = manifest.entries.reduce((n, e) => n + e.bytes, 0) + records.manifest.entries.reduce((n, e) => n + e.bytes, 0);
  if (total > containerLimits(run).maxTotalBytes!) invalid();
  for (const ref of c.inventory.files) {
    const bytes = await bounded(w.open(employeeSafetyMediaEntryPath(ref)), ref.file!.bytes, run);
    try { inspect(ref.file!, bytes, ref); } finally { bytes.fill(0); }
  }
  return c;
}
async function authenticateMedia(file: Pick<ReplacementBackupFile, 'open'>, passphrase: string, w: ArchiveBundleWorkspace, run: Run) {
  run.phase = 'authenticate'; const metadata = await readTransferMetadata(read(file.open(), run.signal), run.signal);
  const scan = new CipherScan(), stream = scan.read(file.open(), run);
  let manifest: VolumeManifest;
  try { manifest = await verifyEncryptedVolume(stream, passphrase, w, { signal: run.signal, limits: containerLimits(run), expectedMetadata: metadata }); }
  finally { void stream.return(undefined).catch(() => undefined); }
  return { manifest, cipherBytes: scan.bytes, cipherSha256: scan.digest() };
}
async function append(w: ArchiveBundleWorkspace, path: string, raw: Uint8Array, run: Run): Promise<void> {
  for (let offset = 0; offset < raw.length; offset += MAX_CONTAINER_INPUT_BYTES) {
    await withSignal(() => w.append(path, raw.slice(offset, offset + MAX_CONTAINER_INPUT_BYTES), run.signal), run.signal);
  }
}
export async function exportEmployeeSafetyMediaBackup(
  source: EmployeeSafetyMediaSource, recordsFile: Pick<ReplacementBackupFile, 'open'>, outputFile: ReplacementBackupFile,
  workspaceFactory: ArchiveBundleWorkspaceFactory, passphrase: string, volumeInfo: VolumeInfo, options: EmployeeSafetyMediaOptions = {},
): Promise<EmployeeSafetyMediaResult> {
  const run = new Run(options, workspaceFactory);
  return run.finish(async () => {
    containerLimits(run);
    if (recordsFile === outputFile || attemptedFiles.has(outputFile)) invalid();
    const records = await authenticateRecords(recordsFile, passphrase, run), info = validateVolumeInfo(volumeInfo); mediaVolume(info, records);
    run.phase = 'inventory'; const baseline = inventory(await withSignal(() => source.inventory(run.signal), run.signal)); same(baseline.records_catalog, records.catalog);
    const snapshot = run.workspace(), files: EmployeeSafetyMediaFile[] = [];
    const recordBytes = records.manifest.entries.reduce((n, e) => n + e.bytes, 0); run.bytes = recordBytes;
    run.phase = 'download';
    for (const ref of baseline.files) {
      run.unknown = true; // Even download commits a technical receipt; cancellation may hide its response.
      const downloaded = await withSignal(() => source.download(structuredClone(ref), run.signal), run.signal);
      const r = object(downloaded, ['file', 'bytes']), file = tuple(r.file, records.catalog);
      if (!(r.bytes instanceof Uint8Array) || r.bytes.length !== file.bytes) invalid();
      const raw = new Uint8Array(r.bytes);
      try {
        inspect(file, raw, ref); run.unknown = false;
        if (run.bytes + raw.length > containerLimits(run).maxTotalBytes!) invalid();
        await append(snapshot, employeeSafetyMediaEntryPath(ref), raw, run);
        files.push(file); run.files++; run.bytes += raw.length; run.progress();
      } finally { raw.fill(0); }
    }
    const recheck = async () => {
      if (files.length) run.unknown = true;
      await withSignal(() => source.recheck(structuredClone(files), run.signal), run.signal); run.unknown = false;
      const current = inventory(await withSignal(() => source.verify(run.signal), run.signal)); matches(current, baseline, files, true); return current;
    };
    run.phase = 'recheck'; const checked = await recheck();
    const c: EmployeeSafetyMediaCatalog = { version: 1, scope: 'employee-safety-media-backup', inventory: checked, records_file: records.file };
    const raw = enc.encode(JSON.stringify(c) + '\n');
    if (raw.length > limits.maxCatalogBytes || run.bytes + raw.length > containerLimits(run).maxTotalBytes!) invalid();
    run.bytes += raw.length; await append(snapshot, EMPLOYEE_SAFETY_MEDIA_CATALOG_PATH, raw, run);
    const expected = expectedEntries(c, raw);
    async function* entries(): AsyncGenerator<TransferEntry> {
      for (const e of expected) yield { path: e.path, bytes: e.bytes, open: () => read(snapshot.open(e.path), run.signal) };
    }
    run.phase = 'save'; const written = new CipherScan(), encrypted = written.read(writeEncryptedVolume(entries(), info, passphrase, { signal: run.signal, limits: containerLimits(run) }), run);
    try {
      await withSignal(async () => {
        attemptedFiles.add(outputFile); run.unknown = true; run.fileState = 'unknown'; await outputFile.write(encrypted, run.signal);
      }, run.signal);
      checkAbort(run.signal); run.cipherSha256 = written.digest(); run.cipherBytes = written.bytes; run.fileState = 'saved'; run.unknown = false; run.progress();
    } finally { void encrypted.return(undefined).catch(() => undefined); }
    await snapshot.abort(new Error('Employee safety media snapshot discarded.'));
    const readback = run.workspace(), authenticated = await authenticateMedia(outputFile, passphrase, readback, run);
    same(authenticated.cipherSha256, written.digest()); same(authenticated.cipherBytes, written.bytes);
    same(validateVolumeInfo(Object.fromEntries(Object.keys(info).map(key => [key, authenticated.manifest[key as keyof VolumeInfo]]))), info);
    same(authenticated.manifest.entries, expected); same(await validateSaved(readback, authenticated.manifest, records, run), c);
    run.fileState = 'verified'; run.phase = 'cleanup'; await run.cleanup(); checkAbort(run.signal);
    run.phase = 'final-recheck'; same(await recheck(), checked); run.progress();
    return { catalog: c, ...authenticated, files: files.length, bytes: run.bytes, mediaVerified: true, ...RESULT_FLAGS };
  });
}
export interface AuthenticatedEmployeeSafetyMediaBackup {
  readonly inventory: EmployeeSafetyMediaInventory;
  readonly manifest: VolumeManifest;
  readonly completeEmployeeBackup: false; readonly canArchive: false; readonly canReplace: false; readonly fullSiteComplete: false;
  open(path: string): TransferByteSource;
}
export async function withAuthenticatedEmployeeSafetyMediaBackup<T>(
  recordsFile: Pick<ReplacementBackupFile, 'open'>, mediaFile: Pick<ReplacementBackupFile, 'open'>, passphrase: string,
  factory: ArchiveBundleWorkspaceFactory, consume: (reader: AuthenticatedEmployeeSafetyMediaBackup) => Promise<T>, options: EmployeeSafetyMediaOptions = {},
): Promise<T> {
  const run = new Run(options, factory);
  return run.finish(async () => {
    containerLimits(run); if (recordsFile === mediaFile) invalid();
    const records = await authenticateRecords(recordsFile, passphrase, run), workspace = run.workspace();
    const authenticated = await authenticateMedia(mediaFile, passphrase, workspace, run), c = await validateSaved(workspace, authenticated.manifest, records, run);
    const paths = new Set(c.inventory.files.map(employeeSafetyMediaEntryPath)); let active = true;
    const lifetime = new AbortController(), abort = () => lifetime.abort();
    run.signal.addEventListener('abort', abort, { once: true }); if (run.signal.aborted) abort();
    const reader: AuthenticatedEmployeeSafetyMediaBackup = Object.freeze({
      get inventory() { if (!active) invalid(); return inventory(c.inventory); },
      get manifest() { if (!active) invalid(); return structuredClone(authenticated.manifest); },
      ...RESULT_FLAGS,
      open(path: string): TransferByteSource {
        if (!active || !paths.has(path)) invalid();
        return { async *[Symbol.asyncIterator]() {
          if (!active) invalid();
          const iterator = read(workspace.open(path), lifetime.signal);
          try {
            for (;;) {
              if (!active) invalid(); const next = await iterator.next(); if (!active) invalid();
              if (next.done) return; yield next.value;
            }
          } catch { throw new EmployeeSafetyMediaError('consume', options.signal?.aborted === true, false, run.fileState, false); }
          finally { void iterator.return(undefined).catch(() => undefined); }
        } };
      },
    });
    run.phase = 'consume';
    try { return await withSignal(() => consume(reader), run.signal); }
    finally { active = false; lifetime.abort(); run.signal.removeEventListener('abort', abort); }
  });
}
