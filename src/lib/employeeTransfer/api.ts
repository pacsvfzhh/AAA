import { getAdminFinancialSessionToken } from '../auth';
import { formatSupabaseError, supabase } from '../supabase';
import { validateSharedExportCatalog, type SharedExportCatalog, type SharedExportSource } from './sharedExport';
import type { SharedImportTarget } from './sharedImport';
import type { ReplacementBackupDescriptor, ReplacementBackupReceiver } from './replacementBackup';

export interface SharedImportSession {
  target: SharedImportTarget;
  apply(planHash: string, signal?: AbortSignal): Promise<unknown>;
  identity(): { jobId: string; jobToken: string } | null;
}

export interface SharedReplacementSession extends SharedImportSession {
  backup(signal?: AbortSignal): Promise<{
    descriptor: ReplacementBackupDescriptor;
    source: SharedExportSource;
    receiver: ReplacementBackupReceiver;
  }>;
}

export function createSharedSettingsImportSession(packageId: string, adminPassword: string): SharedImportSession {
  return createSharedImportSession(packageId, adminPassword, false);
}

export function createSharedSettingsReplacementSession(packageId: string, adminPassword: string): SharedReplacementSession {
  return createSharedImportSession(packageId, adminPassword, true);
}

function createSharedImportSession(packageId: string, adminPassword: string, replace: boolean): SharedReplacementSession {
  const session = getAdminFinancialSessionToken();
  let job: { jobId: string; jobToken: string } | null = null;
  let started = false;
  const args = () => {
    if (!job) throw new Error('The shared import task has not been confirmed by the server.');
    return { p_admin_session_token: session, p_job_token: job.jobToken };
  };
  return {
    identity: () => job && { ...job },
    target: {
      async begin(catalog, signal) {
        if (started) throw new Error('The import begin request cannot be retried automatically. Reconcile the task first.');
        started = true;
        try {
          const query = supabase.rpc(replace ? 'employee_import_shared_replace_begin' : 'employee_import_shared_begin', {
            p_admin_session_token: session, p_admin_password: adminPassword, p_package_id: packageId,
            p_catalog: { ...catalog },
          });
          const { data, error } = await (signal ? query.abortSignal(signal) : query);
          if (error) throw new Error(formatSupabaseError(error));
          const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!data || data.success !== true || data.scope !== 'shared-settings' || data.full_site_complete !== false
            || typeof data.job_id !== 'string' || !uuid.test(data.job_id)
            || typeof data.job_token !== 'string' || !uuid.test(data.job_token)) {
            throw new Error('Shared import task creation was not confirmed.');
          }
          job = { jobId: data.job_id, jobToken: data.job_token };
          return { success: true, scope: 'shared-settings', full_site_complete: false };
        } finally { adminPassword = ''; }
      },
      async stage(key, chunkNo, ndjson, signal) {
        const query = supabase.rpc('employee_import_shared_stage', {
          ...args(), p_table_key: key, p_chunk_no: chunkNo, p_ndjson: ndjson,
        });
        const { data, error } = await (signal ? query.abortSignal(signal) : query);
        if (error) throw new Error(formatSupabaseError(error));
        return data;
      },
      async dryRun(signal) {
        const query = supabase.rpc(replace ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_shared_dry_run', args());
        const { data, error } = await (signal ? query.abortSignal(signal) : query);
        if (error) throw new Error(formatSupabaseError(error));
        return data;
      },
    },
    async apply(planHash, signal) {
      const query = supabase.rpc(replace ? 'employee_import_shared_replace_apply' : 'employee_import_shared_apply', { ...args(), p_plan_hash: planHash });
      const { data, error } = await (signal ? query.abortSignal(signal) : query);
      if (error) throw new Error(formatSupabaseError(error));
      return data;
    },
    async backup(signal) {
      if (!replace) throw new Error('Create-only tasks do not permit replacement backups.');
      const readDescriptor = async (readSignal?: AbortSignal) => {
        const query = supabase.rpc('get_employee_import_shared_backup', args());
        const { data, error } = await (readSignal ? query.abortSignal(readSignal) : query);
        if (error) throw new Error(formatSupabaseError(error));
        if (!data || data.backup_id !== job?.jobId || typeof data.plan_hash !== 'string'
          || !/^[0-9a-f]{64}$/.test(data.plan_hash) || typeof data.target_hash !== 'string'
          || !/^[0-9a-f]{64}$/.test(data.target_hash)) throw new Error('Invalid replacement backup descriptor.');
        return { backup_id: data.backup_id as string, plan_hash: data.plan_hash, target_hash: data.target_hash,
          catalog: validateSharedExportCatalog(data.catalog) };
      };
      const descriptor = await readDescriptor(signal);
      return {
        descriptor: structuredClone(descriptor),
        source: {
          catalog: async () => structuredClone(descriptor.catalog),
          async page(key, after, readSignal) {
            const query = supabase.rpc('get_employee_import_shared_backup_page', {
              ...args(), p_table_key: key, p_after: after, p_limit: 200,
            });
            const { data, error } = await (readSignal ? query.abortSignal(readSignal) : query);
            if (error) throw new Error(formatSupabaseError(error));
            return data;
          },
          async verify(readSignal) {
            const current = await readDescriptor(readSignal);
            if (JSON.stringify(current) !== JSON.stringify(descriptor)) throw new Error('The frozen backup identity changed.');
            return { verified: true, scope: 'shared-settings', full_site_complete: false };
          },
        },
        receiver: {
          async append(chunkNo, hex, writeSignal) {
            const query = supabase.rpc('employee_import_shared_backup_append', {
              ...args(), p_plan_hash: descriptor.plan_hash, p_chunk_no: chunkNo, p_hex: hex,
            });
            const { data, error } = await (writeSignal ? query.abortSignal(writeSignal) : query);
            if (error) throw new Error(formatSupabaseError(error));
            if (!data || data.success !== true || typeof data.bytes !== 'number'
              || typeof data.sha256 !== 'string' || typeof data.repeated !== 'boolean') throw new Error('Invalid backup chunk acknowledgement.');
            return { success: true, bytes: data.bytes, sha256: data.sha256, repeated: data.repeated };
          },
          async seal(sha256, bytes, writeSignal) {
            const query = supabase.rpc('employee_import_shared_backup_seal', {
              ...args(), p_plan_hash: descriptor.plan_hash, p_sha256: sha256, p_bytes: bytes,
            });
            const { data, error } = await (writeSignal ? query.abortSignal(writeSignal) : query);
            if (error) throw new Error(formatSupabaseError(error));
            if (!data || data.success !== true || data.backup_id !== descriptor.backup_id || data.sha256 !== sha256
              || data.bytes !== bytes || data.full_site_complete !== false || typeof data.repeated !== 'boolean') {
              throw new Error('The encrypted replacement backup seal was not confirmed.');
            }
            return data;
          },
        },
      };
    },
  };
}

