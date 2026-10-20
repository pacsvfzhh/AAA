import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { validateArchivesCatalog, type ArchivesCatalog } from './archiveTransfer';
import { Sha256 } from './sha256';

// Independent substage. Caller owns encrypted packaging/disk cleanup and record restore (SQL34).
export const ARCHIVE_MEDIA_LIMITS = Object.freeze({ maxFiles: 3000, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 });
export type ArchiveMediaDirection = 'export' | 'import';
export type ArchiveMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'video/mp4';
export interface ArchiveMediaFile { key: string; source_url: string; bytes: number; sha256: string; content_type: ArchiveMediaType }
export interface ArchiveMediaReference {
  key: string; source_url: string; event_id: string; source_line_sha256: string; ref_key: string; ref_value: string;
  bucket: 'content-audit-evidence'; path: string; file: ArchiveMediaFile | null;
}
export interface ArchiveMediaInventory {
  version: 1; scope: 'site-archives-media'; direction: ArchiveMediaDirection; archives_catalog: ArchivesCatalog;
  files: ArchiveMediaReference[]; bound: boolean; verified: boolean; transferred: string[]; checked: string[]; full_site_complete: false;
}
export class ArchiveMediaError extends Error {
  constructor(readonly outcomeUnknown: boolean) {
    super('Archive media operation is unconfirmed. Read explicit status before resuming. No automatic retry, delete, rollback, activation, maintenance release or full-site completion.');
    this.name = 'ArchiveMediaError';
  }
}
const { object } = dispatchTransferChecks;
const enc = new TextEncoder();
const sha = (bytes: Uint8Array) => new Sha256().update(bytes).digestHex();
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IDENTITY = new RegExp(`^archive-evidence-v1:(${UUID}):(${UUID}):(${UUID}):([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-f]{64})$`);
const TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4'];
function invalid(): never { throw new ArchiveMediaError(false); }
function check(signal?: AbortSignal): void { if (signal?.aborted) invalid(); }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !new RegExp(`^${UUID}$`).test(value)) invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}
function count(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) invalid();
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max || Object.keys(value).length !== value.length) invalid();
  return Array.from(value);
}
function identity(value: unknown): string[] {
  if (typeof value !== 'string') invalid();
  const match = IDENTITY.exec(value);
  if (!match || match[0] !== value) invalid();
  return match;
}
export function validateArchiveMediaFile(value: unknown): ArchiveMediaFile {
  const r = object(value, ['key', 'source_url', 'bytes', 'sha256', 'content_type']);
  const source = identity(r.source_url)[0], key = hash(r.key), bytes = count(r.bytes, ARCHIVE_MEDIA_LIMITS.maxFileBytes);
  if (!bytes || key !== sha(enc.encode(source)) || typeof r.content_type !== 'string' || !TYPES.includes(r.content_type)) invalid();
  return { key, source_url: source, bytes, sha256: hash(r.sha256), content_type: r.content_type as ArchiveMediaType };
}
function same(a: ArchiveMediaFile, b: ArchiveMediaFile): boolean {
  return a.key === b.key && a.source_url === b.source_url && a.bytes === b.bytes && a.sha256 === b.sha256 && a.content_type === b.content_type;
}
function ordered(keys: readonly string[]): void { for (let i = 1; i < keys.length; i++) if (keys[i - 1] >= keys[i]) invalid(); }
function files(input: unknown): ArchiveMediaFile[] {
  const result = array(input, ARCHIVE_MEDIA_LIMITS.maxFiles).map(validateArchiveMediaFile);
  ordered(result.map(f => f.key));
  if (result.reduce((n, f) => n + f.bytes, 0) > ARCHIVE_MEDIA_LIMITS.maxTotalBytes) invalid();
  return result;
}
function reference(value: unknown): ArchiveMediaReference {
  const r = object(value, ['key', 'source_url', 'event_id', 'source_line_sha256', 'ref_key', 'ref_value', 'bucket', 'path', 'file']);
  const id = identity(r.source_url), key = hash(r.key);
  if (key !== sha(enc.encode(id[0])) || uuid(r.event_id) !== id[3] || hash(r.source_line_sha256) !== id[4] ||
    typeof r.ref_key !== 'string' || !r.ref_key || enc.encode(r.ref_key).length > 4096 || sha(enc.encode(r.ref_key)) !== id[5] ||
    typeof r.ref_value !== 'string' || !r.ref_value || r.ref_value.length > 512 ||
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(r.ref_value) || r.ref_value.includes('..') ||
    sha(enc.encode(r.ref_value)) !== id[6] || r.path !== r.ref_value || r.bucket !== 'content-audit-evidence') invalid();
  const file = r.file === null ? null : validateArchiveMediaFile(r.file);
  if (file && (file.key !== key || file.source_url !== id[0])) invalid();
  return { key, source_url: id[0], event_id: r.event_id as string, source_line_sha256: r.source_line_sha256 as string,
    ref_key: r.ref_key, ref_value: r.ref_value, path: r.ref_value, bucket: 'content-audit-evidence', file };
}
export function validateArchiveMediaInventory(value: unknown, direction: ArchiveMediaDirection): ArchiveMediaInventory {
  const r = object(value, ['version', 'scope', 'direction', 'archives_catalog', 'files', 'bound', 'verified', 'transferred', 'checked', 'full_site_complete']);
  if (r.version !== 1 || r.scope !== 'site-archives-media' || r.direction !== direction || r.full_site_complete !== false ||
    typeof r.bound !== 'boolean' || typeof r.verified !== 'boolean') invalid();
  const catalog = validateArchivesCatalog(r.archives_catalog), refs = array(r.files, ARCHIVE_MEDIA_LIMITS.maxFiles).map(reference);
  ordered(refs.map(f => f.key));
  if (refs.some(ref => { const id = identity(ref.source_url); return id[1] !== catalog.site_id || id[2] !== catalog.package_id; })) invalid();
  const transferred = array(r.transferred, refs.length).map(hash), checked = array(r.checked, refs.length).map(hash);
  ordered(transferred); ordered(checked);
  if (transferred.some(key => !refs.some(ref => ref.key === key && ref.file)) || checked.some(key => !transferred.includes(key)) ||
    (r.verified && (!r.bound || checked.length !== refs.length)) || (r.bound && direction === 'import' && refs.some(ref => !ref.file)) ||
    (direction === 'export' && (!r.bound || refs.some(ref => ref.file && !transferred.includes(ref.key)))) ||
    (direction === 'import' && !r.bound && (refs.some(ref => ref.file) || transferred.length !== 0))) invalid();
  if (catalog.tables.reduce((n, t) => n + t.bytes, refs.reduce((n, f) => n + (f.file?.bytes ?? 0), 0)) > ARCHIVE_MEDIA_LIMITS.maxTotalBytes) invalid();
  return { version: 1, scope: 'site-archives-media', direction, archives_catalog: catalog, files: refs, bound: r.bound,
    verified: r.verified, transferred, checked, full_site_complete: false };
}
function detect(bytes: Uint8Array): ArchiveMediaType {
  const starts = (a: number[], offset = 0) => a.every((b, i) => bytes[offset + i] === b);
  if (bytes.length >= 8 && starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (bytes.length >= 3 && starts([255, 216, 255])) return 'image/jpeg';
  if (bytes.length >= 6 && (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))) return 'image/gif';
  if (bytes.length >= 12 && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)) return 'image/webp';
  if (bytes.length >= 16 && starts([102, 116, 121, 112], 4)) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size >= 16 && size <= bytes.length && (size - 16) % 4 === 0) {
      for (let i = 8; i < size; i += i === 8 ? 8 : 4) {
        if (['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '].includes(String.fromCharCode(...bytes.subarray(i, i + 4)))) return 'video/mp4';
      }
    }
  }
  return invalid(); // Magic signatures only, not a decoder or malware scan.
}
function inspect(file: ArchiveMediaFile, bytes: Uint8Array): void {
  if (bytes.length !== file.bytes || sha(bytes) !== file.sha256 || detect(bytes) !== file.content_type) invalid();
}
async function read(response: Response, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) invalid();
  const output = new Uint8Array(max);let used = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      check(signal);const item = await reader.read();check(signal);
      if (item.done) break;
      if (!(item.value instanceof Uint8Array) || item.value.length > max - used) invalid();
      output.set(item.value, used);used += item.value.length;
    }
    return output.subarray(0, used);
  } finally { signal?.removeEventListener('abort', cancel);void reader.cancel().catch(() => {});reader.releaseLock(); }
}
function config() {
  const host = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, ''), apiKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (typeof host !== 'string' || host !== host.trim() || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(host) ||
    typeof apiKey !== 'string' || !apiKey || apiKey !== apiKey.trim() || /[\r\n]/.test(apiKey)) invalid();
  return { endpoint: host + '/functions/v1/employee-transfer-media', apiKey };
}
// Local RPC bridge until the integrator updates database.ts; never extend supabase.ts retries.
type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
const db = supabase as unknown as { rpc(name: string, args: Record<string, unknown>): Query };
const admin = () => uuid(getAdminFinancialSessionToken());
export interface ArchiveMediaSession {
  readonly direction: ArchiveMediaDirection;
  inventory(signal?: AbortSignal): Promise<ArchiveMediaInventory>;
  status(signal?: AbortSignal): Promise<ArchiveMediaInventory>;
  bind(files: readonly ArchiveMediaFile[], signal?: AbortSignal): Promise<void>;
  download(ref: ArchiveMediaReference, signal?: AbortSignal): Promise<{ file: ArchiveMediaFile; bytes: Uint8Array }>;
  upload(file: ArchiveMediaFile, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  recheckExport(files: readonly ArchiveMediaFile[], signal?: AbortSignal): Promise<void>;
  recheckImport(files: readonly ArchiveMediaFile[], signal?: AbortSignal): Promise<void>;
  verify(signal?: AbortSignal): Promise<ArchiveMediaInventory>;
}
export function createArchiveMediaSession(jobToken: string, direction: ArchiveMediaDirection, transport: typeof fetch = globalThis.fetch): ArchiveMediaSession {
  uuid(jobToken);if (direction !== 'export' && direction !== 'import') invalid();
  const { endpoint, apiKey } = config();let busy = false, requiresStatus = false, snapshot: string | null = null;
  let references: string | null = null, requested: ArchiveMediaFile[] | null = null;
  let confirmed: ArchiveMediaInventory | null = null;
  const observed = new Map<string, ArchiveMediaFile>();
  const params = () => ({ p_admin_session_token: admin(), p_job_token: jobToken });
  const run = async <T>(operation: (mark: () => void) => Promise<T>, status = false, signal?: AbortSignal): Promise<T> => {
    if (busy || (requiresStatus && !status)) throw new ArchiveMediaError(requiresStatus);
    busy = true;let dispatched = false;
    try { check(signal);const result = await operation(() => { dispatched = true; });check(signal);return result; }
    catch { if (dispatched) requiresStatus = true;throw new ArchiveMediaError(dispatched || requiresStatus); }
    finally { busy = false; }
  };
  const rpc = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    check(signal);const query = db.rpc(name, args), result = await (signal ? query.abortSignal(signal) : query);
    check(signal);if (result.error) invalid();return result.data;
  };
  const validate = (value: unknown) => {
    const checked = validateArchiveMediaInventory(value, direction), next = JSON.stringify(checked.archives_catalog);
    const refs = JSON.stringify(checked.files.map(ref => ({ ...ref, file: null })));
    if ((snapshot !== null && snapshot !== next) || (references !== null && references !== refs)) invalid();
    if (confirmed && ((confirmed.bound && !checked.bound) || (confirmed.verified && !checked.verified) ||
      confirmed.transferred.some(key => !checked.transferred.includes(key)) || confirmed.checked.some(key => !checked.checked.includes(key)))) invalid();
    for (const [index, ref] of checked.files.entries()) {
      const old = observed.get(ref.key);
      if (old && (!ref.file || !same(old, ref.file))) invalid();
      if (direction === 'import' && checked.bound && requested && (!ref.file || !same(requested[index], ref.file))) invalid();
    }
    // Commit local observations only after the ENTIRE receipt is accepted.
    snapshot = next;references = refs;
    confirmed = { ...checked, archives_catalog: validateArchivesCatalog(checked.archives_catalog),
      files: checked.files.map(ref => ({ ...ref, file: ref.file && { ...ref.file } })),
      transferred: [...checked.transferred], checked: [...checked.checked] };
    for (const ref of checked.files) if (ref.file) observed.set(ref.key, { ...ref.file });
    return checked;
  };
  const inventory = async (status: boolean, signal?: AbortSignal) => validate(await rpc(`employee_transfer_archive_media_${status ? 'status' : 'inventory'}`, { ...params(), p_direction: direction }, signal));
  const post = async (action: string, key: string, mark: () => void, signal?: AbortSignal, body?: Uint8Array) => {
    const headers = { apikey: apiKey, 'Content-Type': 'application/octet-stream', 'x-transfer-scope': 'archives',
      'x-transfer-action': action, 'x-admin-session-token': admin(), 'x-transfer-job-token': jobToken, 'x-transfer-object-key': key };
    check(signal);mark();const result = await transport(endpoint, { method: 'POST', headers, body: body as BodyInit | undefined,
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal });
    if (!result.ok || result.redirected) { void result.body?.cancel().catch(() => {});invalid(); }return result;
  };
  const command = async (action: string, file: ArchiveMediaFile, mark: () => void, signal?: AbortSignal, bytes?: Uint8Array) => {
    const response = await post(action, file.key, mark, signal, bytes);
    const r = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(response, 4096, signal))), ['success', 'key', 'bytes', 'sha256', 'content_type', 'full_site_complete']);
    if (r.success !== true || r.full_site_complete !== false || r.key !== file.key || r.bytes !== file.bytes || r.sha256 !== file.sha256 || r.content_type !== file.content_type) invalid();
  };
  const matches = (available: ArchiveMediaInventory, input: ArchiveMediaFile[]) => {
    if (available.files.length !== input.length || input.some((file, i) => file.key !== available.files[i].key || file.source_url !== available.files[i].source_url ||
      (available.files[i].file && !same(available.files[i].file!, file)))) invalid();
  };
  const recheck = (mode: ArchiveMediaDirection, input: readonly ArchiveMediaFile[], signal?: AbortSignal) => run(async mark => {
    if (direction !== mode) invalid();const checked = files(input);matches(await inventory(false, signal), checked);
    for (const file of checked) await command(mode === 'export' ? 'recheck-export' : 'recheck-import', file, mark, signal);
  }, false, signal);
  return Object.freeze({
    direction,
    inventory: (signal?: AbortSignal) => run(() => inventory(false, signal), false, signal),
    status: (signal?: AbortSignal) => run(async () => { const result = await inventory(true, signal);check(signal);requiresStatus = false;return result; }, true, signal),
    bind: (input: readonly ArchiveMediaFile[], signal?: AbortSignal) => run(async mark => {
      if (direction !== 'import') invalid();const checked = files(input);
      if (requested && (requested.length !== checked.length || requested.some((file, i) => !same(file, checked[i])))) invalid();
      matches(await inventory(false, signal), checked);
      const args = { ...params(), p_files: checked };requested = checked;mark();
      const r = object(await rpc('employee_transfer_archive_media_bind', args, signal), ['success', 'files', 'bytes', 'repeated', 'full_site_complete']);
      if (r.success !== true || r.files !== checked.length || r.bytes !== checked.reduce((n, f) => n + f.bytes, 0) || typeof r.repeated !== 'boolean' || r.full_site_complete !== false) invalid();
      validate({ ...confirmed!, bound: true, files: confirmed!.files.map((ref, i) => ({ ...ref, file: checked[i] })) });
    }, false, signal),
    download: (input: ArchiveMediaReference, signal?: AbortSignal) => run(async mark => {
      if (direction !== 'export') invalid();const ref = reference(input);
      const response = await post('download', ref.key, mark, signal);
      if (response.headers.get('content-type') !== 'application/octet-stream') { void response.body?.cancel().catch(() => {});invalid(); }
      const bytes = await read(response, ref.file?.bytes ?? ARCHIVE_MEDIA_LIMITS.maxFileBytes, signal);
      const file = validateArchiveMediaFile({ key: ref.key, source_url: ref.source_url, bytes: bytes.length,
        sha256: response.headers.get('x-transfer-sha256'), content_type: response.headers.get('x-transfer-content-type') });
      inspect(file, bytes);if (ref.file && !same(file, ref.file)) invalid();return { file, bytes };
    }, false, signal),
    upload: (input: ArchiveMediaFile, raw: Uint8Array, signal?: AbortSignal) => run(async mark => {
      if (direction !== 'import' || !(raw instanceof Uint8Array)) invalid();const file = validateArchiveMediaFile(input), bytes = new Uint8Array(raw);
      inspect(file, bytes);await command('upload', file, mark, signal, bytes);
    }, false, signal),
    recheckExport: (input: readonly ArchiveMediaFile[], signal?: AbortSignal) => recheck('export', input, signal),
    recheckImport: (input: readonly ArchiveMediaFile[], signal?: AbortSignal) => recheck('import', input, signal),
    verify: (signal?: AbortSignal) => run(async mark => {
      const args = { ...params(), p_direction: direction };mark();const result = validate(await rpc('employee_transfer_archive_media_verify', args, signal));
      if (!result.verified) invalid();return result;
    }, false, signal),
  });
}

