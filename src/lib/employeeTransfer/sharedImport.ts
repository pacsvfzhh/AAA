import type { TransferByteSource } from './crypto';
import { Sha256 } from './sha256';
import {
  SHARED_TABLE_KEYS, validateSharedExportCatalog,
  type SharedExportCatalog, type SharedTableCatalog, type SharedTableKey,
} from './sharedExport';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_TABLE_ROWS = 10000;
const MAX_LINE_BYTES = 64 * 1024; // Includes LF.
const MAX_PAGE_ROWS = 200;
const MAX_PAGE_BYTES = 256 * 1024;

export interface SharedImportFiles {
  // Reopen isolated, immutable temporary files only after the whole volume has been authenticated.
  open(key: SharedTableKey): TransferByteSource | ReadableStream<Uint8Array>;
}
export interface SharedImportTarget {
  begin(catalog: SharedExportCatalog, signal?: AbortSignal): Promise<unknown>;
  stage(key: SharedTableKey, chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<unknown>;
  dryRun(signal?: AbortSignal): Promise<unknown>;
}
export interface SharedImportDryRun {
  scope: 'shared-settings';
  full_site_complete: false;
  can_apply: boolean;
  plan_hash: string;
  admins: unknown[];
  conflicts: unknown[];
}
export interface SharedImportProgress {
  scope: 'shared-settings';
  phase: 'validate' | 'stage' | 'dry-run';
  tableKey?: SharedTableKey;
  rows: number;
  bytes: number;
  fullSiteComplete: false;
}
export interface SharedImportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SharedImportProgress) => void;
}
export interface SharedImportResult {
  dryRun: SharedImportDryRun;
  rows: number;
  bytes: number;
  fullSiteComplete: false;
}

export class SharedImportStagingMayExistError extends Error {
  readonly stagingMayExist = true;
  readonly cancelled: boolean;
  readonly originalError: unknown;

  constructor(originalError: unknown, cancelled = false) {
    super('Shared-settings import stopped. Server staging may already exist; reconcile it before rerunning. No rollback or apply was performed.');
    this.name = 'SharedImportStagingMayExistError';
    this.cancelled = cancelled;
    this.originalError = originalError;
    Object.defineProperty(this, 'originalError', { enumerable: false });
  }
}

