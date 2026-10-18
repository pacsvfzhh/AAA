import type { TransferByteSource } from './crypto';
import type { VolumeManifest } from './manifest';
import { Sha256 } from './sha256';
import {
  DISPATCH_TABLE_KEYS, DISPATCH_TRANSFER_LIMITS, dispatchTransferChecks, validateDispatchCatalog,
  type DispatchExportCatalog, type DispatchTableCatalog, type DispatchTableKey,
} from './dispatchTransfer';

const { object, count, uuid, hash, rowIdentity } = dispatchTransferChecks;
const limits = DISPATCH_TRANSFER_LIMITS;
const MAX_INPUT_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface DispatchImportFiles {
  // Reopen isolated, immutable files only after the entire encrypted volume has been authenticated.
  open(path: string): TransferByteSource | ReadableStream<Uint8Array>;
}
export interface DispatchImportTarget {
  begin(catalog: DispatchExportCatalog, signal?: AbortSignal): Promise<unknown>;
  stage(key: DispatchTableKey, chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<unknown>;
  dryRun(signal?: AbortSignal): Promise<unknown>;
}
export interface DispatchImportDryRun {
  scope: 'dispatch-submission'; full_site_complete: false;
  preparation_ready: true; replacement_ready: false; can_apply: false;
  plan_hash: string; source_default_group_id: string;
  counts: Record<DispatchTableKey, number>;
  dependencies: { administrators: number; employees: number; orders: number };
}
export interface DispatchImportProgress {
  scope: 'dispatch-submission'; phase: 'validate' | 'stage' | 'dry-run'; tableKey?: DispatchTableKey;
  rows: number; bytes: number; fullSiteComplete: false;
}
export interface DispatchImportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DispatchImportProgress) => void;
}
export interface DispatchImportResult {
  dryRun: DispatchImportDryRun; rows: number; bytes: number; fullSiteComplete: false;
}
export class DispatchImportCleanupError extends Error {
  readonly cleanupRequired = true;
  constructor(readonly stagingMayExist = false) {
    super('Dispatch import temporary plaintext cleanup was not confirmed. Do not reuse the workspace; reconcile any server staging before retrying.');
    this.name = 'DispatchImportCleanupError';
  }
}
export class DispatchImportStagingMayExistError extends Error {
  readonly stagingMayExist = true;
  constructor(readonly cancelled: boolean) {
    super('Dispatch import preparation stopped. Server staging may already exist; reconcile it before rerunning. No automatic cancel RPC, retry, rollback, apply or close was performed.');
    this.name = 'DispatchImportStagingMayExistError';
  }
}
function invalid(): never { throw new Error('Invalid dispatch/submission import preparation.'); }
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Dispatch import cancelled.', 'AbortError');
}
async function withSignal<T>(operation: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(new DOMException('Dispatch import cancelled.', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    // Observe late failures, but never resume staging after local cancellation.
    Promise.resolve().then(() => { checkAbort(signal); return operation(); }).then(
      value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); },
    );
  });
}
export const dispatchImportChecks = Object.freeze({ checkAbort, withSignal });

