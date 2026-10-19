import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import {
  NOTIFICATIONS_TABLE_KEYS, NOTIFICATIONS_CONFLICT_REASONS, validateNotificationsCatalog,
  validateNotificationsPage, notificationsCursor, type NotificationsCatalog, type NotificationsCounts,
} from './notificationsTransfer';
import type {
  NotificationsBackupDescriptor, NotificationsBackupReceiver, NotificationsBackupSource,
} from './notificationsBackup';

const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const configurationKeys = ['notification_automation_plans', 'notification_automation_tasks', 'message_templates'] as const;
const conflictReasons = [...NOTIFICATIONS_CONFLICT_REASONS, 'source_plan_unmapped', 'ambiguous_notification_configuration',
  'source_configuration_collision', 'notification_configuration_id_collision', 'notification_many_to_one',
  'target_member_outside_plan', 'target_notification_history', 'target_notification_uuid_collision', 'target_execution_unique_collision'];
const failure = 'Notification configuration request outcome is unknown or unconfirmed; server backup data or a seal may exist. Reconcile before retrying. No automatic retry, rollback, apply, cancel or close was performed.';
function invalid(): never { throw new Error(failure); }
function uuid(value: unknown): string {
  const result = dispatchTransferChecks.uuid(value);
  if (result.length !== 36) invalid();
  return result;
}
function hash(value: unknown): string {
  const result = dispatchTransferChecks.hash(value);
  if (result.length !== 64) invalid();
  return result;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, max);
  if (Reflect.ownKeys(value).length !== size + 1) invalid();
  return Array.from({ length: size }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field)) invalid();
    return field.value;
  });
}
export interface NotificationConfigurationPlan {
  scope: 'notification-configuration';
  records: { table_key: typeof configurationKeys[number]; source_id: string; target_id: string; action: 'create' | 'replace' | 'conflict' }[];
  retire_tasks: string[]; members_removed: number; conflicts: string[]; counts: NotificationsCounts;
  checked: true; backup_required: true; can_prepare_backup: boolean; can_apply_configuration: false;
  media_pending: true; automation_pending: true; maintenance: true; replacement_ready: false; full_site_complete: false;
  target_hash: string; plan_hash: string;
}
export function validateNotificationConfigurationPlan(value: unknown, catalog: NotificationsCatalog): NotificationConfigurationPlan {
  try { return configurationPlan(value, validateNotificationsCatalog(catalog)); } catch { invalid(); }
}
function configurationPlan(value: unknown, catalog: NotificationsCatalog): NotificationConfigurationPlan {
  const record = object(value, ['scope', 'records', 'retire_tasks', 'members_removed', 'conflicts', 'counts', 'checked',
    'backup_required', 'can_prepare_backup', 'can_apply_configuration', 'media_pending', 'automation_pending', 'maintenance',
    'replacement_ready', 'full_site_complete', 'target_hash', 'plan_hash']);
  if (record.scope !== 'notification-configuration' || record.checked !== true || record.backup_required !== true
    || record.can_apply_configuration !== false || record.media_pending !== true || record.automation_pending !== true
    || record.maintenance !== true || record.replacement_ready !== false || record.full_site_complete !== false) invalid();
  const counts = object(record.counts, NOTIFICATIONS_TABLE_KEYS);
  for (const table of catalog.tables) if (counts[table.key] !== table.rows) invalid();
  const conflicts = list(record.conflicts, conflictReasons.length).map(value => {
    if (typeof value !== 'string' || !conflictReasons.includes(value)) invalid();
    return value;
  });
  if (new Set(conflicts).size !== conflicts.length || record.can_prepare_backup !== (conflicts.length === 0)) invalid();
  const expectedRows = catalog.tables.filter(t => configurationKeys.some(key => key === t.key)).reduce((n, t) => n + t.rows, 0);
  const seen = new Set<string>();
  const records: NotificationConfigurationPlan['records'] = list(record.records, expectedRows).map(value => {
    const item = object(value, ['table_key', 'source_id', 'target_id', 'action']);
    const table_key = configurationKeys.find(key => key === item.table_key);
    const action = item.action;
    if (!table_key || (action !== 'create' && action !== 'replace' && action !== 'conflict')) invalid();
    const source_id = uuid(item.source_id), target_id = uuid(item.target_id), key = `${table_key}:${source_id}`;
    if (seen.has(key) || (action === 'conflict' && conflicts.length === 0) || (action === 'create' && source_id !== target_id)) invalid();
    seen.add(key);
    return { table_key, source_id, target_id, action };
  });
  if (records.length !== expectedRows) invalid();
  const targets = new Map<string, NotificationConfigurationPlan['records']>();
  for (const item of records) {
    const key = `${item.table_key}:${item.target_id}`;
    targets.set(key, [...(targets.get(key) ?? []), item]);
  }
  for (const entries of targets.values()) if (entries.length > 1
    && (!conflicts.includes('notification_many_to_one') || entries.some(item => item.action !== 'conflict'))) invalid();
  for (const key of configurationKeys) if (records.filter(r => r.table_key === key).length !== counts[key]) invalid();
  const retire_tasks = list(record.retire_tasks, 500000).map(uuid);
  if (new Set(retire_tasks).size !== retire_tasks.length
    || retire_tasks.some(id => records.some(r => r.table_key === 'notification_automation_tasks' && r.target_id === id))) invalid();
  return { scope: 'notification-configuration', records, retire_tasks, members_removed: count(record.members_removed, 500000),
    conflicts, counts: { ...counts } as NotificationsCounts, checked: true, backup_required: true,
    can_prepare_backup: conflicts.length === 0, can_apply_configuration: false, media_pending: true, automation_pending: true,
    maintenance: true, replacement_ready: false, full_site_complete: false, target_hash: hash(record.target_hash), plan_hash: hash(record.plan_hash) };
}
async function response<T>(
  operation: () => PromiseLike<{ data: unknown; error: unknown }>, validate: (value: unknown) => T, signal?: AbortSignal,
): Promise<T> {
  try {
    const { data, error } = await withSignal(operation, signal);
    checkAbort(signal);
    if (error) invalid();
    const result = validate(data);
    checkAbort(signal);
    return result;
  } catch {
    if (signal?.aborted) throw new DOMException(failure, 'AbortError');
    throw new Error(failure);
  }
}
export interface NotificationConfigurationBackup {
  descriptor: NotificationsBackupDescriptor; source: NotificationsBackupSource; receiver: NotificationsBackupReceiver;
}
export interface NotificationConfigurationSession {
  plan(signal?: AbortSignal): Promise<NotificationConfigurationPlan>;
  backup(planHash: string, signal?: AbortSignal): Promise<NotificationConfigurationBackup>;
}
export function createNotificationConfigurationSession(jobToken: string, input: NotificationsCatalog): NotificationConfigurationSession {
  const { auth, token, catalog } = (() => {
    try { return { auth: uuid(getAdminFinancialSessionToken()), token: uuid(jobToken), catalog: validateNotificationsCatalog(input) }; }
    catch { invalid(); }
  })();
  const args = () => ({ p_admin_session_token: auth, p_job_token: token });
  let busy = false, lastPlan: NotificationConfigurationPlan | null = null;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('A notification configuration request is already in progress.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  return {
    plan(signal) {
      return exclusive(async () => {
        lastPlan = null;
        const result = await response(() => {
          const query = supabase.rpc('get_employee_import_notification_configuration_plan', args());
          return signal ? query.abortSignal(signal) : query;
        }, value => validateNotificationConfigurationPlan(value, catalog), signal);
        lastPlan = structuredClone(result);
        return result;
      }, signal);
    },
    backup(planHash, signal) {
      return exclusive(async () => {
        if (!lastPlan?.can_prepare_backup || hash(planHash) !== lastPlan.plan_hash) throw new Error('A confirmed conflict-free notification configuration plan is required.');
        const validators = await import('./notificationsBackup');
        checkAbort(signal);
        const expectedPlan = structuredClone(lastPlan);
        const descriptor = await response(() => {
          const query = supabase.rpc('employee_import_notification_backup_prepare', { ...args(), p_plan_hash: planHash });
          return signal ? query.abortSignal(signal) : query;
        }, value => {
          const result = validators.validateNotificationsBackupDescriptor(value);
          if (result.plan_hash !== expectedPlan.plan_hash || result.target_hash !== expectedPlan.target_hash
            || result.catalog.package_id !== catalog.package_id || result.catalog.site_id === catalog.site_id) invalid();
          return result;
        }, signal);
        const params = () => ({ ...args(), p_backup_id: descriptor.backup_id });
        let verified = false;
        return {
          descriptor: structuredClone(descriptor),
          source: {
            catalog(readSignal) { return exclusive(async () => structuredClone(descriptor.catalog), readSignal); },
            page(key, after, readSignal) {
              verified = false;
              return exclusive(async () => {
                if (!NOTIFICATIONS_TABLE_KEYS.includes(key)) invalid();
                if (after !== null) notificationsCursor(key, after);
                verified = false;
                return response(() => {
                  const query = supabase.rpc('get_employee_import_notification_backup_page', { ...params(), p_table_key: key, p_after: after, p_limit: 200 });
                  return readSignal ? query.abortSignal(readSignal) : query;
                }, value => validateNotificationsPage(value, key, after), readSignal);
              }, readSignal);
            },
            verify(readSignal) {
              verified = false;
              return exclusive(async () => {
                verified = false;
                const result = await response(() => {
                  const query = supabase.rpc('employee_import_notification_backup_verify', params());
                  return readSignal ? query.abortSignal(readSignal) : query;
                }, value => {
                  const result = object(value, ['verified', 'backup_id', 'plan_hash', 'target_hash', 'media_included', 'full_site_complete']);
                  if (result.verified !== true || result.backup_id !== descriptor.backup_id || result.plan_hash !== descriptor.plan_hash
                    || result.target_hash !== descriptor.target_hash || result.media_included !== false || result.full_site_complete !== false) invalid();
                  return { verified: true as const, backup_id: descriptor.backup_id, plan_hash: descriptor.plan_hash,
                    target_hash: descriptor.target_hash, media_included: false as const, full_site_complete: false as const };
                }, readSignal);
                verified = true;
                return result;
              }, readSignal);
            },
          },
          receiver: {
            append(no, hex, writeSignal) {
              return exclusive(async () => {
                if (!verified) throw new Error('Notification snapshot verification is required before ciphertext upload.');
                count(no, 1023);
                if (typeof hex !== 'string' || hex.length < 2 || hex.length > 262144 || hex.length % 2 !== 0
                  || hex.match(/^[0-9a-f]+$/)?.[0] !== hex) invalid();
                const bytes = Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16));
                return response(() => {
                  const query = supabase.rpc('employee_import_notification_backup_append', { ...params(), p_chunk_no: no, p_hex: hex });
                  return writeSignal ? query.abortSignal(writeSignal) : query;
                }, value => {
                  const result = object(value, ['success', 'bytes', 'sha256', 'repeated']);
                  if (result.success !== true || result.bytes !== bytes.length || hash(result.sha256) !== new Sha256().update(bytes).digestHex()
                    || typeof result.repeated !== 'boolean') invalid();
                  return { success: true as const, bytes: bytes.length, sha256: result.sha256 as string, repeated: result.repeated };
                }, writeSignal);
              }, writeSignal);
            },
            seal(digest, bytes, writeSignal) {
              return exclusive(async () => {
                if (!verified) throw new Error('Notification snapshot verification is required before sealing.');
                hash(digest); count(bytes, 9 * 1024 * 1024);
                if (bytes < 64) invalid();
                return response(() => {
                  const query = supabase.rpc('employee_import_notification_backup_seal', { ...params(), p_sha256: digest, p_bytes: bytes });
                  return writeSignal ? query.abortSignal(writeSignal) : query;
                }, value => {
                  const result = object(value, ['success', 'backup_id', 'sha256', 'bytes', 'repeated', 'media_pending', 'full_site_complete']);
                  if (result.success !== true || result.backup_id !== descriptor.backup_id || result.sha256 !== digest || result.bytes !== bytes
                    || typeof result.repeated !== 'boolean' || result.media_pending !== true || result.full_site_complete !== false) invalid();
                  return { success: true as const, backup_id: descriptor.backup_id, sha256: digest, bytes, repeated: result.repeated,
                    media_pending: true as const, full_site_complete: false as const };
                }, writeSignal);
              }, writeSignal);
            },
          },
        };
      }, signal);
    },
  };
}