class SharedImportValidationError extends Error {
  constructor(detail: string) {
    super(`Invalid shared-settings import: ${detail}.`);
    this.name = 'SharedImportValidationError';
  }
}
function invalid(detail: string): never {
  throw new SharedImportValidationError(detail);
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Shared-settings import cancelled.', 'AbortError');
}
async function withSignal<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(new DOMException('Shared-settings import cancelled.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    // Observe late failures without waiting for a stalled read/request on cancellation.
    Promise.resolve().then(() => {
      checkAbort(signal);
      return operation();
    }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('response object shape');
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) {
    invalid('response fields');
  }
  const record: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid('response field descriptor');
    record[key] = descriptor.value;
  }
  return record;
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    invalid('response count or byte limit');
  }
  return value;
}
function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid('response SHA-256 format');
  return value;
}
function validateBegin(value: unknown): void {
  const record = object(value, ['success', 'scope', 'full_site_complete']);
  if (record.success !== true || record.scope !== 'shared-settings' || record.full_site_complete !== false) {
    invalid('begin response');
  }
}
function validateAck(value: unknown, rows: number, bytes: number, hash: string): void {
  const record = object(value, ['success', 'rows', 'bytes', 'sha256', 'repeated']);
  if (record.success !== true || typeof record.repeated !== 'boolean'
    || integer(record.rows, MAX_PAGE_ROWS) !== rows || integer(record.bytes, MAX_PAGE_BYTES) !== bytes
    || sha256(record.sha256) !== hash) invalid('stage acknowledgement');
}
function validateDryRun(value: unknown): SharedImportDryRun {
  const record = object(value, ['scope', 'full_site_complete', 'can_apply', 'plan_hash', 'admins', 'conflicts']);
  if (record.scope !== 'shared-settings' || record.full_site_complete !== false
    || typeof record.can_apply !== 'boolean' || !Array.isArray(record.admins) || !Array.isArray(record.conflicts)) {
    invalid('dry-run response');
  }
  // SQL owns account mapping, super-admin protection, conflicts and explicit approval, not this byte transport.
  return {
    scope: 'shared-settings', full_site_complete: false, can_apply: record.can_apply,
    plan_hash: sha256(record.plan_hash), admins: record.admins.slice(), conflicts: record.conflicts.slice(),
  };
}
function objectLine(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { invalid('NDJSON UTF-8'); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { invalid('NDJSON syntax'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) invalid('NDJSON object row');
  return text;
}

async function scanTable(
  files: SharedImportFiles,
  expected: SharedTableCatalog,
  signal?: AbortSignal,
  onLine?: (text: string, bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  checkAbort(signal);
  const source = files.open(expected.key);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  if (source && 'getReader' in source && typeof source.getReader === 'function') reader = source.getReader();
  else if (source && Symbol.asyncIterator in source && typeof source[Symbol.asyncIterator] === 'function') {
    iterator = source[Symbol.asyncIterator]();
  } else invalid('byte source');
  let ended = false;
  const hash = new Sha256();
  const line = new Uint8Array(MAX_LINE_BYTES);
  let used = 0;
  let rows = 0;
  let bytes = 0;
  try {
    while (true) {
      const next = reader
        ? await withSignal(() => reader!.read(), signal)
        : await withSignal(() => iterator!.next(), signal);
      checkAbort(signal);
      if (next.done) { ended = true; break; }
      if (!(next.value instanceof Uint8Array) || next.value.length > MAX_INPUT_BYTES) invalid('input chunk limit');
      bytes += next.value.length;
      if (bytes > expected.bytes || bytes > MAX_TOTAL_BYTES) invalid('table byte limit');
      // Own the bounded input buffer across awaits, including when the source reuses a Node Buffer.
      const chunk = new Uint8Array(next.value);
      hash.update(chunk);
      let start = 0;
      while (start < chunk.length) {
        checkAbort(signal);
        const lf = chunk.indexOf(10, start);
        const end = lf === -1 ? chunk.length : lf + 1;
        if (used + end - start > MAX_LINE_BYTES) invalid('NDJSON line byte limit');
        line.set(chunk.subarray(start, end), used);
        used += end - start;
        start = end;
        if (lf !== -1) {
          if (++rows > expected.rows || rows > MAX_TABLE_ROWS) invalid('table row limit');
          const raw = line.subarray(0, used);
          const text = objectLine(raw);
          if (onLine) await onLine(text, raw);
          checkAbort(signal);
          used = 0;
        }
      }
    }
    if (used !== 0) invalid('NDJSON final newline');
    if (rows !== expected.rows || bytes !== expected.bytes || hash.digestHex() !== expected.sha256) {
      invalid('table totals or SHA-256 mismatch');
    }
  } finally {
    if (reader) {
      try {
        if (!ended) void reader.cancel().catch(() => undefined);
      } finally { reader.releaseLock(); }
    } else if (!ended && iterator?.return) {
      // return() can itself stall behind a pending next(); do not make cancellation wait for it.
      try { void Promise.resolve(iterator.return()).catch(() => undefined); } catch { /* Read-only source cleanup. */ }
    }
  }
}

export async function stageSharedSettingsImport(
  catalog: unknown,
  files: SharedImportFiles,
  target: SharedImportTarget,
  options: SharedImportOptions = {},
): Promise<SharedImportResult> {
  const { signal, onProgress } = options;
  let stagingMayExist = false;
  try {
    checkAbort(signal);
    let validated: SharedExportCatalog;
    try { validated = validateSharedExportCatalog(catalog); } catch { invalid('catalog'); }
    let checkedRows = 0;
    let checkedBytes = 0;
    for (const key of SHARED_TABLE_KEYS) {
      const table = validated.tables.find(table => table.key === key)!;
      await scanTable(files, table, signal);
      checkedRows += table.rows;
      checkedBytes += table.bytes;
      onProgress?.({ scope: 'shared-settings', phase: 'validate', tableKey: key,
        rows: checkedRows, bytes: checkedBytes, fullSiteComplete: false });
      checkAbort(signal);
    }
    validateBegin(await withSignal(() => {
      stagingMayExist = true;
      return target.begin(validateSharedExportCatalog(validated), signal);
    }, signal));
    checkAbort(signal);
    let rows = 0;
    let bytes = 0;
    for (const key of SHARED_TABLE_KEYS) {
      const table = validated.tables.find(table => table.key === key)!;
      let chunkNo = 0;
      let page = '';
      let pageRows = 0;
      let pageBytes = 0;
      let pageHash = new Sha256();
      const flush = async () => {
        const hash = pageHash.digestHex();
        const ack = await withSignal(() => target.stage(key, chunkNo, page, signal), signal);
        checkAbort(signal);
        validateAck(ack, pageRows, pageBytes, hash);
        rows += pageRows;
        bytes += pageBytes;
        chunkNo++;
        page = '';
        pageRows = 0;
        pageBytes = 0;
        pageHash = new Sha256();
        onProgress?.({ scope: 'shared-settings', phase: 'stage', tableKey: key,
          rows, bytes, fullSiteComplete: false });
        checkAbort(signal);
      };
      await scanTable(files, table, signal, async (text, raw) => {
        if (pageBytes + raw.length > MAX_PAGE_BYTES) await flush();
        page += text;
        pageRows++;
        pageBytes += raw.length;
        pageHash.update(raw);
        if (pageRows === MAX_PAGE_ROWS || pageBytes === MAX_PAGE_BYTES) await flush();
      });
      if (pageRows > 0 || chunkNo === 0) await flush();
    }
    const dryRun = validateDryRun(await withSignal(() => target.dryRun(signal), signal));
    checkAbort(signal);
    onProgress?.({ scope: 'shared-settings', phase: 'dry-run', rows, bytes, fullSiteComplete: false });
    checkAbort(signal);
    return { dryRun, rows, bytes, fullSiteComplete: false };
  } catch (error) {
    if (stagingMayExist) throw new SharedImportStagingMayExistError(error, signal?.aborted === true);
    checkAbort(signal);
    if (error instanceof SharedImportValidationError) throw error;
    // Upstream parser, transport and callback errors can contain credentials; do not expose them.
    const failure = new Error('Shared-settings import stopped before server staging began.');
    failure.name = 'SharedImportError';
    throw failure;
  }
}