export function validateDispatchImportDryRun(value: unknown): DispatchImportDryRun {
  const record = object(value, ['scope', 'full_site_complete', 'preparation_ready', 'replacement_ready',
    'can_apply', 'plan_hash', 'source_default_group_id', 'counts', 'dependencies']);
  if (record.scope !== 'dispatch-submission' || record.full_site_complete !== false
    || record.preparation_ready !== true || record.replacement_ready !== false || record.can_apply !== false) invalid();
  const rawCounts = object(record.counts, DISPATCH_TABLE_KEYS);
  const counts = Object.fromEntries(DISPATCH_TABLE_KEYS.map(key => [key, count(rawCounts[key], limits.maxRows)])) as DispatchImportDryRun['counts'];
  const dependencies = object(record.dependencies, ['administrators', 'employees', 'orders']);
  return { scope: 'dispatch-submission', full_site_complete: false,
    preparation_ready: true, replacement_ready: false, can_apply: false,
    plan_hash: hash(record.plan_hash), source_default_group_id: uuid(record.source_default_group_id), counts,
    dependencies: { administrators: count(dependencies.administrators), employees: count(dependencies.employees),
      orders: count(dependencies.orders) } };
}
export function validateDispatchManifest(manifest: VolumeManifest, catalog: DispatchExportCatalog): void {
  if (manifest.scope !== 'replacement-backup' || manifest.sourceSiteId !== catalog.site_id
    || manifest.volumeIndex !== 1 || manifest.volumeCount !== 1 || manifest.entries.length !== DISPATCH_TABLE_KEYS.length) invalid();
  for (const table of catalog.tables) {
    const entry = manifest.entries.find(entry => entry.path === `data/dispatch-${table.key}.ndjson`);
    if (!entry || entry.kind !== 'ndjson' || entry.bytes !== table.bytes) invalid();
  }
  // Entry SHA-256 is authenticated by the container. The catalog instead binds ordered line hashes,
  // which must also be checked against the actual plaintext by DispatchTableVerifier.
}

type OnLine = (text: string, raw: Uint8Array) => Promise<void>;
// Shared only with dispatchBackup's streaming readback; never reserialize parsed numeric values.
export class DispatchTableVerifier {
  private readonly line = new Uint8Array(limits.maxLineBytes);
  private readonly digest = new Sha256();
  private readonly rowHashes = new Sha256();
  private lastId: string | null = null;
  private used = 0;
  private rows = 0;
  private bytes = 0;
  private finished = false;
  constructor(private readonly expected: DispatchTableCatalog) {}

  async push(input: Uint8Array, signal?: AbortSignal, onLine?: OnLine): Promise<void> {
    checkAbort(signal);
    if (this.finished || !(input instanceof Uint8Array) || input.length > MAX_INPUT_BYTES) invalid();
    this.bytes += input.length;
    if (this.bytes > this.expected.bytes || this.bytes > limits.maxTableBytes) invalid();
    // Own the bounded producer buffer across awaits (including reused Node Buffers).
    const chunk = new Uint8Array(input);
    this.digest.update(chunk);
    let start = 0;
    while (start < chunk.length) {
      checkAbort(signal);
      const lf = chunk.indexOf(10, start);
      const end = lf === -1 ? chunk.length : lf + 1;
      if (this.used + end - start > this.line.length) invalid();
      this.line.set(chunk.subarray(start, end), this.used);
      this.used += end - start; start = end;
      if (lf !== -1) {
        if (++this.rows > this.expected.rows || this.rows > limits.maxRows) invalid();
        const raw = this.line.subarray(0, this.used);
        const text = decoder.decode(raw);
        const id = rowIdentity(text, this.expected.key);
        if (this.lastId !== null && id <= this.lastId) invalid();
        this.lastId = id;
        // Include LF in each row hash; concatenate lowercase hex strings without separators.
        this.rowHashes.update(encoder.encode(new Sha256().update(raw).digestHex()));
        if (onLine) await onLine(text, raw);
        checkAbort(signal);
        this.used = 0;
      }
    }
  }
  finish(): string {
    if (this.used || this.rows !== this.expected.rows || this.bytes !== this.expected.bytes
      || this.rowHashes.digestHex() !== this.expected.row_hashes_sha256) invalid();
    this.finished = true;
    return this.digest.digestHex();
  }
}

