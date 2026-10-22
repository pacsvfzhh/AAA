import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';

export interface SourceCutoff {
  version: 1; policy: 'drained-queue-v1'; site_id: string; cutoff_id: string; frozen_at: string; cutoff_hash: string;
}
export interface SourceCutoverStatus {
  version: 1; success: true; scope: 'source-cutover'; site_id: string; frozen: boolean;
  cutoff: SourceCutoff | null; blockers: string[];
  counts: { pending_automation: number; failed_automation: number; processing_orders: number };
  full_site_complete: false;
}
const { object, uuid, hash, count, checkAbort } = dispatchTransferChecks;
const blockerKeys = ['pending_automation', 'failed_automation', 'processing_orders', 'transfer_running', 'other_maintenance'];
let activeWrite = false;
let uncertainWrite = false;
function invalid(): never { throw new Error('Source cutover state could not be confirmed. Refresh before any explicit recovery; no automatic retry or rollback was performed.'); }
export function validateSourceCutoff(value: unknown): SourceCutoff {
  const r = object(value, ['version', 'policy', 'site_id', 'cutoff_id', 'frozen_at', 'cutoff_hash']);
  if (r.version !== 1 || r.policy !== 'drained-queue-v1' || typeof r.frozen_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(r.frozen_at)
    || !Number.isFinite(Date.parse(r.frozen_at))) invalid();
  const cutoff: SourceCutoff = { version: 1, policy: 'drained-queue-v1', site_id: uuid(r.site_id), cutoff_id: uuid(r.cutoff_id),
    frozen_at: r.frozen_at, cutoff_hash: hash(r.cutoff_hash) };
  // PostgreSQL jsonb text orders these fixed ASCII keys by byte length, then bytes.
  const raw = `{"policy": "drained-queue-v1", "site_id": "${cutoff.site_id}", "version": 1, "cutoff_id": "${cutoff.cutoff_id}", "frozen_at": "${cutoff.frozen_at}"}`;
  if (new Sha256().update(new TextEncoder().encode(raw)).digestHex() !== cutoff.cutoff_hash) invalid();
  return cutoff;
}
function validateStatus(value: unknown): SourceCutoverStatus {
  const r = object(value, ['version', 'success', 'scope', 'site_id', 'frozen', 'cutoff', 'blockers', 'counts', 'full_site_complete']);
  if (r.version !== 1 || r.success !== true || r.scope !== 'source-cutover' || typeof r.frozen !== 'boolean'
    || r.full_site_complete !== false || !Array.isArray(r.blockers) || r.blockers.length > blockerKeys.length
    || Object.keys(r.blockers).length !== r.blockers.length || new Set(r.blockers).size !== r.blockers.length
    || r.blockers.some(v => typeof v !== 'string' || !blockerKeys.includes(v))) invalid();
  const site = uuid(r.site_id), cutoff = r.cutoff === null ? null : validateSourceCutoff(r.cutoff);
  if (r.frozen !== (cutoff !== null) || (cutoff && cutoff.site_id !== site)) invalid();
  const counts = object(r.counts, ['pending_automation', 'failed_automation', 'processing_orders']);
  const checked = { pending_automation: count(counts.pending_automation), failed_automation: count(counts.failed_automation),
    processing_orders: count(counts.processing_orders) };
  for (const key of ['pending_automation', 'failed_automation', 'processing_orders'] as const) {
    if (r.blockers.includes(key) !== (checked[key] > 0) || (r.frozen && checked[key] !== 0)) invalid();
  }
  return { version: 1, success: true, scope: 'source-cutover', site_id: site, frozen: r.frozen, cutoff,
    blockers: r.blockers.slice(), counts: checked, full_site_complete: false };
}
type Rpc = 'get_employee_export_cutover_status' | 'employee_export_cutover_freeze' | 'employee_export_cutover_resume';
async function request(name: Rpc, args: { p_admin_password?: string; p_confirmation?: string; p_cutoff_id?: string }, signal?: AbortSignal): Promise<SourceCutoverStatus> {
  checkAbort(signal);
  const write = name !== 'get_employee_export_cutover_status';
  if (activeWrite || (write && uncertainWrite)) invalid();
  if (write) activeWrite = true;
  try {
    const query = supabase.rpc(name, { p_admin_session_token: getAdminFinancialSessionToken(), ...args });
    const result = await (signal ? query.abortSignal(signal) : query);
    checkAbort(signal);
    if (result.error) invalid();
    const status = validateStatus(result.data);
    if ((name === 'employee_export_cutover_freeze' && !status.frozen)
      || (name === 'employee_export_cutover_resume' && status.frozen)) invalid();
    if (!write) uncertainWrite = false;
    return status;
  } catch {
    if (write) uncertainWrite = true;
    checkAbort(signal); return invalid();
  }
  finally { if (write) activeWrite = false; }
}
export const getSourceCutoverStatus = (signal?: AbortSignal): Promise<SourceCutoverStatus> => request('get_employee_export_cutover_status', {}, signal);
export async function freezeSourceCutover(adminPassword: string, confirmation: string, signal?: AbortSignal): Promise<SourceCutoverStatus> {
  try {
    if (confirmation !== '確認暫停舊站業務並導出' || !adminPassword) invalid();
    return await request('employee_export_cutover_freeze', { p_admin_password: adminPassword, p_confirmation: confirmation }, signal);
  } finally { adminPassword = ''; }
}
export async function resumeSourceCutover(adminPassword: string, confirmation: string, cutoffId: string, signal?: AbortSignal): Promise<SourceCutoverStatus> {
  try {
    if (confirmation !== '確認恢復舊站業務並放棄切站' || !adminPassword) invalid();
    const result = await request('employee_export_cutover_resume', { p_admin_password: adminPassword, p_confirmation: confirmation,
      p_cutoff_id: uuid(cutoffId) }, signal);
    if (result.frozen) invalid();
    return result;
  } finally { adminPassword = ''; }
}
