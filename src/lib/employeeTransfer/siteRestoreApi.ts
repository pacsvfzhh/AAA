import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import type { Database } from '../../types/database';
import { createActivityImportSession } from './activityApi';
import { stageActivityImport } from './activityTransfer';
import { createDispatchImportSession, createProductsImportSession, createSharedSettingsReplacementSession, getTransferMaintenance } from './api';
import { createArchivesImportSession, createArchivesRestoreSession } from './archiveApi';
import { importArchiveBundle, type ArchiveBundleWorkspace, type ArchiveBundleWorkspaceFactory } from './archiveBundle';
import { createArchiveMediaSession } from './archiveMedia';
import { validateArchivesCatalog } from './archiveTransfer';
import type { BrowserTransferDirectory } from './browserStorage';
import { createChatImportSession } from './chatApi';
import { createChatBackup } from './chatBackup';
import { createChatMediaSession, stageChatBundle, validateChatMediaCatalog } from './chatMedia';
import { createChatMergeSession, validateChatMergeDecisions, type ChatMergeDecision } from './chatMergeApi';
import { createChatRestoreSession } from './chatRestoreApi';
import { validateChatCatalog, type ChatPlan } from './chatTransfer';
import { createDispatchDependencySession } from './dependencyApi';
import { createDispatchBackup } from './dispatchBackup';
import { stageDispatchImport } from './dispatchImport';
import { dispatchTransferChecks } from './dispatchTransfer';
import { createFinanceImportSession } from './financeApi';
import { stageFinanceImport } from './financeTransfer';
import { createIdentityImportSession } from './identityApi';
import { IDENTITY_TABLE_KEYS, IDENTITY_TRANSFER_LIMITS, identityEntryPath, stageIdentityImport, validateIdentityCatalog, validateIdentityRow, type IdentityCatalog } from './identityTransfer';
import { createNotificationsImportSession } from './notificationsApi';
import { createNotificationsBackup } from './notificationsBackup';
import { createNotificationConfigurationSession } from './notificationsConfigurationApi';
import { createNotificationsMediaSession, stageNotificationsBundle, type NotificationsMediaFile } from './notificationsMedia';
import { createNotificationsRestoreSession } from './notificationsRestoreApi';
import { validateNotificationsCatalog } from './notificationsTransfer';
import { createProductBackup } from './productBackup';
import { stageProductsImport, validateProductExportCatalog } from './productTransfer';
import { createReplacementBackup, type ReplacementBackupFile } from './replacementBackup';
import { validateSharedExportCatalog } from './sharedExport';
import { stageSharedSettingsImport } from './sharedImport';
import { Sha256 } from './sha256';
import type { ManifestEntry } from './manifest';
import { SITE_DOMAINS, type AuthenticatedSiteBundleSet, type AuthenticatedSiteDomain, type SiteDomain } from './siteTransfer';
import { createVerificationImportSession } from './verificationApi';
import { createVerificationMediaSession, stageVerificationBundle, type VerificationMediaFile } from './verificationMedia';

export type SiteRestoreVerification = Database['public']['Functions']['employee_import_site_verify']['Returns'];

export interface SiteRestoreOptions {
  adminPassword: string;
  passphrase: string;
  directory: BrowserTransferDirectory;
  createWorkspace: ArchiveBundleWorkspaceFactory;
  approvePlan: (domain: SiteDomain, plan: unknown) => Promise<boolean>;
  chooseChatRoles: (plan: ChatPlan) => Promise<ChatMergeDecision[]>;
  signal?: AbortSignal;
  onProgress?: (progress: { domain: string; phase: string; rows: number; files: number; bytes: number }) => void;
  beforeDomain?: () => Promise<void>;
}

