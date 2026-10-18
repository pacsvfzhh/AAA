import { getAdminFinancialSessionToken } from '../auth';
import { formatSupabaseError, supabase } from '../supabase';
import { validateSharedExportCatalog, type SharedExportCatalog, type SharedExportSource } from './sharedExport';
import type { SharedImportTarget } from './sharedImport';
import type { ReplacementBackupDescriptor, ReplacementBackupReceiver } from './replacementBackup';
import {
  productTransferChecks, validateProductExportCatalog, validateProductVerification,
  type ProductExportCatalog, type ProductExportSource, type ProductImportTarget,
} from './productTransfer';
import type { ProductBackupDescriptor } from './productBackup';
import {
  dispatchTransferChecks, validateDispatchCatalog, validateDispatchVerification, validateDispatchPreflight,
  type DispatchExportCatalog, type DispatchExportSource, type DispatchPreflight,
} from './dispatchTransfer';

import { validateDispatchImportDryRun, type DispatchImportTarget } from './dispatchImport';
import type { DispatchBackupDescriptor } from './dispatchBackup';

export type DispatchConfigurationConflict = 'group_mapping_collision' | 'pool_mapping_collision' | 'reserved_retirement_name';
export interface DispatchConfigurationPlan {
  readonly scope: 'dispatch-configuration';
  readonly can_apply_configuration: boolean;
  readonly full_site_complete: false;
  readonly replacement_ready: false;
  readonly conflicts: readonly DispatchConfigurationConflict[];
  readonly group_map: Readonly<Record<string, string>>;
  readonly pool_map: Readonly<Record<string, string>>;
  readonly preparation_plan_hash: string;
  readonly plan_hash: string;
}
export interface DispatchConfigurationReceipt {
  readonly success: true;
  readonly scope: 'dispatch-configuration';
  readonly configuration_applied: true;
  readonly maintenance: true;
  readonly dependencies_pending: true;
  readonly replacement_ready: false;
  readonly full_site_complete: false;
  readonly repeated: boolean;
  readonly group_map: Readonly<Record<string, string>>;
  readonly pool_map: Readonly<Record<string, string>>;
}
export interface DispatchMaintenanceReceipt {
  readonly success: true; readonly maintenance: true; readonly dirty: false;
  readonly repeated: boolean; readonly full_site_complete: false;
}
export interface TransferMaintenance {
  readonly active: boolean; readonly job_id: string | null; readonly dirty: boolean; readonly full_site_complete: false;
}
export interface TransferMaintenanceLeaveReceipt {
  readonly success: true; readonly maintenance: false; readonly full_site_complete: false;
}
const ENTER_DISPATCH_MAINTENANCE = '確認暫停業務並導入派單資料';
const LEAVE_TRANSFER_MAINTENANCE = '確認取消尚未寫入的遷移';
function invalidDispatchConfiguration(): never { throw new Error('Invalid dispatch configuration or maintenance response.'); }

