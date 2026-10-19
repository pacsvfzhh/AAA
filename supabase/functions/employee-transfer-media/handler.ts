export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 90_000;
const BUCKET = 'verification-documents';
const PUBLIC_PREFIX = '/storage/v1/object/public/verification-documents/';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(`^${UUID}$`, 'i');
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const ORIGIN_PATTERN = /^https:\/\/[a-z0-9-]+\.supabase\.co$/;
const PATH_PATTERN = new RegExp(`^(id-front|id-back|selfie)/(${UUID})-[A-Za-z0-9._-]+\\.[A-Za-z0-9]{1,8}$`);
const IMPORT_NAME = new RegExp(`^${UUID}-transfer-[0-9a-f]{32}\\.[a-z0-9]{1,8}$`);
const TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
const ACTIONS = new Set(['download', 'recheck-export', 'upload', 'recheck-import']);
const ALLOWED_HEADERS = 'authorization, apikey, content-type, x-client-info, x-transfer-action, x-admin-session-token, x-transfer-job-token, x-transfer-object-key';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': ALLOWED_HEADERS,
  'Access-Control-Expose-Headers': 'x-transfer-sha256, x-transfer-content-type',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

type Result = { data?: unknown; error?: unknown };
export type MediaRpc = (name: string, args: Record<string, unknown>) => PromiseLike<Result>;
export interface MediaStore {
  download(bucket: string, path: string, signal: AbortSignal): PromiseLike<{ data?: Response | null; error?: unknown }>;
  upload(bucket: string, path: string, bytes: Uint8Array, options: { upsert: false; contentType: string }): PromiseLike<Result>;
}
export interface MediaHandlerDependencies {
  supabaseUrl: string;
  rpc: MediaRpc;
  store: MediaStore;
  crypto?: Pick<Crypto, 'subtle'>;
}

type RecordValue = Record<string, unknown>;
type FileTuple = { key: string; source_url: string; bytes: number; sha256: string; content_type: string };
type Context = { direction: string; key: string; bucket: string; path: string; source_url: string; file: FileTuple | null; generation: string };

// All failures have fixed, non-sensitive responses, including uncertain writes.
class Failure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function fail(status = 502, code = 'TRANSFER_FAILED'): never { throw new Failure(status, code); }
function record(value: unknown): value is RecordValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: RecordValue, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function isOrigin(value: string): boolean {
  // JavaScript `$` also matches before a final newline: require the raw string.
  return value === value.trim() && ORIGIN_PATTERN.test(value);
}
function storageOrigin(value: string): string | null {
  // No normalized URL can turn an unsafe configured address into a safe origin.
  const origin = value.endsWith('/') ? value.slice(0, -1) : value;
  return isOrigin(origin) ? origin : null;
}
function safePath(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && PATH_PATTERN.test(value) && !value.includes('..') && value.split('/')[1].length <= 128;
}
function sourcePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) fail();
  const split = value.indexOf(PUBLIC_PREFIX);
  if (split < 0 || !isOrigin(value.slice(0, split))) fail();
  const path = value.slice(split + PUBLIC_PREFIX.length);
  if (!safePath(path)) fail();
  return path;
}
function fileTuple(value: unknown, key: string, source: string): FileTuple {
  if (!record(value) || !exact(value, ['key', 'source_url', 'bytes', 'sha256', 'content_type']) ||
    value.key !== key || value.source_url !== source || !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 1 || (value.bytes as number) > MAX_MEDIA_BYTES ||
    typeof value.sha256 !== 'string' || value.sha256.length !== 64 || !KEY_PATTERN.test(value.sha256) ||
    typeof value.content_type !== 'string' || !TYPES.has(value.content_type)) fail();
  return value as FileTuple;
}
async function digest(bytes: Uint8Array, crypto: Pick<Crypto, 'subtle'>): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function context(value: unknown, action: string, key: string, origin: string, crypto: Pick<Crypto, 'subtle'>): Promise<Context> {
  const direction = action === 'download' || action === 'recheck-export' ? 'export' : 'import';
  if (!record(value) || !exact(value, ['direction', 'key', 'bucket', 'path', 'source_url', 'file', 'generation']) ||
    value.direction !== direction || value.key !== key || value.bucket !== BUCKET || !safePath(value.path)) fail();
  const generation = value.generation;
  if (typeof generation !== 'string' || (direction === 'export' ? generation !== 'export' :
    generation !== generation.trim() || !/^(0|[1-9][0-9]{0,5})$/.test(generation) || Number(generation) > 500000)) fail();
  const path = sourcePath(value.source_url);
  if (await digest(new TextEncoder().encode(value.source_url as string), crypto) !== key) fail();
  if (direction === 'export') {
    if (value.source_url !== origin + PUBLIC_PREFIX + path || value.path !== path) fail();
  } else {
    const [folder, name] = value.path.split('/');
    const [sourceFolder, sourceName] = path.split('/');
    if (folder !== sourceFolder || name.slice(0, 36) !== sourceName.slice(0, 36) || !IMPORT_NAME.test(name) ||
      name.slice(name.lastIndexOf('.') + 1) !== sourceName.slice(sourceName.lastIndexOf('.') + 1).toLowerCase()) fail();
  }
  const file = value.file === null && action === 'download' ? null : fileTuple(value.file, key, value.source_url as string);
  return { direction, key, bucket: BUCKET, path: value.path, source_url: value.source_url as string, file, generation };
}

