import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { validateActivityCatalog, validateActivityRow } from './activityTransfer';
import { ARCHIVE_BUNDLE_CATALOG_PATH, inspectArchiveBundle, type ArchiveBundleResult, type ArchiveBundleWorkspace, type ArchiveBundleWorkspaceFactory } from './archiveBundle';
import { validateArchivesCatalog, validateArchivesRow } from './archiveTransfer';
import type { BrowserTransferDirectory } from './browserStorage';
import { validateChatCatalog, validateChatRow } from './chatTransfer';
import { inspectChatBundle } from './chatMedia';
import { MAX_CONTAINER_INPUT_BYTES, verifyEncryptedVolume, writeEncryptedVolume, type TransferEntry } from './container';
import { readTransferMetadata, type TransferByteSource } from './crypto';
import { dispatchTransferChecks, validateDispatchCatalog } from './dispatchTransfer';
import { validateFinanceCatalog, validateFinanceRow } from './financeTransfer';
import { validateIdentityCatalog, validateIdentityRow } from './identityTransfer';
import { validateManifest, type ManifestEntry, type VolumeInfo, type VolumeManifest } from './manifest';
import { inspectNotificationsBundle } from './notificationsMedia';
import { validateNotificationsCatalog, validateNotificationsRow } from './notificationsTransfer';
import { validateProductExportCatalog } from './productTransfer';
import type { ReplacementBackupFile } from './replacementBackup';
import { validateSharedExportCatalog } from './sharedExport';
import { Sha256 } from './sha256';
import { createSiteExportDrivers } from './siteExportApi';
import { validateSourceCutoff, type SourceCutoff } from './sourceCutover';
import { inspectVerificationBundle } from './verificationMedia';
import { validateVerificationCatalog, validateVerificationRow } from './verificationTransfer';