// Snapshot own data descriptors, never read response getters or re-read fields through a proxy.
// These validators intentionally have no container/crypto dependency.
function dispatchUuidMap(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidDispatchConfiguration();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) invalidDispatchConfiguration();
  const record = dispatchTransferChecks.object(value, keys as string[]);
  const copy: Record<string, string> = {};
  for (const key of keys as string[]) copy[dispatchTransferChecks.uuid(key)] = dispatchTransferChecks.uuid(record[key]);
  return Object.freeze(copy);
}
function dispatchConfigurationConflicts(value: unknown): readonly DispatchConfigurationConflict[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalidDispatchConfiguration();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || typeof length.value !== 'number'
    || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 1000001) invalidDispatchConfiguration();
  const keys = Array.from({ length: length.value }, (_, index) => String(index));
  const expected = new Set([...keys, 'length']);
  const own = Reflect.ownKeys(value);
  if (own.length !== expected.size || own.some(key => typeof key !== 'string' || !expected.has(key))) {
    invalidDispatchConfiguration();
  }
  const copy: DispatchConfigurationConflict[] = [];
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !('value' in field)) invalidDispatchConfiguration();
    const conflict: unknown = field.value;
    if (conflict !== 'group_mapping_collision' && conflict !== 'pool_mapping_collision' && conflict !== 'reserved_retirement_name') {
      invalidDispatchConfiguration();
    }
    copy.push(conflict);
  }
  return Object.freeze(copy);
}
export function validateDispatchConfigurationPlan(value: unknown): DispatchConfigurationPlan {
  const record = dispatchTransferChecks.object(value, ['scope', 'can_apply_configuration', 'full_site_complete',
    'replacement_ready', 'conflicts', 'group_map', 'pool_map', 'preparation_plan_hash', 'plan_hash']);
  if (record.scope !== 'dispatch-configuration' || typeof record.can_apply_configuration !== 'boolean'
    || record.full_site_complete !== false || record.replacement_ready !== false) invalidDispatchConfiguration();
  const conflicts = dispatchConfigurationConflicts(record.conflicts);
  if (record.can_apply_configuration !== (conflicts.length === 0)) invalidDispatchConfiguration();
  return Object.freeze({ scope: 'dispatch-configuration', can_apply_configuration: record.can_apply_configuration,
    full_site_complete: false, replacement_ready: false, conflicts,
    group_map: dispatchUuidMap(record.group_map), pool_map: dispatchUuidMap(record.pool_map),
    preparation_plan_hash: dispatchTransferChecks.hash(record.preparation_plan_hash), plan_hash: dispatchTransferChecks.hash(record.plan_hash) });
}
export function validateDispatchConfigurationReceipt(value: unknown): DispatchConfigurationReceipt {
  const record = dispatchTransferChecks.object(value, ['success', 'scope', 'configuration_applied', 'maintenance',
    'dependencies_pending', 'replacement_ready', 'full_site_complete', 'repeated', 'group_map', 'pool_map']);
  if (record.success !== true || record.scope !== 'dispatch-configuration' || record.configuration_applied !== true
    || record.maintenance !== true || record.dependencies_pending !== true || record.replacement_ready !== false
    || record.full_site_complete !== false || typeof record.repeated !== 'boolean') invalidDispatchConfiguration();
  return Object.freeze({ success: true, scope: 'dispatch-configuration', configuration_applied: true, maintenance: true,
    dependencies_pending: true, replacement_ready: false, full_site_complete: false, repeated: record.repeated,
    group_map: dispatchUuidMap(record.group_map), pool_map: dispatchUuidMap(record.pool_map) });
}
export function validateDispatchMaintenanceReceipt(value: unknown): DispatchMaintenanceReceipt {
  const record = dispatchTransferChecks.object(value, ['success', 'maintenance', 'dirty', 'repeated', 'full_site_complete']);
  if (record.success !== true || record.maintenance !== true || record.dirty !== false
    || typeof record.repeated !== 'boolean' || record.full_site_complete !== false) invalidDispatchConfiguration();
  return Object.freeze({ success: true, maintenance: true, dirty: false, repeated: record.repeated, full_site_complete: false });
}
export function validateTransferMaintenance(value: unknown): TransferMaintenance {
  const record = dispatchTransferChecks.object(value, ['active', 'job_id', 'dirty', 'full_site_complete']);
  if (typeof record.active !== 'boolean' || typeof record.dirty !== 'boolean' || record.full_site_complete !== false
    || (!record.active && (record.job_id !== null || record.dirty))) invalidDispatchConfiguration();
  return Object.freeze({ active: record.active, job_id: record.active ? dispatchTransferChecks.uuid(record.job_id) : null,
    dirty: record.dirty, full_site_complete: false });
}
export function validateTransferMaintenanceLeaveReceipt(value: unknown): TransferMaintenanceLeaveReceipt {
  const record = dispatchTransferChecks.object(value, ['success', 'maintenance', 'full_site_complete']);
  if (record.success !== true || record.maintenance !== false || record.full_site_complete !== false) invalidDispatchConfiguration();
  return Object.freeze({ success: true, maintenance: false, full_site_complete: false });
}
async function dispatchConfigurationResponse<T>(
  operation: () => PromiseLike<{ data: unknown; error: unknown }>, validate: (value: unknown) => T,
  failure: string, signal?: AbortSignal,
): Promise<T> {
  try {
    const { data, error } = await dispatchTransferChecks.withSignal(operation, signal);
    dispatchTransferChecks.checkAbort(signal);
    if (error) throw new Error(failure);
    const result = validate(data);
    dispatchTransferChecks.checkAbort(signal);
    return result;
  } catch {
    dispatchTransferChecks.checkAbort(signal);
    // Do not echo backend/request exceptions: they may contain credentials or business data.
    throw new Error(failure);
  }
}
export async function getTransferMaintenance(signal?: AbortSignal): Promise<TransferMaintenance> {
  return dispatchConfigurationResponse(() => {
    const query = supabase.rpc('get_employee_transfer_maintenance', {
      p_admin_session_token: getAdminFinancialSessionToken(),
    });
    return signal ? query.abortSignal(signal) : query;
  }, validateTransferMaintenance, 'Transfer maintenance status was not confirmed.', signal);
}
export async function leaveTransferMaintenance(
  jobId: string, adminPassword: string, confirmation: string, signal?: AbortSignal,
): Promise<TransferMaintenanceLeaveReceipt> {
  try {
    dispatchTransferChecks.checkAbort(signal);
    dispatchTransferChecks.uuid(jobId);
    if (confirmation !== LEAVE_TRANSFER_MAINTENANCE) throw new Error('The maintenance cancellation confirmation does not match.');
    return await dispatchConfigurationResponse(() => {
      const query = supabase.rpc('employee_transfer_leave_maintenance', {
        p_admin_session_token: getAdminFinancialSessionToken(), p_job_id: jobId,
        p_admin_password: adminPassword, p_confirmation: confirmation,
      });
      return signal ? query.abortSignal(signal) : query;
    }, validateTransferMaintenanceLeaveReceipt, 'Maintenance cancellation outcome is uncertain; reconcile before retrying.', signal);
  } finally { adminPassword = ''; }
}