export interface SharedExportTask {
  jobId: string;
  jobToken: string;
  catalog: SharedExportCatalog;
  source: SharedExportSource;
}

export function createSharedExportSource(sessionToken: string, jobToken: string): SharedExportSource {
  const args = { p_admin_session_token: sessionToken, p_job_token: jobToken };
  return {
    async catalog(signal) {
      const query = supabase.rpc('get_employee_export_shared_catalog', args);
      const { data, error } = await (signal ? query.abortSignal(signal) : query);
      if (error) throw new Error(formatSupabaseError(error));
      return data;
    },
    async page(key, after, signal) {
      const query = supabase.rpc('get_employee_export_shared_page', {
        ...args, p_table_key: key, p_after: after, p_limit: 200,
      });
      const { data, error } = await (signal ? query.abortSignal(signal) : query);
      if (error) throw new Error(formatSupabaseError(error));
      return data;
    },
    async verify(signal) {
      const query = supabase.rpc('employee_export_shared_verify', args);
      const { data, error } = await (signal ? query.abortSignal(signal) : query);
      if (error) throw new Error(formatSupabaseError(error));
      return data;
    },
  };
}

export async function beginSharedSettingsExport(adminPassword: string, signal?: AbortSignal): Promise<SharedExportTask> {
  const session = getAdminFinancialSessionToken();
  const query = supabase.rpc('employee_export_shared_begin', {
    p_admin_session_token: session, p_admin_password: adminPassword,
  });
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw new Error(formatSupabaseError(error));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid shared export task response.');
  if (data.success !== true) throw new Error('Administrator password verification failed or the account is locked.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof data.job_id !== 'string' || !uuid.test(data.job_id)
    || typeof data.job_token !== 'string' || !uuid.test(data.job_token)) throw new Error('Invalid shared export task identity.');
  return {
    jobId: data.job_id, jobToken: data.job_token, catalog: validateSharedExportCatalog(data.catalog),
    source: createSharedExportSource(session, data.job_token),
  };
}