const { object, uuid, hash, count, checkAbort } = dispatchTransferChecks;
const backupNames = {
  shared: 'backup-shared.edx', products: 'backup-products.edx', dispatch: 'backup-dispatch.edx',
  notifications: 'backup-notifications.edx', chat: 'backup-chat.edx',
} as const;
function blocked(): never {
  throw new Error('Site restore is blocked or unconfirmed. Reconcile the server task and saved backups before any explicit recovery; rerunning is not resumption.');
}
function requireRestore(plan: { can_restore: boolean; conflicts: readonly unknown[] }): void {
  if (plan.can_restore !== true || plan.conflicts.length !== 0) blocked();
}
function uuidMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) blocked();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) blocked();
  const record = object(value, keys as string[]);
  return Object.fromEntries((keys as string[]).map(key => [uuid(key), uuid(record[key])]));
}
function total(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, value) => sum + count(value), 0);
}
function validateSiteVerification(value: unknown, jobId: string, sourceSiteId: string, packageId: string): SiteRestoreVerification {
  const r = object(value, ['version', 'success', 'scope', 'job_id', 'source_site_id', 'package_id', 'verification_hash',
    'verified_domains', 'counts', 'maintenance', 'accounts_active', 'automation_resumed', 'can_release', 'full_site_complete']);
  if (r.version !== 1 || r.success !== true || r.scope !== 'site-restore-verification'
    || uuid(r.job_id) !== jobId || uuid(r.source_site_id) !== sourceSiteId || uuid(r.package_id) !== packageId
    || r.maintenance !== true || r.accounts_active !== false || r.automation_resumed !== false
    || r.can_release !== false || r.full_site_complete !== false
    || typeof r.verification_hash !== 'string' || r.verification_hash.length !== 64) blocked();
  const domains = r.verified_domains;
  if (!Array.isArray(domains) || Object.getPrototypeOf(domains) !== Array.prototype
    || domains.length !== SITE_DOMAINS.length || Reflect.ownKeys(domains).length !== SITE_DOMAINS.length + 1) blocked();
  for (const [index, name] of SITE_DOMAINS.entries()) {
    const field = Object.getOwnPropertyDescriptor(domains, String(index));
    if (!field?.enumerable || !('value' in field) || field.value !== name) blocked();
  }
  const counts = object(r.counts, ['employees', 'pending_withdrawals', 'pending_withdrawal_amount']);
  const amount = counts.pending_withdrawal_amount;
  // Keep the original decimal string; financial precision must not pass through Number or parseFloat.
  if (typeof amount !== 'string' || amount.trim() !== amount || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amount)) blocked();
  return { version: 1, success: true, scope: 'site-restore-verification', job_id: jobId, source_site_id: sourceSiteId,
    package_id: packageId, verification_hash: hash(r.verification_hash), verified_domains: [...SITE_DOMAINS],
    counts: { employees: count(counts.employees), pending_withdrawals: count(counts.pending_withdrawals), pending_withdrawal_amount: amount },
    maintenance: true, accounts_active: false, automation_resumed: false, can_release: false, full_site_complete: false };
}

// Redacted public context; retain BOTH operation and cleanup failures without logging their contents.
class SiteRestoreError extends Error {
  constructor(
    readonly domain: string, readonly phase: string, readonly jobId: string | null,
    readonly verifiedDomains: SiteDomain[], readonly cleanupRequired: boolean, errors: unknown[],
  ) {
    super('Site restore stopped. Writes or sealed backups may already exist; reconcile the task before explicit recovery. '
      + 'No automatic retry, cancellation, rollback, account activation or maintenance release was performed. '
      + (cleanupRequired ? 'Temporary plaintext cleanup was not confirmed. ' : '')
      + 'This is not a completed full-site restore.');
    this.name = 'SiteRestoreError';
    Object.defineProperty(this, 'originalErrors', { value: errors, enumerable: false });
  }
}