export interface DispatchImportSession {
  identity(): { jobId: string; jobToken: string } | null;
  target: DispatchImportTarget;
  enterMaintenance(planHash: string, confirmation: string, adminPassword: string, signal?: AbortSignal): Promise<DispatchMaintenanceReceipt>;
  configurationPlan(signal?: AbortSignal): Promise<DispatchConfigurationPlan>;
  applyConfiguration(planHash: string, signal?: AbortSignal): Promise<DispatchConfigurationReceipt>;
  backup(signal?: AbortSignal): Promise<{
    descriptor: DispatchBackupDescriptor; source: DispatchExportSource; receiver: ReplacementBackupReceiver;
  }>;
  cancel(signal?: AbortSignal): Promise<{ success: true; cancelled: boolean }>;
}
export function createDispatchImportSession(packageId: string, adminPassword: string): DispatchImportSession {
  const session = getAdminFinancialSessionToken();
  const { object, uuid, withSignal, checkAbort } = dispatchTransferChecks;
  uuid(packageId);
  let started = false;
  let configuration: DispatchConfigurationPlan | null = null;
  let job: { jobId: string; jobToken: string } | null = null;
  const args = () => {
    if (!job) throw new Error('Dispatch preparation has not been confirmed by the server.');
    return { p_admin_session_token: session, p_job_token: job.jobToken };
  };
  return {
    identity: () => job && { ...job },
    target: {
      async begin(input, signal) {
        checkAbort(signal);
        if (started) throw new Error('Dispatch begin cannot be retried automatically; reconcile the task first.');
        const catalog = validateDispatchCatalog(input);
        started = true;
        try {
          const response = await withSignal(async () => {
            const query = supabase.rpc('employee_import_dispatch_begin', {
              p_admin_session_token: session, p_admin_password: adminPassword, p_package_id: packageId, p_catalog: { ...catalog },
            });
            const { data, error } = await (signal ? query.abortSignal(signal) : query);
            if (error) throw new Error('Dispatch begin outcome is uncertain; reconcile before retrying.');
            return data;
          }, signal);
          const record = object(response, ['success', 'job_id', 'job_token', 'scope', 'full_site_complete']);
          if (record.success !== true || record.scope !== 'dispatch-submission' || record.full_site_complete !== false) {
            throw new Error('Dispatch preparation task was not confirmed.');
          }
          job = { jobId: uuid(record.job_id), jobToken: uuid(record.job_token) };
          return { success: true, scope: 'dispatch-submission', full_site_complete: false };
        } finally { adminPassword = ''; }
      },
      async stage(key, chunkNo, ndjson, signal) {
        return withSignal(async () => {
          const query = supabase.rpc('employee_import_dispatch_stage', {
            ...args(), p_table_key: key, p_chunk_no: chunkNo, p_ndjson: ndjson,
          });
          const { data, error } = await (signal ? query.abortSignal(signal) : query);
          if (error) throw new Error('Dispatch staging outcome is uncertain; reconcile before retrying.');
          return data;
        }, signal);
      },
      async dryRun(signal) {
        return withSignal(async () => {
          const query = supabase.rpc('get_employee_import_dispatch_dry_run', args());
          const { data, error } = await (signal ? query.abortSignal(signal) : query);
          if (error) throw new Error('Dispatch preparation check failed; no replacement was performed.');
          return validateDispatchImportDryRun(data);
        }, signal);
      },
    },
    async enterMaintenance(planHash, confirmation, adminPassword, signal) {
      try {
        checkAbort(signal);
        const auth = args();
        dispatchTransferChecks.hash(planHash);
        if (confirmation !== ENTER_DISPATCH_MAINTENANCE) throw new Error('The maintenance confirmation does not match.');
        configuration = null;
        return await dispatchConfigurationResponse(() => {
          const query = supabase.rpc('employee_import_dispatch_enter_maintenance', {
            ...auth, p_plan_hash: planHash, p_confirmation: confirmation, p_admin_password: adminPassword,
          });
          return signal ? query.abortSignal(signal) : query;
        }, validateDispatchMaintenanceReceipt, 'Maintenance entry outcome is uncertain; reconcile before retrying.', signal);
      } finally { adminPassword = ''; }
    },
    async configurationPlan(signal) {
      configuration = null;
      const auth = args();
      const plan = await dispatchConfigurationResponse(() => {
        const query = supabase.rpc('get_employee_import_dispatch_configuration_plan', auth);
        return signal ? query.abortSignal(signal) : query;
      }, validateDispatchConfigurationPlan, 'Dispatch configuration plan was not confirmed.', signal);
      checkAbort(signal);
      configuration = plan;
      return plan;
    },
    async applyConfiguration(planHash, signal) {
      checkAbort(signal);
      const auth = args();
      dispatchTransferChecks.hash(planHash);
      if (!configuration?.can_apply_configuration || configuration.plan_hash !== planHash) {
        throw new Error('A matching conflict-free configuration plan must be explicitly confirmed first.');
      }
      return dispatchConfigurationResponse(() => {
        const query = supabase.rpc('employee_import_dispatch_apply_configuration', { ...auth, p_plan_hash: planHash });
        return signal ? query.abortSignal(signal) : query;
      }, validateDispatchConfigurationReceipt, 'Dispatch configuration apply outcome is uncertain; reconcile before retrying.', signal);
    },
    async backup(signal) {
      const read = async (readSignal?: AbortSignal) => withSignal(async () => {
        const query = supabase.rpc('get_employee_import_dispatch_backup', args());
        const { data, error } = await (readSignal ? query.abortSignal(readSignal) : query);
        if (error) throw new Error('Dispatch backup descriptor read failed.');
        const record = object(data, ['backup_id', 'plan_hash', 'target_hash', 'catalog']);
        const catalog = validateDispatchCatalog(record.catalog);
        if (uuid(record.backup_id) !== job?.jobId || catalog.tables.reduce((sum, table) => sum + table.bytes, 0) > 8 * 1024 * 1024) {
          throw new Error('Dispatch backup task mismatch or size limit exceeded.');
        }
        return { backup_id: record.backup_id as string, plan_hash: dispatchTransferChecks.hash(record.plan_hash),
          target_hash: dispatchTransferChecks.hash(record.target_hash), catalog };
      }, readSignal);
      const descriptor = await read(signal);
      return {
        descriptor: structuredClone(descriptor),
        source: {
          async catalog(readSignal) { checkAbort(readSignal); return structuredClone(descriptor.catalog); },
          async page(key, after, readSignal) {
            return withSignal(async () => {
              const query = supabase.rpc('get_employee_import_dispatch_backup_page', {
                ...args(), p_table_key: key, p_after: after, p_limit: 200,
              });
              const { data, error } = await (readSignal ? query.abortSignal(readSignal) : query);
              if (error) throw new Error('Dispatch frozen backup read failed.');
              return data;
            }, readSignal);
          },
          async verify(readSignal) {
            if (JSON.stringify(await read(readSignal)) !== JSON.stringify(descriptor)) throw new Error('Dispatch frozen backup identity changed.');
            return { verified: true, scope: 'dispatch-submission', full_site_complete: false };
          },
        },
        receiver: {
          async append(chunkNo, hex, writeSignal) {
            return withSignal(async () => {
              const query = supabase.rpc('employee_import_dispatch_backup_append', {
                ...args(), p_plan_hash: descriptor.plan_hash, p_chunk_no: chunkNo, p_hex: hex,
              });
              const { data, error } = await (writeSignal ? query.abortSignal(writeSignal) : query);
              if (error) throw new Error('Dispatch backup upload outcome is uncertain; reconcile before retrying.');
              const ack = object(data, ['success', 'bytes', 'sha256', 'repeated']);
              if (ack.success !== true || typeof ack.bytes !== 'number' || typeof ack.sha256 !== 'string'
                || typeof ack.repeated !== 'boolean') throw new Error('Invalid dispatch backup acknowledgement.');
              return { success: true as const, bytes: ack.bytes, sha256: ack.sha256, repeated: ack.repeated };
            }, writeSignal);
          },
          async seal(sha256, bytes, writeSignal) {
            return withSignal(async () => {
              const query = supabase.rpc('employee_import_dispatch_backup_seal', {
                ...args(), p_plan_hash: descriptor.plan_hash, p_sha256: sha256, p_bytes: bytes,
              });
              const { data, error } = await (writeSignal ? query.abortSignal(writeSignal) : query);
              if (error) throw new Error('Dispatch backup seal outcome is uncertain; reconcile before retrying.');
              const ack = object(data, ['success', 'backup_id', 'sha256', 'bytes', 'repeated', 'full_site_complete']);
              if (ack.success !== true || ack.backup_id !== descriptor.backup_id || ack.sha256 !== sha256 || ack.bytes !== bytes
                || typeof ack.repeated !== 'boolean' || ack.full_site_complete !== false) throw new Error('Invalid dispatch backup seal.');
              return { success: true as const, backup_id: descriptor.backup_id, sha256, bytes,
                repeated: ack.repeated, full_site_complete: false as const };
            }, writeSignal);
          },
        },
      };
    },
    async cancel(signal) {
      return withSignal(async () => {
        const query = supabase.rpc('employee_transfer_cancel', args());
        const { data, error } = await (signal ? query.abortSignal(signal) : query);
        if (error) throw new Error('Dispatch cancellation outcome is uncertain; reconcile before retrying.');
        const receipt = object(data, ['success', 'cancelled']);
        if (receipt.success !== true || typeof receipt.cancelled !== 'boolean') throw new Error('Dispatch cancellation was not confirmed.');
        return { success: true, cancelled: receipt.cancelled };
      }, signal);
    },
  };
}

