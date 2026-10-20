import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import type { TemporaryTransferSink } from './container';
import type { TransferByteSource } from './crypto';
import { dispatchTransferChecks } from './dispatchTransfer';
import { claimEntryPath, validateManifest, type ManifestEntry, type VolumeManifest } from './manifest';
import { Sha256 } from './sha256';
import {
  exportChatData, stageChatImport, validateChatCatalog, validateChatPlan,
  validateChatRow, validateChatVerification, chatEntryPath, CHAT_TABLE_KEYS, CHAT_TRANSFER_LIMITS,
  type ChatCatalog, type ChatExportSource, type ChatImportFiles, type ChatImportTarget,
  type ChatPlan, type ChatTableKey, type ChatTableCatalog,
} from './chatTransfer';

// Single substage only; no direct source-URL fetches, automatic retries, deletion or task completion.
export const CHAT_MEDIA_LIMITS = Object.freeze({ maxFiles: 3000, maxFileBytes: 50 * 1024 * 1024, maxAvatarBytes: 5 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024 });
export type ChatMediaDirection = 'export' | 'import';
export type ChatMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf' | 'video/mp4' | 'video/webm';
export type ChatMediaBucket = 'announcement-images' | 'chat-images' | 'template-images' | 'super-customer-avatars';
export interface ChatMediaFile {
  key: string; source_url: string; bytes: number; sha256: string; content_type: ChatMediaType;
}
export interface ChatMediaReference {
  key: string; source_url: string; bucket: ChatMediaBucket; path: string; avatar: boolean; file: ChatMediaFile | null;
}
export interface ChatMediaCatalog {
  version: 1; scope: 'site-chat-media'; chat_catalog: ChatCatalog;
  files: ChatMediaFile[]; full_site_complete: false;
}
export interface ChatMediaInventory {
  version: 1; scope: 'site-chat-media'; direction: ChatMediaDirection; chat_catalog: ChatCatalog;
  files: ChatMediaReference[]; full_site_complete: false;
}
export interface ChatMediaSession {
  readonly direction: ChatMediaDirection;
  inventory(signal?: AbortSignal): Promise<ChatMediaInventory>;
  bind(files: readonly ChatMediaFile[], signal?: AbortSignal): Promise<void>;
  // Count progress only after the temporary sink confirms the write.
  download(reference: ChatMediaReference, signal?: AbortSignal): Promise<{ file: ChatMediaFile; bytes: Uint8Array }>;
  upload(file: ChatMediaFile, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  recheckExport(files: readonly ChatMediaFile[], signal?: AbortSignal): Promise<void>;
  // Call after the complete chat restore and before SQL verify; generation is server-owned.
  recheckImport(files: readonly ChatMediaFile[], signal?: AbortSignal): Promise<void>;
}
export interface ChatMediaProgress {
  scope: 'site-chat-media'; phase: 'export' | 'validate' | 'stage' | 'upload' | 'recheck';
  files: number; bytes: number; rows: number; fullSiteComplete: false;
}
export interface ChatMediaOptions {
  signal?: AbortSignal; onProgress?: (progress: ChatMediaProgress) => void;
}
export interface ChatBundle {
  catalog: ChatCatalog; media: ChatMediaCatalog; entries: ManifestEntry[];
  rows: number; bytes: number; fullSiteComplete: false;
}
// Expose only isolated immutable files after complete container EOF authentication.
export interface ChatBundleFiles extends ChatImportFiles {
  // Include every payload path, but not manifest.json.
  paths(): readonly string[];
}
export interface ChatBundleInput {
  catalog: unknown; media: unknown; manifest: unknown;
}
const { object, count } = dispatchTransferChecks;
const limits = CHAT_MEDIA_LIMITS;
const encoder = new TextEncoder();
const PREFIX = '/storage/v1/object/public/';
const URL_PATTERN = /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/(announcement-images|chat-images|template-images|super-customer-avatars)\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z0-9]{1,8})$/;
const TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm'];
const failure = 'Chat media operation is unconfirmed; reconcile server staging and uploads before retrying. No automatic retry, rollback, deletion or close was performed.';
export class ChatMediaError extends Error {
  constructor(readonly serverStagingOrUploadsMayExist: boolean, readonly cancelled: boolean, readonly cleanupRequired = false) {
    super(cleanupRequired ? 'Chat plaintext cleanup was not confirmed. Do not reuse the workspace. ' + failure : failure);
    this.name = 'ChatMediaError';
  }
}
function invalid(): never { throw new ChatMediaError(false, false); }
function check(signal?: AbortSignal): void { if (signal?.aborted) throw new ChatMediaError(false, true); }
// Serial awaits prevent writes from outliving abort cleanup.
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
function source(value: unknown): { url: string; bucket: ChatMediaBucket; path: string; origin: string } {
  if (typeof value !== 'string' || value.length > 1024) invalid();
  const match = URL_PATTERN.exec(value);
  if (!match || match[0] !== value || match[2].includes('..') || match[2].split('/').includes('.') ||
    (match[1] === 'super-customer-avatars' && !match[2].startsWith('avatars/'))) invalid();
  return { url: value, bucket: match[1] as ChatMediaBucket, path: match[2], origin: origin(value.slice(0, value.indexOf(PREFIX))) };
}
export function chatMediaEntryPath(file: Pick<ChatMediaFile, 'source_url'>): string {
  const ref = source(file.source_url);
  return `media/${ref.bucket}/${ref.path}`;
}
function singleOrigin(files: readonly { source_url: string }[]): void {
  const host = files.length ? source(files[0].source_url).origin : null;
  if (files.some(file => source(file.source_url).origin !== host)) invalid();
}
function tuple(value: unknown): ChatMediaFile {
  const record = object(value, ['key', 'source_url', 'bytes', 'sha256', 'content_type']);
  const ref = source(record.source_url), key = hash(record.key), bytes = count(record.bytes, limits.maxFileBytes);
  if (!bytes || key !== sha(encoder.encode(ref.url)) || typeof record.content_type !== 'string' || !TYPES.includes(record.content_type)) invalid();
  if (ref.bucket === 'super-customer-avatars' && (bytes > limits.maxAvatarBytes || !record.content_type.startsWith('image/'))) invalid();
  return { key, source_url: ref.url, bytes, sha256: hash(record.sha256), content_type: record.content_type as ChatMediaType };
}
function tuples(value: unknown): ChatMediaFile[] {
  const files = array(value, limits.maxFiles).map(tuple);
  ordered(files); singleOrigin(files);
  if (files.reduce((n, f) => n + f.bytes, 0) > limits.maxTotalBytes) invalid();
  return files;
}
function ordered(files: readonly { key: string }[]): void {
  for (let i = 1; i < files.length; i++) if (files[i - 1].key >= files[i].key) invalid();
}
function same(a: ChatMediaFile, b: ChatMediaFile): boolean {
  return a.key === b.key && a.source_url === b.source_url && a.bytes === b.bytes && a.sha256 === b.sha256 && a.content_type === b.content_type;
}
function reference(value: unknown): ChatMediaReference {
  const record = object(value, ['key', 'source_url', 'bucket', 'path', 'avatar', 'file']);
  const ref = source(record.source_url), key = hash(record.key);
  // Inventory paths are source paths; target paths remain server-owned.
  if (key !== sha(encoder.encode(ref.url)) || record.bucket !== ref.bucket || record.path !== ref.path) invalid();
  if (typeof record.avatar !== 'boolean' || (ref.bucket === 'super-customer-avatars' && !record.avatar)) invalid();
  const file = record.file === null ? null : tuple(record.file);
  if (file && (file.key !== key || file.source_url !== ref.url ||
    (record.avatar && (file.bytes > limits.maxAvatarBytes || !file.content_type.startsWith('image/'))))) invalid();
  return { key, source_url: ref.url, bucket: ref.bucket, path: ref.path, avatar: record.avatar, file };
}
function total(catalog: ChatCatalog, bytes: number): void {
  if (catalog.tables.reduce((n, table) => n + table.bytes, bytes) > limits.maxTotalBytes) invalid();
}
export function validateChatMediaCatalog(value: unknown): ChatMediaCatalog {
  const record = object(value, ['version', 'scope', 'chat_catalog', 'files', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'site-chat-media' || record.full_site_complete !== false) invalid();
  const catalog = validateChatCatalog(record.chat_catalog), files = tuples(record.files);
  total(catalog, files.reduce((n, file) => n + file.bytes, 0));
  return { version: 1, scope: 'site-chat-media', chat_catalog: catalog, files, full_site_complete: false };
}
function inventory(value: unknown, direction: ChatMediaDirection): ChatMediaInventory {
  const record = object(value, ['version', 'scope', 'direction', 'chat_catalog', 'files', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'site-chat-media' || record.direction !== direction || record.full_site_complete !== false) invalid();
  const catalog = validateChatCatalog(record.chat_catalog), files = array(record.files, limits.maxFiles).map(reference);
  ordered(files); singleOrigin(files);
  total(catalog, files.reduce((n, f) => n + (f.file?.bytes ?? 0), 0));
  return { version: 1, scope: 'site-chat-media', direction, chat_catalog: catalog, files, full_site_complete: false };
}
function matches(refs: readonly ChatMediaReference[], files: readonly ChatMediaFile[]): void {
  if (refs.length !== files.length) invalid();
  for (let i = 0; i < refs.length; i++) {
    if (refs[i].key !== files[i].key || refs[i].source_url !== files[i].source_url || (refs[i].file && !same(refs[i].file!, files[i])) ||
      (refs[i].avatar && (files[i].bytes > limits.maxAvatarBytes || !files[i].content_type.startsWith('image/')))) invalid();
  }
}
// Keep video signatures identical to employee-transfer-media/handler.ts.
function ebmlNumber(bytes: Uint8Array, offset: number, end: number, id = false): { value: number; length: number } | null {
  if (offset >= end) return null;
  let mask = 0x80, length = 1;
  while (mask && !(bytes[offset] & mask)) { mask >>= 1; length++; }
  if (!mask || length > (id ? 4 : 8) || offset + length > end) return null;
  let value = id ? bytes[offset] : bytes[offset] & (mask - 1);
  let unknown = !id && value === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[offset + i];
    unknown = unknown && bytes[offset + i] === 0xff;
  }
  return unknown || !Number.isSafeInteger(value) ? null : { value, length };
}
function isWebm(bytes: Uint8Array): boolean {
  const header = ebmlNumber(bytes, 4, bytes.length);
  if (!header || !header.value || header.value > 4096) return false;
  let offset = 4 + header.length;
  const end = offset + header.value;
  if (end > bytes.length) return false;
  let webm = false;
  while (offset < end) {
    const id = ebmlNumber(bytes, offset, end, true);
    if (!id) return false;
    offset += id.length;
    const size = ebmlNumber(bytes, offset, end);
    if (!size) return false;
    offset += size.length;
    if (size.value > end - offset) return false;
    if (id.value === 0x4282) {
      if (webm || size.value !== 4 || bytes[offset] !== 0x77 || bytes[offset + 1] !== 0x65 ||
        bytes[offset + 2] !== 0x62 || bytes[offset + 3] !== 0x6d) return false;
      webm = true;
    }
    offset += size.value;
  }
  return webm;
}
function isMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (size < 16 || size > bytes.length || (size - 16) % 4 !== 0) return false;
  const brands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ']);
  for (let offset = 8; offset < size; offset += offset === 8 ? 8 : 4) {
    if (brands.has(String.fromCharCode(...bytes.subarray(offset, offset + 4)))) return true;
  }
  return false;
}
function detect(bytes: Uint8Array): ChatMediaType {
  const starts = (signature: number[], offset = 0) => signature.every((b, i) => bytes[offset + i] === b);
  if (bytes.length >= 3 && starts([255, 216, 255])) return 'image/jpeg';
  if (bytes.length >= 8 && starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (bytes.length >= 6 && (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))) return 'image/gif';
  if (bytes.length >= 12 && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)) return 'image/webp';
  if (bytes.length >= 5 && starts([37, 80, 68, 70, 45])) return 'application/pdf';
  // Signatures only, not media decoding or a security scan.
  if (starts([102, 116, 121, 112], 4) && isMp4(bytes)) return 'video/mp4';
  if (starts([26, 69, 223, 163]) && isWebm(bytes)) return 'video/webm';
  return invalid();
}
function inspect(file: ChatMediaFile, bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== file.bytes || sha(bytes) !== file.sha256 || detect(bytes) !== file.content_type) invalid();
}
function receipt(value: unknown, file: ChatMediaFile): void {
  const record = object(value, ['success', 'key', 'bytes', 'sha256', 'content_type', 'full_site_complete']);
  if (record.success !== true || record.full_site_complete !== false || record.key !== file.key || record.bytes !== file.bytes
    || record.sha256 !== file.sha256 || record.content_type !== file.content_type) invalid();
}