export const SITE_DOMAINS = ['shared', 'products', 'dispatch', 'identity', 'finance', 'activity', 'verification', 'notifications', 'chat', 'archives'] as const;
export type SiteDomain = typeof SITE_DOMAINS[number];
export interface SiteTransferProgress {
  domain: string; phase: string; completedDomains: number; totalDomains: number; rows: number; files: number; bytes: number;
}
export interface SiteExportDriver {
  domain: SiteDomain;
  begin(signal?: AbortSignal): Promise<unknown>;
  collect(workspace: ArchiveBundleWorkspace, onProgress: (value: { rows: number; bytes: number; files: number }) => void, signal?: AbortSignal): Promise<{
    catalog: unknown; entries: ManifestEntry[]; rows: number; bytes: number; files: number; media: unknown;
  }>;
  close(signal?: AbortSignal): Promise<unknown>;
  exportArchive?(file: ReplacementBackupFile, createWorkspace: ArchiveBundleWorkspaceFactory, passphrase: string, info: VolumeInfo,
    onProgress: (value: { phase: string; rows: number; bytes: number; files: number }) => void, signal?: AbortSignal): Promise<ArchiveBundleResult>;
}
export interface SiteTransferCapabilities {
  version: 1; site_id: string; export_protocol: 'site-bundle-set-v1'; can_export: boolean; can_import: false;
  import_blockers: string[]; missing_rpcs: string[];
}
export interface SiteVolumeReceipt {
  domain: SiteDomain | 'index'; filename: string; cipherBytes: number; cipherSha256: string; rows: number; files: number;
}
export interface SiteBundleResult {
  packageId: string; sourceSiteId: string; volumes: SiteVolumeReceipt[]; fullSiteComplete: false; importReady: false;
  sourceCutover?: SourceCutoff;
}
export interface AuthenticatedSiteDomain {
  catalog: unknown; media: unknown; manifest: VolumeManifest;
  workspace: ArchiveBundleWorkspace; file: ReplacementBackupFile; cipherSha256: string; cipherBytes: number;
}
export interface AuthenticatedSiteBundleSet {
  packageId: string; sourceSiteId: string; volumes: SiteVolumeReceipt[]; sourceCutover?: SourceCutoff;
  readDomain<T>(domain: SiteDomain, use: (value: AuthenticatedSiteDomain) => Promise<T>): Promise<T>;
}
interface SiteCatalog {
  site_id: string; tables: { key: string; rows: number; bytes: number; sha256?: string; row_hashes_sha256?: string }[];
  package_id?: string; identity_catalog?: unknown; finance_catalog?: unknown;
}
interface SiteSnapshot {
  version: 1; protocol: 'site-bundle-set-v1'; site_id: string; package_id: string;
  catalogs: Record<SiteDomain, SiteCatalog>; sha256: string; full_site_complete: false; import_ready: false;
  source_cutover?: SourceCutoff;
}
interface SavedVolume { receipt: SiteVolumeReceipt; file: ReplacementBackupFile; manifest: VolumeManifest }
interface IndexedVolume extends SiteVolumeReceipt { volumeId: string }
interface IndexDocument {
  version: 1; protocol: 'site-bundle-set-v1'; snapshot: SiteSnapshot; volumes: IndexedVolume[];
  full_site_complete: false; import_ready: false;
}
interface RunOptions { signal?: AbortSignal; onProgress?: (value: SiteTransferProgress) => void }
const PROTOCOL = 'site-bundle-set-v1';
const INDEX_PATH = 'data/site-index.ndjson';
const INDEX_FILE = 'site-index.edx';
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_CIPHER_BYTES = 1101 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const { object, uuid, hash, count, checkAbort, withSignal } = dispatchTransferChecks;
const sha = (raw: Uint8Array) => new Sha256().update(raw).digestHex();
const stable = (value: unknown): string => JSON.stringify(value, (_, item: unknown) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  }
  return item;
});
function invalid(): never { throw new Error('Site transfer set is incomplete, changed or unsupported. No import or business release was performed.'); }
function same(actual: unknown, expected: unknown): void { if (stable(actual) !== stable(expected)) invalid(); }
function filename(domain: SiteDomain): string { return `${String(SITE_DOMAINS.indexOf(domain) + 1).padStart(2, '0')}-${domain}.edx`; }
function metadataPath(domain: SiteDomain): string { return `data/site-${domain}.ndjson`; }
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length) invalid();
  return Array.from(value);
}
function validateCatalog(domain: SiteDomain, value: unknown): SiteCatalog {
  switch (domain) {
    case 'shared': return validateSharedExportCatalog(value);
    case 'products': return validateProductExportCatalog(value);
    case 'dispatch': return validateDispatchCatalog(value);
    case 'identity': return validateIdentityCatalog(value);
    case 'finance': return validateFinanceCatalog(value);
    case 'activity': return validateActivityCatalog(value);
    case 'verification': return validateVerificationCatalog(value);
    case 'notifications': return validateNotificationsCatalog(value);
    case 'chat': return validateChatCatalog(value);
    case 'archives': return validateArchivesCatalog(value);
  }
}
function validateSnapshot(value: unknown): SiteSnapshot {
  const hasCutover = value !== null && typeof value === 'object' && Object.hasOwn(value, 'source_cutover');
  const r = object(value, ['version', 'protocol', 'site_id', 'package_id', 'catalogs', 'sha256', 'full_site_complete', 'import_ready',
    ...(hasCutover ? ['source_cutover'] : [])]);
  const cutoff = hasCutover ? validateSourceCutoff(r.source_cutover) : undefined;
  if (r.version !== 1 || r.protocol !== PROTOCOL || r.full_site_complete !== false || r.import_ready !== false) invalid();
  const site = uuid(r.site_id), pkg = uuid(r.package_id), raw = object(r.catalogs, SITE_DOMAINS);
  if (cutoff && cutoff.site_id !== site) invalid();
  const catalogs = {} as Record<SiteDomain, SiteCatalog>;
  for (const domain of SITE_DOMAINS) {
    const catalog = validateCatalog(domain, raw[domain]);
    if (catalog.site_id !== site || (catalog.package_id !== undefined && catalog.package_id !== pkg)) invalid();
    catalogs[domain] = catalog;
  }
  for (const catalog of Object.values(catalogs)) {
    if (catalog.identity_catalog !== undefined) same(catalog.identity_catalog, catalogs.identity);
    if (catalog.finance_catalog !== undefined) same(catalog.finance_catalog, catalogs.finance);
  }
  return { version: 1, protocol: PROTOCOL, site_id: site, package_id: pkg, catalogs,
    sha256: hash(r.sha256), full_site_complete: false, import_ready: false,
    ...(cutoff ? { source_cutover: cutoff } : {}) };
}
async function rpc(name: 'get_employee_transfer_capabilities' | 'get_employee_export_site_snapshot' | 'get_employee_transfer_log',
  extra: Record<string, string | number> = {}, signal?: AbortSignal): Promise<unknown> {
  try {
    checkAbort(signal);
    const query = supabase.rpc(name, { p_admin_session_token: getAdminFinancialSessionToken(), ...extra });
    const result = await withSignal(() => signal ? query.abortSignal(signal) : query, signal);
    checkAbort(signal);
    if (result.error) invalid();
    return result.data;
  } catch { checkAbort(signal); throw new Error('Migration backend support or session could not be confirmed.'); }
}
export async function getSiteTransferCapabilities(signal?: AbortSignal): Promise<SiteTransferCapabilities> {
  const r = object(await rpc('get_employee_transfer_capabilities', {}, signal),
    ['version', 'site_id', 'export_protocol', 'can_export', 'can_import', 'import_blockers', 'missing_rpcs']);
  if (r.version !== 1 || r.export_protocol !== PROTOCOL || typeof r.can_export !== 'boolean' || r.can_import !== false) invalid();
  const strings = (value: unknown) => list(value, 256).map(item => {
    if (typeof item !== 'string' || item.length > 256) invalid();
    return item;
  });
  const missing = strings(r.missing_rpcs), blockers = strings(r.import_blockers);
  if (r.can_export !== (missing.length === 0) || !blockers.length) invalid();
  return { version: 1, site_id: uuid(r.site_id), export_protocol: PROTOCOL, can_export: r.can_export,
    can_import: false, import_blockers: blockers, missing_rpcs: missing };
}
async function snapshot(packageId: string, signal?: AbortSignal): Promise<SiteSnapshot> {
  const result = validateSnapshot(await rpc('get_employee_export_site_snapshot', { p_package_id: packageId }, signal));
  if (result.package_id !== packageId) invalid();
  return result;
}
export async function getSiteTransferHistory(signal?: AbortSignal): Promise<Array<{
  id: string; kind: string; status: string; startedAt: string; finishedAt: string | null;
}>> {
  const raw = await rpc('get_employee_transfer_log', { p_limit: 100 }, signal);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const events = list((raw as Record<string, unknown>).events, 100);
  return events.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const event = value as Record<string, unknown>;
    if (typeof event.action !== 'string' || !/^[a-z_]{1,100}$/.test(event.action)
      || (event.kind !== 'import' && event.kind !== 'export') || typeof event.occurred_at !== 'string'
      || !Number.isFinite(Date.parse(event.occurred_at))) invalid();
    return { id: `${uuid(event.job_id)}:${String(event.id)}`, kind: event.kind,
      status: event.action.endsWith('_finished') ? 'finished' : event.action.endsWith('_cancelled') ? 'cancelled'
        : event.action.endsWith('_begin') ? 'running' : event.action.includes('verified') ? 'verified' : 'unknown',
      startedAt: event.occurred_at, finishedAt: event.occurred_at };
  });
}
export async function stopSiteExportTask(adminPassword: string, confirmation: string, signal?: AbortSignal): Promise<{ cancelled: boolean }> {
  try {
    if (confirmation !== '確認停止導出任務') invalid();
    const raw = await rpc('get_employee_transfer_log', { p_limit: 1 }, signal);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
    const running = (raw as Record<string, unknown>).running;
    if (running === null) return { cancelled: false };
    if (!running || typeof running !== 'object' || Array.isArray(running)) invalid();
    const job = running as Record<string, unknown>;
    if (job.kind !== 'export') invalid();
    const jobId = uuid(job.id);
    const query = supabase.rpc('employee_export_stop_owned', { p_admin_session_token: getAdminFinancialSessionToken(),
      p_admin_password: adminPassword, p_job_id: jobId, p_confirmation: confirmation });
    const { data, error } = await withSignal(() => signal ? query.abortSignal(signal) : query, signal);
    checkAbort(signal);
    if (error || !data || data.success !== true || data.job_id !== jobId || data.scope !== 'export-task'
      || data.full_site_complete !== false || typeof data.cancelled !== 'boolean') invalid();
    return { cancelled: data.cancelled };
  } catch { checkAbort(signal); throw new Error('Export stop could not be confirmed. Recheck server task status before another attempt.'); }
  finally { adminPassword = ''; }
}
function progress(options: RunOptions, domain: string, phase: string, completedDomains: number,
  value = { rows: 0, files: 0, bytes: 0 }): void {
  checkAbort(options.signal);
  options.onProgress?.({ domain, phase, completedDomains, totalDomains: SITE_DOMAINS.length,
    rows: value.rows, files: value.files, bytes: value.bytes });
  checkAbort(options.signal);
}
async function* scanned(source: TransferByteSource, state: { bytes: number; digest: Sha256 }, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let ended = false;
  try {
    for (;;) {
      const next = await withSignal(() => iterator.next(), signal);
      checkAbort(signal);
      if (next.done) { ended = true; break; }
      if (!(next.value instanceof Uint8Array) || next.value.length > MAX_CONTAINER_INPUT_BYTES) invalid();
      const raw = new Uint8Array(next.value);
      state.bytes += raw.length;
      if (state.bytes > MAX_CIPHER_BYTES) invalid();
      state.digest.update(raw);
      yield raw;
    }
  } finally {
    if (!ended) { try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* A blocked source must not delay cancellation. */ } }
  }
}
async function authenticate(file: ReplacementBackupFile, passphrase: string, workspace: ArchiveBundleWorkspace,
  signal?: AbortSignal, info?: VolumeInfo): Promise<{ manifest: VolumeManifest; cipherBytes: number; cipherSha256: string }> {
  const metadata = info ? { exportId: info.exportId, volumeId: info.volumeId } : await readTransferMetadata(file.open(), signal);
  const state = { bytes: 0, digest: new Sha256() };
  const source = scanned(file.open(), state, signal);
  try {
    const manifest = await verifyEncryptedVolume(source, passphrase, workspace, {
      signal, expectedMetadata: metadata,
      limits: { maxLineBytes: MAX_METADATA_BYTES },
    });
    if (info) same({ ...info, version: 1, entries: manifest.entries }, manifest);
    return { manifest, cipherBytes: state.bytes, cipherSha256: state.digest.digestHex() };
  } finally { void source.return(undefined).catch(() => undefined); }
}
async function readSmall(workspace: ArchiveBundleWorkspace, path: string, signal?: AbortSignal): Promise<string> {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for await (const raw of workspace.open(path)) {
    checkAbort(signal); bytes += raw.length;
    if (bytes > MAX_METADATA_BYTES) invalid();
    parts.push(new Uint8Array(raw));
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }
  return decoder.decode(joined);
}
async function writeMetadata(workspace: ArchiveBundleWorkspace, path: string, value: unknown, signal?: AbortSignal): Promise<ManifestEntry> {
  const raw = encoder.encode(JSON.stringify(value) + '\n');
  if (raw.length > MAX_METADATA_BYTES) invalid();
  for (let offset = 0; offset < raw.length; offset += MAX_CONTAINER_INPUT_BYTES) {
    await workspace.append(path, raw.slice(offset, offset + MAX_CONTAINER_INPUT_BYTES), signal);
    checkAbort(signal);
  }
  return { path, kind: 'ndjson', bytes: raw.length, sha256: sha(raw) };
}
function tablePath(domain: SiteDomain, key: string): string {
  return domain === 'products' ? 'data/products.ndjson' : `data/${domain === 'verification' ? 'verification' : domain}-${key}.ndjson`;
}
async function validateTable(workspace: ArchiveBundleWorkspace, path: string, domain: SiteDomain,
  table: SiteCatalog['tables'][number], signal?: AbortSignal): Promise<void> {
  let rows = 0, bytes = 0, used = 0;
  const line = new Uint8Array(64 * 1024), hashes = new Sha256(), digest = new Sha256();
  for await (const chunk of workspace.open(path)) {
    checkAbort(signal); bytes += chunk.length;
    if (bytes > table.bytes || chunk.length > MAX_CONTAINER_INPUT_BYTES) invalid();
    digest.update(chunk);
    for (const byte of chunk) {
      if (used === line.length) invalid();
      line[used++] = byte;
      if (byte !== 10) continue;
      const raw = line.subarray(0, used), text = decoder.decode(raw);
      hashes.update(encoder.encode(sha(raw))); rows++;
      switch (domain) {
        case 'identity': validateIdentityRow(text, table.key as Parameters<typeof validateIdentityRow>[1]); break;
        case 'finance': validateFinanceRow(text, table.key as Parameters<typeof validateFinanceRow>[1]); break;
        case 'activity': validateActivityRow(text, table.key as Parameters<typeof validateActivityRow>[1]); break;
        case 'verification': validateVerificationRow(text, table.key as Parameters<typeof validateVerificationRow>[1]); break;
        case 'notifications': validateNotificationsRow(text, table.key as Parameters<typeof validateNotificationsRow>[1]); break;
        case 'chat': validateChatRow(text, table.key as Parameters<typeof validateChatRow>[1]); break;
        case 'archives': validateArchivesRow(text, table.key as Parameters<typeof validateArchivesRow>[1]); break;
      }
      if (rows > table.rows) invalid();
      used = 0;
    }
  }
  if (used || rows !== table.rows || bytes !== table.bytes || (table.sha256 && digest.digestHex() !== table.sha256)
    || (table.row_hashes_sha256 && hashes.digestHex() !== table.row_hashes_sha256)) invalid();
}
async function validateDomain(workspace: ArchiveBundleWorkspace, domain: SiteDomain, manifest: VolumeManifest,
  baseline: SiteSnapshot, signal?: AbortSignal): Promise<void> {
  const catalog = baseline.catalogs[domain], expectedPaths = new Set(catalog.tables.map(t => tablePath(domain, t.key)));
  if (domain === 'archives') {
    same(validateArchivesCatalog(JSON.parse(await readSmall(workspace, ARCHIVE_BUNDLE_CATALOG_PATH, signal))), catalog);
    await inspectArchiveBundle(workspace, manifest, { signal });
    return;
  } else {
    const path = metadataPath(domain);
    expectedPaths.add(path);
    const r = object(JSON.parse(await readSmall(workspace, path, signal)),
      ['version', 'protocol', 'domain', 'package_id', 'site_id', 'snapshot_hash', 'catalog', 'media', 'full_site_complete', 'import_ready']);
    if (r.version !== 1 || r.protocol !== PROTOCOL || r.domain !== domain || r.package_id !== baseline.package_id
      || r.site_id !== baseline.site_id || r.snapshot_hash !== baseline.sha256 || r.full_site_complete !== false || r.import_ready !== false) invalid();
    same(validateCatalog(domain, r.catalog), catalog);
    if (domain === 'verification' || domain === 'notifications' || domain === 'chat') {
      const payload = validateManifest({ ...manifest, entries: manifest.entries.filter(entry => entry.path !== path) });
      const files = { open: (name: string) => workspace.open(name), paths: () => payload.entries.map(entry => entry.path),
        abort: (reason: unknown) => workspace.abort(reason) };
      const input = { catalog: r.catalog, media: r.media, manifest: payload };
      if (domain === 'verification') await inspectVerificationBundle(input, files, { signal });
      else if (domain === 'notifications') await inspectNotificationsBundle(input, files, { signal });
      else await inspectChatBundle(input, files, { signal });
      return;
    }
    if (r.media !== null) invalid();
  }
  if (manifest.entries.length !== expectedPaths.size || manifest.entries.some(e => !expectedPaths.has(e.path))) invalid();
  for (const table of catalog.tables) {
    const path = tablePath(domain, table.key), entry = manifest.entries.find(e => e.path === path);
    if (!entry || entry.kind !== 'ndjson' || entry.bytes !== table.bytes) invalid();
    await validateTable(workspace, path, domain, table, signal);
  }
}
function volumeInfo(baseline: SiteSnapshot): VolumeInfo {
  return { exportId: baseline.package_id, sourceSiteId: baseline.site_id, volumeId: crypto.randomUUID(),
    createdAt: new Date().toISOString(), scope: 'replacement-backup', volumeIndex: 1, volumeCount: 1 };
}
async function save(workspace: ArchiveBundleWorkspace, entries: ManifestEntry[], file: ReplacementBackupFile,
  info: VolumeInfo, passphrase: string, signal?: AbortSignal): Promise<{ cipherBytes: number; cipherSha256: string }> {
  async function* payloads(): AsyncGenerator<TransferEntry> {
    for (const entry of entries) yield { path: entry.path, bytes: entry.bytes, open: () => workspace.open(entry.path) };
  }
  const state = { bytes: 0, digest: new Sha256() };
  const stream = scanned(writeEncryptedVolume(payloads(), info, passphrase, { signal, limits: { maxLineBytes: MAX_METADATA_BYTES } }), state, signal);
  try { await file.write(stream, signal); checkAbort(signal); }
  finally { void stream.return(undefined).catch(() => undefined); }
  return { cipherBytes: state.bytes, cipherSha256: state.digest.digestHex() };
}
export async function exportSiteBundleSet(options: RunOptions & {
  adminPassword: string; passphrase: string; directory: BrowserTransferDirectory;
  createWorkspace: ArchiveBundleWorkspaceFactory; beforeDomain?: () => Promise<void>;
}): Promise<SiteBundleResult> {
  let password = options.adminPassword, passphrase = options.passphrase;
  const spaces = new Set<ArchiveBundleWorkspace>();
  const workspace = () => {
    const space = options.createWorkspace();
    if (spaces.has(space)) invalid();
    spaces.add(space); return space;
  };
  const saved: SavedVolume[] = [], indexed: IndexedVolume[] = [];
  let phase = 'preflight', current = 'site';
  let outcome: SiteBundleResult | undefined, failure: Error | undefined;
  try {
    progress(options, current, phase, 0);
    const capabilities = await getSiteTransferCapabilities(options.signal);
    if (!capabilities.can_export) invalid();
    const baseline = await snapshot(crypto.randomUUID(), options.signal);
    if (baseline.site_id !== capabilities.site_id) invalid();
    const drivers = createSiteExportDrivers(baseline.package_id, password);
    password = '';
    same(drivers.map(driver => driver.domain), SITE_DOMAINS);
    for (const driver of drivers) {
      await options.beforeDomain?.(); checkAbort(options.signal);
      current = driver.domain; phase = 'begin'; progress(options, current, phase, saved.length);
      same(validateCatalog(driver.domain, await driver.begin(options.signal)), baseline.catalogs[driver.domain]);
      const file = options.directory.createFile(filename(driver.domain)), info = volumeInfo(baseline);
      let result: { manifest: VolumeManifest; cipherBytes: number; cipherSha256: string; rows: number; files: number };
      if (driver.domain === 'archives') {
        if (!driver.exportArchive) invalid();
        result = await driver.exportArchive(file, workspace, passphrase, info,
          value => { phase = value.phase; progress(options, current, phase, saved.length, value); }, options.signal);
      } else {
        const data = workspace(); phase = 'records';
        const collected = await driver.collect(data, value => progress(options, current, phase, saved.length, value), options.signal);
        same(validateCatalog(driver.domain, collected.catalog), baseline.catalogs[driver.domain]);
        const metadata = await writeMetadata(data, metadataPath(driver.domain), {
          version: 1, protocol: PROTOCOL, domain: driver.domain, package_id: baseline.package_id, site_id: baseline.site_id,
          snapshot_hash: baseline.sha256, catalog: collected.catalog, media: collected.media, full_site_complete: false, import_ready: false,
        }, options.signal);
        const entries = [...collected.entries, metadata];
        phase = 'save'; progress(options, current, phase, saved.length, collected);
        const written = await save(data, entries, file, info, passphrase, options.signal);
        await data.abort(new Error('Encrypted export saved; discard plaintext.'));
        phase = 'authenticate'; progress(options, current, phase, saved.length, collected);
        const readback = workspace();
        const verified = await authenticate(file, passphrase, readback, options.signal, info);
        same(verified.manifest.entries, entries); same(written, { cipherBytes: verified.cipherBytes, cipherSha256: verified.cipherSha256 });
        await validateDomain(readback, driver.domain, verified.manifest, baseline, options.signal);
        await readback.abort(new Error('Independent saved-file readback complete.'));
        result = { ...verified, rows: collected.rows, files: collected.files };
      }
      phase = 'close'; progress(options, current, phase, saved.length);
      await driver.close(options.signal); checkAbort(options.signal);
      const receipt: SiteVolumeReceipt = { domain: driver.domain, filename: filename(driver.domain),
        cipherBytes: result.cipherBytes, cipherSha256: result.cipherSha256, rows: result.rows, files: result.files };
      saved.push({ receipt, file, manifest: result.manifest }); indexed.push({ ...receipt, volumeId: info.volumeId });
    }
    current = 'site'; phase = 'recheck'; progress(options, current, phase, saved.length);
    same(await snapshot(baseline.package_id, options.signal), baseline);
    for (const volume of saved) {
      const state = { bytes: 0, digest: new Sha256() };
      for await (const raw of scanned(volume.file.open(), state, options.signal)) void raw;
      if (state.bytes !== volume.receipt.cipherBytes || state.digest.digestHex() !== volume.receipt.cipherSha256) invalid();
    }
    const index: IndexDocument = { version: 1, protocol: PROTOCOL, snapshot: baseline, volumes: indexed, full_site_complete: false, import_ready: false };
    const data = workspace(), info = volumeInfo(baseline), file = options.directory.createFile(INDEX_FILE);
    const entry = await writeMetadata(data, INDEX_PATH, index, options.signal);
    phase = 'save-index'; progress(options, 'index', phase, saved.length);
    const written = await save(data, [entry], file, info, passphrase, options.signal);
    await data.abort(new Error('Encrypted index saved; discard plaintext.'));
    const readback = workspace(), verified = await authenticate(file, passphrase, readback, options.signal, info);
    same(verified.manifest.entries, [entry]);
    same(JSON.parse(await readSmall(readback, INDEX_PATH, options.signal)), index);
    same(written, { cipherBytes: verified.cipherBytes, cipherSha256: verified.cipherSha256 });
    await readback.abort(new Error('Index readback complete.'));
    const receipt: SiteVolumeReceipt = { domain: 'index', filename: INDEX_FILE, ...written, rows: 0, files: 0 };
    saved.push({ receipt, file, manifest: verified.manifest });
    outcome = { packageId: baseline.package_id, sourceSiteId: baseline.site_id,
      volumes: saved.map(item => ({ ...item.receipt })), fullSiteComplete: false, importReady: false,
      ...(baseline.source_cutover ? { sourceCutover: structuredClone(baseline.source_cutover) } : {}) };
  } catch {
    failure = options.signal?.aborted ? new DOMException('Site export cancelled; reconcile saved files and server task.', 'AbortError')
      : new Error(`Site export stopped during ${phase}. Keep saved files and reconcile the active server task. No automatic cancellation or rollback was performed.`);
  } finally { password = ''; passphrase = ''; }
  let cleanupFailed = false;
  for (const space of spaces) { try { await space.abort(new Error('Site transfer plaintext discarded.')); } catch { cleanupFailed = true; } }
  if (cleanupFailed) throw new Error('Site transfer plaintext cleanup could not be confirmed. Do not reuse its workspace.');
  if (failure) throw failure;
  checkAbort(options.signal);
  progress(options, 'site', 'complete', SITE_DOMAINS.length);
  return outcome!;
}
function validateIndex(value: unknown): IndexDocument {
  const r = object(value, ['version', 'protocol', 'snapshot', 'volumes', 'full_site_complete', 'import_ready']);
  if (r.version !== 1 || r.protocol !== PROTOCOL || r.full_site_complete !== false || r.import_ready !== false) invalid();
  const baseline = validateSnapshot(r.snapshot), volumes = list(r.volumes, SITE_DOMAINS.length);
  if (volumes.length !== SITE_DOMAINS.length) invalid();
  const ids = new Set<string>();
  const checked = volumes.map((value, index): IndexedVolume => {
    const v = object(value, ['domain', 'filename', 'cipherBytes', 'cipherSha256', 'rows', 'files', 'volumeId']);
    const domain = SITE_DOMAINS[index], volumeId = uuid(v.volumeId);
    if (v.domain !== domain || v.filename !== filename(domain) || ids.has(volumeId)) invalid();
    ids.add(volumeId);
    const rows = baseline.catalogs[domain].tables.reduce((n, t) => n + t.rows, 0);
    if (v.rows !== rows) invalid();
    return { domain, filename: filename(domain), volumeId, rows, files: count(v.files, 3000),
      cipherBytes: count(v.cipherBytes, MAX_CIPHER_BYTES), cipherSha256: hash(v.cipherSha256) };
  });
  return { version: 1, protocol: PROTOCOL, snapshot: baseline, volumes: checked, full_site_complete: false, import_ready: false };
}
function fromFile(file: File): ReplacementBackupFile {
  return {
    async write() { throw new Error('Inspection cannot write files.'); },
    open: () => (async function* () {
      for (let offset = 0; offset < file.size; offset += MAX_CONTAINER_INPUT_BYTES) {
        yield new Uint8Array(await file.slice(offset, offset + MAX_CONTAINER_INPUT_BYTES).arrayBuffer());
      }
    })(),
  };
}
export async function withAuthenticatedSiteBundleSet<T>(
  files: File[], passphrase: string, createWorkspace: ArchiveBundleWorkspaceFactory,
  consumeBundle: (bundle: AuthenticatedSiteBundleSet) => Promise<T>, options: RunOptions = {},
): Promise<T> {
  const selected = files.slice(), spaces = new Set<ArchiveBundleWorkspace>();
  let active = true, busy = false;
  const fresh = () => {
    checkAbort(options.signal);
    const space = createWorkspace();
    if (spaces.has(space)) invalid();
    spaces.add(space);
    return space;
  };
  let outcome: T | undefined, failed = false, failure: unknown;
  try {
    const inspected = await inspectSiteBundleSet(selected, passphrase, fresh, options);
    const byName = new Map(selected.map(file => [file.name, file]));
    const indexSpace = fresh(), indexFile = byName.get(INDEX_FILE)!;
    const verified = await authenticate(fromFile(indexFile), passphrase, indexSpace, options.signal);
    const indexReceipt = inspected.volumes.find(volume => volume.domain === 'index')!;
    if (verified.cipherSha256 !== indexReceipt.cipherSha256 || verified.cipherBytes !== indexReceipt.cipherBytes) invalid();
    const index = validateIndex(JSON.parse(await readSmall(indexSpace, INDEX_PATH, options.signal)));
    await indexSpace.abort(new Error('Authenticated import index discarded.'));
    const baseline = index.snapshot;
    const bundle: AuthenticatedSiteBundleSet = {
      packageId: inspected.packageId, sourceSiteId: inspected.sourceSiteId,
      volumes: inspected.volumes.map(volume => ({ ...volume })),
      ...(baseline.source_cutover ? { sourceCutover: structuredClone(baseline.source_cutover) } : {}),
      async readDomain(domain, consume) {
        if (!active || busy) invalid();
        const expected = index.volumes.find(volume => volume.domain === domain);
        if (!expected) invalid();
        checkAbort(options.signal); busy = true;
        let result: Awaited<ReturnType<typeof consume>> | undefined;
        let readFailed = false, readFailure: unknown;
        const space = fresh();
        try {
          const file = fromFile(byName.get(expected.filename)!);
          const readback = await authenticate(file, passphrase, space, options.signal);
          const manifest = validateManifest(readback.manifest);
          if (manifest.exportId !== baseline.package_id || manifest.sourceSiteId !== baseline.site_id
            || manifest.volumeId !== expected.volumeId || manifest.scope !== 'replacement-backup'
            || manifest.volumeIndex !== 1 || manifest.volumeCount !== 1
            || readback.cipherSha256 !== expected.cipherSha256 || readback.cipherBytes !== expected.cipherBytes) invalid();
          await validateDomain(space, domain, manifest, baseline, options.signal);
          let media: unknown = null;
          if (domain !== 'archives') {
            const metadata = JSON.parse(await readSmall(space, metadataPath(domain), options.signal)) as Record<string, unknown>;
            media = metadata.media;
          }
          const payload = domain === 'archives' ? manifest : validateManifest({ ...manifest,
            entries: manifest.entries.filter(entry => entry.path !== metadataPath(domain)) });
          checkAbort(options.signal);
          result = await consume({ catalog: structuredClone(baseline.catalogs[domain]), media,
            manifest: payload, workspace: space, file, cipherSha256: readback.cipherSha256, cipherBytes: readback.cipherBytes });
          checkAbort(options.signal);
        } catch (error) { readFailed = true; readFailure = error; }
        let cleanupFailed = false;
        try { await space.abort(new Error('Authenticated import domain discarded.')); }
        catch { cleanupFailed = true; }
        busy = false;
        if (cleanupFailed) throw new Error('Import input plaintext cleanup could not be confirmed.');
        if (readFailed) throw readFailure;
        return result!;
      },
    };
    outcome = await consumeBundle(bundle);
    checkAbort(options.signal);
  } catch (error) { failed = true; failure = error; }
  finally { active = false; passphrase = ''; }
  let cleanupFailed = false;
  for (const space of spaces) {
    try { await space.abort(new Error('Import input plaintext discarded.')); }
    catch { cleanupFailed = true; }
  }
  if (cleanupFailed) throw new Error('Import input plaintext cleanup could not be confirmed.');
  if (failed) throw failure;
  checkAbort(options.signal);
  return outcome!;
}
export async function inspectSiteBundleSet(files: File[], passphrase: string, createWorkspace: ArchiveBundleWorkspaceFactory,
  options: RunOptions = {}): Promise<SiteBundleResult> {
  const spaces = new Set<ArchiveBundleWorkspace>();
  const workspace = () => { const space = createWorkspace(); if (spaces.has(space)) invalid(); spaces.add(space); return space; };
  let outcome: SiteBundleResult | undefined, failure: Error | undefined;
  try {
    checkAbort(options.signal);
    if (files.length !== SITE_DOMAINS.length + 1) invalid();
    const byName = new Map<string, File>();
    for (const file of files) {
      if (byName.has(file.name) || ![INDEX_FILE, ...SITE_DOMAINS.map(filename)].includes(file.name)
        || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_CIPHER_BYTES) invalid();
      byName.set(file.name, file);
    }
    const indexFile = byName.get(INDEX_FILE); if (!indexFile) invalid();
    progress(options, 'index', 'authenticate', 0);
    const indexSpace = workspace(), verifiedIndex = await authenticate(fromFile(indexFile), passphrase, indexSpace, options.signal);
    if (verifiedIndex.manifest.entries.length !== 1 || verifiedIndex.manifest.entries[0].path !== INDEX_PATH) invalid();
    const index = validateIndex(JSON.parse(await readSmall(indexSpace, INDEX_PATH, options.signal))), baseline = index.snapshot;
    if (verifiedIndex.manifest.exportId !== baseline.package_id || verifiedIndex.manifest.sourceSiteId !== baseline.site_id) invalid();
    await indexSpace.abort(new Error('Authenticated index inspected.'));
    const volumes: SiteVolumeReceipt[] = [];
    for (const expected of index.volumes) {
      const domain = expected.domain; if (domain === 'index') invalid();
      progress(options, domain, 'authenticate', volumes.length);
      const file = byName.get(expected.filename); if (!file || file.size !== expected.cipherBytes) invalid();
      const space = workspace(), result = await authenticate(fromFile(file), passphrase, space, options.signal);
      const manifest = validateManifest(result.manifest);
      if (manifest.exportId !== baseline.package_id || manifest.sourceSiteId !== baseline.site_id || manifest.volumeId !== expected.volumeId
        || manifest.scope !== 'replacement-backup' || manifest.volumeIndex !== 1 || manifest.volumeCount !== 1
        || result.cipherBytes !== expected.cipherBytes || result.cipherSha256 !== expected.cipherSha256
        || manifest.entries.filter(e => e.kind === 'media').length !== expected.files) invalid();
      progress(options, domain, 'validate', volumes.length, { rows: expected.rows, files: expected.files, bytes: file.size });
      await validateDomain(space, domain, manifest, baseline, options.signal);
      await space.abort(new Error('Authenticated domain inspected.'));
      volumes.push({ domain, filename: expected.filename, cipherBytes: expected.cipherBytes,
        cipherSha256: expected.cipherSha256, rows: expected.rows, files: expected.files });
    }
    volumes.push({ domain: 'index', filename: INDEX_FILE, cipherBytes: verifiedIndex.cipherBytes,
      cipherSha256: verifiedIndex.cipherSha256, rows: 0, files: 0 });
    outcome = { packageId: baseline.package_id, sourceSiteId: baseline.site_id, volumes, fullSiteComplete: false, importReady: false };
  } catch {
    failure = options.signal?.aborted ? new DOMException('Inspection cancelled.', 'AbortError')
      : new Error('The selected encrypted files could not be confirmed as a complete, matching domain set. No database writes were performed.');
  } finally { passphrase = ''; }
  let cleanupFailed = false;
  for (const space of spaces) { try { await space.abort(new Error('Inspection plaintext discarded.')); } catch { cleanupFailed = true; } }
  if (cleanupFailed) throw new Error('Inspection plaintext cleanup could not be confirmed.');
  if (failure) throw failure;
  checkAbort(options.signal);
  progress(options, 'site', 'complete', SITE_DOMAINS.length);
  return outcome!;
}
