import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import {
  ARCHIVES_TRANSFER_LIMITS, archivesCursor, archivesTableKey, validateArchivesCatalog,
  validateArchivesPage, validateArchivesVerification, type ArchivesCatalog, type ArchivesExportSource,
} from './archiveTransfer';
import {
  readArchiveMedia, validateArchiveMediaInventory, type ArchiveMediaFile,
  type ArchiveMediaInventory, type ArchiveMediaReference, type ArchiveMediaSession,
} from './archiveMedia';
import { exportArchiveBundle, type ArchiveBundleOptions, type ArchiveBundleResult, type ArchiveBundleWorkspaceFactory } from './archiveBundle';
import type { ReplacementBackupFile } from './replacementBackup';
import { validateVolumeInfo, type VolumeInfo } from './manifest';
import { Sha256 } from './sha256';

export interface ArchiveReexportSnapshot { catalog: ArchivesCatalog; snapshot_hash: string }
export interface ArchiveReexportInventory {
  scope: 'transferred-archives'; namespaces: ArchiveReexportSnapshot[]; fingerprint: string; full_site_complete: false;
}
const { object, withSignal, checkAbort } = dispatchTransferChecks;
const failure = 'Archive re-export was not confirmed. Keep any saved volumes and restart from a fresh inventory after reconciling the source. No server write, archive, deletion, maintenance release or full-site completion was performed.';
function invalid(): never { throw new Error(failure); }
function uuid(input: unknown): string {
  if (typeof input !== 'string' || input.length !== 36) invalid();
  return dispatchTransferChecks.uuid(input);
}
function hash(input: unknown): string {
  if (typeof input !== 'string' || input.length !== 64) invalid();
  return dispatchTransferChecks.hash(input);
}
function equal(a: unknown, b: unknown): void { if (JSON.stringify(a) !== JSON.stringify(b)) invalid(); }
export function validateArchiveReexportSnapshot(input: unknown): ArchiveReexportSnapshot {
  const r = object(input, ['catalog', 'snapshot_hash']);
  return { catalog: validateArchivesCatalog(r.catalog), snapshot_hash: hash(r.snapshot_hash) };
}
export function validateArchiveReexportInventory(input: unknown): ArchiveReexportInventory {
  const r = object(input, ['scope', 'namespaces', 'fingerprint', 'full_site_complete']);
  if (r.scope !== 'transferred-archives' || r.full_site_complete !== false || !Array.isArray(r.namespaces)
    || r.namespaces.length > 1000 || Object.keys(r.namespaces).length !== r.namespaces.length) invalid();
  const namespaces = Array.from(r.namespaces, validateArchiveReexportSnapshot);
  let last = '';
  for (const snapshot of namespaces) {
    const key = `${snapshot.catalog.site_id}:${snapshot.catalog.package_id}`;
    if (key <= last) invalid();
    last = key;
  }
  const result: ArchiveReexportInventory = { scope: 'transferred-archives', namespaces, fingerprint: hash(r.fingerprint), full_site_complete: false };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 2 * 1024 * 1024) invalid();
  return result;
}
type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
async function request<T>(operation: () => Query, validate: (data: unknown) => T, signal?: AbortSignal): Promise<T> {
  try {
    checkAbort(signal);
    const { data, error } = await withSignal(() => {
      const query = operation(); return signal ? query.abortSignal(signal) : query;
    }, signal);
    checkAbort(signal);
    if (error) invalid();
    const result = validate(data); checkAbort(signal); return result;
  } catch {
    if (signal?.aborted) throw new DOMException(failure, 'AbortError');
    invalid();
  }
}
const admin = () => uuid(getAdminFinancialSessionToken());
export function getArchiveReexportInventory(signal?: AbortSignal): Promise<ArchiveReexportInventory> {
  return request(() => supabase.rpc('get_employee_archive_reexport_inventory', { p_admin_session_token: admin() }), validateArchiveReexportInventory, signal);
}
export function createArchiveReexportSession(sourceSiteId: string, packageId: string, expected?: ArchiveReexportSnapshot,
  transport: typeof fetch = globalThis.fetch): { source: ArchivesExportSource; media: ArchiveMediaSession } {
  uuid(sourceSiteId); uuid(packageId);
  let snapshot = expected === undefined ? null : validateArchiveReexportSnapshot(expected);
  if (snapshot && (snapshot.catalog.site_id !== sourceSiteId || snapshot.catalog.package_id !== packageId)) invalid();
  let busy = false, inventory: ArchiveMediaInventory | null = null;
  const downloaded = new Set<string>(), checked = new Set<string>();
  const args = () => ({ p_admin_session_token: admin(), p_source_site_id: sourceSiteId, p_package_id: packageId });
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (busy) invalid(); busy = true;
    try { checkAbort(signal); const result = await operation(); checkAbort(signal); return result; }
    catch { if (signal?.aborted) throw new DOMException(failure, 'AbortError'); invalid(); }
    finally { busy = false; }
  };
  const loadSnapshot = async (signal?: AbortSignal) => {
    const next = await request(() => supabase.rpc('get_employee_archive_reexport_catalog', args()), validateArchiveReexportSnapshot, signal);
    if (next.catalog.site_id !== sourceSiteId || next.catalog.package_id !== packageId) invalid();
    if (snapshot) equal(next, snapshot); else snapshot = next;
    return validateArchiveReexportSnapshot(snapshot);
  };
  const current = () => { if (!snapshot) invalid(); return snapshot; };
  const verify = (signal?: AbortSignal) => request(() => supabase.rpc('get_employee_archive_reexport_verify', {
    ...args(), p_snapshot_hash: current().snapshot_hash,
  }), validateArchivesVerification, signal);
  const loadMedia = async (signal?: AbortSignal) => {
    const next = await request(() => supabase.rpc('get_employee_archive_reexport_media', {
      ...args(), p_snapshot_hash: current().snapshot_hash,
    }), value => validateArchiveMediaInventory(value, 'export'), signal);
    equal(next.archives_catalog, current().catalog);
    if (!next.verified || next.files.some(ref => ref.file === null)) invalid();
    if (inventory) equal(next, inventory); else inventory = next;
    return next;
  };
  const readFile = async (ref: ArchiveMediaReference, signal?: AbortSignal) => {
    if (!ref.file) invalid();
    await verify(signal);
    const blob = await readArchiveMedia({ source_site_id: sourceSiteId, package_id: packageId,
      event_id: ref.event_id, ref_key: ref.ref_key }, signal, transport);
    checkAbort(signal);
    const bytes = new Uint8Array(await withSignal(() => blob.arrayBuffer(), signal));
    try {
      if (bytes.length !== ref.file.bytes || blob.type !== ref.file.content_type
        || new Sha256().update(bytes).digestHex() !== ref.file.sha256) invalid();
      await verify(signal);
      return { file: { ...ref.file }, bytes };
    } catch (error) { bytes.fill(0); throw error; }
  };
  const unsupported = async (): Promise<never> => invalid();
  return {
    source: {
      catalog: signal => exclusive(async () => (await loadSnapshot(signal)).catalog, signal),
      page: (key, after, signal) => exclusive(() => {
        archivesTableKey(key); if (after !== null) archivesCursor(key, after);
        return request(() => supabase.rpc('get_employee_archive_reexport_page', { ...args(), p_snapshot_hash: current().snapshot_hash,
          p_table_key: key, p_after: after, p_limit: ARCHIVES_TRANSFER_LIMITS.maxPageRows }), value => validateArchivesPage(value, key, after), signal);
      }, signal),
      verify: signal => exclusive(() => verify(signal), signal),
    },
    media: {
      direction: 'export',
      inventory: signal => exclusive(() => loadMedia(signal), signal),
      status: signal => exclusive(() => loadMedia(signal), signal),
      bind: unsupported, upload: unsupported, recheckImport: unsupported,
      download: (input, signal) => exclusive(async () => {
        const available = await loadMedia(signal), ref = available.files.find(ref => ref.key === input.key);
        if (!ref) invalid(); equal(input, ref);
        const result = await readFile(ref, signal); downloaded.add(ref.key); return result;
      }, signal),
      recheckExport: (files: readonly ArchiveMediaFile[], signal) => exclusive(async () => {
        checked.clear();
        const available = await loadMedia(signal);
        equal(files, available.files.map(ref => ref.file));
        if (downloaded.size !== files.length) invalid();
        for (const ref of available.files) {
          const result = await readFile(ref, signal);
          result.bytes.fill(0); checked.add(ref.key);
        }
      }, signal),
      verify: signal => exclusive(async () => {
        const available = await loadMedia(signal);
        if (checked.size !== available.files.length || downloaded.size !== available.files.length) invalid();
        await verify(signal); return available;
      }, signal),
    },
  };
}
export async function exportTransferredArchiveBundles(
  prepare: (snapshot: ArchiveReexportSnapshot, index: number, total: number) => Promise<{
    file: ReplacementBackupFile; createWorkspace: ArchiveBundleWorkspaceFactory; info: VolumeInfo;
  }>, passphrase: string, options: ArchiveBundleOptions & {
    transport?: typeof fetch;
    onNamespace?: (progress: { completed: number; total: number; rows: number; files: number; bytes: number; fullSiteComplete: false }) => void;
  } = {},
): Promise<{ inventory: ArchiveReexportInventory; volumes: ArchiveBundleResult[]; fullSiteComplete: false }> {
  const inventory = await getArchiveReexportInventory(options.signal), baseline = JSON.stringify(inventory);
  const volumes: ArchiveBundleResult[] = [], ids = new Set<string>();
  let rows = 0, files = 0, bytes = 0;
  const progress = () => {
    checkAbort(options.signal);
    options.onNamespace?.({ completed: volumes.length, total: inventory.namespaces.length, rows, files, bytes, fullSiteComplete: false });
    checkAbort(options.signal);
  };
  progress();
  for (const expected of inventory.namespaces) {
    const prepared = await withSignal(() => prepare(validateArchiveReexportSnapshot(expected), volumes.length, inventory.namespaces.length), options.signal);
    const info = validateVolumeInfo(prepared.info);
    if (info.exportId !== expected.catalog.package_id || info.sourceSiteId !== expected.catalog.site_id || ids.has(info.volumeId)) invalid();
    ids.add(info.volumeId);
    const session = createArchiveReexportSession(expected.catalog.site_id, expected.catalog.package_id, expected, options.transport);
    const result = await exportArchiveBundle(session.source, session.media, prepared.file, prepared.createWorkspace, passphrase, info, options);
    volumes.push(result); rows += result.rows; files += result.files; bytes += result.bytes; progress();
  }
  const final = await getArchiveReexportInventory(options.signal);
  if (JSON.stringify(final) !== baseline) invalid();
  progress();
  return { inventory: validateArchiveReexportInventory(inventory), volumes, fullSiteComplete: false };
}