async function scanTable(
  files: DispatchImportFiles, table: DispatchTableCatalog, signal?: AbortSignal, onLine?: OnLine,
): Promise<void> {
  checkAbort(signal);
  const source = files.open(`data/dispatch-${table.key}.ndjson`);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  if (source && 'getReader' in source && typeof source.getReader === 'function') reader = source.getReader();
  else if (source && Symbol.asyncIterator in source && typeof source[Symbol.asyncIterator] === 'function') {
    iterator = source[Symbol.asyncIterator]();
  } else invalid();
  const verifier = new DispatchTableVerifier(table);
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
      try { if (!ended) void reader.cancel().catch(() => undefined); }
      finally { reader.releaseLock(); }
    } else if (!ended && iterator?.return) {
      // return() may stall behind next(); close reads without waiting for blocked producers.
      try { void Promise.resolve(iterator.return()).catch(() => undefined); } catch { /* Read closure only. */ }
    }
  }
}

export async function stageDispatchImport(
  input: unknown, files: DispatchImportFiles, target: DispatchImportTarget, options: DispatchImportOptions = {},
): Promise<DispatchImportResult> {
  const { signal, onProgress } = options;
  let stagingMayExist = false;
  try {
    checkAbort(signal);
    const catalog = validateDispatchCatalog(input);
    let checkedRows = 0, checkedBytes = 0;
    // All seven files must pass before begin can send any request.
    for (const table of catalog.tables) {
      await scanTable(files, table, signal);
      checkedRows += table.rows; checkedBytes += table.bytes;
      onProgress?.({ scope: 'dispatch-submission', phase: 'validate', tableKey: table.key,
        rows: checkedRows, bytes: checkedBytes, fullSiteComplete: false });
      checkAbort(signal);
    }
    const begin = object(await withSignal(() => {
      stagingMayExist = true;
      return target.begin(validateDispatchCatalog(catalog), signal);
    }, signal), ['success', 'scope', 'full_site_complete']);
    if (begin.success !== true || begin.scope !== 'dispatch-submission' || begin.full_site_complete !== false) invalid();
    checkAbort(signal);
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      let chunkNo = 0, pageRows = 0, pageBytes = 0;
      let page = '', pageHash = new Sha256();
      const flush = async () => {
        const sha256 = pageHash.digestHex();
        const ack = object(await withSignal(() => target.stage(table.key, chunkNo, page, signal), signal),
          ['success', 'rows', 'bytes', 'sha256', 'repeated']);
        if (ack.success !== true || typeof ack.repeated !== 'boolean'
          || ack.rows !== pageRows || ack.bytes !== pageBytes || ack.sha256 !== sha256) invalid();
        checkAbort(signal);
        rows += pageRows; bytes += pageBytes; chunkNo++;
        page = ''; pageRows = 0; pageBytes = 0; pageHash = new Sha256();
        onProgress?.({ scope: 'dispatch-submission', phase: 'stage', tableKey: table.key,
          rows, bytes, fullSiteComplete: false });
        checkAbort(signal);
      };
      // Reopen and verify the same row hashes, counts and bytes while staging bounded raw pages.
      await scanTable(files, table, signal, async (text, raw) => {
        if (pageBytes + raw.length > limits.maxPageBytes) await flush();
        page += text; pageRows++; pageBytes += raw.length; pageHash.update(raw);
        if (pageRows === limits.maxPageRows || pageBytes === limits.maxPageBytes) await flush();
      });
      if (pageRows || chunkNo === 0) await flush();
    }
    const dryRun = validateDispatchImportDryRun(await withSignal(() => target.dryRun(signal), signal));
    if (catalog.tables.some(table => dryRun.counts[table.key] !== table.rows)) invalid();
    checkAbort(signal);
    onProgress?.({ scope: 'dispatch-submission', phase: 'dry-run', rows, bytes, fullSiteComplete: false });
    checkAbort(signal);
    return { dryRun, rows, bytes, fullSiteComplete: false };
  } catch {
    if (stagingMayExist) throw new DispatchImportStagingMayExistError(signal?.aborted === true);
    checkAbort(signal);
    // Never expose parser/transport/callback errors that may contain sensitive source values.
    throw new Error('Dispatch import preparation stopped before server staging began.');
  }
}
