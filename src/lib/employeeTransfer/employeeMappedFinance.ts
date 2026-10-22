import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import { FINANCE_CONFLICT_REASONS, FINANCE_TABLE_KEYS, FINANCE_TRANSFER_LIMITS, financeTableKey,
  validateFinanceCatalog, validateFinancePage, type FinanceCatalog, type FinanceTableKey } from './financeTransfer';
import { Sha256 } from './sha256';

const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const limits = FINANCE_TRANSFER_LIMITS;
const encoder = new TextEncoder();
const failure = 'Mapped employee finance request is unconfirmed. Reconcile the original task with an explicit status request (the same source employee after an unknown apply) before further writes. Status requires complete staging; if rejected, pause and reconcile the original task. No automatic retry, account enablement, archive, replacement or maintenance release was performed.';
const SCOPE = 'employee-mapped-finance';
const ZERO = '00000000-0000-0000-0000-000000000000';
const BINDING_KEYS = ['job_id', 'site_id', 'source_site_id', 'package_id', 'catalog_hash', 'mapping_hash', 'plan_hash'] as const;
const COMMON_KEYS = [...BINDING_KEYS, 'scope', 'totals', 'employees', 'pending_withdrawals', 'maintenance',
  'dependencies_pending', 'financial_data_pending', 'can_restore', 'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete'];
