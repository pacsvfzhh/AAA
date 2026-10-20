import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { validateIdentityCatalog } from './identityTransfer';
import { runSiteRestore, type SiteRestoreOptions } from './siteRestoreApi';
import { withAuthenticatedSiteBundleSet, type SiteDomain, type SiteTransferProgress } from './siteTransfer';

const { object, uuid, checkAbort, withSignal } = dispatchTransferChecks;
const BLOCKERS = ['same_site', 'active_maintenance', 'active_transfer_task', 'target_has_business', 'missing_backend_support'] as const;
export interface SiteImportPreflight {
  version: 1; protocol: 'site-maintenance-restore-v1'; site_id: string; source_site_id: string;
  can_restore_to_maintenance: boolean; blockers: typeof BLOCKERS[number][]; missing_rpcs: string[];
  full_site_complete: false; can_release: false;
}
export interface SiteImportOptions extends Omit<SiteRestoreOptions, 'onProgress'> {
  files: File[]; confirmation: string;
  onProgress?: (progress: SiteTransferProgress) => void;
}
function blocked(): never {
  throw new Error('Site import prerequisites could not be confirmed. No activation or maintenance release was performed.');
}
export async function getSiteImportPreflight(sourceSiteId: string, signal?: AbortSignal): Promise<SiteImportPreflight> {
  try {
    const source = uuid(sourceSiteId);
    const query = supabase.rpc('get_employee_import_site_preflight', {
      p_admin_session_token: getAdminFinancialSessionToken(), p_source_site_id: source,
    });
    const { data, error } = await withSignal(() => signal ? query.abortSignal(signal) : query, signal);
    checkAbort(signal);
    if (error) blocked();
    const r = object(data, ['version', 'protocol', 'site_id', 'source_site_id', 'can_restore_to_maintenance',
      'blockers', 'missing_rpcs', 'full_site_complete', 'can_release']);
    if (r.version !== 1 || r.protocol !== 'site-maintenance-restore-v1' || r.source_site_id !== source
      || typeof r.can_restore_to_maintenance !== 'boolean' || r.full_site_complete !== false || r.can_release !== false
      || !Array.isArray(r.blockers) || !Array.isArray(r.missing_rpcs) || r.missing_rpcs.length > 256) blocked();
    const blockers = BLOCKERS.filter(code => (r.blockers as unknown[]).includes(code));
    if (JSON.stringify(blockers) !== JSON.stringify(r.blockers)) blocked();
    const missing = r.missing_rpcs.map(value => {
      if (typeof value !== 'string' || value.length > 256 || !/^public\.[a-z_]+\([a-z0-9_, ]*\)$/.test(value)) blocked();
      return value;
    });
    const site = uuid(r.site_id);
    if (new Set(missing).size !== missing.length || blockers.includes('missing_backend_support') !== (missing.length > 0)
      || blockers.includes('same_site') !== (site === source) || r.can_restore_to_maintenance !== (blockers.length === 0)) blocked();
    return { version: 1, protocol: 'site-maintenance-restore-v1', site_id: site, source_site_id: source,
      can_restore_to_maintenance: blockers.length === 0, blockers, missing_rpcs: missing, full_site_complete: false, can_release: false };
  } catch {
    checkAbort(signal);
    blocked();
  }
}
export async function importSiteBundleSetToMaintenance(options: SiteImportOptions): Promise<{
  jobId: string; verifiedDomains: SiteDomain[]; maintenance: true; fullSiteComplete: false; importReady: false;
}> {
  const settings = { ...options, files: options.files.slice() };
  if (settings.confirmation !== '確認導入員工資料' || typeof settings.approvePlan !== 'function'
    || typeof settings.chooseChatRoles !== 'function') blocked();
  const spaces = new Set<ReturnType<SiteRestoreOptions['createWorkspace']>>();
  const createWorkspace = () => {
    checkAbort(settings.signal);
    const space = settings.createWorkspace();
    if (spaces.has(space)) blocked();
    spaces.add(space);
    return space;
  };
  const verified = new Set<string>();
  try {
    return await withAuthenticatedSiteBundleSet(settings.files, settings.passphrase, createWorkspace, async bundle => {
      const preflight = await getSiteImportPreflight(bundle.sourceSiteId, settings.signal);
      if (!preflight.can_restore_to_maintenance) blocked();
      await bundle.readDomain('identity', async input => {
        if (validateIdentityCatalog(input.catalog).processing_orders !== 0) blocked();
      });
      return runSiteRestore(bundle, {
        adminPassword: settings.adminPassword, passphrase: settings.passphrase,
        directory: settings.directory, createWorkspace, approvePlan: settings.approvePlan,
        chooseChatRoles: settings.chooseChatRoles, signal: settings.signal, beforeDomain: settings.beforeDomain,
        onProgress: value => {
          if (value.phase === 'verified') verified.add(value.domain);
          settings.onProgress?.({ ...value, completedDomains: verified.size, totalDomains: 10 });
        },
      });
    }, { signal: settings.signal, onProgress: value => settings.onProgress?.({ ...value, phase: `input-${value.phase}` }) });
  } finally { settings.adminPassword = ''; settings.passphrase = ''; }
}