// Admission and complete input authentication belong to siteImport; this is not a resume path.
export async function runSiteRestore(
  bundle: AuthenticatedSiteBundleSet, options: SiteRestoreOptions,
): Promise<{
  jobId: string; verifiedDomains: SiteDomain[]; maintenance: true; fullSiteComplete: false; importReady: false;
  serverVerification: SiteRestoreVerification;
}> {
  const settings = { ...options };
  const signal = settings.signal;
  let password = settings.adminPassword, passphrase = settings.passphrase;
  // Do not retain a second password/passphrase copy in the callback configuration.
  settings.adminPassword = ''; settings.passphrase = '';
  let domain: string = 'site', phase = 'prepare', jobId: string | null = null;
  const verified = new Set<SiteDomain>();
  let serverVerification: SiteRestoreVerification | null = null;
  const inputSpaces = new Set<ArchiveBundleWorkspace>();
  const spaces: { original: ArchiveBundleWorkspace; workspace: ArchiveBundleWorkspace; discard: () => Promise<void> }[] = [];
  const files = new Set<ReplacementBackupFile>();
  const usedBackupNames = new Set<string>();
  const errors: unknown[] = [];
  let failed = false, cleanupRequired = false;
  const step = async <T>(operation: () => PromiseLike<T>): Promise<T> => {
    checkAbort(signal);
    const result = await operation();
    checkAbort(signal);
    return result;
  };
  const report = (name: string, values: { rows?: number; files?: number; bytes?: number } = {}) => {
    checkAbort(signal);
    phase = name;
    settings.onProgress?.({ domain, phase, rows: count(values.rows ?? 0), files: count(values.files ?? 0), bytes: count(values.bytes ?? 0) });
    checkAbort(signal);
  };
  const progress = (value: { phase: string; rows?: number; files?: number; bytes: number }) => report(value.phase, value);
  const backupProgress = (value: { phase: string; bytes: number }) => report(`backup-${value.phase}`, { bytes: value.bytes });
  const approve = async (name: SiteDomain, plan: unknown) => {
    // Never give an application callback the plan snapshot used for authorization.
    const approved = await step(() => settings.approvePlan(name, structuredClone(plan)));
    if (approved !== true) blocked();
  };
  const freshWorkspace = (): ArchiveBundleWorkspace => {
    checkAbort(signal);
    const original = settings.createWorkspace();
    if (inputSpaces.has(original) || spaces.some(item => item.original === original || item.workspace === original)) blocked();
    let cleanup: Promise<void> | undefined;
    const discard = () => cleanup ??= Promise.resolve().then(() => original.abort(new Error('Site restore temporary plaintext discarded.')));
    const workspace: ArchiveBundleWorkspace = {
      open: path => { checkAbort(signal); return original.open(path); },
      append: (path, raw, writeSignal) => step(() => original.append(path, raw, writeSignal)),
      // Cleanup must really run, and must still be awaited after cancellation.
      abort: discard,
    };
    spaces.push({ original, workspace, discard });
    checkAbort(signal);
    return workspace;
  };
  const verifyPrerequisites = async (token: string) => {
    report('verify-prerequisites');
    const receipt = await step(async () => {
      const query = supabase.rpc('employee_import_site_verify_prerequisites', {
        p_admin_session_token: getAdminFinancialSessionToken(), p_job_token: token,
      });
      const result = await (signal ? query.abortSignal(signal) : query);
      if (result.error) blocked();
      return object(result.data, ['success', 'scope', 'verified', 'maintenance', 'full_site_complete']);
    });
    if (receipt.success !== true || receipt.scope !== 'site-prerequisites' || receipt.verified !== true
      || receipt.maintenance !== true || receipt.full_site_complete !== false) blocked();
  };
  const backupFile = (name: keyof typeof backupNames): ReplacementBackupFile => {
    checkAbort(signal);
    const filename = backupNames[name];
    if (usedBackupNames.has(filename)) blocked();
    usedBackupNames.add(filename);
    const file = settings.directory.createFile(filename);
    if (files.has(file)) blocked();
    files.add(file);
    let attempted = false;
    checkAbort(signal);
    return {
      write: (source, writeSignal) => step(() => {
        if (attempted) blocked();
        attempted = true;
        return file.write(source, writeSignal);
      }),
      open: () => { checkAbort(signal); return file.open(); },
    };
  };
  const readDomain = async <T>(name: SiteDomain, use: (input: AuthenticatedSiteDomain) => Promise<T>): Promise<T> => {
    checkAbort(signal); domain = name; report('prepare');
    if (settings.beforeDomain) await step(() => settings.beforeDomain!());
    return step(() => bundle.readDomain(name, async (input: AuthenticatedSiteDomain) => {
      checkAbort(signal);
      if (input.manifest.exportId !== packageId || input.manifest.sourceSiteId !== sourceSiteId
        || files.has(input.file) || inputSpaces.has(input.workspace)
        || spaces.some(item => item.original === input.workspace || item.workspace === input.workspace)) blocked();
      inputSpaces.add(input.workspace); files.add(input.file);
      const result = await step(() => use(input));
      checkAbort(signal);
      return result;
    })); // The authenticated bundle owner, not a stage helper, discards this input workspace.
  };
  const inputFiles = (input: AuthenticatedSiteDomain) => ({
    open: (path: string) => { checkAbort(signal); return input.workspace.open(path); },
    paths: () => input.manifest.entries.map((entry: ManifestEntry) => entry.path),
    async abort() { /* readDomain owns the real cleanup; media rechecks still need the immutable bytes. */ },
  });
  const markVerified = (name: SiteDomain, values: { rows: number; files?: number; bytes: number }) => {
    checkAbort(signal); verified.add(name); report('verified', values);
  };
  let packageId = '', sourceSiteId = '';
  try {
    checkAbort(signal);
    packageId = uuid(bundle.packageId); sourceSiteId = uuid(bundle.sourceSiteId);

    await readDomain('shared', async input => {
      const catalog = validateSharedExportCatalog(input.catalog);
      const session = createSharedSettingsReplacementSession(packageId, password);
      const staged = await step(() => stageSharedSettingsImport(catalog, {
        open: key => { checkAbort(signal); return input.workspace.open(`data/shared-${key}.ndjson`); },
      }, session.target, { signal, onProgress: progress }));
      if (staged.dryRun.can_apply !== true || staged.dryRun.conflicts.length) blocked();
      await approve('shared', staged.dryRun);
      report('backup-prepare');
      const backup = await step(() => session.backup(signal));
      const identity = session.identity();
      if (!identity || backup.descriptor.backup_id !== identity.jobId || backup.descriptor.plan_hash !== staged.dryRun.plan_hash) blocked();
      jobId = uuid(identity.jobId);
      await step(() => createReplacementBackup(backup.descriptor, backup.source, freshWorkspace(), backupFile('shared'),
        backup.receiver, passphrase, { signal, onProgress: backupProgress }));
      report('apply');
      const receipt = object(await step(() => session.apply(staged.dryRun.plan_hash, signal)),
        ['success', 'scope', 'full_site_complete', 'repeated', 'backup_id', 'admin_map', 'admin_group_map', 'created_admins', 'replaced_admins']);
      if (receipt.success !== true || receipt.scope !== 'shared-settings' || receipt.full_site_complete !== false
        || typeof receipt.repeated !== 'boolean' || receipt.backup_id !== identity.jobId) blocked();
      const adminMap = uuidMap(receipt.admin_map), groupMap = uuidMap(receipt.admin_group_map);
      if (Object.keys(adminMap).length !== catalog.tables.find(table => table.key === 'admins')!.rows
        || Object.keys(groupMap).length !== catalog.tables.find(table => table.key === 'admin_groups')!.rows) blocked();
      count(receipt.created_admins, Object.keys(adminMap).length); count(receipt.replaced_admins, Object.keys(adminMap).length);
      report('close-applied-shared');
      // Shared replacement has no close API. SQL12 preserves its applied same-package summary on cancel.
      // This is only after a validated apply receipt, never in finally and never for dispatch/dirty maintenance.
      const cancelled = await step(async () => {
        const query = supabase.rpc('employee_transfer_cancel', {
          p_admin_session_token: getAdminFinancialSessionToken(), p_job_token: identity.jobToken,
        });
        const result = await (signal ? query.abortSignal(signal) : query);
        checkAbort(signal);
        if (result.error) blocked();
        return object(result.data, ['success', 'cancelled']);
      });
      if (cancelled.success !== true || cancelled.cancelled !== true) blocked();
      markVerified('shared', staged);
    });

    await readDomain('products', async input => {
      const catalog = validateProductExportCatalog(input.catalog);
      const session = createProductsImportSession(packageId, password);
      const staged = await step(() => stageProductsImport(catalog, inputFiles(input), session.target, { signal, onProgress: progress }));
      const identity = session.identity();
      if (!identity) blocked();
      jobId = uuid(identity.jobId);
      if (staged.dryRun.can_apply !== true || staged.dryRun.conflicts.length) blocked();
      await approve('products', staged.dryRun);
      report('backup-prepare');
      const backup = await step(() => session.backup(signal));
      if (backup.descriptor.plan_hash !== staged.dryRun.plan_hash) blocked();
      await step(() => createProductBackup(backup.descriptor, backup.source, freshWorkspace(), backupFile('products'),
        backup.receiver, passphrase, { signal, onProgress: backupProgress }));
      report('apply');
      const receipt = object(await step(() => session.apply(staged.dryRun.plan_hash, signal)),
        ['success', 'scope', 'full_site_complete', 'product_map', 'repeated']);
      if (receipt.success !== true || receipt.scope !== 'product-catalog' || receipt.full_site_complete !== false
        || typeof receipt.repeated !== 'boolean' || Object.keys(uuidMap(receipt.product_map)).length !== catalog.tables[0].rows) blocked();
      report('close');
      const closed = object(await step(() => session.close(signal)), ['success', 'scope', 'full_site_complete']);
      if (closed.success !== true || closed.scope !== 'product-catalog' || closed.full_site_complete !== false) blocked();
      markVerified('products', staged);
    });

    const dispatch = await readDomain('dispatch', async input => {
      const session = createDispatchImportSession(packageId, password);
      const staged = await step(() => stageDispatchImport(input.catalog, inputFiles(input), session.target, { signal, onProgress: progress }));
      const identity = session.identity();
      if (!identity) blocked();
      jobId = uuid(identity.jobId);
      await approve('dispatch', staged.dryRun); // can_apply=false is the preparation protocol, not permission to bypass it.
      report('backup-prepare');
      const backup = await step(() => session.backup(signal));
      if (backup.descriptor.plan_hash !== staged.dryRun.plan_hash) blocked();
      await step(() => createDispatchBackup(backup.descriptor, backup.source, freshWorkspace(), backupFile('dispatch'),
        backup.receiver, passphrase, { signal, onProgress: backupProgress }));
      report('enter-maintenance');
      await step(() => session.enterMaintenance(staged.dryRun.plan_hash, '確認暫停業務並導入派單資料', password, signal));
      await verifyPrerequisites(identity.jobToken);
      report('configuration-plan');
      const plan = await step(() => session.configurationPlan(signal));
      if (plan.can_apply_configuration !== true || plan.conflicts.length || plan.preparation_plan_hash !== staged.dryRun.plan_hash) blocked();
      await approve('dispatch', plan);
      report('configuration-apply');
      await step(() => session.applyConfiguration(plan.plan_hash, signal));
      report('valid-begin');
      let current = await step(() => session.beginValidData(plan.plan_hash, signal));
      if (current.repeated || current.verified || current.next_chunk !== 0) blocked();
      while (current.next_chunk < current.chunks) {
        const next: number = current.next_chunk;
        report('valid-chunk', { rows: current.rows });
        current = await step(() => session.applyValidDataChunk(next, signal));
        if (current.next_chunk !== next + 1) blocked();
      }
      report('valid-verify');
      const checked = await step(() => session.verifyValidData(signal));
      if (!checked.verified) blocked();
      // Dispatch is NOT verified until identity and the member/used-data dependency phase below pass.
      return { jobToken: uuid(identity.jobToken), rows: staged.rows, bytes: staged.bytes };
    });
    const token = dispatch.jobToken;

    const employeeIds = await readDomain('identity', async input => {
      const catalog = validateIdentityCatalog(input.catalog);
      const session = createIdentityImportSession(token);
      const staged = await step(() => stageIdentityImport(catalog, inputFiles(input), session.target, { signal, onProgress: progress }));
      requireRestore(staged.plan); // Same-name, UUID and employee-number conflicts stop; no archive/delete workaround.
      const entry = input.manifest.entries.find((entry: ManifestEntry) => entry.path === identityEntryPath('accounts'));
      if (!entry || entry.kind !== 'ndjson' || entry.bytes !== catalog.tables[0].bytes) blocked();
      const ids = await step(() => collectEmployeeIds(input.workspace, catalog, entry.sha256, signal));
      await approve('identity', staged.plan);
      report('begin');
      let current = await step(() => session.begin(staged.plan.plan_hash, signal));
      if (current.repeated || current.verified || total(current.next_chunks) !== 0) blocked();
      for (const key of IDENTITY_TABLE_KEYS) {
        while (current.next_chunks[key] < current.chunks[key]) {
          const next: number = current.next_chunks[key];
          report('chunk', { rows: total(current.counts) });
          current = await step(() => session.chunk(key, next, signal));
          if (current.next_chunks[key] !== next + 1) blocked();
        }
      }
      report('verify');
      const checked = await step(() => session.verify(signal));
      if (!checked.verified) blocked();
      markVerified('identity', staged);
      return ids;
    });

    domain = 'dispatch'; report('dependencies-plan');
    const dependencies = createDispatchDependencySession(token);
    const dependencyPlan = await step(() => dependencies.plan(signal));
    requireRestore(dependencyPlan);
    report('dependencies-begin');
    let dependencyReceipt = await step(() => dependencies.begin(dependencyPlan.plan_hash, signal));
    if (dependencyReceipt.repeated || dependencyReceipt.verified || total(dependencyReceipt.next_chunks) !== 0) blocked();
    for (const key of ['dispatch_group_members', 'used_order_data'] as const) {
      while (dependencyReceipt.next_chunks[key] < dependencyReceipt.chunks[key]) {
        const next: number = dependencyReceipt.next_chunks[key];
        report('dependencies-chunk', { rows: total(dependencyReceipt.counts) });
        dependencyReceipt = await step(() => dependencies.chunk(key, next, signal));
        if (dependencyReceipt.next_chunks[key] !== next + 1) blocked();
      }
    }
    report('dependencies-verify');
    const checkedDependencies = await step(() => dependencies.verify(signal));
    if (!checkedDependencies.verified) blocked();
    markVerified('dispatch', dispatch);

    await readDomain('finance', async input => {
      const session = createFinanceImportSession(token);
      const staged = await step(() => stageFinanceImport(input.catalog, inputFiles(input), session.target, { signal, onProgress: progress }));
      requireRestore(staged.plan);
      if (staged.plan.employees !== employeeIds.length) blocked();
      await approve('finance', staged.plan);
      for (const id of employeeIds) {
        report('apply');
        await step(() => session.apply(id, staged.plan.plan_hash, signal));
      }
      report('verify');
      const checked = await step(() => session.verify(signal));
      if (checked.verified !== true) blocked();
      markVerified('finance', staged);
    });

    await readDomain('activity', async input => {
      const session = createActivityImportSession(token);
      const staged = await step(() => stageActivityImport(input.catalog, inputFiles(input), session.target, { signal, onProgress: progress }));
      requireRestore(staged.plan);
      if (staged.plan.employees !== employeeIds.length) blocked();
      await approve('activity', staged.plan);
      for (const id of employeeIds) {
        report('apply');
        await step(() => session.apply(id, staged.plan.plan_hash, signal));
      }
      report('verify');
      const checked = await step(() => session.verify(signal));
      if (checked.verified !== true) blocked();
      markVerified('activity', staged);
    });

    await readDomain('verification', async input => {
      const session = createVerificationImportSession(token), media = createVerificationMediaSession(token, 'import');
      const retainedMedia: unknown = structuredClone(input.media);
      const staged = await step(() => stageVerificationBundle({ catalog: input.catalog, media: retainedMedia, manifest: input.manifest },
        inputFiles(input), session.target, media, { signal, onProgress: progress }));
      requireRestore(staged.plan);
      if (staged.plan.employees !== employeeIds.length || !Array.isArray(retainedMedia)) blocked();
      // stageVerificationBundle validated every tuple and the actual bytes of this private snapshot.
      const mediaFiles = retainedMedia as VerificationMediaFile[];
      await approve('verification', staged.plan);
      for (const id of employeeIds) {
        report('apply');
        await step(() => session.apply(id, staged.plan.plan_hash, signal));
      }
      report('media-recheck', staged);
      await step(() => media.recheckImport(mediaFiles, signal));
      report('verify', staged);
      const checked = await step(() => session.verify(signal));
      if (checked.verified !== true) blocked();
      markVerified('verification', staged);
    });

    await readDomain('notifications', async input => {
      const catalog = validateNotificationsCatalog(input.catalog);
      const session = createNotificationsImportSession(token), media = createNotificationsMediaSession(token, 'import');
      const retainedMedia: unknown = structuredClone(input.media);
      const staged = await step(() => stageNotificationsBundle({ catalog, media: retainedMedia, manifest: input.manifest },
        inputFiles(input), session.target, media, { signal, onProgress: progress }));
      if (staged.plan.conflicts.length || !Array.isArray(retainedMedia)) blocked();
      const mediaFiles = retainedMedia as NotificationsMediaFile[]; // Validated by the successful stage above.
      report('configuration-plan');
      const configuration = createNotificationConfigurationSession(token, catalog);
      const plan = await step(() => configuration.plan(signal));
      if (plan.can_prepare_backup !== true || plan.conflicts.length) blocked();
      await approve('notifications', plan);
      report('backup-prepare');
      const backup = await step(() => configuration.backup(plan.plan_hash, signal));
      await step(() => createNotificationsBackup(backup.descriptor, backup.source, freshWorkspace(), backupFile('notifications'),
        backup.receiver, passphrase, { signal, onProgress: backupProgress }));
      const restore = createNotificationsRestoreSession(token, catalog);
      report('begin');
      let current = await step(() => restore.begin(plan.plan_hash, signal));
      if (current.repeated || current.verified || current.next_chunk !== 0) blocked();
      while (current.next_chunk < current.total_chunks) {
        const next: number = current.next_chunk;
        report('chunk', { rows: total(current.counts), files: staged.files });
        current = await step(() => restore.chunk(next, signal));
        if (current.next_chunk !== next + 1) blocked();
      }
      report('media-recheck', staged);
      await step(() => media.recheckImport(mediaFiles, signal));
      report('verify', staged);
      const checked = await step(() => restore.verify(signal));
      if (checked.verified !== true || checked.stage !== 'done') blocked();
      markVerified('notifications', staged);
    });

    await readDomain('chat', async input => {
      const catalog = validateChatCatalog(input.catalog), retainedMedia = validateChatMediaCatalog(input.media);
      const session = createChatImportSession(token), media = createChatMediaSession(token, 'import');
      const staged = await step(() => stageChatBundle({ catalog, media: retainedMedia, manifest: input.manifest },
        inputFiles(input), session.target, media, { signal, onProgress: progress }));
      if (staged.plan.conflicts.length) blocked();
      report('choose-roles');
      const decisions = validateChatMergeDecisions(await step(() => settings.chooseChatRoles(structuredClone(staged.plan))));
      const merge = createChatMergeSession(token, catalog);
      report('merge-plan');
      const plan = await step(() => merge.plan(structuredClone(decisions), signal));
      if (plan.can_prepare_backup !== true || plan.conflicts.length) blocked();
      await approve('chat', plan);
      report('backup-prepare');
      const backup = await step(() => merge.backup(plan.plan_hash, structuredClone(decisions), signal));
      await step(() => createChatBackup(backup.descriptor, backup.source, freshWorkspace(), backupFile('chat'),
        backup.receiver, passphrase, { signal, onProgress: backupProgress }));
      const restore = createChatRestoreSession(token, catalog);
      report('begin');
      let current = await step(() => restore.begin(plan.plan_hash, signal));
      if (current.repeated || current.verified || current.next_chunk !== 0) blocked();
      while (current.next_chunk < current.total_chunks) {
        const next: number = current.next_chunk;
        report('chunk', { rows: total(current.counts), files: staged.files });
        current = await step(() => restore.chunk(next, signal));
        if (current.next_chunk !== next + 1) blocked();
      }
      report('media-recheck', staged);
      await step(() => media.recheckImport(retainedMedia.files, signal));
      report('verify', staged);
      const checked = await step(() => restore.verify(signal));
      if (checked.verified !== true || checked.stage !== 'done' || checked.media_pending !== false) blocked();
      markVerified('chat', staged);
    });

    await readDomain('archives', async input => {
      const catalog = validateArchivesCatalog(input.catalog);
      report('authenticate');
      const result = await step(() => importArchiveBundle(input.file, passphrase,
        { exportId: input.manifest.exportId, volumeId: input.manifest.volumeId }, freshWorkspace, {
          records: createArchivesImportSession(token), restore: createArchivesRestoreSession(token, catalog),
          media: createArchiveMediaSession(token, 'import'),
        }, { signal, onProgress: progress, approvePlan: async plan => { await approve('archives', plan); return true; },
          expectedSource: { catalog, cipherSha256: input.cipherSha256, cipherBytes: input.cipherBytes } }));
      if (result.recordsVerified !== true || result.mediaVerified !== true || result.fullSiteComplete !== false) blocked();
      markVerified('archives', result);
    });

    domain = 'site';
    await verifyPrerequisites(token);
    report('verify-site');
    if (jobId === null) blocked();
    const verification = await step(async () => {
      const query = supabase.rpc('employee_import_site_verify', {
        p_admin_session_token: getAdminFinancialSessionToken(), p_job_token: token,
      });
      const result = await (signal ? query.abortSignal(signal) : query);
      checkAbort(signal);
      if (result.error) blocked();
      return result.data;
    });
    serverVerification = validateSiteVerification(verification, jobId, sourceSiteId, packageId);
    if (serverVerification.counts.employees !== employeeIds.length) blocked();
    report('verify-maintenance');
    const maintenance = await step(() => getTransferMaintenance(signal));
    if (verified.size !== SITE_DOMAINS.length || !maintenance.active || !maintenance.dirty || maintenance.job_id !== jobId) blocked();
  } catch (error) { failed = true; errors.push(error); }
  finally {
    password = ''; passphrase = '';
    // Only local plaintext is cleaned here. NEVER cancel a server job or release maintenance in finally.
    for (const space of spaces) {
      try { await space.discard(); }
      catch (error) { cleanupRequired = true; errors.push(error); }
    }
  }
  if (failed || cleanupRequired || signal?.aborted || jobId === null || serverVerification === null) {
    throw new SiteRestoreError(domain, phase, jobId, SITE_DOMAINS.filter(name => verified.has(name)), cleanupRequired, errors);
  }
  try { checkAbort(signal); report('maintenance'); }
  catch (error) { throw new SiteRestoreError(domain, phase, jobId, SITE_DOMAINS.filter(name => verified.has(name)), false, [error]); }
  return { jobId, verifiedDomains: SITE_DOMAINS.filter(name => verified.has(name)), maintenance: true,
    fullSiteComplete: false, importReady: false, serverVerification };
}