export type EmployeeMappedFinanceCounts = Readonly<Record<FinanceTableKey, number>>;
export type EmployeeMappedFinanceConflict = typeof FINANCE_CONFLICT_REASONS[number];
interface Common {
  readonly scope: 'employee-mapped-finance';
  readonly job_id: string; readonly site_id: string; readonly source_site_id: string; readonly package_id: string;
  readonly catalog_hash: string; readonly mapping_hash: string; readonly plan_hash: string;
  readonly totals: EmployeeMappedFinanceCounts; readonly employees: number;
  readonly pending_withdrawals: Readonly<{ count: number; amount: string }>;
  readonly maintenance: true; readonly dependencies_pending: true; readonly financial_data_pending: true;
  readonly can_restore: false; readonly complete_employee_backup: false; readonly can_archive: false;
  readonly can_replace: false; readonly full_site_complete: false;
}
export interface EmployeeMappedFinancePlan extends Common {
  readonly can_begin: boolean; readonly conflicts: readonly EmployeeMappedFinanceConflict[];
}
export interface EmployeeMappedFinanceEmployee {
  readonly source_id: string; readonly target_id: string; readonly applied: boolean; readonly counts: EmployeeMappedFinanceCounts;
}
export interface EmployeeMappedFinanceStatus extends Common {
  readonly started: boolean; readonly completed_employees: number; readonly verified: boolean;
  readonly employee: EmployeeMappedFinanceEmployee | null;
}
export interface EmployeeMappedFinanceBindReceipt {
  readonly success: true; readonly scope: 'employee-mapped-finance'; readonly catalog_hash: string; readonly full_site_complete: false;
}
export interface EmployeeMappedFinanceStageReceipt {
  readonly success: true; readonly scope: 'employee-mapped-finance'; readonly table_key: FinanceTableKey;
  readonly chunk_no: number; readonly rows: number; readonly bytes: number; readonly sha256: string; readonly full_site_complete: false;
}
function invalid(): never { throw new Error(failure); }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36) invalid();
  return dispatchTransferChecks.uuid(value);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64) invalid();
  return dispatchTransferChecks.hash(value);
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function counts(value: unknown): EmployeeMappedFinanceCounts {
  const r = object(value, FINANCE_TABLE_KEYS);
  return Object.freeze({ wallets: count(r.wallets, limits.maxRows), wallet_balance_baselines: count(r.wallet_balance_baselines, limits.maxRows),
    wallet_ledger_entries: count(r.wallet_ledger_entries, limits.maxRows), wallet_transactions: count(r.wallet_transactions, limits.maxRows),
    withdrawals: count(r.withdrawals, limits.maxRows), wallet_reconciliation_audit: count(r.wallet_reconciliation_audit, limits.maxRows) });
}
function sameCounts(a: EmployeeMappedFinanceCounts, b: EmployeeMappedFinanceCounts): boolean {
  return FINANCE_TABLE_KEYS.every(key => a[key] === b[key]);
}
function common(r: Record<string, unknown>): Common {
  if (r.scope !== SCOPE || r.maintenance !== true || r.dependencies_pending !== true || r.financial_data_pending !== true
    || r.can_restore !== false || r.complete_employee_backup !== false || r.can_archive !== false
    || r.can_replace !== false || r.full_site_complete !== false) invalid();
  const totals = counts(r.totals), pending = object(r.pending_withdrawals, ['count', 'amount']);
  const pendingCount = count(pending.count, limits.maxRows);
  // Do not pass this decimal string through Number, parseFloat, or JSON numeric serialization.
  if (pendingCount > totals.withdrawals || typeof pending.amount !== 'string' || pending.amount.length > limits.maxLineBytes
    || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(pending.amount) || pending.amount.endsWith('\n')) invalid();
  return { scope: SCOPE, job_id: uuid(r.job_id), site_id: uuid(r.site_id), source_site_id: uuid(r.source_site_id),
    package_id: uuid(r.package_id), catalog_hash: hash(r.catalog_hash), mapping_hash: hash(r.mapping_hash), plan_hash: hash(r.plan_hash),
    totals, employees: count(r.employees, limits.maxRows), pending_withdrawals: Object.freeze({ count: pendingCount, amount: pending.amount }),
    maintenance: true, dependencies_pending: true, financial_data_pending: true, can_restore: false,
    complete_employee_backup: false, can_archive: false, can_replace: false, full_site_complete: false };
}
function conflicts(value: unknown): readonly EmployeeMappedFinanceConflict[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, FINANCE_CONFLICT_REASONS.length);
  if (Reflect.ownKeys(value).length !== size + 1) invalid();
  const result: EmployeeMappedFinanceConflict[] = [];
  for (let index = 0; index < size; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field) || !FINANCE_CONFLICT_REASONS.includes(field.value) || result.includes(field.value)) invalid();
    result.push(field.value);
  }
  return Object.freeze(result);
}
function plan(value: unknown): EmployeeMappedFinancePlan {
  const r = object(value, [...COMMON_KEYS, 'can_begin', 'conflicts']), binding = common(r);
  const blockers = conflicts(r.conflicts), canBegin = boolean(r.can_begin);
  if (canBegin !== (blockers.length === 0) || (canBegin && binding.totals.wallets !== binding.employees)) invalid();
  return Object.freeze({ ...binding, can_begin: canBegin, conflicts: blockers });
}
function status(value: unknown): EmployeeMappedFinanceStatus {
  const r = object(value, [...COMMON_KEYS, 'started', 'completed_employees', 'verified', 'employee']), binding = common(r);
  const started = boolean(r.started), verified = boolean(r.verified), completed = count(r.completed_employees, binding.employees);
  if ((!started && (completed !== 0 || verified)) || (verified && completed !== binding.employees)
    || (started && binding.totals.wallets !== binding.employees)) invalid();
  let employee: EmployeeMappedFinanceEmployee | null = null;
  if (r.employee !== null) {
    const e = object(r.employee, ['source_id', 'target_id', 'applied', 'counts']);
    const source = uuid(e.source_id), target = uuid(e.target_id), applied = boolean(e.applied), actual = counts(e.counts);
    if (source === target || source === ZERO || target === ZERO || binding.employees === 0
      || (applied && (!started || completed === 0 || actual.wallets !== 1 || actual.wallet_balance_baselines > 1))
      || (!applied && started && completed === binding.employees)
      || FINANCE_TABLE_KEYS.some(key => actual[key] > binding.totals[key] || (!applied && actual[key] !== 0))) invalid();
    employee = Object.freeze({ source_id: source, target_id: target, applied, counts: actual });
  }
  return Object.freeze({ ...binding, started, completed_employees: completed, verified, employee });
}
export function validateEmployeeMappedFinancePlan(value: unknown): EmployeeMappedFinancePlan {
  try { return plan(value); } catch { invalid(); }
}
export function validateEmployeeMappedFinanceStatus(value: unknown): EmployeeMappedFinanceStatus {
  try { return status(value); } catch { invalid(); }
}
function samePlan(a: Common, b: Common): boolean {
  return BINDING_KEYS.every(key => a[key] === b[key]) && sameCounts(a.totals, b.totals) && a.employees === b.employees
    && a.pending_withdrawals.count === b.pending_withdrawals.count && a.pending_withdrawals.amount === b.pending_withdrawals.amount;
}
function freezeCatalog(value: unknown): FinanceCatalog {
  const result = validateFinanceCatalog(value);
  uuid(result.site_id); uuid(result.package_id); uuid(result.identity_catalog.site_id); uuid(result.identity_catalog.package_id);
  for (const table of [...result.tables, ...result.identity_catalog.tables]) { hash(table.row_hashes_sha256); Object.freeze(table); }
  Object.freeze(result.identity_catalog.tables); Object.freeze(result.identity_catalog); Object.freeze(result.tables);
  return Object.freeze(result);
}