export interface DispatchExportTask {
  jobId: string; jobToken: string; catalog: DispatchExportCatalog; source: DispatchExportSource;
  close(signal?: AbortSignal): Promise<unknown>;
  cancel(signal?: AbortSignal): Promise<{ success: true; cancelled: boolean }>;
}
export async function beginDispatchExport(adminPassword: string, signal?: AbortSignal): Promise<DispatchExportTask> {
  const session = getAdminFinancialSessionToken();
  const { object, uuid, withSignal, checkAbort } = dispatchTransferChecks;
  let response: unknown;
  try {
    response = await withSignal(async () => {
      const query = supabase.rpc('employee_export_dispatch_begin', {
        p_admin_session_token: session, p_admin_password: adminPassword,
      });
      const { data, error } = await (signal ? query.abortSignal(signal) : query);
      if (error) throw new Error('Dispatch export begin outcome is uncertain; reconcile before retrying.');
      return data;
    }, signal);
  } finally { adminPassword = ''; }
  const record = object(response, ['success', 'job_id', 'job_token', 'site_id', 'catalog', 'scope', 'full_site_complete']);
  if (record.success !== true || record.scope !== 'dispatch-submission' || record.full_site_complete !== false) {
    throw new Error('Dispatch export task creation was not confirmed; reconcile before retrying.');
  }
  const jobId = uuid(record.job_id), jobToken = uuid(record.job_token);
  const catalog = validateDispatchCatalog(record.catalog);
  if (uuid(record.site_id) !== catalog.site_id) throw new Error('Dispatch export site identity mismatch.');
  const args = () => ({ p_admin_session_token: session, p_job_token: jobToken });
  return {
    jobId, jobToken, catalog: structuredClone(catalog),
    source: {
      async catalog(readSignal) { checkAbort(readSignal); return structuredClone(catalog); },
      async page(key, after, readSignal) {
        if (after !== null) uuid(after);
        return withSignal(async () => {
          const query = supabase.rpc('get_employee_export_dispatch_page', {
            ...args(), p_table_key: key, p_after: after, p_limit: 200,
          });
          const { data, error } = await (readSignal ? query.abortSignal(readSignal) : query);
          if (error) throw new Error('Dispatch export page read failed.');
          return data;
        }, readSignal);
      },
      async verify(readSignal) {
        return withSignal(async () => {
          const query = supabase.rpc('employee_export_dispatch_verify', args());
          const { data, error } = await (readSignal ? query.abortSignal(readSignal) : query);
          if (error) throw new Error('Dispatch export verification failed.');
          validateDispatchVerification(data);
          return data;
        }, readSignal);
      },
    },
    async close(closeSignal) {
      return withSignal(async () => {
        const query = supabase.rpc('employee_export_dispatch_close', args());
        const { data, error } = await (closeSignal ? query.abortSignal(closeSignal) : query);
        if (error) throw new Error('Dispatch export close outcome is uncertain; reconcile before retrying.');
        const receipt = object(data, ['success', 'scope', 'full_site_complete']);
        if (receipt.success !== true || receipt.scope !== 'dispatch-submission' || receipt.full_site_complete !== false) {
          throw new Error('Dispatch export close was not confirmed.');
        }
        return data;
      }, closeSignal);
    },
    async cancel(cancelSignal) {
      return withSignal(async () => {
        const query = supabase.rpc('employee_transfer_cancel', args());
        const { data, error } = await (cancelSignal ? query.abortSignal(cancelSignal) : query);
        if (error) throw new Error('Dispatch cancellation outcome is uncertain; reconcile before retrying.');
        const receipt = object(data, ['success', 'cancelled']);
        if (receipt.success !== true || typeof receipt.cancelled !== 'boolean') {
          throw new Error('Dispatch task cancellation was not confirmed.');
        }
        return { success: true, cancelled: receipt.cancelled };
      }, cancelSignal);
    },
  };
}
export async function getDispatchImportPreflight(signal?: AbortSignal): Promise<DispatchPreflight> {
  return dispatchTransferChecks.withSignal(async () => {
    const query = supabase.rpc('get_employee_import_dispatch_preflight', {
      p_admin_session_token: getAdminFinancialSessionToken(),
    });
    const { data, error } = await (signal ? query.abortSignal(signal) : query);
    if (error) throw new Error('Dispatch/submission target preflight failed.');
    return validateDispatchPreflight(data);
  }, signal);
}

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