// Reopen the already authenticated, staged accounts verbatim. Parse ONLY each UUID, never rewrite numeric JSON.
async function collectEmployeeIds(workspace: ArchiveBundleWorkspace, catalog: IdentityCatalog, expectedHash: string, signal?: AbortSignal): Promise<string[]> {
  checkAbort(signal);
  const table = catalog.tables.find(table => table.key === 'accounts');
  if (!table) blocked();
  const line = new Uint8Array(IDENTITY_TRANSFER_LIMITS.maxLineBytes), digest = new Sha256();
  const rowsDigest = new Sha256(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), encoder = new TextEncoder();
  const ids: string[] = [];
  let used = 0, bytes = 0, previous: string | null = null;
  const iterator = workspace.open(identityEntryPath('accounts'))[Symbol.asyncIterator]();
  let ended = false;
  try {
    for (;;) {
      checkAbort(signal);
      const next = await iterator.next();
      checkAbort(signal);
      if (next.done) { ended = true; break; }
      if (!(next.value instanceof Uint8Array) || next.value.length > IDENTITY_TRANSFER_LIMITS.maxInputBytes) blocked();
      const chunk = new Uint8Array(next.value);
      bytes += chunk.length;
      if (bytes > table.bytes) blocked();
      digest.update(chunk);
      let start = 0;
      while (start < chunk.length) {
        checkAbort(signal);
        const lf = chunk.indexOf(10, start), end = lf === -1 ? chunk.length : lf + 1;
        if (used + end - start > line.length) blocked();
        line.set(chunk.subarray(start, end), used); used += end - start; start = end;
        if (lf !== -1) {
          const raw = line.subarray(0, used), id = validateIdentityRow(decoder.decode(raw), 'accounts');
          if ((previous !== null && id <= previous) || ids.length >= table.rows) blocked();
          rowsDigest.update(encoder.encode(new Sha256().update(raw).digestHex()));
          ids.push(id); previous = id; used = 0;
        }
      }
    }
    if (used || bytes !== table.bytes || ids.length !== table.rows || rowsDigest.digestHex() !== table.row_hashes_sha256) blocked();
    // Check both the authenticated raw file hash and the ordered raw line hashes.
    if (digest.digestHex() !== expectedHash) blocked();
    checkAbort(signal);
    return ids;
  } finally {
    line.fill(0);
    if (!ended && iterator.return) await iterator.return();
  }
}
