import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import type { VerificationMediaFile, VerificationMediaReference } from './verificationMedia';

// SQL53 only: no source fetches, export, deletion, automatic retries or task completion.
export const EMPLOYEE_MAPPED_VERIFICATION_MEDIA_LIMITS = Object.freeze({
  maxFiles: 3000, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024,
});
export type EmployeeMappedVerificationMediaFile = Readonly<VerificationMediaFile>;
export interface EmployeeMappedVerificationMediaInventory {
  readonly scope: 'employee-mapped-verification-media'; readonly direction: 'import';
  readonly files: readonly Readonly<Omit<VerificationMediaReference, 'file'> & { file: EmployeeMappedVerificationMediaFile | null }>[];
  readonly full_site_complete: false;
}
export interface EmployeeMappedVerificationMediaSession {
  readonly direction: 'import';
  inventory(signal?: AbortSignal): Promise<EmployeeMappedVerificationMediaInventory>;
  bind(files: readonly EmployeeMappedVerificationMediaFile[], signal?: AbortSignal): Promise<void>;
  upload(file: EmployeeMappedVerificationMediaFile, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  // Explicitly call after all employee applies, before the SQL verification step.
  recheckImport(files: readonly EmployeeMappedVerificationMediaFile[], signal?: AbortSignal): Promise<void>;
}
const SCOPE = 'employee-mapped-verification-media';
const BUCKET = 'verification-documents';
const PREFIX = '/storage/v1/object/public/verification-documents/';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH = new RegExp(`^(id-front|id-back|selfie)/(${UUID})-[A-Za-z0-9._-]+\\.[A-Za-z0-9]{1,8}$`);
const TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const { object, count, withSignal } = dispatchTransferChecks;
const limits = EMPLOYEE_MAPPED_VERIFICATION_MEDIA_LIMITS;
const encoder = new TextEncoder();
const failure = 'Mapped verification media operation is unconfirmed. Pause and reconcile the original task and uploads before continuing with a new session. No automatic retry, deletion, rollback or job close was performed.';
export class EmployeeMappedVerificationMediaError extends Error {
  constructor(readonly serverStagingOrUploadsMayExist: boolean, readonly cancelled: boolean) {
    super(failure);
    this.name = 'EmployeeMappedVerificationMediaError';
  }
}
function invalid(): never { throw new EmployeeMappedVerificationMediaError(false, false); }
function check(signal?: AbortSignal): void { if (signal?.aborted) invalid(); }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36) invalid();
  return dispatchTransferChecks.uuid(value);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64) invalid();
  return dispatchTransferChecks.hash(value);
}
function sha(bytes: Uint8Array): string { return new Sha256().update(bytes).digestHex(); }
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, limits.maxFiles);
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
function source(value: unknown): { url: string; path: string } {
  if (typeof value !== 'string' || value.length > 512 || value !== value.trim()) invalid();
  const at = value.indexOf(PREFIX);
  if (at < 0) invalid();
  origin(value.slice(0, at));
  const path = value.slice(at + PREFIX.length), match = PATH.exec(path);
  if (!match || match[0] !== path || path.includes('..') || path.split('/')[1].length > 128) invalid();
  return { url: value, path };
}
function tuple(value: unknown): EmployeeMappedVerificationMediaFile {
  const r = object(value, ['key', 'source_url', 'bytes', 'sha256', 'content_type']);
  const ref = source(r.source_url), key = hash(r.key), bytes = count(r.bytes, limits.maxFileBytes);
  if (!bytes || key !== sha(encoder.encode(ref.url)) || typeof r.content_type !== 'string' || !TYPES.includes(r.content_type)) invalid();
  return Object.freeze({ key, source_url: ref.url, bytes, sha256: hash(r.sha256), content_type: r.content_type as VerificationMediaFile['content_type'] });
}
function ordered(files: readonly { key: string }[]): void {
  for (let i = 1; i < files.length; i++) if (files[i - 1].key >= files[i].key) invalid();
}
function total(files: readonly EmployeeMappedVerificationMediaFile[]): number {
  const bytes = files.reduce((n, file) => n + file.bytes, 0);
  if (bytes > limits.maxTotalBytes) invalid();
  return bytes;
}
function tuples(value: unknown): readonly EmployeeMappedVerificationMediaFile[] {
  const files = array(value).map(tuple);
  ordered(files); total(files);
  return Object.freeze(files);
}
function same(a: EmployeeMappedVerificationMediaFile, b: EmployeeMappedVerificationMediaFile): boolean {
  return a.key === b.key && a.source_url === b.source_url && a.bytes === b.bytes && a.sha256 === b.sha256 && a.content_type === b.content_type;
}
function inventory(value: unknown): EmployeeMappedVerificationMediaInventory {
  const r = object(value, ['scope', 'direction', 'files', 'full_site_complete']);
  if (r.scope !== SCOPE || r.direction !== 'import' || r.full_site_complete !== false) invalid();
  const files = array(r.files).map(value => {
    const ref = object(value, ['key', 'source_url', 'bucket', 'path', 'file']);
    const location = source(ref.source_url), key = hash(ref.key);
    if (key !== sha(encoder.encode(location.url)) || ref.bucket !== BUCKET || ref.path !== location.path) invalid();
    const file = ref.file === null ? null : tuple(ref.file);
    if (file && (file.key !== key || file.source_url !== location.url)) invalid();
    return Object.freeze({ key, source_url: location.url, bucket: BUCKET, path: location.path, file });
  });
  ordered(files); total(files.flatMap(ref => ref.file ? [ref.file] : []));
  return Object.freeze({ scope: SCOPE, direction: 'import', files: Object.freeze(files), full_site_complete: false });
}
function matches(refs: EmployeeMappedVerificationMediaInventory['files'], files: readonly EmployeeMappedVerificationMediaFile[], bound = false): void {
  if (refs.length !== files.length) invalid();
  for (let i = 0; i < files.length; i++) {
    if (refs[i].key !== files[i].key || refs[i].source_url !== files[i].source_url || (bound && !refs[i].file) ||
      (refs[i].file && !same(refs[i].file!, files[i]))) invalid();
  }
}
function detect(bytes: Uint8Array): VerificationMediaFile['content_type'] {
  const starts = (signature: number[], offset = 0) => signature.every((b, i) => bytes[offset + i] === b);
  if (bytes.length >= 3 && starts([255, 216, 255])) return 'image/jpeg';
  if (bytes.length >= 8 && starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (bytes.length >= 6 && (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))) return 'image/gif';
  if (bytes.length >= 12 && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)) return 'image/webp';
  if (bytes.length >= 5 && starts([37, 80, 68, 70, 45])) return 'application/pdf';
  return invalid();
}
function receipt(value: unknown, file: EmployeeMappedVerificationMediaFile): void {
  const r = object(value, ['success', 'key', 'bytes', 'sha256', 'content_type', 'full_site_complete']);
  if (r.success !== true || r.full_site_complete !== false || r.key !== file.key || r.bytes !== file.bytes ||
    r.sha256 !== file.sha256 || r.content_type !== file.content_type) invalid();
}
async function readReceipt(response: Response, signal?: AbortSignal): Promise<unknown> {
  if (response.redirected || !response.ok) {
    try { void response.body?.cancel().catch(() => {}); } catch { /* Redacted. */ }
    invalid();
  }
  const reader = response.body?.getReader();
  if (!reader) invalid();
  const output = new Uint8Array(4096);
  let used = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      check(signal);
      const { done, value } = await reader.read();
      check(signal);
      if (done) break;
      if (!(value instanceof Uint8Array) || value.length > output.length - used) invalid();
      output.set(value, used); used += value.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, used)));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { void reader.cancel().catch(() => {}); } catch { /* No untrusted cancellation wait. */ }
    reader.releaseLock();
  }
}
type Query = PromiseLike<{ data: unknown; error?: unknown }> & { abortSignal(signal: AbortSignal): Query };
type Auth = { p_admin_session_token: string; p_job_token: string };
export function createEmployeeMappedVerificationMediaSession(
  jobToken: string, transport: typeof fetch = globalThis.fetch,
): EmployeeMappedVerificationMediaSession {
  let endpoint: string, apiKey: string;
  try {
    uuid(jobToken);
    const configured = import.meta.env.VITE_SUPABASE_URL;
    const host = origin(typeof configured === 'string' && configured.endsWith('/') ? configured.slice(0, -1) : configured);
    endpoint = host + '/functions/v1/employee-transfer-media';
    apiKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (typeof apiKey !== 'string' || !apiKey || apiKey !== apiKey.trim() || /[\r\n]/.test(apiKey) || typeof transport !== 'function') invalid();
  } catch { throw new EmployeeMappedVerificationMediaError(false, false); }
  let busy = false, paused = false;
  let boundFiles: readonly EmployeeMappedVerificationMediaFile[] | undefined;
  const auth = (): Auth => ({ p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: jobToken });
  const run = async <T>(operation: (mark: () => void) => Promise<T>, writing: boolean, signal?: AbortSignal): Promise<T> => {
    let mayExist = false;
    try {
      check(signal);
      if (busy || (writing && paused)) invalid();
      busy = true;
      // Snapshot input synchronously, before auth callbacks/awaits. Even when the caller aborts,
      // only the underlying operation's settlement releases the mutex.
      const pending = (async () => {
        try {
          const result = await operation(() => { check(signal); mayExist = true; });
          check(signal);
          return result;
        } catch {
          if (mayExist) paused = true;
          invalid();
        } finally { busy = false; }
      })();
      // A synchronous auth/transport callback can abort before withSignal subscribes.
      void pending.catch(() => undefined);
      return await withSignal(() => pending, signal);
    } catch {
      if (mayExist) paused = true;
      throw new EmployeeMappedVerificationMediaError(mayExist, signal?.aborted === true);
    }
  };
  const settleQuery = async (query: Query, signal?: AbortSignal) => {
    let selected: Query;
    try { selected = signal ? query.abortSignal(signal) : query; }
    catch {
      // A custom/query implementation may already have dispatched before throwing.
      // Await that original operation too; never release the mutex early.
      try { await query; } catch { /* Redacted. */ }
      invalid();
    }
    return await selected;
  };
  const readInventory = async (signal?: AbortSignal) => {
    check(signal);
    const current = auth();
    check(signal);
    const query = supabase.rpc('get_employee_transfer_mapped_verification_media', current); // Intentionally NO direction argument.
    const result = await settleQuery(query, signal);
    check(signal);
    if (result.error) invalid();
    const refs = inventory(result.data);
    if (boundFiles) matches(refs.files, boundFiles, true);
    return refs;
  };
  const command = async (action: 'upload' | 'recheck-import', file: EmployeeMappedVerificationMediaFile,
    mark: () => void, signal?: AbortSignal, bytes?: Uint8Array) => {
    check(signal);
    const current = auth(); // Fresh session for EVERY RPC/Edge operation.
    check(signal); mark();
    const response = await transport(endpoint, {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
      headers: { apikey: apiKey, 'Content-Type': 'application/octet-stream', 'x-transfer-scope': 'mapped-verification',
        'x-transfer-action': action, 'x-admin-session-token': current.p_admin_session_token,
        'x-transfer-job-token': jobToken, 'x-transfer-object-key': file.key }, body: bytes,
    });
    receipt(await readReceipt(response, signal), file);
    check(signal);
  };
  return Object.freeze({
    direction: 'import',
    inventory: (signal?: AbortSignal) => run(() => readInventory(signal), false, signal),
    bind: (input: readonly EmployeeMappedVerificationMediaFile[], signal?: AbortSignal) => run(async mark => {
      const files = tuples(input);
      matches((await readInventory(signal)).files, files);
      check(signal);
      const current = auth();
      check(signal); mark();
      const query = supabase.rpc('employee_import_mapped_verification_media_bind', { ...current, p_files: files.map(file => ({ ...file })) });
      const result = await settleQuery(query, signal);
      check(signal);
      if (result.error) invalid();
      const r = object(result.data, ['success', 'scope', 'files', 'bytes', 'repeated', 'full_site_complete']);
      if (r.success !== true || r.scope !== SCOPE || r.files !== files.length || r.bytes !== total(files) ||
        typeof r.repeated !== 'boolean' || r.full_site_complete !== false) invalid();
      boundFiles = files;
    }, true, signal),
    upload: (input: EmployeeMappedVerificationMediaFile, inputBytes: Uint8Array, signal?: AbortSignal) => run(async mark => {
      const file = tuple(input);
      if (!(inputBytes instanceof Uint8Array) || inputBytes.length !== file.bytes) invalid();
      const bytes = new Uint8Array(inputBytes); // Copy before the first auth callback or await.
      if (sha(bytes) !== file.sha256 || detect(bytes) !== file.content_type) invalid();
      const refs = (await readInventory(signal)).files;
      const ref = refs.find(ref => ref.key === file.key);
      if (!ref?.file || !same(ref.file, file)) invalid();
      await command('upload', file, mark, signal, bytes);
    }, true, signal),
    recheckImport: (input: readonly EmployeeMappedVerificationMediaFile[], signal?: AbortSignal) => run(async mark => {
      const files = tuples(input);
      matches((await readInventory(signal)).files, files, true);
      for (const file of files) await command('recheck-import', file, mark, signal);
    }, true, signal),
  });
}