// Viewing does not use an import job token. The service resolves this exact immutable binding.
export async function readArchiveMedia(binding: { source_site_id: string; package_id: string; event_id: string; ref_key: string },
  signal?: AbortSignal, transport: typeof fetch = globalThis.fetch): Promise<Blob> {
  try {
    const r = object(binding, ['source_site_id', 'package_id', 'event_id', 'ref_key']);
    uuid(r.source_site_id);uuid(r.package_id);uuid(r.event_id);
    if (typeof r.ref_key !== 'string' || !r.ref_key || enc.encode(r.ref_key).length > 4096) invalid();
    const { endpoint, apiKey } = config();check(signal);
    const response = await transport(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
      headers: { apikey: apiKey, 'Content-Type': 'application/json', 'x-transfer-scope': 'archives', 'x-transfer-action': 'read', 'x-admin-session-token': admin() }, body: JSON.stringify(r) });
    if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {});invalid(); }
    const bytes = await read(response, ARCHIVE_MEDIA_LIMITS.maxFileBytes, signal), type = detect(bytes);
    if (response.headers.get('content-type') !== type || response.headers.get('x-transfer-content-type') !== type || response.headers.get('x-transfer-sha256') !== sha(bytes)) invalid();
    check(signal);return new Blob([bytes as BlobPart], { type });
  } catch { throw new ArchiveMediaError(false); }
}
