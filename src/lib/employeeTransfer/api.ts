import { getAdminFinancialSessionToken } from '../auth';
import { formatSupabaseError, supabase } from '../supabase';
import { validateSharedExportCatalog, type SharedExportCatalog, type SharedExportSource } from './sharedExport';

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
