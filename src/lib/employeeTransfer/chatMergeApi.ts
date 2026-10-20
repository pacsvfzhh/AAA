import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import {
  CHAT_TABLE_KEYS, CHAT_CONFLICT_REASONS, CHAT_TRANSFER_LIMITS, chatCursor, chatTableKey,
  validateChatCatalog, validateChatBackupPage, type ChatCatalog, type ChatCounts,
} from './chatTransfer';
import type { ChatBackupDescriptor, ChatBackupReceiver, ChatBackupSource } from './chatBackup';

const { object, count, withSignal } = dispatchTransferChecks;
export const CHAT_MERGE_CONFLICT_REASONS = Object.freeze([
  ...CHAT_CONFLICT_REASONS, 'chat_target_role_invalid', 'chat_role_uuid_collision', 'chat_role_number_collision',
] as const);
const failure = 'Chat merge request outcome is unknown or unconfirmed; server backup data or a seal may exist. Reconcile before retrying. No automatic retry, rollback, restore, apply, cancel or close was performed. Media is not included in this records-only backup.';
function invalid(): never { throw new Error(failure); }
function aborted(signal?: AbortSignal): boolean {
  try { return signal?.aborted === true; } catch { invalid(); }
}
function checkAbort(signal?: AbortSignal): void {
  if (aborted(signal)) throw new DOMException(failure, 'AbortError');
}
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
export interface ChatMergeDecision {
  source_id: string; target_id: string | null; allow_visibility: boolean; confirmed: true;
}
export interface ChatMergeRole {
  source_id: string; target_id: string; action: 'create' | 'merge'; number: string;
  visibility_employee_ids: string[]; allow_visibility: boolean; multi_source_target: boolean;
}
export interface ChatMergePlan {
  scope: 'chat-merge'; checked: true; decisions: ChatMergeDecision[]; roles: ChatMergeRole[];
  counts: ChatCounts; conflicts: typeof CHAT_MERGE_CONFLICT_REASONS[number][];
  can_prepare_backup: boolean; can_restore: false; backup_required: true; media_pending: true;
  maintenance: true; replacement_ready: false; full_site_complete: false; target_hash: string; plan_hash: string;
}
export function validateChatMergeDecisions(value: unknown): ChatMergeDecision[] {
  try {
    const decisions = list(value, CHAT_TRANSFER_LIMITS.maxRoles).map(value => {
      const item = object(value, ['source_id', 'target_id', 'allow_visibility', 'confirmed']);
      if (typeof item.allow_visibility !== 'boolean' || item.confirmed !== true) invalid();
      return { source_id: uuid(item.source_id), target_id: item.target_id === null ? null : uuid(item.target_id),
        allow_visibility: item.allow_visibility, confirmed: true as const };
    });
    if (new Set(decisions.map(d => d.source_id)).size !== decisions.length
      || new TextEncoder().encode(JSON.stringify(decisions)).length > 1024 * 1024) invalid();
    return decisions.sort((a, b) => a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0);
  } catch { invalid(); }
}
export function validateChatMergePlan(value: unknown, input: ChatCatalog): ChatMergePlan {
  try {
    const catalog = validateChatCatalog(input);
    const record = object(value, ['scope', 'checked', 'decisions', 'roles', 'counts', 'conflicts', 'can_prepare_backup',
      'can_restore', 'backup_required', 'media_pending', 'maintenance', 'replacement_ready', 'full_site_complete', 'target_hash', 'plan_hash']);
    if (record.scope !== 'chat-merge' || record.checked !== true || record.can_restore !== false || record.backup_required !== true
      || record.media_pending !== true || record.maintenance !== true || record.replacement_ready !== false || record.full_site_complete !== false) invalid();
    const decisions = validateChatMergeDecisions(record.decisions);
    const suppliedOrder = list(record.decisions, CHAT_TRANSFER_LIMITS.maxRoles).map(d => object(d, ['source_id', 'target_id', 'allow_visibility', 'confirmed']).source_id);
    if (decisions.some((d, i) => d.source_id !== suppliedOrder[i]) || decisions.length !== catalog.tables[0].rows) invalid();
    const rawCounts = object(record.counts, CHAT_TABLE_KEYS);
    for (const table of catalog.tables) if (rawCounts[table.key] !== table.rows) invalid();
    const conflicts = list(record.conflicts, CHAT_MERGE_CONFLICT_REASONS.length).map(value => {
      const reason = CHAT_MERGE_CONFLICT_REASONS.find(reason => reason === value);
      if (!reason) invalid();
      return reason;
    });
    if (conflicts.some((reason, i) => i > 0 && reason <= conflicts[i - 1]) || record.can_prepare_backup !== (conflicts.length === 0)) invalid();
    const roles = list(record.roles, CHAT_TRANSFER_LIMITS.maxRoles).map((value, index): ChatMergeRole => {
      const role = object(value, ['source_id', 'target_id', 'action', 'number', 'visibility_employee_ids', 'allow_visibility', 'multi_source_target']);
      const decision = decisions[index];
      if (!decision || role.source_id !== decision.source_id || role.target_id !== (decision.target_id ?? decision.source_id)
        || role.action !== (decision.target_id === null ? 'create' : 'merge') || role.allow_visibility !== decision.allow_visibility
        || typeof role.number !== 'string' || typeof role.multi_source_target !== 'boolean') invalid();
      // Do not interpret names, avatars or visibility locally; only enforce the SQL receipt shape.
      const visibility = list(role.visibility_employee_ids, catalog.identity_catalog.tables[0].rows).map(uuid);
      if (visibility.some((id, i) => i > 0 && id <= visibility[i - 1]) || (role.action === 'create' && visibility.length)) invalid();
      return { source_id: uuid(role.source_id), target_id: uuid(role.target_id), action: decision.target_id === null ? 'create' : 'merge', number: role.number,
        visibility_employee_ids: visibility, allow_visibility: decision.allow_visibility, multi_source_target: role.multi_source_target };
    });
    if (roles.length !== decisions.length) invalid();
    const targets = new Map<string, number>();
    for (const role of roles) targets.set(role.target_id, (targets.get(role.target_id) ?? 0) + 1);
    if (roles.some(role => role.multi_source_target !== (targets.get(role.target_id)! > 1))) invalid();
    return { scope: 'chat-merge', checked: true, decisions, roles, counts: { ...rawCounts } as ChatCounts, conflicts,
      can_prepare_backup: conflicts.length === 0, can_restore: false, backup_required: true, media_pending: true,
      maintenance: true, replacement_ready: false, full_site_complete: false, target_hash: hash(record.target_hash), plan_hash: hash(record.plan_hash) };
  } catch { invalid(); }
}
async function response<T>(operation: () => PromiseLike<{ data: unknown; error: unknown }>, validate: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
  try {
    const { data, error } = await withSignal(operation, signal);
    checkAbort(signal);
    if (error) invalid();
    const result = validate(data);
    checkAbort(signal);
    return result;
  } catch {
    if (aborted(signal)) throw new DOMException(failure, 'AbortError');
    invalid();
  }
}
export interface ChatMergeBackup {
  descriptor: ChatBackupDescriptor; source: ChatBackupSource; receiver: ChatBackupReceiver;
}
export interface ChatSavedBackupChunk {
  backup_id: string; chunk_no: number; hex: string; sha256: string; bytes: number; chunks: number;
}
export interface ChatMergeSession {
  plan(decisions: ChatMergeDecision[], signal?: AbortSignal): Promise<ChatMergePlan>;
  backup(planHash: string, decisions: ChatMergeDecision[], signal?: AbortSignal): Promise<ChatMergeBackup>;
  savedChunk(backupId: string, no: number, signal?: AbortSignal): Promise<ChatSavedBackupChunk>;
}
export function createChatMergeSession(jobToken: string, input: ChatCatalog): ChatMergeSession {
  const { token, catalog } = (() => {
    try { return { token: uuid(jobToken), catalog: validateChatCatalog(input) }; } catch { invalid(); }
  })();
  // A new login session from the original super-admin can read a sealed backup after cancellation/expiry.
  const auth = () => uuid(getAdminFinancialSessionToken());
  const args = () => ({ p_admin_session_token: auth(), p_job_token: token });
  let busy = false, lastPlan: ChatMergePlan | null = null;
  const exclusive = async <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    checkAbort(signal);
    if (busy) throw new Error('A chat merge request is already in progress.');
    busy = true;
    try { return await operation(); }
    catch {
      if (aborted(signal)) throw new DOMException(failure, 'AbortError');
      invalid();
    } finally { busy = false; }
  };
  return {
    plan(decisions, signal) {
      lastPlan = null;
      return exclusive(async () => {
        const expected = validateChatMergeDecisions(decisions);
        if (expected.length !== catalog.tables[0].rows) invalid();
        const result = await response(() => {
          const query = supabase.rpc('get_employee_import_chat_merge_plan', { ...args(), p_decisions: structuredClone(expected) });
          return signal ? query.abortSignal(signal) : query;
        }, value => {
          const plan = validateChatMergePlan(value, catalog);
          if (JSON.stringify(plan.decisions) !== JSON.stringify(expected)) invalid();
          return plan;
        }, signal);
        lastPlan = structuredClone(result);
        return result;
      }, signal);
    },
    backup(planHash, decisions, signal) {
      return exclusive(async () => {
        const expected = validateChatMergeDecisions(decisions);
        if (!lastPlan?.can_prepare_backup || hash(planHash) !== lastPlan.plan_hash
          || JSON.stringify(expected) !== JSON.stringify(lastPlan.decisions)) invalid();
        const expectedPlan = structuredClone(lastPlan);
        const validators = await import('./chatBackup');
        checkAbort(signal);
        const descriptor = await response(() => {
          const query = supabase.rpc('employee_import_chat_backup_prepare', { ...args(), p_plan_hash: planHash, p_decisions: structuredClone(expected) });
          return signal ? query.abortSignal(signal) : query;
        }, value => {
          const result = validators.validateChatBackupDescriptor(value);
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
                chatTableKey(key);
                if (after !== null) chatCursor(key, after);
                return response(() => {
                  const query = supabase.rpc('get_employee_import_chat_backup_page', { ...params(), p_table_key: key, p_after: after, p_limit: 200 });
                  return readSignal ? query.abortSignal(readSignal) : query;
                }, value => validateChatBackupPage(value, key, after), readSignal);
              }, readSignal);
            },
            verify(readSignal) {
              verified = false;
              return exclusive(async () => {
                const result = await response(() => {
                  const query = supabase.rpc('employee_import_chat_backup_verify', params());
                  return readSignal ? query.abortSignal(readSignal) : query;
                }, value => {
                  const record = object(value, ['verified', 'backup_id', 'plan_hash', 'target_hash', 'media_included', 'media_pending', 'full_site_complete']);
                  if (record.verified !== true || record.backup_id !== descriptor.backup_id || record.plan_hash !== descriptor.plan_hash
                    || record.target_hash !== descriptor.target_hash || record.media_included !== false || record.media_pending !== true || record.full_site_complete !== false) invalid();
                  return { verified: true as const, backup_id: descriptor.backup_id, plan_hash: descriptor.plan_hash,
                    target_hash: descriptor.target_hash, media_included: false as const, media_pending: true as const, full_site_complete: false as const };
                }, readSignal);
                verified = true;
                return result;
              }, readSignal);
            },
          },
          receiver: {
            append(no, hex, writeSignal) {
              return exclusive(async () => {
                if (!verified) invalid();
                count(no, 1023);
                if (typeof hex !== 'string' || hex.length < 2 || hex.length > 262144 || hex.length % 2 !== 0 || hex.match(/^[0-9a-f]+$/)?.[0] !== hex) invalid();
                const bytes = Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16));
                return response(() => {
                  const query = supabase.rpc('employee_import_chat_backup_append', { ...params(), p_chunk_no: no, p_hex: hex });
                  return writeSignal ? query.abortSignal(writeSignal) : query;
                }, value => {
                  const record = object(value, ['success', 'bytes', 'sha256', 'repeated', 'media_pending', 'full_site_complete']);
                  if (record.success !== true || record.bytes !== bytes.length || hash(record.sha256) !== new Sha256().update(bytes).digestHex()
                    || typeof record.repeated !== 'boolean' || record.media_pending !== true || record.full_site_complete !== false) invalid();
                  return { success: true as const, bytes: bytes.length, sha256: hash(record.sha256), repeated: record.repeated,
                    media_pending: true as const, full_site_complete: false as const };
                }, writeSignal);
              }, writeSignal);
            },
            seal(digest, bytes, writeSignal) {
              return exclusive(async () => {
                if (!verified) invalid();
                hash(digest); count(bytes, 9 * 1024 * 1024);
                if (bytes < 64) invalid();
                return response(() => {
                  const query = supabase.rpc('employee_import_chat_backup_seal', { ...params(), p_sha256: digest, p_bytes: bytes });
                  return writeSignal ? query.abortSignal(writeSignal) : query;
                }, value => {
                  const record = object(value, ['success', 'backup_id', 'sha256', 'bytes', 'repeated', 'media_pending', 'full_site_complete']);
                  if (record.success !== true || record.backup_id !== descriptor.backup_id || record.sha256 !== digest || record.bytes !== bytes
                    || typeof record.repeated !== 'boolean' || record.media_pending !== true || record.full_site_complete !== false) invalid();
                  return { success: true as const, backup_id: descriptor.backup_id, sha256: digest, bytes, repeated: record.repeated,
                    media_pending: true as const, full_site_complete: false as const };
                }, writeSignal);
              }, writeSignal);
            },
          },
        };
      }, signal);
    },
    savedChunk(backupId, no, signal) {
      return exclusive(async () => {
        const id = uuid(backupId); count(no, 1023);
        return response(() => {
          const query = supabase.rpc('get_employee_chat_saved_backup_chunk', { p_admin_session_token: auth(), p_backup_id: id, p_chunk_no: no });
          return signal ? query.abortSignal(signal) : query;
        }, value => {
          const record = object(value, ['backup_id', 'chunk_no', 'hex', 'sha256', 'bytes', 'chunks']);
          const bytes = count(record.bytes, 9 * 1024 * 1024), chunks = count(record.chunks, 1024);
          if (record.backup_id !== id || record.chunk_no !== no || bytes < 64 || chunks !== Math.ceil(bytes / 131072) || no >= chunks
            || typeof record.hex !== 'string' || record.hex.length > 262144 || record.hex.match(/^(?:[0-9a-f]{2})+$/)?.[0] !== record.hex
            || record.hex.length !== 2 * (no === chunks - 1 ? bytes - no * 131072 : 131072)) invalid();
          return { backup_id: id, chunk_no: no, hex: record.hex, sha256: hash(record.sha256), bytes, chunks };
        }, signal);
      }, signal);
    },
  };
}