// Endpoint and key must come from the current environment, not caller input.
export function createChatMediaSession(
  jobToken: string, direction: ChatMediaDirection, transport: typeof fetch = globalThis.fetch,
): ChatMediaSession {
  let endpoint: string, apiKey: string;
  try {
    uuid(getAdminFinancialSessionToken()); uuid(jobToken);
    if (direction !== 'export' && direction !== 'import') invalid();
    const configured = import.meta.env.VITE_SUPABASE_URL;
    const host = origin(typeof configured === 'string' && configured.endsWith('/') ? configured.slice(0, -1) : configured);
    endpoint = host + '/functions/v1/employee-transfer-media';
    apiKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (typeof apiKey !== 'string' || !apiKey || apiKey !== apiKey.trim() || /[\r\n]/.test(apiKey)) invalid();
  } catch { throw new ChatMediaError(false, false); }
  let busy = false;
  // Every Edge action can commit a receipt, including downloads.
  const run = async <T>(operation: (mark: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    let mayExist = false;
    try {
      check(signal);
      if (busy) invalid();
      busy = true;
      try { return await operation(() => { mayExist = true; }); } finally { busy = false; }
    } catch { throw new ChatMediaError(mayExist, signal?.aborted === true); }
  };
  const params = () => ({ p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: jobToken });
  let catalogSnapshot: string | null = null;
  const readInventory = async (signal?: AbortSignal) => {
    const result = await settled(() => {
      const query = supabase.rpc('get_employee_transfer_chat_media', { ...params(), p_direction: direction });
      return signal ? query.abortSignal(signal) : query;
    }, signal);
    if (result.error) invalid();
    const checked = inventory(result.data, direction), snapshot = JSON.stringify(checked.chat_catalog);
    if (catalogSnapshot !== null && snapshot !== catalogSnapshot) invalid();
    catalogSnapshot = snapshot;
    return checked;
  };
  const post = async (action: string, key: string, mark: () => void, signal?: AbortSignal, body?: Uint8Array): Promise<Response> => {
    check(signal); mark();
    const res = await transport(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
      headers: { apikey: apiKey, 'Content-Type': 'application/octet-stream', 'x-transfer-action': action, 'x-transfer-scope': 'chat',
        'x-admin-session-token': params().p_admin_session_token, 'x-transfer-job-token': jobToken, 'x-transfer-object-key': key }, body });
    if (signal?.aborted || !res.ok || res.redirected) {
      try { await res.body?.cancel(); } catch { /* Never expose transport errors. */ }
      invalid();
    }
    return res;
  };
  const command = async (action: string, file: ChatMediaFile, mark: () => void, signal?: AbortSignal, bytes?: Uint8Array) => {
    const res = await post(action, file.key, mark, signal, bytes);
    // Bound receipts before JSON parsing.
    const raw = await readBytes(res.body, 4096, signal);
    receipt(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)), file);
  };
  const recheck = (mode: ChatMediaDirection, input: readonly ChatMediaFile[], signal?: AbortSignal) => run(async mark => {
    if (direction !== mode) invalid();
    const files = tuples(input), refs = await readInventory(signal);
    matches(refs.files, files);
    for (const file of files) await command(mode === 'export' ? 'recheck-export' : 'recheck-import', file, mark, signal);
  }, signal);
  return Object.freeze({
    direction,
    inventory: (signal?: AbortSignal) => run(() => readInventory(signal), signal),
    bind: (input: readonly ChatMediaFile[], signal?: AbortSignal) => run(async mark => {
      if (direction !== 'import') invalid();
      const files = tuples(input);
      matches((await readInventory(signal)).files, files);
      const result = await settled(() => {
        mark();
        const query = supabase.rpc('employee_import_chat_media_bind', { ...params(), p_files: files });
        return signal ? query.abortSignal(signal) : query;
      }, signal);
      if (result.error) invalid();
      const r = object(result.data, ['success', 'version', 'scope', 'files', 'bytes', 'repeated', 'full_site_complete']);
      if (r.success !== true || r.version !== 1 || r.scope !== 'site-chat-media' || r.files !== files.length
        || r.bytes !== files.reduce((n, f) => n + f.bytes, 0) || typeof r.repeated !== 'boolean' || r.full_site_complete !== false) invalid();
    }, signal),
    download: (input: ChatMediaReference, signal?: AbortSignal) => run(async mark => {
      if (direction !== 'export') invalid();
      const ref = reference(input);
      if (source(ref.source_url).origin !== endpoint.slice(0, -'/functions/v1/employee-transfer-media'.length)) invalid();
      const res = await post('download', ref.key, mark, signal);
      const digest = res.headers.get('x-transfer-sha256'), contentType = res.headers.get('x-transfer-content-type');
      if (res.headers.get('content-type') !== 'application/octet-stream') {
        try { await res.body?.cancel(); } catch { /* Redacted. */ }
        invalid();
      }
      const bytes = await readBytes(res.body, ref.file?.bytes ?? (ref.avatar ? limits.maxAvatarBytes : limits.maxFileBytes), signal);
      const file = tuple({ key: ref.key, source_url: ref.source_url, bytes: bytes.length, sha256: digest, content_type: contentType });
      inspect(file, bytes);
      if (ref.file && !same(ref.file, file)) invalid();
      return { file, bytes };
    }, signal),
    upload: (input: ChatMediaFile, inputBytes: Uint8Array, signal?: AbortSignal) => run(async mark => {
      if (direction !== 'import') invalid();
      const file = tuple(input);
      if (!(inputBytes instanceof Uint8Array) || inputBytes.length !== file.bytes) invalid();
      const bytes = new Uint8Array(inputBytes); // Isolate mutable producer buffers across awaits.
      inspect(file, bytes);
      await command('upload', file, mark, signal, bytes);
    }, signal),
    recheckExport: (files: readonly ChatMediaFile[], signal?: AbortSignal) => recheck('export', files, signal),
    recheckImport: (files: readonly ChatMediaFile[], signal?: AbortSignal) => recheck('import', files, signal),
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
function progress(options: ChatMediaOptions, phase: ChatMediaProgress['phase'], files: number, bytes: number, rows = 0): void {
  check(options.signal);
  options.onProgress?.({ scope: 'site-chat-media', phase, files, bytes, rows, fullSiteComplete: false });
  check(options.signal);
}
async function discard(files: Pick<ChatImportFiles, 'abort'>, mayExist: boolean, signal?: AbortSignal): Promise<void> {
  try { await files.abort(new Error('Chat temporary plaintext discarded.')); }
  catch { throw new ChatMediaError(mayExist, signal?.aborted === true, true); }
}
// Mirror SQL26's conservative tokenizer; DOM recovery would silently omit malformed media.
function mediaUrls(content: string, direct: boolean): string[] {
  if (direct) return [content];
  if (/(https?|storage|supabase)[^\s<>"'`]*[&%\\\\]/i.test(content)) invalid();
  if (/(^|[^A-Za-z0-9_-])url[ \t\n\r\f\v]*\(/i.test(content)) invalid();
  const urls: string[] = [];
  let rest = content;
  while (true) {
    const open = rest.indexOf('<');
    if (open === -1) break;
    rest = rest.slice(open + 1);
    if (rest[0] === '!' || rest[0] === '?') invalid();
    const name = /^\/?[A-Za-z][A-Za-z0-9:_-]*/.exec(rest)?.[0];
    if (!name) continue;
    if (['style', 'script'].includes(name.replace(/^\//, '').toLowerCase())) invalid();
    rest = rest.slice(name.length);
    while (true) {
      rest = rest.replace(/^[ \t\n\r\f]+/, '');
      if (rest.startsWith('>')) { rest = rest.slice(1); break; }
      if (rest.startsWith('/>')) { rest = rest.slice(2); break; }
      const attr = /^[^ \t\n\r\f\v<>"'=/`]+/.exec(rest)?.[0];
      if (!attr) invalid();
      rest = rest.slice(attr.length).replace(/^[ \t\n\r\f]+/, '');
      let value: string | null = null, quoted = false;
      if (rest.startsWith('=')) {
        rest = rest.slice(1).replace(/^[ \t\n\r\f]+/, '');
        const quote = rest[0];
        if (quote === '"' || quote === "'") {
          quoted = true;
          const end = rest.indexOf(quote, 1);
          if (end === -1) invalid();
          value = rest.slice(1, end); rest = rest.slice(end + 1);
        } else {
          value = /^[^ \t\n\r\f\v<>"'=`]+/.exec(rest)?.[0] ?? null;
          if (value === null) invalid();
          rest = rest.slice(value.length);
        }
      }
      const field = attr.toLowerCase();
      if (field === 'srcset') invalid();
      if (field === 'style' && value !== null && (/[&\\]/.test(value) || value.includes('/*'))) invalid();
      if (field === 'src' || field === 'poster') {
        if (!quoted || value === null) invalid();
        urls.push(value);
      } else if (field === 'href' && value !== null) {
        if (value.includes('&')) invalid();
        if (/^[ \t\n\r\f\v]*(data|blob):/i.test(value)) invalid();
        if (/\/storage\/v1\/object\//i.test(value)) {
          if (!quoted) invalid();
          urls.push(value);
        }
      }
    }
  }
  for (const match of content.matchAll(/[^ \t\n\r\f\v<>"'`]*\/storage\/v1\/object\/[^ \t\n\r\f\v<>"'`]*/gi)) urls.push(match[0]);
  return urls;
}
const MEDIA_FIELDS: Partial<Record<ChatTableKey, readonly string[]>> = {
  simulated_customers: ['custom_avatar_url', 'customer_avatar'],
  customer_employee_conversations: ['message_content', 'image_url'],
  cs_message_templates: ['content'], customer_auto_messages: ['content'], rich_card_contents: ['html_content'],
};
// SQL31 uses the same deliberately conservative rating-JSON rejection policy.
function ratingMediaGuard(value: unknown): void {
  if (typeof value === 'string') {
    if (/[:/\\\\%&<>]/.test(value) || /(https?|data|blob|storage|supabase|base64)/i.test(value) ||
      /\.(jpe?g|png|gif|webp|pdf|mp4|webm|svg|avif|heic|zip)($|[?#\s])/i.test(value)) invalid();
  } else if (Array.isArray(value)) {
    value.forEach(ratingMediaGuard);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      // Known React text field, never a media-loading container. Non-string comments recurse.
      if (key === 'comment' && typeof entry === 'string') continue;
      if (/(url|uri|src|href|poster|image|avatar|file|attachment|media|path|bucket|storage|base64)/i.test(key)) invalid();
      ratingMediaGuard(entry);
    }
  }
}
function refsFromRow(text: string, table: ChatTableKey, refs: Map<string, ChatMediaReference>): void {
  const fields = MEDIA_FIELDS[table];
  if (!fields) return;
  const row = JSON.parse(text) as Record<string, unknown>;
  if (table === 'customer_employee_conversations') ratingMediaGuard(row.rating_data);
  for (const field of fields) {
    const content = row[field];
    if (content === null) continue;
    if (typeof content !== 'string') invalid();
    if (field === 'customer_avatar' && /^customer-avatar:(regular|vip):[0-9]+$/.exec(content)?.[0] === content) continue;
    for (const url of mediaUrls(content, ['image_url', 'custom_avatar_url', 'customer_avatar'].includes(field))) {
      const ref = source(url), key = sha(encoder.encode(ref.url));
      const first = refs.values().next().value as ChatMediaReference | undefined;
      if (first && source(first.source_url).origin !== ref.origin) invalid();
      const existing = refs.get(key);
      if (existing && existing.source_url !== ref.url) invalid();
      refs.set(key, { key, source_url: ref.url, bucket: ref.bucket, path: ref.path,
        avatar: existing?.avatar === true || table === 'simulated_customers' || ref.bucket === 'super-customer-avatars', file: null });
      if (refs.size > limits.maxFiles) invalid();
    }
  }
}
function sortedRefs(refs: Map<string, ChatMediaReference>): ChatMediaReference[] {
  return [...refs.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
// On success the caller owns the sink until encrypted save/readback, then MUST abort it.
export async function exportChatBundle(
  sourceApi: ChatExportSource, sink: TemporaryTransferSink, media: ChatMediaSession, options: ChatMediaOptions = {},
): Promise<ChatBundle> {
  let mayExist = false;
  try {
    check(options.signal);
    if (media.direction !== 'export') invalid();
    const refs = new Map<string, ChatMediaReference>();
    // Validate URLs in the original bytes; never reserialize records.
    const data = await exportChatData({
      // Record API adapters race AbortSignal; let each request settle before outer cleanup.
      catalog: () => settled(() => sourceApi.catalog(), options.signal),
      page: (key, after) => settled(() => sourceApi.page(key, after), options.signal),
      verify: () => settled(() => sourceApi.verify(), options.signal),
    }, {
      async append(path, raw) {
        check(options.signal);
        const table = CHAT_TABLE_KEYS.find(key => chatEntryPath(key) === path);
        if (!table) invalid();
        for (const line of new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).split('\n').slice(0, -1)) refsFromRow(line, table, refs);
        await settled(() => sink.append(path, raw, options.signal), options.signal);
      },
      async abort() { /* Defer cleanup to the outer owner. */ },
    }); // Avoid the inner exporter's abort race around sink writes.
    const available = inventory(await settled(() => media.inventory(options.signal), options.signal), 'export');
    if (JSON.stringify(available.chat_catalog) !== JSON.stringify(data.catalog)) invalid();
    const expected = sortedRefs(refs);
    if (available.files.length !== expected.length || available.files.some((ref, i) => ref.key !== expected[i].key || ref.source_url !== expected[i].source_url || ref.avatar !== expected[i].avatar)) invalid();
    const paths = new Set<string>();
    for (const entry of data.entries) claimEntryPath(entry.path, paths);
    for (const ref of available.files) claimEntryPath(chatMediaEntryPath(ref), paths);
    const files: ChatMediaFile[] = [], entries: ManifestEntry[] = [...data.entries];
    let bytes = data.bytes;
    for (const ref of available.files) {
      mayExist = true;
      const downloaded = await settled(() => media.download(ref, options.signal), options.signal);
      const file = tuple(downloaded.file);
      matches([ref], [file]); inspect(file, downloaded.bytes);
      bytes += file.bytes;
      if (bytes > limits.maxTotalBytes) invalid();
      const path = chatMediaEntryPath(file);
      await settled(() => sink.append(path, downloaded.bytes, options.signal), options.signal);
      files.push(file);
      entries.push({ path, kind: 'media', bytes: file.bytes, sha256: file.sha256 });
      progress(options, 'export', files.length, bytes, data.rows);
    }
    mayExist = true;
    await settled(() => media.recheckExport(files, options.signal), options.signal);
    // The old verify attests records only and still explicitly says media_pending.
    validateChatVerification(await settled(() => sourceApi.verify(), options.signal));
    return { catalog: data.catalog,
      media: validateChatMediaCatalog({ version: 1, scope: 'site-chat-media', chat_catalog: data.catalog, files, full_site_complete: false }),
      entries, rows: data.rows, bytes, fullSiteComplete: false };
  } catch {
    await discard(sink, mayExist, options.signal);
    throw new ChatMediaError(mayExist, options.signal?.aborted === true);
  }
}

function bundle(input: ChatBundleInput, files: ChatBundleFiles): { catalog: ChatCatalog; media: ChatMediaFile[]; manifest: VolumeManifest } {
  const descriptor = object(input, ['catalog', 'media', 'manifest']);
  const catalog = validateChatCatalog(descriptor.catalog), mediaCatalog = validateChatMediaCatalog(descriptor.media);
  if (JSON.stringify(catalog) !== JSON.stringify(mediaCatalog.chat_catalog)) invalid();
  const media = mediaCatalog.files;
  // Snapshot untrusted descriptors before validation.
  const raw = object(descriptor.manifest, ['version', 'scope', 'exportId', 'volumeId', 'sourceSiteId', 'createdAt', 'volumeIndex', 'volumeCount', 'entries']);
  const entries = array(raw.entries, limits.maxFiles + CHAT_TABLE_KEYS.length).map(e => object(e, ['path', 'kind', 'bytes', 'sha256']));
  const manifest = validateManifest({ ...raw, entries });
  if (manifest.scope !== 'replacement-backup' || manifest.exportId !== catalog.package_id || manifest.sourceSiteId !== catalog.site_id
    || manifest.volumeIndex !== 1 || manifest.volumeCount !== 1 || entries.length !== media.length + CHAT_TABLE_KEYS.length) invalid();
  const expected = new Map<string, { kind: string; bytes: number; sha256?: string }>();
  for (const table of catalog.tables) expected.set(chatEntryPath(table.key), { kind: 'ndjson', bytes: table.bytes });
  for (const file of media) {
    const path = chatMediaEntryPath(file);
    if (expected.has(path)) invalid();
    expected.set(path, { kind: 'media', bytes: file.bytes, sha256: file.sha256 });
  }
  for (const entry of manifest.entries) {
    const e = expected.get(entry.path);
    hash(entry.sha256);
    if (!e || e.kind !== entry.kind || e.bytes !== entry.bytes || (e.sha256 !== undefined && e.sha256 !== entry.sha256)) invalid();
  }
  if (manifest.entries.reduce((n, e) => n + e.bytes, 0) > limits.maxTotalBytes) invalid();
  const paths = array(files.paths(), limits.maxFiles + CHAT_TABLE_KEYS.length);
  if (paths.length !== expected.size || new Set(paths).size !== paths.length || paths.some(p => typeof p !== 'string' || !expected.has(p))) invalid();
  return { catalog, media, manifest };
}
async function scanRecords(
  files: ChatBundleFiles, table: ChatTableCatalog, entry: ManifestEntry,
  refs: Map<string, ChatMediaReference>, signal?: AbortSignal,
): Promise<void> {
  const digest = new Sha256(), rowHashes = new Sha256();
  const line = new Uint8Array(CHAT_TRANSFER_LIMITS.maxLineBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let used = 0, bytes = 0, rows = 0, last: string | null = null;
  await consume(files.open(entry.path), async chunk => {
    if (chunk.length > CHAT_TRANSFER_LIMITS.maxInputBytes) invalid();
    bytes += chunk.length;
    if (bytes > table.bytes) invalid();
    const copy = new Uint8Array(chunk); digest.update(copy);
    for (const byte of copy) {
      if (used === line.length) invalid();
      line[used++] = byte;
      if (byte !== 10) continue;
      const raw = line.subarray(0, used), text = decoder.decode(raw), id = validateChatRow(text, table.key);
      if (last !== null && id <= last) invalid();
      last = id; rows++;
      if (rows > table.rows) invalid();
      refsFromRow(text, table.key, refs);
      rowHashes.update(encoder.encode(sha(raw))); used = 0;
    }
  }, signal);
  if (used || bytes !== table.bytes || rows !== table.rows || rowHashes.digestHex() !== table.row_hashes_sha256 || digest.digestHex() !== entry.sha256) invalid();
}
async function* checkedRecordFile(files: ChatBundleFiles, entry: ManifestEntry, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const digest = new Sha256();
  let bytes = 0;
  for await (const raw of checkedChunks(files.open(entry.path), signal)) {
    if (raw.length > CHAT_TRANSFER_LIMITS.maxInputBytes || raw.length > entry.bytes - bytes) invalid();
    const copy = new Uint8Array(raw);
    digest.update(copy); bytes += copy.length;
    yield copy;
  }
  if (bytes !== entry.bytes || digest.digestHex() !== entry.sha256) invalid();
}
async function scanMedia(files: ChatImportFiles, file: ChatMediaFile, signal?: AbortSignal, collect = false): Promise<Uint8Array> {
  const digest = new Sha256(), output = new Uint8Array(collect ? file.bytes : 0);
  // Complete video headers can exceed 12 bytes. Reuse the upload buffer, bounded to 50 MiB.
  const head = collect ? output : new Uint8Array(file.content_type.startsWith('video/') ? file.bytes : 12);
  let used = 0;
  await consume(files.open(chatMediaEntryPath(file)), async chunk => {
    if (chunk.length > CHAT_TRANSFER_LIMITS.maxInputBytes || chunk.length > file.bytes - used) invalid();
    const copy = new Uint8Array(chunk);
    if (used < head.length) head.set(copy.subarray(0, head.length - used), used);
    digest.update(copy); used += copy.length;
  }, signal);
  if (used !== file.bytes || digest.digestHex() !== file.sha256 || detect(head.subarray(0, Math.min(used, head.length))) !== file.content_type) invalid();
  return output;
}
export async function stageChatBundle(
  input: ChatBundleInput, files: ChatBundleFiles, target: ChatImportTarget,
  media: ChatMediaSession, options: ChatMediaOptions = {},
): Promise<{ plan: ChatPlan; files: number; bytes: number; rows: number; fullSiteComplete: false; serverStagingOrUploadsMayExist: true }> {
  let mayExist = false;
  let result: { plan: ChatPlan; files: number; bytes: number; rows: number; fullSiteComplete: false; serverStagingOrUploadsMayExist: true } | undefined;
  try {
    check(options.signal);
    if (media.direction !== 'import') invalid();
    const checked = bundle(input, files);
    // Validate all plaintext before any server write.
    const records = new Map(checked.manifest.entries.filter(e => e.kind === 'ndjson').map(e => [e.path, e]));
    const refs = new Map<string, ChatMediaReference>();
    for (const table of checked.catalog.tables) await scanRecords(files, table, records.get(chatEntryPath(table.key))!, refs, options.signal);
    matches(sortedRefs(refs), checked.media);
    for (const file of checked.media) await scanMedia(files, file, options.signal);
    const recordRows = checked.catalog.tables.reduce((n, table) => n + table.rows, 0);
    progress(options, 'validate', checked.media.length, checked.manifest.entries.reduce((n, e) => n + e.bytes, 0), recordRows);
    // Defer inner cleanup so media remains available for its second read.
    const staged = await stageChatImport(checked.catalog, {
      open: path => {
        const entry = records.get(path);
        if (!entry) invalid();
        return checkedRecordFile(files, entry, options.signal);
      },
      async abort() { /* Outer finally owns all plaintext. */ },
    }, {
      // Do not pass the signal to adapters that reject before their RPC actually settles.
      bind: catalog => settled(() => { mayExist = true; return target.bind(catalog); }, options.signal),
      stage: (key, no, raw) => settled(() => target.stage(key, no, raw), options.signal),
      plan: () => settled(() => target.plan(), options.signal),
    }, { onProgress: p => {
      if (p.phase === 'stage') progress(options, 'stage', 0, p.bytes, p.rows);
    } }); // Inner abort races must not release outstanding writes.
    const stagedPlan = validateChatPlan(staged.plan);
    // Records preflight is never restore approval; unrelated conflicts block uploads.
    if (stagedPlan.conflicts.length) invalid();
    check(options.signal);
    const available = inventory(await settled(() => media.inventory(options.signal), options.signal), 'import');
    if (JSON.stringify(available.chat_catalog) !== JSON.stringify(checked.catalog)) invalid();
    matches(available.files, checked.media);
    const expectedRefs = sortedRefs(refs);
    if (available.files.some((ref, i) => ref.avatar !== expectedRefs[i].avatar)) invalid();
    mayExist = true;
    await settled(() => media.bind(checked.media, options.signal), options.signal);
    let uploaded = 0, bytes = checked.catalog.tables.reduce((n, table) => n + table.bytes, 0);
    for (const file of checked.media) {
      const raw = await scanMedia(files, file, options.signal, true); // Detect drift before uploading.
      await settled(() => media.upload(file, raw, options.signal), options.signal);
      uploaded++; bytes += file.bytes;
      progress(options, 'upload', uploaded, bytes, staged.rows);
    }
    // Never patch server approval locally.
    const plan = validateChatPlan(await settled(() => target.plan(), options.signal));
    if (checked.catalog.tables.some(table => plan.counts[table.key] !== table.rows) || plan.employees !== checked.catalog.identity_catalog.tables[0].rows) invalid();
    result = { plan, files: uploaded, bytes, rows: staged.rows, fullSiteComplete: false, serverStagingOrUploadsMayExist: true };
  } catch { /* Report only after plaintext cleanup. */ }
  await discard(files, mayExist, options.signal);
  if (!result || options.signal?.aborted) throw new ChatMediaError(mayExist, options.signal?.aborted === true);
  return result;
}