type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
type Result = EmployeeMappedFinancePlan | EmployeeMappedFinanceStatus | EmployeeMappedFinanceBindReceipt | EmployeeMappedFinanceStageReceipt;
export interface EmployeeMappedFinanceSession {
  bind(catalog: FinanceCatalog, signal?: AbortSignal): Promise<EmployeeMappedFinanceBindReceipt>;
  stage(tableKey: FinanceTableKey, chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<EmployeeMappedFinanceStageReceipt>;
  plan(signal?: AbortSignal): Promise<EmployeeMappedFinancePlan>;
  begin(plan: EmployeeMappedFinancePlan, signal?: AbortSignal): Promise<EmployeeMappedFinanceStatus>;
  apply(sourceId: string, signal?: AbortSignal): Promise<EmployeeMappedFinanceStatus>;
  status(sourceId?: string | null, signal?: AbortSignal): Promise<EmployeeMappedFinanceStatus>;
  verify(signal?: AbortSignal): Promise<EmployeeMappedFinanceStatus>;
}
export function createEmployeeMappedFinanceSession(jobToken: string): EmployeeMappedFinanceSession {
  try { uuid(jobToken); } catch { invalid(); }
  let busy = false;
  let uncertain: { source: string | null } | undefined;
  let catalog: FinanceCatalog | undefined, catalogHash: string | undefined;
  let binding: Common | undefined, progress: EmployeeMappedFinanceStatus | undefined;
  const employees = new Map<string, EmployeeMappedFinanceEmployee>();
  const observedAt = new Map<string, number>();
  const checkCatalog = (input: FinanceCatalog, value: Common) => {
    if (input.site_id !== value.source_site_id || input.package_id !== value.package_id
      || input.identity_catalog.tables[0].rows !== value.employees
      || input.tables.some(table => table.rows !== value.totals[table.key])) invalid();
  };
  const checkBinding = (value: Common) => {
    if ((binding && !samePlan(binding, value)) || (catalogHash && catalogHash !== value.catalog_hash)) invalid();
    if (catalog) checkCatalog(catalog, value);
  };
  const checkStatus = (value: EmployeeMappedFinanceStatus, source: string | null) => {
    checkBinding(value);
    if (value.employee?.source_id !== (source ?? undefined) || (source === null && value.employee !== null)) invalid();
    if (progress && ((progress.started && !value.started) || (progress.verified && !value.verified)
      || value.completed_employees < progress.completed_employees)) invalid();
    const known = new Map(employees), employee = value.employee;
    if (employee) {
      const prior = known.get(employee.source_id);
      if (prior && (prior.target_id !== employee.target_id || (prior.applied && (!employee.applied || !sameCounts(prior.counts, employee.counts)))
        || (!prior.applied && employee.applied && value.completed_employees <= observedAt.get(employee.source_id)!))) invalid();
      for (const other of known.values()) {
        if (other.source_id !== employee.source_id && (other.target_id === employee.target_id
          || other.source_id === employee.target_id || other.target_id === employee.source_id)) invalid();
      }
      known.set(employee.source_id, employee);
    }
    const applied = [...known.values()].filter(e => e.applied);
    const unapplied = [...known.values()].filter(e => !e.applied && observedAt.get(e.source_id) === value.completed_employees);
    if (employee && !employee.applied && !unapplied.includes(employee)) unapplied.push(employee);
    if (known.size > value.employees || applied.length > value.completed_employees
      || unapplied.length > value.employees - value.completed_employees) invalid();
    for (const key of FINANCE_TABLE_KEYS) {
      const sum = applied.reduce((sum, e) => sum + e.counts[key], 0);
      if (sum > value.totals[key] || (applied.length === value.employees && sum !== value.totals[key])) invalid();
    }
  };
  const remember = (value: Common) => { binding = value; catalogHash = value.catalog_hash; };
  const rememberStatus = (value: EmployeeMappedFinanceStatus) => {
    remember(value); progress = value;
    if (value.employee) {
      employees.set(value.employee.source_id, value.employee);
      observedAt.set(value.employee.source_id, value.completed_employees);
    }
  };
  const writable = () => { if (uncertain) invalid(); };
  const confirmed = () => { writable(); if (!progress?.started) invalid(); return progress; };
  const request = async <T extends Result>(prepare: () => {
    operation: (auth: { p_admin_session_token: string; p_job_token: string }) => Query;
    validate: (value: unknown) => T; commit: (value: T) => void;
    writing?: { source: string | null; pin?: () => void };
  }, signal?: AbortSignal): Promise<T> => {
    if (busy) invalid();
    busy = true;
    let inFlight = false, finished = false;
    const track = (query: Query) => {
      inFlight = true;
      return Promise.resolve(query).finally(() => { inFlight = false; if (finished) busy = false; });
    };
    try {
      checkAbort(signal);
      // Snapshot plans/catalogs and raw input before auth callbacks or asynchronous transport work.
      const { operation, validate, commit, writing } = prepare();
      const { data, error } = await withSignal(() => {
        checkAbort(signal);
        const auth = { p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_job_token: jobToken };
        checkAbort(signal);
        if (writing) { writing.pin?.(); uncertain = { source: writing.source }; }
        const raw = operation(auth);
        let query: Query;
        try { query = signal ? raw.abortSignal(signal) : raw; }
        catch { void track(raw).catch(() => undefined); invalid(); }
        // Cancellation rejects promptly, but a signal-ignoring underlying call retains the mutex until settled.
        return track(query);
      }, signal);
      checkAbort(signal);
      if (error) invalid();
      const result = validate(data);
      checkAbort(signal);
      commit(result);
      return result;
    } catch {
      if (signal?.aborted) throw new DOMException(failure, 'AbortError');
      throw new Error(failure);
    } finally { finished = true; if (!inFlight) busy = false; }
  };
  return {
    bind(input, signal) {
      return request(() => {
        writable();
        const snapshot = freezeCatalog(input);
        if (catalog && JSON.stringify(catalog) !== JSON.stringify(snapshot)) invalid();
        if (binding) checkCatalog(snapshot, binding);
        return { writing: { source: null, pin: () => { catalog ??= snapshot; } },
          operation: auth => supabase.rpc('employee_import_mapped_finance_bind', { ...auth, p_catalog: snapshot as unknown as Record<string, unknown> }),
          validate: value => {
            const r = object(value, ['success', 'scope', 'catalog_hash', 'full_site_complete']), digest = hash(r.catalog_hash);
            if (r.success !== true || r.scope !== SCOPE || r.full_site_complete !== false || (catalogHash && digest !== catalogHash)) invalid();
            return Object.freeze({ success: true as const, scope: SCOPE, catalog_hash: digest, full_site_complete: false as const });
          }, commit: result => { catalogHash = result.catalog_hash; uncertain = undefined; } };
      }, signal);
    },
    stage(tableKey, chunkNo, ndjson, signal) {
      return request(() => {
        writable();
        const key = financeTableKey(tableKey), chunk = count(chunkNo, limits.maxChunks - 1);
        if (!catalog || typeof ndjson !== 'string' || ndjson.length > limits.maxPageBytes) invalid();
        const bytes = encoder.encode(ndjson), digest = new Sha256().update(bytes).digestHex();
        let rows = 0;
        for (const byte of bytes) if (byte === 10) rows++;
        validateFinancePage({ table_key: key, count: rows, ndjson, next_after: null, sha256: digest }, key, null);
        const table = catalog.tables.find(table => table.key === key)!;
        if (rows > table.rows || bytes.length > table.bytes || (rows === 0 && (table.rows !== 0 || chunk !== 0))) invalid();
        return { writing: { source: null },
          operation: auth => supabase.rpc('employee_import_mapped_finance_stage', { ...auth, p_table_key: key, p_chunk_no: chunk, p_ndjson: ndjson }),
          validate: value => {
            const r = object(value, ['success', 'scope', 'table_key', 'chunk_no', 'rows', 'bytes', 'sha256', 'full_site_complete']);
            if (r.success !== true || r.scope !== SCOPE || r.full_site_complete !== false || r.table_key !== key
              || r.chunk_no !== chunk || r.rows !== rows || r.bytes !== bytes.length || hash(r.sha256) !== digest) invalid();
            return Object.freeze({ success: true as const, scope: SCOPE, table_key: key, chunk_no: chunk,
              rows, bytes: bytes.length, sha256: digest, full_site_complete: false as const });
          }, commit: () => { uncertain = undefined; } };
      }, signal);
    },
    plan(signal) {
      return request(() => ({ operation: auth => supabase.rpc('employee_import_mapped_finance_plan', auth),
        validate: value => { const result = plan(value); checkBinding(result); if (progress?.started && !result.can_begin) invalid(); return result; },
        commit: remember }), signal);
    },
    begin(input, signal) {
      return request(() => {
        writable();
        const baseline = plan(input);
        if (!baseline.can_begin) invalid();
        checkBinding(baseline);
        return { writing: { source: null, pin: () => { binding ??= baseline; catalogHash ??= baseline.catalog_hash; } },
          operation: auth => supabase.rpc('employee_import_mapped_finance_begin', { ...auth, p_plan_hash: baseline.plan_hash }),
          validate: value => {
            const result = status(value); checkStatus(result, null);
            if (!result.started || !samePlan(baseline, result)) invalid();
            return result;
          }, commit: result => { rememberStatus(result); uncertain = undefined; } };
      }, signal);
    },
    apply(sourceId, signal) {
      return request(() => {
        const source = uuid(sourceId), baseline = confirmed();
        if (source === ZERO || [...employees.values()].some(e => e.target_id === source)) invalid();
        return { writing: { source },
          operation: auth => supabase.rpc('employee_import_mapped_finance_apply', { ...auth, p_source_id: source, p_plan_hash: baseline.plan_hash }),
          validate: value => {
            const result = status(value); checkStatus(result, source);
            if (!result.started || !result.employee?.applied) invalid();
            return result;
          }, commit: result => { rememberStatus(result); uncertain = undefined; } };
      }, signal);
    },
    status(sourceId = null, signal) {
      return request(() => {
        const source = sourceId === null ? null : uuid(sourceId);
        if (source === ZERO || (source !== null && [...employees.values()].some(e => e.target_id === source))) invalid();
        return { operation: auth => supabase.rpc('employee_import_mapped_finance_status', { ...auth, p_source_id: source }),
          validate: value => { const result = status(value); checkStatus(result, source); return result; },
          commit: result => {
            rememberStatus(result);
            if (uncertain && (uncertain.source === null || uncertain.source === source)) uncertain = undefined;
          } };
      }, signal);
    },
    verify(signal) {
      return request(() => {
        const baseline = confirmed();
        if (baseline.completed_employees !== baseline.employees) invalid();
        return { writing: { source: null }, operation: auth => supabase.rpc('employee_import_mapped_finance_verify', auth),
          validate: value => {
            const result = status(value); checkStatus(result, null);
            if (!result.started || !result.verified) invalid();
            return result;
          }, commit: result => { rememberStatus(result); uncertain = undefined; } };
      }, signal);
    },
  };
}
