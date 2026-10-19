import type { TemporaryTransferSink } from './container';
import type { TransferByteSource } from './crypto';
import type { VolumeManifest } from './manifest';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import { validateIdentityCatalog, type IdentityCatalog } from './identityTransfer';
import { validateFinanceCatalog, type FinanceCatalog } from './financeTransfer';

export const CHAT_PROTOCOL = 'site-chat-v1';
export const CHAT_TABLE_KEYS = Object.freeze([
  'simulated_customers', 'cs_message_templates', 'customer_auto_messages', 'rich_card_contents',
  'customer_employee_conversations', 'customer_service_sessions', 'ccc_conversation_annotations',
  'customer_auto_message_logs', 'rating_requests', 'service_ratings',
] as const);
export type ChatTableKey = typeof CHAT_TABLE_KEYS[number];
export const CHAT_TRANSFER_LIMITS = Object.freeze({
  maxRows: 1000000, maxTableBytes: 512 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024,
  maxLineBytes: 64 * 1024, maxPageRows: 200, maxPageBytes: 256 * 1024,
  maxRoles: 2000, maxChunks: 1000001, maxInputBytes: 1024 * 1024,
});
const limits = CHAT_TRANSFER_LIMITS;
const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const EMPTY_HASH = new Sha256().digestHex();
const FLAGS = ['maintenance', 'financial_data_pending', 'dependencies_pending', 'replacement_ready', 'full_site_complete'] as const;
export interface ChatPending {
  maintenance: true; financial_data_pending: true; dependencies_pending: true;
  replacement_ready: false; full_site_complete: false;
}
export interface ChatTableCatalog {
  key: ChatTableKey; rows: number; bytes: number; row_hashes_sha256: string;
}
export interface ChatCatalog {
  version: 1; scope: 'site-chat'; site_id: string; package_id: string;
  identity_catalog: IdentityCatalog; finance_catalog: FinanceCatalog;
  tables: ChatTableCatalog[]; full_site_complete: false;
}
export type ChatCounts = Record<ChatTableKey, number>;
export const CHAT_CONFLICT_REASONS = Object.freeze([
  'source_employee_missing', 'source_admin_unmapped', 'source_reference_missing', 'source_scope_mismatch',
  'source_unique_collision', 'rich_card_unresolvable', 'source_visibility_unmapped',
] as const);
export const CHAT_ROLE_MATCHES = Object.freeze(['exact', 'name', 'ambiguous', 'number_conflict', 'new', 'unmapped'] as const);
export interface ChatRole {
  source_id: string; source_name: string; source_number: string; target_admin_id: string | null;
  source_type: 'aaa_service' | 'ccc_service'; match: typeof CHAT_ROLE_MATCHES[number]; target_id: string | null;
  candidates: { id: string; name: string; number: string }[]; needs_confirmation: boolean;
  number_occupied: boolean; visibility_employee_ids: string[]; multi_source_target: boolean;
}
export interface ChatPlan extends ChatPending {
  scope: 'site-chat'; checked: true; can_restore: false; restore_pending: true;
  media_pending: true; counts: ChatCounts; employees: number; roles: ChatRole[];
  conflicts: typeof CHAT_CONFLICT_REASONS[number][]; plan_hash: string;
}
export interface ChatExportSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(key: ChatTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(signal?: AbortSignal): Promise<unknown>;
}
export interface ChatImportTarget {
  bind(catalog: ChatCatalog, signal?: AbortSignal): Promise<unknown>;
  stage(key: ChatTableKey, chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<unknown>;
  plan(signal?: AbortSignal): Promise<unknown>;
}
export interface ChatImportFiles {
  // Before calling stageChatImport, authenticate the same-package manifest and entire
  // encrypted volume through complete EOF. Only reopen isolated, immutable plaintext files.
  open(path: string): TransferByteSource | ReadableStream<Uint8Array>;
  // Invalidate pending reads/writes and discard all temporary plaintext, including on success.
  abort(reason: unknown): Promise<void>;
}
export interface ChatProgress {
  scope: 'site-chat'; phase: 'export' | 'validate' | 'stage' | 'plan';
  tableKey?: ChatTableKey; rows: number; bytes: number; fullSiteComplete: false;
}
export interface ChatTransferOptions {
  signal?: AbortSignal; onProgress?: (progress: ChatProgress) => void;
}
export interface ChatExportResult {
  catalog: ChatCatalog; entries: { path: string; kind: 'ndjson'; bytes: number; sha256: string }[];
  rows: number; bytes: number; fullSiteComplete: false;
}
export interface ChatImportResult {
  plan: ChatPlan; rows: number; bytes: number; fullSiteComplete: false;
}
export class ChatTransferCleanupError extends Error {
  readonly cleanupRequired = true;
  constructor(readonly stagingMayExist = false) {
    super('Chat temporary plaintext cleanup was not confirmed. Do not reuse the workspace; reconcile any server staging.');
    this.name = 'ChatTransferCleanupError';
  }
}
export class ChatImportStagingMayExistError extends Error {
  readonly stagingMayExist = true;
  constructor(readonly cancelled: boolean) {
    super('Chat import stopped. Server staging may exist; reconcile before rerunning. No automatic retry, cancel, rollback, restore or close was performed.');
    this.name = 'ChatImportStagingMayExistError';
  }
}
function invalid(): never { throw new Error('Invalid chat transfer.'); }
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
export function chatTableKey(value: unknown): ChatTableKey {
  const key = CHAT_TABLE_KEYS.find(key => value === key);
  if (!key) invalid();
  return key;
}
export function chatEntryPath(key: ChatTableKey): string { return `data/chat-${chatTableKey(key)}.ndjson`; }
function pending(record: Record<string, unknown>): ChatPending {
  if (record.maintenance !== true || record.financial_data_pending !== true || record.dependencies_pending !== true
    || record.replacement_ready !== false || record.full_site_complete !== false) invalid();
  return { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
}
function counts(value: unknown): ChatCounts {
  const record = object(value, CHAT_TABLE_KEYS);
  return Object.fromEntries(CHAT_TABLE_KEYS.map(key => [key, count(record[key], limits.maxRows)])) as ChatCounts;
}
function checkDependencyHashes(identity: IdentityCatalog, finance: FinanceCatalog): void {
  // Older validators accept a trailing newline in a digest/UUID; tighten these nested contracts here.
  uuid(identity.site_id); uuid(identity.package_id); uuid(finance.site_id); uuid(finance.package_id);
  for (const table of [...identity.tables, ...finance.tables, ...finance.identity_catalog.tables]) hash(table.row_hashes_sha256);
}
export function validateChatCatalog(value: unknown): ChatCatalog {
  const record = object(value, ['version', 'scope', 'site_id', 'package_id', 'identity_catalog', 'finance_catalog',
    'tables', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'site-chat' || record.full_site_complete !== false) invalid();
  const raw = array(record.tables, CHAT_TABLE_KEYS.length);
  if (raw.length !== CHAT_TABLE_KEYS.length) invalid();
  let total = 0;
  const tables = CHAT_TABLE_KEYS.map((key, index) => {
    const table = object(raw[index], ['key', 'rows', 'bytes', 'row_hashes_sha256']);
    if (table.key !== key) invalid();
    const rows = count(table.rows, limits.maxRows), bytes = count(table.bytes, limits.maxTableBytes);
    const digest = hash(table.row_hashes_sha256);
    if ((rows === 0) !== (bytes === 0) || (rows === 0 && digest !== EMPTY_HASH)) invalid();
    if (key === 'simulated_customers' && rows > limits.maxRoles) invalid();
    total += bytes;
    return { key, rows, bytes, row_hashes_sha256: digest };
  });
  if (total > limits.maxTotalBytes) invalid();
  const site = uuid(record.site_id), packageId = uuid(record.package_id);
  const identity = validateIdentityCatalog(record.identity_catalog), finance = validateFinanceCatalog(record.finance_catalog);
  checkDependencyHashes(identity, finance);
  if (identity.site_id !== site || identity.package_id !== packageId || finance.site_id !== site || finance.package_id !== packageId
    || JSON.stringify(finance.identity_catalog) !== JSON.stringify(identity)) invalid();
  return { version: 1, scope: 'site-chat', site_id: site, package_id: packageId, identity_catalog: identity,
    finance_catalog: finance, tables, full_site_complete: false };
}
function text(value: unknown): string {
  if (typeof value !== 'string') invalid();
  unicode(value);
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function uuidArray(value: unknown): string[] { return array(value, limits.maxRows).map(uuid); }
function role(value: unknown): ChatRole {
  const record = object(value, ['source_id', 'source_name', 'source_number', 'target_admin_id', 'source_type', 'match',
    'target_id', 'candidates', 'needs_confirmation', 'number_occupied', 'visibility_employee_ids', 'multi_source_target']);
  const match = CHAT_ROLE_MATCHES.find(match => match === record.match);
  if (!match || (record.source_type !== 'aaa_service' && record.source_type !== 'ccc_service')) invalid();
  // Matching, ambiguity and confirmation decisions belong exclusively to SQL. Never infer them here.
  return { source_id: uuid(record.source_id), source_name: text(record.source_name), source_number: text(record.source_number),
    target_admin_id: record.target_admin_id === null ? null : uuid(record.target_admin_id), source_type: record.source_type,
    match, target_id: record.target_id === null ? null : uuid(record.target_id),
    candidates: array(record.candidates, limits.maxRoles).map(value => {
      const candidate = object(value, ['id', 'name', 'number']);
      return { id: uuid(candidate.id), name: text(candidate.name), number: text(candidate.number) };
    }), needs_confirmation: boolean(record.needs_confirmation), number_occupied: boolean(record.number_occupied),
    visibility_employee_ids: uuidArray(record.visibility_employee_ids), multi_source_target: boolean(record.multi_source_target) };
}
export function validateChatPlan(value: unknown): ChatPlan {
  const record = object(value, ['scope', 'checked', 'can_restore', 'restore_pending', 'media_pending',
    'counts', 'employees', 'conflicts', 'roles', 'plan_hash', ...FLAGS]);
  if (record.scope !== 'site-chat' || record.checked !== true || record.can_restore !== false
    || record.restore_pending !== true || record.media_pending !== true) invalid();
  const conflicts = array(record.conflicts, 200).map(value => {
    const reason = CHAT_CONFLICT_REASONS.find(reason => reason === value);
    if (!reason) invalid();
    return reason;
  });
  return { scope: 'site-chat', checked: true, can_restore: false, restore_pending: true, media_pending: true,
    counts: counts(record.counts), employees: count(record.employees, limits.maxRows), roles: array(record.roles, limits.maxRoles).map(role),
    conflicts, plan_hash: hash(record.plan_hash), ...pending(record) };
}
export function validateChatVerification(value: unknown): {
  verified: true; scope: 'site-chat'; media_pending: true; full_site_complete: false;
} {
  const record = object(value, ['verified', 'scope', 'media_pending', 'full_site_complete']);
  if (record.verified !== true || record.scope !== 'site-chat' || record.media_pending !== true || record.full_site_complete !== false) invalid();
  return { verified: true, scope: 'site-chat', media_pending: true, full_site_complete: false };
}
export function validateChatBind(value: unknown): { success: true; scope: 'site-chat'; full_site_complete: false; repeated: boolean } {
  const record = object(value, ['success', 'scope', 'full_site_complete', 'repeated']);
  if (record.success !== true || record.scope !== 'site-chat' || record.full_site_complete !== false
    || typeof record.repeated !== 'boolean') invalid();
  return { success: true, scope: 'site-chat', full_site_complete: false, repeated: record.repeated };
}
export function validateChatClose(value: unknown): {
  success: true; scope: 'site-chat'; media_pending: true; full_site_complete: false;
} {
  const record = object(value, ['success', 'scope', 'media_pending', 'full_site_complete']);
  if (record.success !== true || record.scope !== 'site-chat' || record.media_pending !== true || record.full_site_complete !== false) invalid();
  return { success: true, scope: 'site-chat', media_pending: true, full_site_complete: false };
}
// This validates the isolated 10-entry manifest, not ciphertext authentication. The caller must
// verify the complete same-package container through EOF and its actual entry digests first.
export function validateChatManifest(manifest: VolumeManifest, input: ChatCatalog): void {
  const catalog = validateChatCatalog(input);
  const record = object(manifest, ['version', 'scope', 'exportId', 'volumeId', 'sourceSiteId', 'createdAt', 'volumeIndex', 'volumeCount', 'entries']);
  if (record.version !== 1 || record.scope !== 'replacement-backup' || record.exportId !== catalog.package_id
    || record.sourceSiteId !== catalog.site_id || record.volumeIndex !== 1 || record.volumeCount !== 1) invalid();
  const entries = array(record.entries, CHAT_TABLE_KEYS.length);
  if (entries.length !== CHAT_TABLE_KEYS.length) invalid();
  for (let index = 0; index < CHAT_TABLE_KEYS.length; index++) {
    const entry = object(entries[index], ['path', 'kind', 'bytes', 'sha256']);
    if (entry.path !== chatEntryPath(catalog.tables[index].key) || entry.kind !== 'ndjson'
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
// Only annotations' virtual id and conversations' SQL-null marker extend the physical columns.
const SPEC: Record<ChatTableKey, Record<string, string>> = {
  simulated_customers: { id: 'uuid!', admin_id: 'uuid!', customer_name: 'text!', customer_avatar: 'text', is_active: 'boolean',
    created_at: 'time', updated_at: 'time', customer_id: 'text!', is_super: 'boolean!', super_customer_title: 'text', badge_type: 'text',
    custom_avatar_url: 'text', is_pinned: 'boolean!', vip_label: 'text', remarks: 'text', source_type: 'text!', employee_pin_top: 'boolean!',
    employee_always_visible: 'boolean!', target_employee_id: 'uuid', target_employee_ids: 'uuid[]', auto_messages_enabled: 'boolean!' },
  cs_message_templates: { id: 'uuid!', admin_id: 'text!', name: 'text!', content: 'text!', content_type: 'text!', sort_order: 'integer!',
    created_at: 'time!', updated_at: 'time!', is_pinned: 'boolean!', source_type: 'text!', title: 'text', subtitle: 'text' },
  customer_auto_messages: { id: 'uuid!', customer_id: 'uuid!', admin_id: 'text!', message_type: 'text!', name: 'text!', title: 'text',
    subtitle: 'text', content: 'text!', content_type: 'text!', sort_order: 'integer!', is_enabled: 'boolean!', created_at: 'time!', updated_at: 'time!' },
  rich_card_contents: { id: 'uuid!', html_content: 'text!', created_at: 'time!', source_template_id: 'uuid', source_auto_message_id: 'uuid', content_hash: 'text' },
  customer_employee_conversations: { id: 'uuid!', customer_id: 'uuid!', employee_id: 'uuid!', sender_type: 'text!', message_content: 'text!',
    is_read: 'boolean', created_at: 'time', message_type: 'text', image_url: 'text', rating_data: 'jsonb', read_at: 'time', source_type: 'text!',
    title: 'text', rich_card_content_id: 'uuid', subtitle: 'text', source_template_id: 'uuid', source_auto_message_id: 'uuid', content_frozen: 'boolean!',
    rating_data_sql_null: 'boolean!' },
  customer_service_sessions: { id: 'uuid!', customer_id: 'uuid!', employee_id: 'uuid!', service_ticket_number: 'text!', status: 'text!', created_at: 'time', closed_at: 'time' },
  ccc_conversation_annotations: { id: 'text!', customer_id: 'uuid!', employee_id: 'uuid!', owner_admin_id: 'uuid!', is_special: 'boolean!', note: 'text', updated_by: 'uuid', updated_at: 'time!' },
  customer_auto_message_logs: { id: 'uuid!', customer_id: 'uuid!', employee_id: 'uuid!', auto_message_id: 'uuid!', sent_at: 'time!' },
  rating_requests: { id: 'uuid!', customer_id: 'uuid!', employee_id: 'uuid!', session_id: 'uuid', status: 'text', requested_at: 'time', completed_at: 'time' },
  service_ratings: { id: 'uuid!', customer_id: 'uuid!', employee_id: 'uuid!', session_id: 'uuid', rating: 'integer!', comment: 'text', created_at: 'time' },
};
function enumeration(value: unknown, allowed: readonly string[]): void {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid();
}
function integer(value: unknown, min = -2147483648, max = 2147483647): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid();
}
export function chatCursor(key: ChatTableKey, value: unknown): string {
  chatTableKey(key);
  if (typeof value !== 'string') invalid();
  if (key === 'ccc_conversation_annotations') {
    if (value.length !== 73 || value[36] !== ':') invalid();
    uuid(value.slice(0, 36)); uuid(value.slice(37));
  } else uuid(value);
  return value;
}
// JSON.parse discards duplicate/escaped-equivalent keys. Check every object, with bounded depth.
function checkJson(line: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '{' || char === '[') {
      // The row object is depth one; rating_data itself may contain up to 32 containers.
      if (stack.length === 33) invalid();
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
export function validateChatRow(line: string, key: ChatTableKey): string {
  if (typeof line !== 'string' || line.length > limits.maxLineBytes) invalid();
  unicode(line);
  const bytes = encoder.encode(line);
  if (bytes.length + (line.endsWith('\n') ? 0 : 1) > limits.maxLineBytes) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { invalid(); }
  const spec = SPEC[chatTableKey(key)], row = object(parsed, Object.keys(spec));
  checkJson(line);
  for (const [field, type] of Object.entries(spec)) {
    const value = row[field];
    if (value === null) { if (type.endsWith('!')) invalid(); continue; }
    switch (type.replace('!', '')) {
      case 'uuid': uuid(value); break;
      case 'text': if (typeof value !== 'string') invalid(); break;
      case 'boolean': if (typeof value !== 'boolean') invalid(); break;
      case 'integer': integer(value); break;
      case 'uuid[]': uuidArray(value); break;
      case 'time': timestamp(value); break;
      // JSON.parse is only a syntax/shape check: retain the ORIGINAL numeric lexemes, including
      // integers beyond 2^53 or exponents outside JS's range. No parsed JSON is ever reserialized.
      case 'jsonb': break;
      default: invalid();
    }
  }
  if ('source_type' in row) enumeration(row.source_type, ['aaa_service', 'ccc_service']);
  if (key === 'ccc_conversation_annotations' && row.id !== `${row.customer_id}:${row.employee_id}`) invalid();
  if (key === 'customer_employee_conversations') {
    if (row.rating_data_sql_null === true && row.rating_data !== null) invalid();
    enumeration(row.sender_type, ['customer', 'employee']);
    if (row.message_type !== null) enumeration(row.message_type, ['text', 'image', 'rating_request', 'rating_result', 'tip', 'rich_card']);
  }
  if (key === 'cs_message_templates' || key === 'customer_auto_messages') enumeration(row.content_type, ['text', 'richtext', 'rich_card']);
  if (key === 'customer_auto_messages') enumeration(row.message_type, ['quick_send', 'rich_card']);
  if (key === 'customer_service_sessions') enumeration(row.status, ['active', 'closed']);
  if (key === 'rating_requests' && row.status !== null) enumeration(row.status, ['pending', 'completed', 'expired']);
  if (key === 'service_ratings') integer(row.rating, 1, 5);
  if (key === 'simulated_customers' && row.badge_type !== null) enumeration(row.badge_type, ['diamond', 'crown', 'star', 'vip', 'premium']);
  // Cross-row ownership, visibility, rich-card resolution and matching are SQL preflight decisions.
  return chatCursor(key, row.id);
}
export interface ChatPage {
  table_key: ChatTableKey; count: number; ndjson: string; next_after: string | null; sha256: string;
}
export function validateChatPage(value: unknown, key: ChatTableKey, after: string | null): ChatPage {
  const record = object(value, ['table_key', 'count', 'ndjson', 'next_after', 'sha256']);
  if (record.table_key !== chatTableKey(key) || typeof record.ndjson !== 'string' || record.ndjson.length > limits.maxPageBytes) invalid();
  unicode(record.ndjson);
  const bytes = encoder.encode(record.ndjson), size = count(record.count, limits.maxPageRows);
  if (bytes.length > limits.maxPageBytes || (bytes.length > 0 && bytes[bytes.length - 1] !== 10)
    || new Sha256().update(bytes).digestHex() !== hash(record.sha256)) invalid();
  let last = after === null ? null : chatCursor(key, after), rows = 0, start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    if (end - start + 1 > limits.maxLineBytes) invalid();
    const id = validateChatRow(decoder.decode(bytes.subarray(start, end)), key);
    // All cursors are ASCII: JS dictionary order equals PostgreSQL id COLLATE "C" text order.
    if (last !== null && id <= last) invalid();
    last = id; rows++; start = end + 1;
  }
  const next = record.next_after === null ? null : chatCursor(key, record.next_after);
  if (rows !== size || (next !== null && (size === 0 || next !== last))) invalid();
  return { table_key: key, count: size, ndjson: record.ndjson, next_after: next, sha256: hash(record.sha256) };
}
export function validateChatStage(value: unknown, rows: number, bytes: number, digest: string): {
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
  constructor(private readonly expected: ChatTableCatalog) {}
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
        const id = validateChatRow(text, this.expected.key);
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
export async function exportChatData(
  source: ChatExportSource, sink: TemporaryTransferSink, options: ChatTransferOptions = {},
): Promise<ChatExportResult> {
  const { signal, onProgress } = options;
  try {
    const catalog = validateChatCatalog(await withSignal(() => source.catalog(signal), signal));
    const entries: ChatExportResult['entries'] = [];
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      const verifier = new TableVerifier(table), path = chatEntryPath(table.key);
      let after: string | null = null;
      do {
        const page = validateChatPage(await withSignal(() => source.page(table.key, after, signal), signal), table.key, after);
        const raw = encoder.encode(page.ndjson), pageBytes = raw.length;
        await verifier.push(raw, signal);
        await withSignal(() => sink.append(path, raw, signal), signal);
        checkAbort(signal);
        rows += page.count; bytes += pageBytes;
        onProgress?.({ scope: 'site-chat', phase: 'export', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal); after = page.next_after;
      } while (after !== null);
      entries.push({ path, kind: 'ndjson', bytes: table.bytes, sha256: verifier.finish() });
    }
    validateChatVerification(await withSignal(() => source.verify(signal), signal));
    checkAbort(signal);
    return { catalog, entries, rows, bytes, fullSiteComplete: false };
  } catch {
    try { await sink.abort(new Error('Chat export discarded.')); } catch { throw new ChatTransferCleanupError(); }
    checkAbort(signal);
    throw new Error('Chat export validation, source verification or temporary write failed.');
  }
}
async function scanTable(
  files: ChatImportFiles, table: ChatTableCatalog, signal?: AbortSignal,
  onLine?: (text: string, raw: Uint8Array) => Promise<void>,
): Promise<void> {
  checkAbort(signal);
  const source = files.open(chatEntryPath(table.key));
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
export async function stageChatImport(
  input: unknown, files: ChatImportFiles, target: ChatImportTarget, options: ChatTransferOptions = {},
): Promise<ChatImportResult> {
  const { signal, onProgress } = options;
  let stagingMayExist = false;
  let outcome: { result: ChatImportResult } | { error: unknown };
  try {
    checkAbort(signal);
    const catalog = validateChatCatalog(input);
    let checkedRows = 0, checkedBytes = 0;
    for (const table of catalog.tables) {
      await scanTable(files, table, signal);
      checkedRows += table.rows; checkedBytes += table.bytes;
      onProgress?.({ scope: 'site-chat', phase: 'validate', tableKey: table.key, rows: checkedRows, bytes: checkedBytes, fullSiteComplete: false });
      checkAbort(signal);
    }
    validateChatBind(await withSignal(() => {
      stagingMayExist = true;
      return target.bind(validateChatCatalog(catalog), signal);
    }, signal));
    checkAbort(signal);
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      let chunkNo = 0, pageRows = 0, pageBytes = 0, page = '', digest = new Sha256();
      const flush = async () => {
        count(chunkNo, limits.maxChunks - 1);
        validateChatStage(await withSignal(() => target.stage(table.key, chunkNo, page, signal), signal), pageRows, pageBytes, digest.digestHex());
        checkAbort(signal);
        rows += pageRows; bytes += pageBytes; chunkNo++;
        pageRows = 0; pageBytes = 0; page = ''; digest = new Sha256();
        onProgress?.({ scope: 'site-chat', phase: 'stage', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal);
      };
      await scanTable(files, table, signal, async (text, raw) => {
        if (pageBytes + raw.length > limits.maxPageBytes) await flush();
        page += text; pageRows++; pageBytes += raw.length; digest.update(raw);
        if (pageRows === limits.maxPageRows || pageBytes === limits.maxPageBytes) await flush();
      });
      if (pageRows || chunkNo === 0) await flush();
    }
    const plan = validateChatPlan(await withSignal(() => target.plan(signal), signal));
    if (catalog.tables.some(table => plan.counts[table.key] !== table.rows) || plan.employees !== catalog.identity_catalog.tables[0].rows) invalid();
    checkAbort(signal);
    onProgress?.({ scope: 'site-chat', phase: 'plan', rows, bytes, fullSiteComplete: false });
    checkAbort(signal);
    outcome = { result: { plan, rows, bytes, fullSiteComplete: false } };
  } catch { outcome = { error: true }; }
  try { await files.abort(new Error('Chat import plaintext discarded.')); }
  catch { throw new ChatTransferCleanupError(stagingMayExist); }
  // Cancellation during cleanup cannot prove absence of server staging, even after plan success.
  if (signal?.aborted && stagingMayExist) throw new ChatImportStagingMayExistError(true);
  if ('error' in outcome) {
    if (stagingMayExist) throw new ChatImportStagingMayExistError(signal?.aborted === true);
    checkAbort(signal);
    throw new Error('Chat import stopped before server staging began.');
  }
  checkAbort(signal);
  return outcome.result;
}