export interface ProductsExportTask {
  jobId: string;
  jobToken: string;
  catalog: ProductExportCatalog;
  source: ProductExportSource;
  close(signal?: AbortSignal): Promise<unknown>;
}
export interface ProductsImportSession {
  target: ProductImportTarget;
  identity(): { jobId: string; jobToken: string } | null;
  backup(signal?: AbortSignal): Promise<{
    descriptor: ProductBackupDescriptor; source: ProductExportSource; receiver: ReplacementBackupReceiver;
  }>;
  apply(planHash: string, signal?: AbortSignal): Promise<unknown>;
  close(signal?: AbortSignal): Promise<unknown>;
}
// Separate product-only endpoints: never route a one-table catalog through seven-table shared RPCs.
export async function beginProductsExport(adminPassword: string, signal?: AbortSignal): Promise<ProductsExportTask> {
  const session = getAdminFinancialSessionToken();
  const { object, uuid, withSignal } = productTransferChecks;
  let response: unknown;
  try {
    response = await withSignal(async () => {
      const query = supabase.rpc('employee_export_products_begin', {
        p_admin_session_token: session, p_admin_password: adminPassword,
      });
      const { data, error } = await (signal ? query.abortSignal(signal) : query);
      if (error) throw new Error('Product export begin outcome is uncertain; reconcile the task before retrying.');
      return data;
    }, signal);
  } finally { adminPassword = ''; }
  const record = object(response, ['success', 'job_id', 'job_token', 'site_id', 'catalog', 'scope', 'full_site_complete']);
  if (record.success !== true || record.scope !== 'product-catalog' || record.full_site_complete !== false) {
    throw new Error('Product export task creation was not confirmed; reconcile before retrying.');
  }
  const jobId = uuid(record.job_id), jobToken = uuid(record.job_token);
  const catalog = validateProductExportCatalog(record.catalog);
  if (uuid(record.site_id) !== catalog.site_id) throw new Error('Product export site identity mismatch.');
  const args = () => ({ p_admin_session_token: session, p_job_token: jobToken });
  return {
    jobId, jobToken, catalog: structuredClone(catalog),
    source: {
      async catalog(readSignal) { productTransferChecks.checkAbort(readSignal); return structuredClone(catalog); },
      async page(after, readSignal) {
        if (after !== null) uuid(after);
        return withSignal(async () => {
          const query = supabase.rpc('get_employee_export_products_page', { ...args(), p_after: after, p_limit: 200 });
          const { data, error } = await (readSignal ? query.abortSignal(readSignal) : query);
          if (error) throw new Error('Product export page read failed.');
          return data;
        }, readSignal);
      },
      async verify(readSignal) {
        return withSignal(async () => {
          const query = supabase.rpc('employee_export_products_verify', args());
          const { data, error } = await (readSignal ? query.abortSignal(readSignal) : query);
          if (error) throw new Error('Product export verification failed.');
          validateProductVerification(data);
          return data;
        }, readSignal);
      },
    },
    async close(closeSignal) {
      return withSignal(async () => {
        const query = supabase.rpc('employee_products_close', args());
        const { data, error } = await (closeSignal ? query.abortSignal(closeSignal) : query);
        if (error) throw new Error('Product close outcome is uncertain; reconcile before retrying.');
        return data;
      }, closeSignal);
    },
  };
}
export function createProductsImportSession(packageId: string, adminPassword: string): ProductsImportSession {
  const { object, uuid, hash, checkAbort, withSignal } = productTransferChecks;
  uuid(packageId);
  const session = getAdminFinancialSessionToken();
  let job: { jobId: string; jobToken: string } | null = null;
  let started = false;
  const args = () => {
    if (!job) throw new Error('The product import task has not been confirmed by the server.');
    return { p_admin_session_token: session, p_job_token: job.jobToken };
  };
  return {
    identity: () => job && { ...job },
    target: {
      async begin(input, signal) {
        checkAbort(signal);
        const catalog = validateProductExportCatalog(input);
        if (started) throw new Error('Product begin cannot be retried automatically; reconcile the task first.');
        started = true;
        try {
          return await withSignal(async () => {
            const query = supabase.rpc('employee_import_products_begin', {
              p_admin_session_token: session, p_admin_password: adminPassword, p_package_id: packageId, p_catalog: { ...catalog },
            });
            const { data, error } = await (signal ? query.abortSignal(signal) : query);
            if (error) throw new Error('Product import begin outcome is uncertain; reconcile before retrying.');
            const record = object(data, ['success', 'job_id', 'job_token', 'scope', 'full_site_complete']);
            if (record.success !== true || record.scope !== 'product-catalog' || record.full_site_complete !== false) {
              throw new Error('Product import task creation was not confirmed.');
            }
            checkAbort(signal);
            job = { jobId: uuid(record.job_id), jobToken: uuid(record.job_token) };
            return { success: true, scope: 'product-catalog', full_site_complete: false };
          }, signal);
        } finally { adminPassword = ''; }
      },
      async stage(chunkNo, ndjson, signal) {
        return withSignal(async () => {
          const query = supabase.rpc('employee_import_products_stage', { ...args(), p_chunk_no: chunkNo, p_ndjson: ndjson });
          const { data, error } = await (signal ? query.abortSignal(signal) : query);
          if (error) throw new Error('Product staging outcome is uncertain; reconcile before retrying.');
          return data;
        }, signal);
      },
      async dryRun(signal) {
        return withSignal(async () => {
          const query = supabase.rpc('get_employee_import_products_dry_run', args());
          const { data, error } = await (signal ? query.abortSignal(signal) : query);
          if (error) throw new Error('Product dry-run failed.');
          return data;
        }, signal);
      },
    },
    async backup(signal) {
      const readDescriptor = async (readSignal?: AbortSignal) => withSignal(async () => {
        const query = supabase.rpc('get_employee_import_products_backup', args());
        const { data, error } = await (readSignal ? query.abortSignal(readSignal) : query);
        if (error) throw new Error('Product backup descriptor read failed.');
        const record = object(data, ['backup_id', 'plan_hash', 'target_hash', 'catalog']);
        const descriptor: ProductBackupDescriptor = { backup_id: uuid(record.backup_id), plan_hash: hash(record.plan_hash),
          target_hash: hash(record.target_hash), catalog: validateProductExportCatalog(record.catalog) };
        if (descriptor.backup_id !== job?.jobId) throw new Error('Product backup task identity mismatch.');
        return descriptor;
      }, readSignal);
      const frozen = await readDescriptor(signal);
      return {
        descriptor: structuredClone(frozen),
        source: {
          async catalog(readSignal) { checkAbort(readSignal); return structuredClone(frozen.catalog); },
          async page(after, readSignal) {
            if (after !== null) uuid(after);
            return withSignal(async () => {
              const query = supabase.rpc('get_employee_import_products_backup_page', { ...args(), p_after: after, p_limit: 200 });
              const { data, error } = await (readSignal ? query.abortSignal(readSignal) : query);
              if (error) throw new Error('Product backup page read failed.');
              return data;
            }, readSignal);
          },
          async verify(readSignal) {
            const current = await readDescriptor(readSignal);
            if (JSON.stringify(current) !== JSON.stringify(frozen)) throw new Error('The frozen product backup descriptor changed.');
            return { verified: true, scope: 'product-catalog', full_site_complete: false };
          },
        },
        receiver: {
          async append(chunkNo, hex, writeSignal) {
            return withSignal(async () => {
              const query = supabase.rpc('employee_import_products_backup_append', {
                ...args(), p_plan_hash: frozen.plan_hash, p_chunk_no: chunkNo, p_hex: hex,
              });
              const { data, error } = await (writeSignal ? query.abortSignal(writeSignal) : query);
              if (error) throw new Error('Product backup append outcome is uncertain; reconcile before retrying.');
              const ack = object(data, ['success', 'bytes', 'sha256', 'repeated']);
              if (ack.success !== true || typeof ack.repeated !== 'boolean') throw new Error('Invalid product backup acknowledgement.');
              return { success: true, bytes: productTransferChecks.count(ack.bytes, 128 * 1024), sha256: hash(ack.sha256), repeated: ack.repeated };
            }, writeSignal);
          },
          async seal(sha256, bytes, writeSignal) {
            return withSignal(async () => {
              const query = supabase.rpc('employee_import_products_backup_seal', {
                ...args(), p_plan_hash: frozen.plan_hash, p_sha256: sha256, p_bytes: bytes,
              });
              const { data, error } = await (writeSignal ? query.abortSignal(writeSignal) : query);
              if (error) throw new Error('Product backup seal outcome is uncertain; reconcile before retrying.');
              const ack = object(data, ['success', 'backup_id', 'sha256', 'bytes', 'repeated', 'full_site_complete']);
              if (ack.success !== true || ack.backup_id !== frozen.backup_id || ack.sha256 !== sha256 || ack.bytes !== bytes
                || typeof ack.repeated !== 'boolean' || ack.full_site_complete !== false) throw new Error('Product backup seal was not confirmed.');
              return structuredClone(data);
            }, writeSignal);
          },
        },
      };
    },
    async apply(planHash, signal) {
      hash(planHash);
      return withSignal(async () => {
        const query = supabase.rpc('employee_import_products_apply', { ...args(), p_plan_hash: planHash });
        const { data, error } = await (signal ? query.abortSignal(signal) : query);
        if (error) throw new Error('Product apply outcome is uncertain; reconcile before retrying.');
        const ack = object(data, ['success', 'scope', 'full_site_complete', 'product_map', 'repeated']);
        if (ack.success !== true || ack.scope !== 'product-catalog' || ack.full_site_complete !== false
          || typeof ack.repeated !== 'boolean' || !ack.product_map || typeof ack.product_map !== 'object' || Array.isArray(ack.product_map)) {
          throw new Error('Product apply was not confirmed.');
        }
        for (const [source, target] of Object.entries(ack.product_map)) { uuid(source); uuid(target); }
        return structuredClone(data);
      }, signal);
    },
    async close(signal) {
      return withSignal(async () => {
        const query = supabase.rpc('employee_products_close', args());
        const { data, error } = await (signal ? query.abortSignal(signal) : query);
        if (error) throw new Error('Product close outcome is uncertain; reconcile before retrying.');
        return data;
      }, signal);
    },
  };
}
