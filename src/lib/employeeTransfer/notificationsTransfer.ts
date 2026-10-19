import type { TemporaryTransferSink } from './container';
import type { TransferByteSource } from './crypto';
import type { VolumeManifest } from './manifest';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import { validateIdentityCatalog, type IdentityCatalog } from './identityTransfer';
import { validateFinanceCatalog, type FinanceCatalog } from './financeTransfer';

export const NOTIFICATIONS_PROTOCOL = 'site-notifications-v1';
export const NOTIFICATIONS_TABLE_KEYS = Object.freeze([
  'notification_automation_plans', 'notification_automation_tasks', 'notification_automation_plan_members',
  'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_executions',
  'notification_automation_date_runs', 'notification_automation_failures', 'messages', 'message_recipients',
  'message_templates', 'broadcast_messages', 'broadcast_recipients',
] as const);
export type NotificationsTableKey = typeof NOTIFICATIONS_TABLE_KEYS[number];
export const NOTIFICATIONS_TRANSFER_LIMITS = Object.freeze({
  maxRows: 500000, maxTableBytes: 256 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024,
  maxLineBytes: 64 * 1024, maxPageRows: 200, maxPageBytes: 256 * 1024,
  maxChunks: 500001, maxInputBytes: 1024 * 1024,
});
const limits = NOTIFICATIONS_TRANSFER_LIMITS;
const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const EMPTY_HASH = new Sha256().digestHex();
const FLAGS = ['maintenance', 'financial_data_pending', 'dependencies_pending', 'replacement_ready', 'full_site_complete'] as const;
export interface NotificationsPending {
  maintenance: true; financial_data_pending: true; dependencies_pending: true;
  replacement_ready: false; full_site_complete: false;
}
export interface NotificationsTableCatalog {
  key: NotificationsTableKey; rows: number; bytes: number; row_hashes_sha256: string;
}
export interface NotificationsCatalog {
  version: 1; scope: 'site-notifications'; site_id: string; package_id: string;
  identity_catalog: IdentityCatalog; finance_catalog: FinanceCatalog; date_runs_supported: boolean;
  tables: NotificationsTableCatalog[]; full_site_complete: false;
}
export type NotificationsCounts = Record<NotificationsTableKey, number>;
export const NOTIFICATIONS_CONFLICT_REASONS = Object.freeze([
  'source_employee_missing', 'source_admin_unmapped', 'source_reference_missing', 'source_scope_mismatch',
  'source_unique_collision', 'reward_link_mismatch', 'unfinished_execution', 'unsupported_date_runs',
] as const);
export interface NotificationsPlan extends NotificationsPending {
  scope: 'site-notifications'; checked: true; can_restore: false; restore_pending: true;
  media_pending: true; automation_pending: true; counts: NotificationsCounts; employees: number; rewards: number;
  conflicts: typeof NOTIFICATIONS_CONFLICT_REASONS[number][]; plan_hash: string;
}
export interface NotificationsExportSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(key: NotificationsTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(signal?: AbortSignal): Promise<unknown>;
}
export interface NotificationsImportTarget {
  bind(catalog: NotificationsCatalog, signal?: AbortSignal): Promise<unknown>;
  stage(key: NotificationsTableKey, chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<unknown>;
  plan(signal?: AbortSignal): Promise<unknown>;
}
export interface NotificationsImportFiles {
  // Before calling stageNotificationsImport, authenticate the same-package manifest and entire
  // encrypted volume through complete EOF. Only reopen isolated, immutable plaintext files.
  open(path: string): TransferByteSource | ReadableStream<Uint8Array>;
  // Invalidate pending reads/writes and discard all temporary plaintext, including on success.
  abort(reason: unknown): Promise<void>;
}
export interface NotificationsProgress {
  scope: 'site-notifications'; phase: 'export' | 'validate' | 'stage' | 'plan';
  tableKey?: NotificationsTableKey; rows: number; bytes: number; fullSiteComplete: false;
}
export interface NotificationsTransferOptions {
  signal?: AbortSignal; onProgress?: (progress: NotificationsProgress) => void;
}
export interface NotificationsExportResult {
  catalog: NotificationsCatalog; entries: { path: string; kind: 'ndjson'; bytes: number; sha256: string }[];
  rows: number; bytes: number; fullSiteComplete: false;
}
export interface NotificationsImportResult {
  plan: NotificationsPlan; rows: number; bytes: number; fullSiteComplete: false;
}
export class NotificationsTransferCleanupError extends Error {
  readonly cleanupRequired = true;
  constructor(readonly stagingMayExist = false) {
    super('Notifications temporary plaintext cleanup was not confirmed. Do not reuse the workspace; reconcile any server staging.');
    this.name = 'NotificationsTransferCleanupError';
  }
}
export class NotificationsImportStagingMayExistError extends Error {
  readonly stagingMayExist = true;
  constructor(readonly cancelled: boolean) {
    super('Notifications import stopped. Server staging may exist; reconcile before rerunning. No automatic retry, cancel, rollback, restore or close was performed.');
    this.name = 'NotificationsImportStagingMayExistError';
  }
}
function invalid(): never { throw new Error('Invalid notifications transfer.'); }
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
// Snapshot descriptors, not getters/iterators or a second proxy get.
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, max), own = Reflect.ownKeys(value);
  if (own.length !== size + 1 || own.some(key => typeof key !== 'string'
    || (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= size)))) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < size; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field)) invalid();
    result.push(field.value);
  }
  return result;
}
export function notificationsTableKey(value: unknown): NotificationsTableKey {
  const key = NOTIFICATIONS_TABLE_KEYS.find(key => value === key);
  if (!key) invalid();
  return key;
}
export function notificationsEntryPath(key: NotificationsTableKey): string { return `data/notifications-${notificationsTableKey(key)}.ndjson`; }
function pending(record: Record<string, unknown>): NotificationsPending {
  if (record.maintenance !== true || record.financial_data_pending !== true || record.dependencies_pending !== true
    || record.replacement_ready !== false || record.full_site_complete !== false) invalid();
  return { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
}
function counts(value: unknown): NotificationsCounts {
  const record = object(value, NOTIFICATIONS_TABLE_KEYS);
  return Object.fromEntries(NOTIFICATIONS_TABLE_KEYS.map(key => [key, count(record[key], limits.maxRows)])) as NotificationsCounts;
}
function checkDependencyHashes(identity: IdentityCatalog, finance: FinanceCatalog): void {
  // Older validators accept a trailing newline in a digest/UUID; tighten these nested contracts here.
  uuid(identity.site_id); uuid(identity.package_id); uuid(finance.site_id); uuid(finance.package_id);
  for (const table of [...identity.tables, ...finance.tables, ...finance.identity_catalog.tables]) hash(table.row_hashes_sha256);
}
export function validateNotificationsCatalog(value: unknown): NotificationsCatalog {
  const record = object(value, ['version', 'scope', 'site_id', 'package_id', 'identity_catalog', 'finance_catalog',
    'date_runs_supported', 'tables', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'site-notifications' || record.full_site_complete !== false
    || typeof record.date_runs_supported !== 'boolean') invalid();
  const raw = array(record.tables, NOTIFICATIONS_TABLE_KEYS.length);
  if (raw.length !== NOTIFICATIONS_TABLE_KEYS.length) invalid();
  let total = 0;
  const tables = NOTIFICATIONS_TABLE_KEYS.map((key, index) => {
    const table = object(raw[index], ['key', 'rows', 'bytes', 'row_hashes_sha256']);
    if (table.key !== key) invalid();
    const rows = count(table.rows, limits.maxRows), bytes = count(table.bytes, limits.maxTableBytes);
    const digest = hash(table.row_hashes_sha256);
    if ((rows === 0) !== (bytes === 0) || (rows === 0 && digest !== EMPTY_HASH)) invalid();
    if (!record.date_runs_supported && key === 'notification_automation_date_runs' && (rows !== 0 || bytes !== 0 || digest !== EMPTY_HASH)) invalid();
    total += bytes;
    return { key, rows, bytes, row_hashes_sha256: digest };
  });
  if (total > limits.maxTotalBytes) invalid();
  const site = uuid(record.site_id), packageId = uuid(record.package_id);
  const identity = validateIdentityCatalog(record.identity_catalog), finance = validateFinanceCatalog(record.finance_catalog);
  checkDependencyHashes(identity, finance);
  if (identity.site_id !== site || identity.package_id !== packageId || finance.site_id !== site || finance.package_id !== packageId
    || JSON.stringify(finance.identity_catalog) !== JSON.stringify(identity)) invalid();
  return { version: 1, scope: 'site-notifications', site_id: site, package_id: packageId, identity_catalog: identity,
    finance_catalog: finance, date_runs_supported: record.date_runs_supported, tables, full_site_complete: false };
}
export function validateNotificationsPlan(value: unknown): NotificationsPlan {
  const record = object(value, ['scope', 'checked', 'can_restore', 'restore_pending', 'media_pending', 'automation_pending',
    'counts', 'employees', 'rewards', 'conflicts', 'plan_hash', ...FLAGS]);
  if (record.scope !== 'site-notifications' || record.checked !== true || record.can_restore !== false
    || record.restore_pending !== true || record.media_pending !== true || record.automation_pending !== true) invalid();
  const conflicts = array(record.conflicts, 200).map(value => {
    const reason = NOTIFICATIONS_CONFLICT_REASONS.find(reason => reason === value);
    if (!reason) invalid();
    return reason;
  });
  return { scope: 'site-notifications', checked: true, can_restore: false, restore_pending: true, media_pending: true,
    automation_pending: true, counts: counts(record.counts), employees: count(record.employees, limits.maxRows),
    rewards: count(record.rewards, limits.maxRows), conflicts, plan_hash: hash(record.plan_hash), ...pending(record) };
}
export function validateNotificationsVerification(value: unknown): {
  verified: true; scope: 'site-notifications'; media_pending: true; full_site_complete: false;
} {
  const record = object(value, ['verified', 'scope', 'media_pending', 'full_site_complete']);
  if (record.verified !== true || record.scope !== 'site-notifications' || record.media_pending !== true || record.full_site_complete !== false) invalid();
  return { verified: true, scope: 'site-notifications', media_pending: true, full_site_complete: false };
}
export function validateNotificationsBind(value: unknown): { success: true; scope: 'site-notifications'; full_site_complete: false; repeated: boolean } {
  const record = object(value, ['success', 'scope', 'full_site_complete', 'repeated']);
  if (record.success !== true || record.scope !== 'site-notifications' || record.full_site_complete !== false
    || typeof record.repeated !== 'boolean') invalid();
  return { success: true, scope: 'site-notifications', full_site_complete: false, repeated: record.repeated };
}
export function validateNotificationsClose(value: unknown): {
  success: true; scope: 'site-notifications'; media_pending: true; full_site_complete: false;
} {
  const record = object(value, ['success', 'scope', 'media_pending', 'full_site_complete']);
  if (record.success !== true || record.scope !== 'site-notifications' || record.media_pending !== true || record.full_site_complete !== false) invalid();
  return { success: true, scope: 'site-notifications', media_pending: true, full_site_complete: false };
}
// This validates the isolated 13-entry manifest, not ciphertext authentication. The caller must
// verify the complete same-package container through EOF and its actual entry digests first.
export function validateNotificationsManifest(manifest: VolumeManifest, input: NotificationsCatalog): void {
  const catalog = validateNotificationsCatalog(input);
  const record = object(manifest, ['version', 'scope', 'exportId', 'volumeId', 'sourceSiteId', 'createdAt', 'volumeIndex', 'volumeCount', 'entries']);
  if (record.version !== 1 || record.scope !== 'replacement-backup' || record.exportId !== catalog.package_id
    || record.sourceSiteId !== catalog.site_id || record.volumeIndex !== 1 || record.volumeCount !== 1) invalid();
  const entries = array(record.entries, NOTIFICATIONS_TABLE_KEYS.length);
  if (entries.length !== NOTIFICATIONS_TABLE_KEYS.length) invalid();
  for (let index = 0; index < NOTIFICATIONS_TABLE_KEYS.length; index++) {
    const entry = object(entries[index], ['path', 'kind', 'bytes', 'sha256']);
    if (entry.path !== notificationsEntryPath(catalog.tables[index].key) || entry.kind !== 'ndjson'
      || entry.bytes !== catalog.tables[index].bytes) invalid();
    hash(entry.sha256);
  }
}
function unicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) invalid();
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
}
function timestamp(value: unknown): void {
  if (typeof value !== 'string') invalid();
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.[0-9]{1,6})?(Z|\+00:00)$/.exec(value);
  if (!match || match[0].length !== value.length) invalid();
  const [, ys, ms, ds, hs, mins, ss] = match;
  const y = Number(ys), m = Number(ms), d = Number(ds);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hs) > 23 || Number(mins) > 59 || Number(ss) > 59) invalid();
}
// Source whitelist copied from the fixed transfer-scope inventory. No runtime inventory access.
// Composite tables add only the protocol's virtual id; recipient lease fields are never admitted.
const SPEC: Record<NotificationsTableKey, Record<string, string>> = {
  notification_automation_plans: { id: 'uuid!', owner_admin_id: 'uuid!', name: 'text!', description: 'text!', status: 'text!',
    created_at: 'time!', updated_at: 'time!', activated_at: 'time' },
  notification_automation_tasks: { id: 'uuid!', owner_admin_id: 'uuid!', source_task_id: 'uuid', source_version: 'integer',
    name: 'text!', description: 'text!', status: 'text!', is_shared_template: 'boolean!', trigger_type: 'text!', trigger_mode: 'text!',
    threshold_value: 'numeric!', minimum_daily_orders: 'integer', minimum_daily_work_minutes: 'integer', recipient_scope: 'text!',
    title_template: 'text!', content_template: 'text!', message_type: 'text!', priority: 'text!', reward_enabled: 'boolean!',
    reward_amount: 'numeric', starts_at: 'time', ends_at: 'time', version: 'integer!', activated_at: 'time', created_at: 'time!',
    updated_at: 'time!', annual_month: 'smallint', annual_day: 'smallint', delivery_mode: 'text!', plan_id: 'uuid' },
  notification_automation_plan_members: { id: 'text!', plan_id: 'uuid!', user_id: 'uuid!', created_at: 'time!' },
  notification_automation_task_recipients: { id: 'text!', task_id: 'uuid!', user_id: 'uuid!', created_at: 'time!' },
  notification_automation_progress: { id: 'text!', task_id: 'uuid!', user_id: 'uuid!', last_metric: 'numeric!', last_stage: 'bigint!',
    last_period_key: 'text!', updated_at: 'time!' },
  notification_automation_executions: { id: 'uuid!', task_id: 'uuid', task_version: 'integer!', owner_admin_id: 'uuid', user_id: 'uuid',
    employee_username: 'text!', period_key: 'text!', stage: 'bigint!', actual_value: 'numeric!', trigger_snapshot: 'snapshot!',
    title_snapshot: 'text!', content_snapshot: 'text!', reward_amount: 'numeric', reward_currency: 'text', message_id: 'uuid',
    wallet_transaction_id: 'uuid', status: 'text!', error_message: 'text', executed_at: 'time!', completed_at: 'time', plan_id: 'uuid' },
  notification_automation_date_runs: { id: 'text!', task_id: 'uuid!', task_version: 'integer!', period_key: 'text!', created_at: 'time!' },
  notification_automation_failures: { id: 'text!', task_id: 'uuid!', user_id: 'uuid!', owner_admin_id: 'uuid!', attempts: 'integer!',
    last_error: 'text!', first_failed_at: 'time!', last_failed_at: 'time!' },
  messages: { id: 'uuid!', sender_id: 'uuid!', sender_username: 'text!', title: 'text!', content: 'text!', message_type: 'text!',
    priority: 'text!', expires_at: 'time', created_at: 'time', notification_category: 'text!', reward_amount: 'numeric', reward_currency: 'text',
    automation_execution_id: 'uuid', delivery_mode: 'text!', audit_origin: 'text!' },
  message_recipients: { id: 'uuid!', message_id: 'uuid!', recipient_id: 'uuid!', is_read: 'boolean', read_at: 'time', is_shown: 'boolean',
    shown_at: 'time', created_at: 'time', delivery_channel: 'text', delivered_at: 'time', delivery_sequence: 'bigint!' },
  message_templates: { id: 'uuid!', admin_id: 'uuid!', name: 'text!', title: 'text!', content: 'text!', message_type: 'text!', priority: 'text!',
    sort_order: 'integer!', created_at: 'time!', updated_at: 'time!', delivery_mode: 'text!' },
  broadcast_messages: { id: 'uuid!', admin_id: 'uuid', message_content: 'text!', message_type: 'text!', image_url: 'text', target_type: 'text!',
    target_admin_id: 'uuid', sent_count: 'integer', created_at: 'time' },
  broadcast_recipients: { id: 'uuid!', broadcast_id: 'uuid!', employee_id: 'uuid!', is_read: 'boolean', read_at: 'time', created_at: 'time' },
};
const TRIGGERS = ['total_orders', 'daily_orders', 'work_days', 'commission_amount', 'consecutive_work_days', 'annual_date', 'first_login'];
const MODES = ['reach_once', 'recurring'];
function enumeration(value: unknown, allowed: readonly string[]): void { if (!allowed.includes(value as string)) invalid(); }
function integer(value: unknown, min = -2147483648, max = 2147483647): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid();
}
function numeric(value: unknown): void { if (typeof value !== 'number' || !Number.isFinite(value)) invalid(); }
function bigint(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 20) invalid();
  const match = /^(?:0|-?[1-9][0-9]*)$/.exec(value);
  if (!match || match[0] !== value) invalid();
  const result = BigInt(value);
  if (result < -9223372036854775808n || result > 9223372036854775807n) invalid();
  return result;
}
function period(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) invalid();
  const match = /^[A-Za-z0-9:._-]{1,128}$/.exec(value);
  if (!match || match[0] !== value) invalid();
  return value;
}
function snapshot(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const required = ['trigger_type', 'trigger_mode', 'threshold_value', 'minimum_daily_orders', 'minimum_daily_work_minutes'];
  const optional = ['annual_month', 'annual_day'].filter(key => Object.getOwnPropertyDescriptor(value, key) !== undefined);
  const record = object(value, [...required, ...optional]);
  enumeration(record.trigger_type, TRIGGERS); enumeration(record.trigger_mode, MODES); numeric(record.threshold_value);
  // SQL NULL settings inside an actual snapshot object remain null; JSON null is not a snapshot.
  for (const field of ['minimum_daily_orders', 'minimum_daily_work_minutes']) if (record[field] !== null) integer(record[field]);
  for (const field of optional) if (record[field] !== null) integer(record[field], -32768, 32767);
}
export function notificationsCursor(key: NotificationsTableKey, value: unknown): string {
  notificationsTableKey(key);
  if (typeof value !== 'string') invalid();
  if (key === 'notification_automation_task_recipients' || key === 'notification_automation_progress' || key === 'notification_automation_failures') {
    if (value.length !== 73 || value[36] !== ':') invalid();
    uuid(value.slice(0, 36)); uuid(value.slice(37));
  } else if (key === 'notification_automation_date_runs') {
    if (value.length < 49 || value[36] !== ':' || value[47] !== ':' || !/^[0-9]{10}$/.test(value.slice(37, 47))) invalid();
    uuid(value.slice(0, 36)); integer(Number(value.slice(37, 47)), 1); period(value.slice(48));
  } else uuid(value);
  return value;
}
// JSON.parse discards duplicate/escaped-equivalent keys. Check every object, with bounded depth.
function checkJson(line: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '{' || char === '[') {
      if (stack.length === 32) invalid();
      stack.push(char === '{' ? new Set<string>() : null);
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = index;
      while (++index < line.length) {
        if (line[index] === '\\') index++;
        else if (line[index] === '"') break;
      }
      const decoded: unknown = JSON.parse(line.slice(start, index + 1));
      if (typeof decoded !== 'string') invalid();
      unicode(decoded);
      let after = index + 1;
      while (line[after] === ' ' || line[after] === '\t' || line[after] === '\r' || line[after] === '\n') after++;
      if (line[after] === ':') {
        const keys = stack[stack.length - 1];
        if (!keys || keys.has(decoded)) invalid();
        keys.add(decoded);
      }
    }
  }
}
export function validateNotificationsRow(line: string, key: NotificationsTableKey): string {
  if (typeof line !== 'string' || line.length > limits.maxLineBytes) invalid();
  unicode(line);
  const bytes = encoder.encode(line);
  if (bytes.length + (line.endsWith('\n') ? 0 : 1) > limits.maxLineBytes) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { invalid(); }
  const spec = SPEC[notificationsTableKey(key)], row = object(parsed, Object.keys(spec));
  checkJson(line);
  for (const [field, type] of Object.entries(spec)) {
    const value = row[field];
    if (value === null) { if (type.endsWith('!')) invalid(); continue; }
    switch (type.replace('!', '')) {
      case 'uuid': uuid(value); break;
      case 'text': if (typeof value !== 'string') invalid(); break;
      case 'boolean': if (typeof value !== 'boolean') invalid(); break;
      case 'integer': integer(value); break;
      case 'smallint': integer(value, -32768, 32767); break;
      case 'bigint': bigint(value); break;
      // Validation only. Original numeric lexemes/microseconds/UTF-8 bytes are never reserialized.
      case 'numeric': numeric(value); break;
      case 'time': timestamp(value); break;
      case 'snapshot': snapshot(value); break;
      default: invalid();
    }
  }
  for (const field of ['period_key', 'last_period_key']) if (field in row) period(row[field]);
  if (key === 'notification_automation_plan_members' && row.id !== row.user_id) invalid();
  if (key === 'notification_automation_task_recipients' || key === 'notification_automation_progress' || key === 'notification_automation_failures') {
    if (row.id !== `${row.task_id}:${row.user_id}`) invalid();
  }
  if (key === 'notification_automation_date_runs') {
    integer(row.task_version, 1);
    if (row.id !== `${row.task_id}:${String(row.task_version).padStart(10, '0')}:${row.period_key}`) invalid();
  }
  if (key === 'notification_automation_executions') {
    enumeration(row.status, ['processing', 'succeeded', 'failed']);
    integer(row.task_version, 1);
    if (bigint(row.stage) <= 0n || (row.error_message !== null && row.error_message !== 'redacted migration error')) invalid();
  }
  if (key === 'notification_automation_failures' && row.last_error !== 'redacted migration error') invalid();
  if (key === 'notification_automation_progress' && bigint(row.last_stage) < 0n) invalid();
  if (key === 'message_recipients') {
    if (bigint(row.delivery_sequence) <= 0n) invalid();
    if (row.delivery_channel !== null) enumeration(row.delivery_channel, ['realtime', 'login_popup']);
  }
  if (key === 'notification_automation_plans') enumeration(row.status, ['active', 'paused', 'archived']);
  if (key === 'notification_automation_tasks') {
    enumeration(row.status, ['draft', 'active', 'paused']); enumeration(row.trigger_type, TRIGGERS); enumeration(row.trigger_mode, MODES);
    enumeration(row.recipient_scope, ['all_managed', 'selected']);
  }
  if (key === 'messages' || key === 'message_templates' || key === 'notification_automation_tasks') {
    enumeration(row.message_type, ['login_popup', 'realtime']); enumeration(row.priority, ['low', 'normal', 'high', 'urgent']);
    enumeration(row.delivery_mode, ['realtime_only', 'login_only', 'realtime_with_login_fallback']);
  }
  if (key === 'messages') {
    enumeration(row.notification_category, ['standard', 'performance_reward']); enumeration(row.audit_origin, ['manual_admin', 'automation', 'unverified']);
  }
  if (key === 'broadcast_messages') {
    enumeration(row.message_type, ['text', 'image']); enumeration(row.target_type, ['all', 'admin_group', 'specific_employees']);
  }
  // Cross-row links, reward consistency and real CHECK constraints are owned by SQL preflight.
  return notificationsCursor(key, row.id);
}
export interface NotificationsPage {
  table_key: NotificationsTableKey; count: number; ndjson: string; next_after: string | null; sha256: string;
}
export function validateNotificationsPage(value: unknown, key: NotificationsTableKey, after: string | null): NotificationsPage {
  const record = object(value, ['table_key', 'count', 'ndjson', 'next_after', 'sha256']);
  if (record.table_key !== notificationsTableKey(key) || typeof record.ndjson !== 'string' || record.ndjson.length > limits.maxPageBytes) invalid();
  unicode(record.ndjson);
  const bytes = encoder.encode(record.ndjson), size = count(record.count, limits.maxPageRows);
  if (bytes.length > limits.maxPageBytes || (bytes.length > 0 && bytes[bytes.length - 1] !== 10)
    || new Sha256().update(bytes).digestHex() !== hash(record.sha256)) invalid();
  let last = after === null ? null : notificationsCursor(key, after), rows = 0, start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    if (end - start + 1 > limits.maxLineBytes) invalid();
    const id = validateNotificationsRow(decoder.decode(bytes.subarray(start, end)), key);
    // All cursors are ASCII: JS dictionary order equals PostgreSQL id COLLATE "C" text order.
    if (last !== null && id <= last) invalid();
    last = id; rows++; start = end + 1;
  }
  const next = record.next_after === null ? null : notificationsCursor(key, record.next_after);
  if (rows !== size || (next !== null && (size === 0 || next !== last))) invalid();
  return { table_key: key, count: size, ndjson: record.ndjson, next_after: next, sha256: hash(record.sha256) };
}
export function validateNotificationsStage(value: unknown, rows: number, bytes: number, digest: string): {
  success: true; rows: number; bytes: number; sha256: string; repeated: boolean;
} {
  const record = object(value, ['success', 'rows', 'bytes', 'sha256', 'repeated']);
  if (record.success !== true || typeof record.repeated !== 'boolean' || record.rows !== rows || record.bytes !== bytes || hash(record.sha256) !== digest) invalid();
  return { success: true, rows, bytes, sha256: digest, repeated: record.repeated };
}
// Bounded state: one input fragment, one line and two incremental digests per table.
class TableVerifier {
  private readonly line = new Uint8Array(limits.maxLineBytes);
  private readonly digest = new Sha256();
  private readonly rowHashes = new Sha256();
  private last: string | null = null;
  private used = 0;
  private rows = 0;
  private bytes = 0;
  constructor(private readonly expected: NotificationsTableCatalog) {}
  async push(input: Uint8Array, signal?: AbortSignal, onLine?: (text: string, raw: Uint8Array) => Promise<void>): Promise<void> {
    checkAbort(signal);
    if (!(input instanceof Uint8Array) || input.length > limits.maxInputBytes) invalid();
    this.bytes += input.length;
    if (this.bytes > this.expected.bytes) invalid();
    const chunk = new Uint8Array(input);
    this.digest.update(chunk);
    let start = 0;
    while (start < chunk.length) {
      checkAbort(signal);
      const lf = chunk.indexOf(10, start), end = lf === -1 ? chunk.length : lf + 1;
      if (this.used + end - start > this.line.length) invalid();
      this.line.set(chunk.subarray(start, end), this.used); this.used += end - start; start = end;
      if (lf !== -1) {
        if (++this.rows > this.expected.rows) invalid();
        const raw = this.line.subarray(0, this.used), text = decoder.decode(raw);
        const id = validateNotificationsRow(text, this.expected.key);
        if (this.last !== null && id <= this.last) invalid();
        this.last = id;
        this.rowHashes.update(encoder.encode(new Sha256().update(raw).digestHex()));
        if (onLine) await onLine(text, raw);
        checkAbort(signal); this.used = 0;
      }
    }
  }
  finish(): string {
    if (this.used || this.rows !== this.expected.rows || this.bytes !== this.expected.bytes || this.rowHashes.digestHex() !== this.expected.row_hashes_sha256) invalid();
    return this.digest.digestHex();
  }
}
export async function exportNotificationsData(
  source: NotificationsExportSource, sink: TemporaryTransferSink, options: NotificationsTransferOptions = {},
): Promise<NotificationsExportResult> {
  const { signal, onProgress } = options;
  try {
    const catalog = validateNotificationsCatalog(await withSignal(() => source.catalog(signal), signal));
    const entries: NotificationsExportResult['entries'] = [];
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      const verifier = new TableVerifier(table), path = notificationsEntryPath(table.key);
      let after: string | null = null;
      do {
        const page = validateNotificationsPage(await withSignal(() => source.page(table.key, after, signal), signal), table.key, after);
        const raw = encoder.encode(page.ndjson), pageBytes = raw.length;
        await verifier.push(raw, signal);
        await withSignal(() => sink.append(path, raw, signal), signal);
        checkAbort(signal);
        rows += page.count; bytes += pageBytes;
        onProgress?.({ scope: 'site-notifications', phase: 'export', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal); after = page.next_after;
      } while (after !== null);
      entries.push({ path, kind: 'ndjson', bytes: table.bytes, sha256: verifier.finish() });
    }
    validateNotificationsVerification(await withSignal(() => source.verify(signal), signal));
    checkAbort(signal);
    return { catalog, entries, rows, bytes, fullSiteComplete: false };
  } catch {
    try { await sink.abort(new Error('Notifications export discarded.')); } catch { throw new NotificationsTransferCleanupError(); }
    checkAbort(signal);
    throw new Error('Notifications export validation, source verification or temporary write failed.');
  }
}
async function scanTable(
  files: NotificationsImportFiles, table: NotificationsTableCatalog, signal?: AbortSignal,
  onLine?: (text: string, raw: Uint8Array) => Promise<void>,
): Promise<void> {
  checkAbort(signal);
  const source = files.open(notificationsEntryPath(table.key));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  if (source && 'getReader' in source && typeof source.getReader === 'function') reader = source.getReader();
  else if (source && Symbol.asyncIterator in source && typeof source[Symbol.asyncIterator] === 'function') iterator = source[Symbol.asyncIterator]();
  else invalid();
  const verifier = new TableVerifier(table);
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
      try { if (!ended) void reader.cancel().catch(() => undefined); } finally { reader.releaseLock(); }
    } else if (!ended && iterator?.return) {
      try { void Promise.resolve(iterator.return()).catch(() => undefined); } catch { /* Do not await a blocked producer. */ }
    }
  }
}
export async function stageNotificationsImport(
  input: unknown, files: NotificationsImportFiles, target: NotificationsImportTarget, options: NotificationsTransferOptions = {},
): Promise<NotificationsImportResult> {
  const { signal, onProgress } = options;
  let stagingMayExist = false;
  let outcome: { result: NotificationsImportResult } | { error: unknown };
  try {
    checkAbort(signal);
    const catalog = validateNotificationsCatalog(input);
    let checkedRows = 0, checkedBytes = 0;
    for (const table of catalog.tables) {
      await scanTable(files, table, signal);
      checkedRows += table.rows; checkedBytes += table.bytes;
      onProgress?.({ scope: 'site-notifications', phase: 'validate', tableKey: table.key, rows: checkedRows, bytes: checkedBytes, fullSiteComplete: false });
      checkAbort(signal);
    }
    validateNotificationsBind(await withSignal(() => {
      stagingMayExist = true;
      return target.bind(validateNotificationsCatalog(catalog), signal);
    }, signal));
    checkAbort(signal);
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      let chunkNo = 0, pageRows = 0, pageBytes = 0, page = '', digest = new Sha256();
      const flush = async () => {
        count(chunkNo, limits.maxChunks - 1);
        validateNotificationsStage(await withSignal(() => target.stage(table.key, chunkNo, page, signal), signal), pageRows, pageBytes, digest.digestHex());
        checkAbort(signal);
        rows += pageRows; bytes += pageBytes; chunkNo++;
        pageRows = 0; pageBytes = 0; page = ''; digest = new Sha256();
        onProgress?.({ scope: 'site-notifications', phase: 'stage', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal);
      };
      await scanTable(files, table, signal, async (text, raw) => {
        if (pageBytes + raw.length > limits.maxPageBytes) await flush();
        page += text; pageRows++; pageBytes += raw.length; digest.update(raw);
        if (pageRows === limits.maxPageRows || pageBytes === limits.maxPageBytes) await flush();
      });
      if (pageRows || chunkNo === 0) await flush();
    }
    const plan = validateNotificationsPlan(await withSignal(() => target.plan(signal), signal));
    if (catalog.tables.some(table => plan.counts[table.key] !== table.rows) || plan.employees !== catalog.identity_catalog.tables[0].rows) invalid();
    checkAbort(signal);
    onProgress?.({ scope: 'site-notifications', phase: 'plan', rows, bytes, fullSiteComplete: false });
    checkAbort(signal);
    outcome = { result: { plan, rows, bytes, fullSiteComplete: false } };
  } catch { outcome = { error: true }; }
  try { await files.abort(new Error('Notifications import plaintext discarded.')); }
  catch { throw new NotificationsTransferCleanupError(stagingMayExist); }
  // Cancellation during cleanup cannot prove absence of server staging, even after plan success.
  if (signal?.aborted && stagingMayExist) throw new NotificationsImportStagingMayExistError(true);
  if ('error' in outcome) {
    if (stagingMayExist) throw new NotificationsImportStagingMayExistError(signal?.aborted === true);
    checkAbort(signal);
    throw new Error('Notifications import stopped before server staging began.');
  }
  checkAbort(signal);
  return outcome.result;
}