// Only byte signatures establish MIME; caller metadata is not evidence.
function detectType(bytes: Uint8Array): string {
  const starts = (signature: number[], offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte);
  if (bytes.length >= 3 && starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 8 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytes.length >= 6 && (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return 'image/gif';
  if (bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (bytes.length >= 5 && starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  fail(422, 'INVALID_MEDIA');
}
async function inspect(bytes: Uint8Array, ctx: Context, crypto: Pick<Crypto, 'subtle'>): Promise<FileTuple> {
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) fail(422, 'INVALID_MEDIA');
  const actual = { key: ctx.key, source_url: ctx.source_url, bytes: bytes.length, sha256: await digest(bytes, crypto), content_type: detectType(bytes) };
  if (ctx.file && !sameFile(ctx.file, actual)) fail(422, 'INVALID_MEDIA');
  return actual;
}
function sameFile(a: FileTuple, b: FileTuple): boolean {
  return a.key === b.key && a.source_url === b.source_url && a.bytes === b.bytes && a.sha256 === b.sha256 && a.content_type === b.content_type;
}
async function cancelBody(request: Request): Promise<void> {
  try { await request.body?.cancel(); } catch { /* Never expose stream/backend errors. */ }
}
// A fixed bounded buffer avoids unbounded chunk retention and concatenation.
async function readBounded(request: Request, limit: number, expected: number | null): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) { if (expected && expected > 0) fail(400, 'INVALID_REQUEST'); return new Uint8Array(); }
  const output = new Uint8Array(limit);
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener('abort', onAbort, { once: true });
  let length = 0;
  try {
    while (true) {
      if (request.signal.aborted) fail(400, 'INVALID_REQUEST');
      const { done, value } = await reader.read();
      if (request.signal.aborted) fail(400, 'INVALID_REQUEST');
      if (done) break;
      if (!(value instanceof Uint8Array) || value.length > limit - length) fail(413, 'BODY_TOO_LARGE');
      output.set(value, length); length += value.length;
    }
    if (expected !== null && length !== expected) fail(400, 'INVALID_REQUEST');
    return output.subarray(0, length);
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    // Cancellation has no database/Storage side effects and cannot mask failure.
    try { await reader.cancel(); } catch { /* Stream errors are deliberately discarded. */ }
    reader.releaseLock();
  }
}
function declaredLength(request: Request, max: number): number | null {
  const header = request.headers.get('content-length');
  if (header === null) return null;
  if (!/^(0|[1-9][0-9]{0,8})$/.test(header)) fail(400, 'INVALID_REQUEST');
  const size = Number(header);
  if (size > max) fail(413, 'BODY_TOO_LARGE');
  return size;
}
function isOccupied(error: unknown): boolean {
  // Storage can wrap a structured 409 in HTTP 400; free-form messages are unsafe.
  return record(error) && (error.statusCode === '409' || error.statusCode === 409 || error.status === 409);
}
function cancelStream(body: ReadableStream<Uint8Array> | null): void {
  // Do not await an untrusted stream's cancellation promise or drain its tail.
  try { void body?.cancel().catch(() => {}); } catch { /* No backend errors escape. */ }
}
async function download(store: MediaStore, ctx: Context, requestSignal: AbortSignal): Promise<Uint8Array> {
  const controller = new AbortController();
  const onRequestAbort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);
  requestSignal.addEventListener('abort', onRequestAbort, { once: true });
  if (requestSignal.aborted) onRequestAbort();
  const signal = controller.signal;
  let response: Response | undefined;
  try {
    if (signal.aborted) fail();
    const result = await store.download(BUCKET, ctx.path, signal);
    if (!(result.data instanceof Response)) fail();
    response = result.data;
    const encoding = response.headers.get('content-encoding');
    if (result.error || response.status !== 200 || response.redirected || response.headers.has('content-range') ||
      (encoding !== null && encoding.toLowerCase() !== 'identity') || signal.aborted) fail();
    const header = response.headers.get('content-length');
    let declared: number | null = null;
    if (header !== null) {
      if (!/^(0|[1-9][0-9]{0,8})$/.test(header)) fail();
      declared = Number(header);
      if (!declared || declared > MAX_MEDIA_BYTES || (ctx.file && declared !== ctx.file.bytes)) fail(422, 'INVALID_MEDIA');
    }
    const expected = ctx.file?.bytes ?? declared;
    const limit = expected ?? MAX_MEDIA_BYTES;
    if (!response.body) fail(422, 'INVALID_MEDIA');
    const reader = response.body.getReader();
    const onAbort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    // Capped geometric growth avoids retaining an unbounded list of chunks.
    let output = new Uint8Array(expected ?? Math.min(64 * 1024, limit));
    let length = 0;
    try {
      while (true) {
        if (signal.aborted) fail();
        const { done, value } = await reader.read();
        if (signal.aborted) fail();
        if (done) break;
        if (!(value instanceof Uint8Array)) fail();
        if (value.length > limit - length) fail(422, 'INVALID_MEDIA');
        if (length + value.length > output.length) {
          const grown = new Uint8Array(Math.min(limit, Math.max(length + value.length, output.length * 2)));
          grown.set(output.subarray(0, length)); output = grown;
        }
        output.set(value, length); length += value.length;
      }
      if (!length || (expected !== null && length !== expected)) fail(422, 'INVALID_MEDIA');
      return output.subarray(0, length);
    } finally {
      signal.removeEventListener('abort', onAbort);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    cancelStream(response?.body ?? null);
    throw error;
  } finally {
    // Headers alone are not completion; stalled response bodies need the same deadline.
    clearTimeout(timer);
    requestSignal.removeEventListener('abort', onRequestAbort);
  }
}
function receipt(file: FileTuple) {
  return { success: true, key: file.key, bytes: file.bytes, sha256: file.sha256, content_type: file.content_type, full_site_complete: false };
}
function validCommit(value: unknown, file: FileTuple): boolean {
  return record(value) && exact(value, ['success', 'key', 'bytes', 'sha256', 'content_type', 'full_site_complete']) &&
    value.success === true && value.full_site_complete === false && value.key === file.key && value.bytes === file.bytes &&
    value.sha256 === file.sha256 && value.content_type === file.content_type;
}

export function createEmployeeTransferMediaHandler(deps: MediaHandlerDependencies): (request: Request) => Promise<Response> {
  const origin = storageOrigin(deps.supabaseUrl);
  const crypto = deps.crypto ?? globalThis.crypto;
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('access-control-request-method');
        const headers = request.headers.get('access-control-request-headers');
        if ((method !== null && method !== 'POST') || (headers !== null && headers.split(',').some(header =>
          !ALLOWED_HEADERS.split(', ').includes(header.trim().toLowerCase())))) fail(400, 'INVALID_REQUEST');
        return new Response(null, { status: 204, headers: CORS });
      }
      if (request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED');
      if (!origin || !crypto?.subtle) fail(500, 'TRANSFER_FAILED');
      const action = request.headers.get('x-transfer-action') ?? '';
      const admin = request.headers.get('x-admin-session-token') ?? '';
      const job = request.headers.get('x-transfer-job-token') ?? '';
      const key = request.headers.get('x-transfer-object-key') ?? '';
      if (!ACTIONS.has(action) || !UUID_PATTERN.test(admin) || !UUID_PATTERN.test(job) || !KEY_PATTERN.test(key) ||
        request.signal.aborted || request.headers.has('content-encoding') || request.headers.has('content-range')) fail(400, 'INVALID_REQUEST');
      const length = declaredLength(request, action === 'upload' ? MAX_MEDIA_BYTES : 0);
      const args = { p_admin_session_token: admin, p_job_token: job, p_action: action, p_object_key: key };
      const authorized = await deps.rpc('employee_transfer_verification_media_authorize', args);
      if (authorized.error || authorized.data === null || authorized.data === undefined) fail(403, 'NOT_AUTHORIZED');
      const ctx = await context(authorized.data, action, key, origin, crypto);
      if (request.signal.aborted) fail(400, 'INVALID_REQUEST');
      let bytes: Uint8Array | undefined;
      let file: FileTuple;
      if (action === 'upload') {
        const expected = ctx.file!;
        if (length !== null && length !== expected.bytes) fail(400, 'INVALID_REQUEST');
        bytes = await readBounded(request, expected.bytes, expected.bytes);
        file = await inspect(bytes, ctx, crypto);
        if (request.signal.aborted) fail(400, 'INVALID_REQUEST');
        // The SDK cannot abort an upload; cancellation cannot promise a rollback.
        const uploaded = await deps.store.upload(BUCKET, ctx.path, bytes, { upsert: false, contentType: file.content_type });
        bytes = undefined; // Release the upload buffer before bounded streaming readback.
        if (uploaded.error && !isOccupied(uploaded.error)) fail();
        if (request.signal.aborted) fail();
        // Readback may fail after storage wrote the object; never delete or fake rollback.
        const readback = await download(deps.store, ctx, request.signal);
        const verified = await inspect(readback, ctx, crypto);
        if (!sameFile(file, verified)) fail();
      } else {
        await readBounded(request, 0, 0);
        bytes = await download(deps.store, ctx, request.signal);
        file = await inspect(bytes, ctx, crypto);
      }
      if (request.signal.aborted) fail();
      const committed = await deps.rpc('employee_transfer_verification_media_commit', {
        ...args, p_bytes: file.bytes, p_sha256: file.sha256, p_content_type: file.content_type, p_storage_origin: origin,
        p_generation: ctx.generation, // Never reauthorize/refresh this after reading the object.
      });
      if (committed.error || !validCommit(committed.data, file) || request.signal.aborted) fail();
      if (action === 'download') {
        // A stream avoids Response(Uint8Array)'s additional full-size copy.
        const payload = bytes!;
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(payload); controller.close(); } });
        return new Response(body, { headers: { ...CORS, 'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment', 'x-transfer-sha256': file.sha256, 'x-transfer-content-type': file.content_type } });
      }
      return json(receipt(file));
    } catch (error) {
      await cancelBody(request);
      const known = error instanceof Failure;
      return json({ success: false, error: known ? error.code : 'TRANSFER_FAILED' }, known ? error.status : 502);
    }
  };
}
